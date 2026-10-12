import { describe, expect, test } from 'claude-code/testing'

import {
  appendRecord,
  byteLength,
  clipRecord,
  createQueue,
  emptyShard,
  formatArgs,
  isBackgroundRow,
  loadedTools,
  MAX_ARGS_CHARS,
  MAX_RECORD_CHARS,
  MAX_SHARD_BYTES,
  nonTextNote,
  OVERFLOW_PART_CHARS,
  personRequests,
  readRecord,
  recentActions,
  search,
  shardName,
  splitParts,
  toolGroupOf,
} from '../hooks/lib/history.ts'
import { groupsWanted } from '../hooks/lib/history.ts'
import type { SearchQuery } from '../hooks/lib/history.ts'
import type { HistoryRecord } from '../hooks/lib/types.ts'

const row = (seq: number, over: Partial<HistoryRecord> = {}): HistoryRecord => ({
  seq,
  uuid: `u${seq}`,
  ts: seq * 1_000,
  window: 1,
  role: 'tool',
  text: `text ${seq}`,
  ...over,
})

describe('shardName', () => {
  test('names part 0 plainly, parts 1..25 by letter, later parts by number', () => {
    expect(shardName(3, 0)).toBe('history-w003.jsonl')
    expect(shardName(3, 1)).toBe('history-w003-b.jsonl')
    expect(shardName(12, 2)).toBe('history-w012-c.jsonl')
    expect(shardName(1, 26)).toBe('history-w001-p26.jsonl')
    expect(shardName(3, 25)).toBe('history-w003-z.jsonl')
  })

  test('keeps every digit of a window past 999', () => {
    expect(shardName(1234, 0)).toBe('history-w1234.jsonl')
  })
})

describe('byteLength', () => {
  test('counts ASCII, CJK and an astral code point by their UTF-8 width', () => {
    expect(byteLength('')).toBe(0)
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('中文')).toBe(6)
    expect(byteLength('😀')).toBe(4)
    expect(byteLength('a中😀')).toBe(8)
  })
})

describe('clipRecord', () => {
  test('leaves a short record alone', () => {
    const short = row(1, { text: 'hi' })
    expect(clipRecord(short)).toEqual(short)
  })

  test('clips a long one and names the original length on its own line', () => {
    const long = row(2, { text: 'x'.repeat(MAX_RECORD_CHARS + 5_000) })
    const clipped = clipRecord(long)
    expect(clipped.text.length).toBeGreaterThan(MAX_RECORD_CHARS)
    expect(clipped.text.length).toBeLessThanOrEqual(MAX_RECORD_CHARS + 40)
    expect(clipped.text).toContain(String(long.text.length))
    expect(clipped.text).toContain('\n')
    expect(clipped.text.startsWith('x'.repeat(200))).toBe(true)
    // Everything but the text survives untouched.
    expect(clipped.seq).toBe(2)
    expect(clipped.uuid).toBe('u2')
  })

  test('does not leave half a surrogate pair behind', () => {
    const long = row(3, { text: `${'x'.repeat(MAX_RECORD_CHARS - 1)}😀${'y'.repeat(10)}` })
    const clipped = clipRecord(long)
    expect(clipped.text.startsWith('x'.repeat(50))).toBe(true)
    expect(clipped.text).toContain(String(long.text.length))
  })
})

describe('appendRecord', () => {
  test('appends onto the shard it was given, so the caller keeps only the newest', () => {
    const base = emptyShard(1)
    const first = appendRecord(base, row(1))
    const second = appendRecord(first.shard, row(2))

    expect(first.isNew).toBe(false)
    expect(second.isNew).toBe(false)
    // The shard handed in is consumed: the same object and the same rows array
    // come back, so an append is O(1) instead of copying every row.
    expect(first.shard).toBe(base)
    expect(second.shard).toBe(base)
    expect(second.shard.rows).toBe(first.shard.rows)
    expect(second.shard.part).toBe(0)
    expect(second.shard.rows.map(one => one.seq)).toEqual([1, 2])
    expect(second.shard.bytes).toBe(byteLength(JSON.stringify(row(1))) + 1 + byteLength(JSON.stringify(row(2))) + 1)
  })

  test('a long run against one shard keeps a single rows array', () => {
    const shard = emptyShard(1)
    const kept = shard.rows
    let latest = shard
    for (let seq = 1; seq <= 1_000; seq += 1) latest = appendRecord(latest, row(seq)).shard

    expect(latest).toBe(shard)
    expect(latest.rows).toBe(kept)
    expect(latest.rows).toHaveLength(1_000)
    expect(latest.rows[999]?.seq).toBe(1_000)
  })

  test('starts a fresh part 0 when the window changes', () => {
    const filled = appendRecord(emptyShard(1, 3), row(1)).shard
    const moved = appendRecord(filled, row(2, { window: 2 }))

    expect(moved.isNew).toBe(true)
    expect(moved.shard.window).toBe(2)
    expect(moved.shard.part).toBe(0)
    expect(moved.shard.rows.map(one => one.seq)).toEqual([2])
  })

  test('opens the next part once a shard would pass its byte ceiling', () => {
    const big = row(1, { text: 'x'.repeat(1_500_000) })
    const first = appendRecord(emptyShard(1), big)
    expect(first.shard.part).toBe(0)
    expect(first.shard.bytes).toBeLessThan(MAX_SHARD_BYTES)

    const second = appendRecord(first.shard, row(2, { text: big.text }))
    expect(second.isNew).toBe(true)
    expect(second.shard).not.toBe(first.shard)
    expect(second.shard.part).toBe(1)
    expect(second.shard.rows.map(one => one.seq)).toEqual([2])
    // A rotation never reaches back into the written shard.
    expect(first.shard.rows).toHaveLength(1)
    expect(first.shard.rows[0]?.seq).toBe(1)
  })

  test('a record too big for any shard still lands alone in an empty one', () => {
    const huge = row(1, { text: 'y'.repeat(MAX_SHARD_BYTES + 10) })
    const shard = appendRecord(emptyShard(1), huge).shard
    expect(shard.rows).toHaveLength(1)
    expect(shard.bytes).toBeGreaterThan(MAX_SHARD_BYTES)
  })
})

describe('search', () => {
  const rows: HistoryRecord[] = [
    row(1, { window: 1, role: 'user', isPerson: true, text: 'Read the Config file' }),
    row(2, { window: 1, tool: 'Read', path: 'C:\\work\\src\\App.ts', text: 'opened config' }),
    row(3, { window: 2, tool: 'Edit', path: '/work/src/app.ts', text: 'patched CONFIG value' }),
    row(4, { window: 2, role: 'assistant', text: 'no mention here' }),
  ]

  test('matches a literal substring without regard to case', () => {
    const hits = search(rows, { query: 'config' })
    expect(hits.map(hit => hit.seq)).toEqual([3, 2, 1])
    expect(hits[0]?.excerpt).toContain('CONFIG')
    expect(hits[1]?.excerpt).toContain('config')
  })

  test('filters by window, role, tool and a path written either way', () => {
    expect(search(rows, { query: '', window: 2 }).map(hit => hit.seq)).toEqual([4, 3])
    expect(search(rows, { query: '', role: 'user' }).map(hit => hit.seq)).toEqual([1])
    expect(search(rows, { query: '', tool: 'Read' }).map(hit => hit.seq)).toEqual([2])
    expect(search(rows, { query: '', path: 'SRC/APP.ts' }).map(hit => hit.seq)).toEqual([3, 2])
    expect(search(rows, { query: 'config', role: 'user' }).map(hit => hit.seq)).toEqual([1])
  })

  test('reports newest first and honours limit', () => {
    expect(search(rows, { query: 'config', limit: 2 }).map(hit => hit.seq)).toEqual([3, 2])
    expect(search(rows, { query: 'config', limit: 500 })).toHaveLength(3)
  })

  test('a limit that is not a finite positive number never widens the answer', () => {
    const many = Array.from({ length: 40 }, (_, index) => row(index + 1, { text: 'hit me' }))
    const asLimit = (value: unknown): number => value as number

    expect(search(many, { query: 'hit', limit: asLimit(Number.NaN) })).toHaveLength(20)
    expect(search(many, { query: 'hit', limit: asLimit('lots') })).toHaveLength(20)
    expect(search(many, { query: 'hit', limit: asLimit(Number.POSITIVE_INFINITY) })).toHaveLength(20)
    expect(search(many, { query: 'hit', limit: asLimit(0) })).toHaveLength(20)
    expect(search(many, { query: 'hit', limit: asLimit(-5) })).toHaveLength(20)
    expect(search(many, { query: 'hit', limit: asLimit(undefined) })).toHaveLength(20)
  })

  test('a finite positive limit is floored and clamped to [1, 100]', () => {
    const many = Array.from({ length: 150 }, (_, index) => row(index + 1, { text: 'hit me' }))

    expect(search(many, { query: 'hit', limit: 3.9 })).toHaveLength(3)
    expect(search(many, { query: 'hit', limit: 1 })).toHaveLength(1)
    expect(search(many, { query: 'hit', limit: 150 })).toHaveLength(100)
  })

  test('missing or wrongly typed query fields filter instead of throwing', () => {
    const loose = (value: Record<string, unknown>): SearchQuery => value as unknown as SearchQuery

    expect(search(rows, loose({}))).toHaveLength(4)
    expect(search(rows, loose({ query: 42 }))).toHaveLength(4)
    expect(search(rows, loose({ query: 'config', window: 'two' }))).toHaveLength(3)
    expect(search(rows, loose({ query: 'config', window: Number.NaN }))).toHaveLength(3)
    expect(search(rows, loose({ query: 'config', window: Number.POSITIVE_INFINITY }))).toHaveLength(3)
    expect(search(rows, loose({ query: 'config', role: 'nope' }))).toHaveLength(3)
    expect(search(rows, loose({ query: 'config', tool: 7 }))).toHaveLength(3)
    expect(search(rows, loose({ query: 'config', path: {} }))).toHaveLength(3)
    // The filters that are still usable keep working alongside the bad ones.
    expect(search(rows, loose({ query: 'config', window: 2, role: 'nope' })).map(hit => hit.seq)).toEqual([3])
  })

  test('an empty query keeps the filters and shows the head of the text', () => {
    const hits = search(rows, { query: '', window: 1 })
    expect(hits.map(hit => hit.seq)).toEqual([2, 1])
    expect(hits[1]?.excerpt).toBe('Read the Config file')
    expect(hits[1]?.role).toBe('user')
    expect(hits[0]?.tool).toBe('Read')
  })

  test('a query with no match answers nothing', () => {
    expect(search(rows, { query: 'absent' })).toHaveLength(0)
  })

  test('an excerpt folds newlines into spaces and carries the match', () => {
    const withBreak = [row(9, { text: `before\n${'pad '.repeat(80)}needle tail` })]
    const hits = search(withBreak, { query: 'needle' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.excerpt).toContain('needle')
    expect(hits[0]?.excerpt).not.toContain('\n')
  })

  test('the mod\'s own rows are skipped unless a tool filter names them, and stay readable by number', () => {
    const own = [
      row(10, { window: 1, tool: 'mcp__ctx-mod__history', text: 'history results mention needle' }),
      row(11, { window: 1, tool: 'Grep', text: 'needle in source' }),
    ]
    expect(search(own, { query: 'needle' }).map(hit => hit.seq)).toEqual([11])
    expect(search(own, { query: '', window: 1 }).map(hit => hit.seq)).toEqual([11])
    expect(search(own, { query: 'needle', tool: 'mcp__ctx-mod__history' }).map(hit => hit.seq)).toEqual([10])
    expect(readRecord(own, 10)).toMatchObject({ found: true, tool: 'mcp__ctx-mod__history' })
  })
})

describe('readRecord', () => {
  const rows = [row(7, { text: 'abcdefghij' })]

  test('reports a seq it does not hold', () => {
    expect(readRecord(rows, 99)).toEqual({ found: false })
  })

  test('a seq, offset or length that is not a finite number falls back', () => {
    const asNumber = (value: unknown): number => value as number

    expect(readRecord(rows, asNumber(Number.NaN))).toEqual({ found: false })
    expect(readRecord(rows, asNumber('7'))).toEqual({ found: false })
    expect(readRecord(rows, asNumber(Number.POSITIVE_INFINITY))).toEqual({ found: false })
    // A NaN offset used to slice nothing at all; it now reads from the start.
    expect(readRecord(rows, 7, asNumber(Number.NaN))).toMatchObject({ text: 'abcdefghij', hasMore: false })
    expect(readRecord(rows, 7, -5)).toMatchObject({ text: 'abcdefghij' })
    expect(readRecord(rows, 7, 0, asNumber(Number.NaN))).toMatchObject({ text: 'abcdefghij' })
    expect(readRecord(rows, 7, 0, asNumber(Number.POSITIVE_INFINITY))).toMatchObject({ text: 'abcdefghij' })
    expect(readRecord(rows, 7, 0, asNumber(undefined))).toMatchObject({ text: 'abcdefghij' })
  })

  test('slices by offset and length and says whether more follows', () => {
    expect(readRecord(rows, 7)).toEqual({
      found: true,
      seq: 7,
      window: 1,
      role: 'tool',
      ts: 7_000,
      field: 'text',
      text: 'abcdefghij',
      total: 10,
      hasMore: false,
    })
    expect(readRecord(rows, 7, 2, 3)).toMatchObject({ text: 'cde', total: 10, hasMore: true })
    expect(readRecord(rows, 7, 8, 3)).toMatchObject({ text: 'ij', hasMore: false })
    expect(readRecord(rows, 7, 50, 3)).toMatchObject({ text: '', hasMore: false })
  })

  test('hands back the path it found and caps length at 20000', () => {
    const long = [row(8, { path: '/a.ts', text: 'z'.repeat(30_000) })]
    const got = readRecord(long, 8, 0, 100_000)
    expect(got.found).toBe(true)
    if (!got.found) return
    expect(got.text.length).toBe(20_000)
    expect(got.total).toBe(30_000)
    expect(got.hasMore).toBe(true)
    expect(got.path).toBe('/a.ts')
  })
})

describe('recentActions', () => {
  const rows: HistoryRecord[] = [
    row(1, { window: 1, role: 'user', isPerson: true, text: 'go' }),
    row(2, { window: 1, tool: 'Read', path: '/a.ts', text: 'line one\nline two' }),
    row(3, { window: 1, role: 'assistant', text: 'ok' }),
    row(4, { window: 1, tool: 'Edit', isError: true, text: 'wrote' }),
    row(5, { window: 2, tool: 'Bash', text: 'elsewhere' }),
    row(6, { window: 1, tool: 'Read', text: 'again' }),
  ]

  test('takes the last tool rows of one window, oldest first', () => {
    const actions = recentActions(rows, 1, 2)
    expect(actions.map(action => action.seq)).toEqual([4, 6])
    expect(actions[0]).toMatchObject({ tool: 'Edit', isError: true, head: 'wrote' })
    expect(actions[1]).toMatchObject({ tool: 'Read', isError: false, head: 'again' })
  })

  test('flattens the head and carries a path only where there is one', () => {
    const actions = recentActions(rows, 1, 3)
    expect(actions.map(action => action.seq)).toEqual([2, 4, 6])
    expect(actions[0]?.head).toBe('line one line two')
    expect(actions[0]?.path).toBe('/a.ts')
    expect(actions[1]?.path).toBeUndefined()
  })

  test('asks for nothing when the count is not positive', () => {
    expect(recentActions(rows, 1, 0)).toHaveLength(0)
  })

  test('the mod\'s own calls are left out before the tail is taken, so the count holds real actions', () => {
    const mixed: HistoryRecord[] = [
      row(1, { window: 1, tool: 'Read', path: '/a.ts', text: 'a' }),
      row(2, { window: 1, tool: 'mcp__ctx-mod__ledger_append', text: 'booked' }),
      row(3, { window: 1, tool: 'Bash', text: 'b' }),
      row(4, { window: 1, tool: 'mcp__ctx-mod__context', text: 'fill' }),
      row(5, { window: 1, tool: 'Edit', text: 'c' }),
      row(6, { window: 1, tool: 'mcp__ctx-mod__history', text: 'found' }),
    ]
    const actions = recentActions(mixed, 1, 3)
    expect(actions.map(action => action.tool)).toEqual(['Read', 'Bash', 'Edit'])
    expect(actions.some(action => action.tool.startsWith('mcp__ctx-mod__'))).toBe(false)
  })
})

describe('loadedTools', () => {
  test('merges an MCP server into one line, keeps only the tools that were used, and counts them', () => {
    const rows: HistoryRecord[] = [
      row(1, {
        tool: 'ToolSearch',
        input: 'select:mcp__computer-use__screenshot,WebFetch,mcp__computer-use__click,WebSearch',
        loaded: ['mcp__computer-use__screenshot', 'WebFetch', 'mcp__computer-use__click', 'WebSearch'],
      }),
      row(2, { tool: 'mcp__computer-use__screenshot' }),
      row(3, { tool: 'mcp__computer-use__screenshot' }),
      row(4, { tool: 'WebFetch' }),
      row(5, { tool: 'mcp__computer-use__click' }),
      // Another window's loads and calls never count here.
      row(6, { window: 2, tool: 'ToolSearch', loaded: ['Grep'] }),
      row(7, { window: 2, tool: 'Grep' }),
    ]
    expect(loadedTools(rows, 1)).toEqual([
      { name: 'mcp__computer-use__*', calls: 3 },
      { name: 'WebFetch', calls: 1 },
    ])
    expect(loadedTools(rows, 2)).toEqual([{ name: 'Grep', calls: 1 }])
  })

  test('a row written before loaded existed is read back from its select: query', () => {
    const rows: HistoryRecord[] = [
      row(1, { tool: 'ToolSearch', input: 'select:WebFetch, mcp__computer-use__drag ' }),
      row(2, { tool: 'WebFetch' }),
      row(3, { tool: 'mcp__computer-use__drag' }),
      // A query that is a keyword search loads nothing that can be read back.
      row(4, { tool: 'ToolSearch', input: 'computer-use' }),
    ]
    expect(loadedTools(rows, 1)).toEqual([
      { name: 'WebFetch', calls: 1 },
      { name: 'mcp__computer-use__*', calls: 1 },
    ])
  })

  test('lists at most eight, in the order they were first loaded', () => {
    const names = Array.from({ length: 10 }, (_, index) => `Tool${index}`)
    const rows: HistoryRecord[] = [
      row(1, { tool: 'ToolSearch', loaded: names }),
      ...names.map((name, index) => row(index + 2, { tool: name })),
    ]
    const tools = loadedTools(rows, 1)
    expect(tools).toHaveLength(8)
    expect(tools.map(tool => tool.name)).toEqual(names.slice(0, 8))
  })

  test('is empty when nothing loaded was used', () => {
    expect(loadedTools([row(1, { tool: 'ToolSearch', loaded: ['WebFetch'] })], 1)).toEqual([])
    expect(loadedTools([], 1)).toEqual([])
  })
})

describe('toolGroupOf', () => {
  test('lists an MCP tool under its server, and any other name stands alone', () => {
    expect(toolGroupOf('mcp__computer-use__screenshot')).toBe('mcp__computer-use__*')
    expect(toolGroupOf('WebFetch')).toBe('WebFetch')
  })
})

describe('groupsWanted', () => {
  const KNOWN = ['mcp__computer-use__*', 'WebFetch', 'mcp__other__*']

  test('select: names the groups of its tools, in the order the table gives, and drops what is not known', () => {
    expect(groupsWanted('select:mcp__computer-use__screenshot', KNOWN)).toEqual(['mcp__computer-use__*'])
    expect(groupsWanted('select:WebFetch, mcp__computer-use__drag ', KNOWN)).toEqual(['mcp__computer-use__*', 'WebFetch'])
    expect(groupsWanted('select:WebFetch,mcp__computer-use__drag', KNOWN)).toEqual(['mcp__computer-use__*', 'WebFetch'])
    expect(groupsWanted('select:mcp__computer-use__drag,Nope,WebFetch', KNOWN)).toEqual(['mcp__computer-use__*', 'WebFetch'])
    expect(groupsWanted('select:WebFetch', ['WebFetch', 'WebFetch'])).toEqual(['WebFetch'])
  })

  test('a keyword matches a group by its core name, with dashes and spaces read alike', () => {
    expect(groupsWanted('computer-use', KNOWN)).toEqual(['mcp__computer-use__*'])
    expect(groupsWanted('+computer-use screenshot', KNOWN)).toEqual(['mcp__computer-use__*'])
    expect(groupsWanted('computer use', KNOWN)).toEqual(['mcp__computer-use__*'])
    expect(groupsWanted('WEBFETCH', KNOWN)).toEqual(['WebFetch'])
  })

  test('an unrelated keyword wants nothing, and an empty table wants nothing', () => {
    expect(groupsWanted('weather', KNOWN)).toEqual([])
    expect(groupsWanted('select:mcp__computer-use__screenshot', [])).toEqual([])
  })
})

describe('personRequests', () => {
  const rows: HistoryRecord[] = [
    row(1, { window: 1, role: 'user', isPerson: true, text: 'first' }),
    row(2, { window: 1, role: 'user', text: 'sent by a plugin' }),
    row(3, { window: 2, role: 'user', isPerson: true, text: 'second' }),
    row(4, { window: 2, text: 'a tool result' }),
    row(5, { window: 2, role: 'user', isPerson: true, text: 'third' }),
  ]

  test('takes the last person prompts across windows, oldest first', () => {
    expect(personRequests(rows, 2).map(one => one.seq)).toEqual([3, 5])
    expect(personRequests(rows, 9).map(one => one.seq)).toEqual([1, 3, 5])
    expect(personRequests(rows, 0)).toHaveLength(0)
  })
})

describe('createQueue', () => {
  type Gate = () => void

  /** A writer every call of which parks on a gate the test opens by hand. */
  const harness = (onError?: (path: string, error: unknown) => void) => {
    const written: { path: string; text: string }[] = []
    const gates: Gate[] = []
    let live = 0
    let peak = 0

    const write = async (path: string, text: string): Promise<void> => {
      live += 1
      peak = Math.max(peak, live)
      written.push({ path, text })
      await new Promise<void>(resolve => {
        gates.push(resolve)
      })
      live -= 1
    }

    return {
      queue: createQueue(write, onError),
      written,
      peak: () => peak,
      /** Opens every gate as it appears until all the given pushes have settled. */
      settle: async (pushes: readonly Promise<unknown>[]): Promise<void> => {
        let isDone = false
        const all = Promise.all(pushes).then(() => {
          isDone = true
        })
        for (let i = 0; i < 200 && !isDone; i += 1) {
          for (const open of gates.splice(0)) open()
          await Promise.resolve()
        }
        await all
      },
    }
  }

  test('merges three pushes to one path into two writes and keeps the last text', async () => {
    const h = harness()
    const first = h.queue.push('a.jsonl', 'one')
    const second = h.queue.push('a.jsonl', 'two')
    const third = h.queue.push('a.jsonl', 'three')

    // The first write is under way and cannot be merged into.
    expect(h.written).toEqual([{ path: 'a.jsonl', text: 'one' }])

    await h.settle([first, second, third])
    expect(h.written).toHaveLength(2)
    expect(h.written[1]?.text).toBe('three')
    expect(h.peak()).toBe(1)
  })

  test('runs different paths one after another, never two at once', async () => {
    const h = harness()
    const a = h.queue.push('a.jsonl', 'A')
    const b = h.queue.push('b.jsonl', 'B')
    const c = h.queue.push('c.jsonl', 'C')

    expect(h.written.map(one => one.path)).toEqual(['a.jsonl'])

    await h.settle([a, b, c])
    expect(h.written.map(one => one.path)).toEqual(['a.jsonl', 'b.jsonl', 'c.jsonl'])
    expect(h.peak()).toBe(1)
  })

  test('a failing write is reported and the writes behind it still run', async () => {
    const errors: { path: string; error: unknown }[] = []
    const written: string[] = []
    const queue = createQueue(
      async (path, text) => {
        written.push(`${path}:${text}`)
        if (text === 'boom') throw new Error('disk full')
      },
      (path, error) => {
        errors.push({ path, error })
      },
    )

    await queue.push('a.jsonl', 'boom')
    await queue.push('a.jsonl', 'after')
    await queue.idle()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.path).toBe('a.jsonl')
    expect(written).toEqual(['a.jsonl:boom', 'a.jsonl:after'])
  })

  test('push says whether the write succeeded, and a failure does not stall the writes behind it', async () => {
    const written: string[] = []
    const queue = createQueue(async (path, text) => {
      written.push(`${path}:${text}`)
      if (text === 'boom') throw new Error('disk full')
    })

    expect(await queue.push('a.jsonl', 'fine')).toBe(true)
    expect(await queue.push('a.jsonl', 'boom')).toBe(false)
    expect(await queue.push('b.jsonl', 'after')).toBe(true)
    await queue.idle()
    expect(written).toEqual(['a.jsonl:fine', 'a.jsonl:boom', 'b.jsonl:after'])
  })

  test('two pushes merged into one write get the same result, that of the text finally written', async () => {
    let release = (): void => {}
    const queue = createQueue(async (_path, text) => {
      if (text === 'one') {
        await new Promise<void>(resolve => {
          release = resolve
        })
      }
      if (text === 'three') throw new Error('EIO')
    })
    // The first write occupies the queue, so the next two pushes to the other path merge.
    const first = queue.push('a.jsonl', 'one')
    const second = queue.push('b.jsonl', 'two')
    const third = queue.push('b.jsonl', 'three')
    release()
    const results = await Promise.all([first, second, third])
    expect(results).toEqual([true, false, false])
  })
  test('idle resolves only after every queued write is done', async () => {
    const h = harness()
    const a = h.queue.push('a.jsonl', 'A')
    let isIdle = false
    const idle = h.queue.idle().then(() => {
      isIdle = true
    })

    expect(isIdle).toBe(false)
    await h.settle([a, idle])
    expect(isIdle).toBe(true)
  })
})

describe('the fields a long history needs', () => {
  test('formatArgs writes one segment per key, strings as they are and the rest as JSON', () => {
    expect(formatArgs({ command: 'ls\n-la', timeout: 5000, flags: ['a', 'b'], none: undefined })).toBe(
      'command: ls\n-la\ntimeout: 5000\nflags: ["a","b"]',
    )
    expect(formatArgs({})).toBe('')
  })

  test('nonTextNote counts the blocks that are not text, and says nothing for text', () => {
    expect(nonTextNote([{ type: 'text', text: 'a' }])).toBe('')
    expect(nonTextNote([{ type: 'image' }, { type: 'image' }, { type: 'document' }, { type: 'text', text: 'a' }])).toBe(
      '[非文本内容：image×2、document×1]',
    )
    expect(nonTextNote([{ type: 'tool_reference' }], ['tool_reference'])).toBe('')
  })

  test('splitParts cuts at the part size and moves a cut off a surrogate pair', () => {
    expect(splitParts('abc')).toEqual({ parts: ['abc'] })
    const plain = splitParts('a'.repeat(OVERFLOW_PART_CHARS + 5))
    expect(plain.parts.map(part => part.length)).toEqual([OVERFLOW_PART_CHARS, 5])
    expect(plain.cuts).toBeUndefined()
    const pair = splitParts(`${'a'.repeat(OVERFLOW_PART_CHARS - 1)}😀bb`)
    expect(pair.cuts).toEqual([OVERFLOW_PART_CHARS - 1])
    expect(pair.parts.join('')).toBe(`${'a'.repeat(OVERFLOW_PART_CHARS - 1)}😀bb`)
  })

  test('clipRecord sets aside a long text and long arguments, each under its own field', () => {
    const clipped = clipRecord(row(1, { text: 'x'.repeat(MAX_RECORD_CHARS + 1), args: 'y'.repeat(MAX_ARGS_CHARS + 1) }))
    expect(clipped.overflow?.text).toEqual({ chars: MAX_RECORD_CHARS + 1, parts: 1 })
    expect(clipped.overflow?.args).toEqual({ chars: MAX_ARGS_CHARS + 1, parts: 1 })
    expect(clipped.args?.startsWith('y'.repeat(100))).toBe(true)
    expect(clipRecord(row(2, { args: 'short' })).overflow).toBeUndefined()
  })

  test('search skips the background rows unless a door is named, and looks in the arguments', () => {
    const rows = [
      row(1, { role: 'user', text: 'needle in a delivery', door: 'delivery' }),
      row(2, { role: 'user', text: 'needle in memory', door: 'attachment', name: 'nested_memory' }),
      row(3, { role: 'user', text: 'needle typed mid-turn', door: 'attachment', name: 'queued_command' }),
      row(4, { role: 'user', text: 'needle from a hook', door: 'hook-context' }),
      row(5, { role: 'user', text: 'needle note', door: 'note' }),
      row(6, { tool: 'Agent', text: 'finished', input: 'worker: task', args: `prompt: ${'z'.repeat(400)} deep-needle tail` }),
    ]
    expect(isBackgroundRow(rows[1] as HistoryRecord)).toBe(true)
    expect(isBackgroundRow(rows[2] as HistoryRecord)).toBe(false)
    expect(search(rows, { query: 'needle' }).map(hit => hit.seq)).toEqual([6, 3, 1])
    expect(search(rows, { query: 'needle', door: 'note' }).map(hit => hit.seq)).toEqual([5])
    expect(search(rows, { query: 'needle', door: 'attachment' }).map(hit => hit.seq)).toEqual([3, 2])
    const deep = search(rows, { query: 'deep-needle' })
    expect(deep.map(hit => hit.seq)).toEqual([6])
    expect(deep[0]?.excerpt).toContain('deep-needle tail')
  })

  test('readRecord reads the arguments when asked, and says when a row only has the summary', () => {
    const withArgs = row(1, { args: 'prompt: whole task text', input: 'summary' })
    expect(readRecord([withArgs], 1, 0, 100, 'input')).toMatchObject({ text: 'prompt: whole task text', field: 'input' })
    const legacy = readRecord([row(2, { input: 'only the summary' })], 2, 0, 100, 'input')
    expect(legacy).toMatchObject({ text: 'only the summary' })
    expect(legacy.found && legacy.note).toContain('旧记录')
  })
})
