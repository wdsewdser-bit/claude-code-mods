import { describe, expect, test } from 'claude-code/testing'

import { createSession, looksLikePerson, stripInjected } from '../hooks/lib/session.ts'
import type { Env, Io, Session } from '../hooks/lib/session.ts'
import { segmentName, shardName } from '../hooks/lib/history.ts'
import { openingOf } from '../hooks/lib/handoff.ts'
import { DEFAULTS, estimateTokens, parseJsonl } from '../hooks/lib/types.ts'
import type { Config, HistoryRecord, LedgerEntry } from '../hooks/lib/types.ts'

const DIR = '/ctx'

const shardPath = (window: number, part = 0): string => `${DIR}/${shardName(window, part)}`

/** Every row of one window, legacy parts and per-record segments alike, in seq order. */
const windowRows = (box: Box, window: number): HistoryRecord[] => {
  const head = `${DIR}/history-w${String(window).padStart(3, '0')}`
  const rows: HistoryRecord[] = []
  for (const [path, text] of box.files) {
    if (!path.startsWith(head)) continue
    const rest = path.slice(head.length)
    if (!rest.startsWith('.') && !rest.startsWith('-')) continue
    if (!path.endsWith('.jsonl')) continue
    rows.push(...parseJsonl<HistoryRecord>(text))
  }
  return rows.sort((left, right) => left.seq - right.seq)
}

/** One window's history as the text on disk, all files joined. */
const windowText = (box: Box, window: number): string => windowRows(box, window).map(row => JSON.stringify(row)).join('\n')

type Box = {
  files: Map<string, string>
  io: Io
  /** Moves the injected clock, so timestamps and cooldowns can be driven by hand. */
  advance: (ms: number) => void
}

const makeIo = (start = 1_000_000): Box => {
  const files = new Map<string, string>()
  let clock = start
  const io: Io = {
    read: async path => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    write: async (path, text) => {
      files.set(path, text)
    },
    now: () => clock,
    list: async dir => {
      const prefix = `${dir}/`

      return [...files.keys()].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map(path => path.slice(prefix.length))
    },
  }

  return { files, io, advance: ms => (clock += ms) }
}

const env = (tokens: number | undefined, limit = 100_000): Env => ({
  tokens,
  limit,
  cache: null,
  fiveHourPercent: undefined,
})

const readMeta = (box: Box): Record<string, unknown> =>
  JSON.parse(box.files.get(`${DIR}/meta.json`) ?? '{}') as Record<string, unknown>

const readLedger = (box: Box, name = 'ledger.jsonl'): LedgerEntry[] =>
  parseJsonl<LedgerEntry>(box.files.get(`${DIR}/${name}`) ?? '')

/** A session with one person prompt (#1) and one successful tool result (#2), nothing else. */
const freshSession = async (box: Box, config: Config = DEFAULTS): Promise<Session> => {
  const session = createSession(DIR, box.io, config)
  await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把登录页的按钮改成蓝色' })
  box.advance(1_000)
  await session.record({ uuid: 't1', role: 'tool', tool: 'Edit', path: 'src/a.ts', text: 'edited ok' })

  return session
}

describe('record', () => {
  test('numbers rows, writes valid JSONL and keeps counting after a reload', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    const first = await session.record({ uuid: 'u1', role: 'user', isPerson: true, text: '你好' })
    const second = await session.record({ uuid: 'u2', role: 'tool', tool: 'Read', path: 'a.ts', text: 'ok' })

    expect([first.seq, second.seq]).toEqual([1, 2])
    expect(first.window).toBe(1)
    expect(session.window()).toBe(1)
    await session.flush()

    const rows = windowRows(box, 1)
    expect(rows.map(row => row.seq)).toEqual([1, 2])
    expect(rows[0]?.isPerson).toBe(true)
    expect(rows[1]?.tool).toBe('Read')
    expect(readMeta(box).seq).toBe(2)

    const reloaded = createSession(DIR, box.io, DEFAULTS)
    const third = await reloaded.record({ uuid: 'u3', role: 'assistant', text: '继续' })
    expect(third.seq).toBe(3)
    expect(reloaded.window()).toBe(1)
    await reloaded.flush()
    expect(windowRows(box, 1).map(row => row.seq)).toEqual([1, 2, 3])
  })

  test('a damaged meta.json and a damaged line leave the session usable', async () => {
    const box = makeIo()
    box.files.set(`${DIR}/meta.json`, '{ this is not json')
    box.files.set(shardPath(1), '{"seq":1,"uuid":"u1","ts":1,"window":1,"role":"user","text":"旧"}\nnot json\n')
    const session = createSession(DIR, box.io, DEFAULTS)

    expect(session.window()).toBe(1)
    const record = await session.record({ uuid: 'u2', role: 'user', text: '新' })
    // #1 is already on disk: handing it out again would make one number mean two rows.
    expect(record.seq).toBe(2)
    expect((await session.ledgerRead({})).result).toContain('第 1 个窗口')
    expect((await session.historyTool({ action: 'search', query: '旧' })).result).toContain('#1 w1')
    expect((await session.historyTool({ action: 'read', seq: 1 })).result).toContain('旧')
    await session.flush()
  })

  test('a damaged meta.json recovers the window, the seq and the archive from the files', async () => {
    const box = makeIo()
    const config: Config = { ...DEFAULTS, pageTokens: 100, recentRequests: 2 }
    const session = createSession(DIR, box.io, config)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '第一个请求' })
    await session.record({ uuid: 't1', role: 'tool', tool: 'Edit', path: 'src/app.ts', text: 'edited ok' })
    await session.ledgerAppend(
      { task_id: 'old-done', title: '早先完成的任务', status: 'done', text: '说明文字'.repeat(30), evidence: [2], request_ref: 1 },
      env(10_000),
    )
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '第二个请求' })
    await session.record({ uuid: 'p3', role: 'user', isPerson: true, text: '第三个请求' })
    await session.ledgerAppend(
      { task_id: 'open-1', title: '进行中的任务', status: 'in_progress', text: '在做', next_step: '接着做' },
      env(10_000),
    )
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    await session.flush()
    const archived = box.files.get(`${DIR}/archive-001.jsonl`)
    expect(readLedger(box, 'archive-001.jsonl').map(entry => entry.task_id)).toEqual(['old-done'])

    // Window 2 holds no row yet, so the seq has to come from window 1's shard.
    box.files.set(`${DIR}/meta.json`, '{ this is not json')
    const reloaded = createSession(DIR, box.io, config)
    const record = await reloaded.record({ uuid: 'u9', role: 'assistant', text: '新窗口' })
    expect(record.window).toBe(2)
    expect(record.seq).toBe(5)

    const next = await reloaded.ledgerAppend(
      { task_id: 'open-1', title: '进行中的任务', status: 'in_progress', text: '继续', next_step: '接着做' },
      env(10_000),
    )
    expect(next.result).toContain('#L3')
    expect((await reloaded.ledgerRead({ view: 'archive:1' })).result).toContain('old-done')
    await reloaded.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接二' })
    await reloaded.flush()
    // The first archive page is still what it was: a later page never lands on top of it.
    expect(box.files.get(`${DIR}/archive-001.jsonl`)).toBe(archived)
    expect(readMeta(box).window).toBe(3)
  })

  test('a meta.json that fell behind the shards never reuses a seq', async () => {
    const box = makeIo()
    const session = await freshSession(box)
    await session.flush()
    const stale = box.files.get(`${DIR}/meta.json`) ?? ''
    await session.record({ uuid: 'u3', role: 'assistant', text: '第三条' })
    await session.flush()
    box.files.set(`${DIR}/meta.json`, stale)

    const reloaded = createSession(DIR, box.io, DEFAULTS)
    const record = await reloaded.record({ uuid: 'u4', role: 'assistant', text: '第四条' })
    expect(record.seq).toBe(4)
  })

  test('an earlier window that rotated is read back whole after a reload', async () => {
    const box = makeIo()
    // One row per segment keeps the rotation itself under test.
    const session = createSession(DIR, box.io, { ...DEFAULTS, segmentRecords: 1 })
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '第一个请求' })
    // Every row lands in a segment of its own, however large it is.
    for (let index = 0; index < 12; index += 1) {
      await session.record({ uuid: `big${index}`, role: 'tool', tool: 'Read', text: `ROW${index} ${'x'.repeat(190_000)}` })
    }
    const last = await session.record({ uuid: 'tail', role: 'tool', tool: 'Read', text: 'TAILMARK 在第二个分片里' })
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '第二个请求' })
    await session.flush()
    expect(box.files.has(`${DIR}/${segmentName(1, last.seq)}`)).toBe(true)
    expect(windowRows(box, 1).map(row => row.seq)).toContain(last.seq)
    // Nothing was rotated into a second legacy part.
    expect(box.files.has(shardPath(1, 1))).toBe(false)

    const reloaded = createSession(DIR, box.io, { ...DEFAULTS, segmentRecords: 1 })
    const read = await reloaded.historyTool({ action: 'read', seq: last.seq })
    expect(read.isError).not.toBe(true)
    expect(read.result).toContain('TAILMARK')
    expect((await reloaded.historyTool({ action: 'search', query: 'TAILMARK' })).result).toContain(`#${last.seq} w1`)
  })

  test('the current window is read past the part meta.json names', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, { ...DEFAULTS, segmentRecords: 1 })
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '第一个请求' })
    await session.flush()
    const stale = box.files.get(`${DIR}/meta.json`) ?? ''
    for (let index = 0; index < 12; index += 1) {
      await session.record({ uuid: `big${index}`, role: 'tool', tool: 'Read', text: `ROW${index} ${'x'.repeat(190_000)}` })
    }
    const last = await session.record({ uuid: 'tail', role: 'tool', tool: 'Read', text: 'TAILMARK' })
    await session.flush()
    expect(box.files.has(`${DIR}/${segmentName(1, last.seq)}`)).toBe(true)
    box.files.set(`${DIR}/meta.json`, stale)

    const reloaded = createSession(DIR, box.io, { ...DEFAULTS, segmentRecords: 1 })
    const record = await reloaded.record({ uuid: 'u9', role: 'assistant', text: '接着写' })
    expect(record.seq).toBe(last.seq + 1)
    await reloaded.flush()
    // The new row gets a segment of its own; the earlier ones are never rewritten.
    expect(windowRows(box, 1).map(row => row.seq)).toContain(record.seq)
    expect((await reloaded.historyTool({ action: 'read', seq: last.seq })).result).toContain('TAILMARK')
  })

  test('works on a directory that has no files at all', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)

    expect((await session.ledgerRead({ view: 'current' })).result).toContain('还没有条目')
    expect((await session.historyTool({ action: 'search', query: 'x' })).result).toBe('没有匹配。')
    expect((await session.historyTool({ action: 'read', seq: 1 })).isError).toBe(true)
    expect(session.status(env(undefined, 100_000))).toContain('ctx ?')
    expect(await session.buildHandoff({ isMidTurn: true })).toContain('第 2 个窗口')
    expect(() => session.noteRequest()).not.toThrow()
    await session.flush()
  })
})

describe('reminder', () => {
  const at = (tokens: number, limit = 400_000) => env(tokens, limit)

  test('three absolute fills, each said once per window', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)

    // Below 250k nothing is said, however close: the window is meant to be used.
    expect(session.reminder(at(249_999))).toBeNull()
    expect(session.reminder(at(250_000))).toContain('上下文已用 250k/400k。如果当前任务刚告一段落')
    expect(session.reminder(at(250_000))).toBeNull()
    expect(session.reminder(at(299_999))).toBeNull()
    expect(session.reminder(at(300_000))).toContain('上下文已用 300k/400k，再过一段就该换窗口了')
    expect(session.reminder(at(300_000))).toBeNull()
    expect(session.reminder(at(349_999))).toBeNull()
    expect(session.reminder(at(350_000))).toContain('上下文已用 350k/400k，离上限只剩约 50k')
    expect(session.reminder(at(350_000))).toBeNull()
    expect(session.reminder(env(undefined))).toBeNull()
    expect(session.reminder(at(10_000))).toBeNull()
  })

  test('a window that starts at urgent never back-fills the lower fills', async () => {
    const box = makeIo()
    const jumped = createSession('/other', box.io, DEFAULTS)

    expect(jumped.reminder(at(350_000))).toContain('离上限只剩约 50k')
    expect(jumped.reminder(at(250_000))).toBeNull()
    expect(jumped.reminder(at(300_000))).toBeNull()
  })

  test('a new window reminds again', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    expect(session.reminder(at(250_000))).toContain('上下文已用 250k/400k')

    await session.commitSwitch({ trigger: 'manual', tokensBefore: 350_000, handoffText: '交接内容' })
    expect(session.reminder(at(250_000))).toContain('上下文已用 250k/400k')
  })

  test('no fill sits closer than 30k to the limit', async () => {
    const box = makeIo()
    // At a 300k limit soft and urgent both cap at 270k, so 270k is already urgent.
    const capped = createSession('/cap', box.io, DEFAULTS)
    expect(capped.reminder(at(249_999, 300_000))).toBeNull()
    expect(capped.reminder(at(250_000, 300_000))).toContain('上下文已用 250k/300k。如果当前任务刚告一段落')
    expect(capped.reminder(at(270_000, 300_000))).toContain('上下文已用 270k/300k，离上限只剩约 30k')

    // At a 280k limit every fill caps at 250k: the first thing said is already urgent.
    const small = createSession('/small', box.io, DEFAULTS)
    expect(small.reminder(at(249_999, 280_000))).toBeNull()
    expect(small.reminder(at(250_000, 280_000))).toContain('上下文已用 250k/280k，离上限只剩约 30k')
  })
})

describe('ledgerAppend', () => {
  const good = {
    task_id: 'login-btn',
    title: '登录页按钮改蓝',
    status: 'in_progress' as const,
    text: '改了一半',
    next_step: '继续改样式',
  }

  test('rejects anything that is not a plain object', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)

    expect((await session.ledgerAppend('do it', env(10_000))).isError).toBe(true)
    expect((await session.ledgerAppend(null, env(10_000))).isError).toBe(true)
    expect((await session.ledgerAppend([1, 2], env(10_000))).isError).toBe(true)
    expect((await session.ledgerAppend({ ...good, text: 42 }, env(10_000))).isError).toBe(true)
  })

  test('lists every problem and writes nothing when the check fails', async () => {
    const box = makeIo()
    const session = await freshSession(box)
    const answer = await session.ledgerAppend(
      { task_id: 'bad id', title: '', status: 'nope', text: 'x' },
      env(10_000),
    )

    expect(answer.isError).toBe(true)
    expect(answer.result).toContain('账本记录未通过校验：')
    expect(answer.result).toContain('task_id')
    expect(answer.result).toContain('title 不能为空')
    expect(answer.result).toContain('status 只能是')
    expect(box.files.has(`${DIR}/ledger.jsonl`)).toBe(false)
  })

  test('writes a passing entry with a stamped seq, request_ref and anchors', async () => {
    const box = makeIo()
    box.files.set('src/Button.tsx', 'line one\nconst blue = 1\nline three\n')
    const session = await freshSession(box)
    const answer = await session.ledgerAppend(
      { ...good, anchors: [{ path: 'src/Button.tsx', match: 'const blue = 1', note: '按钮样式' }] },
      env(10_000),
    )

    expect(answer.isError).toBeUndefined()
    expect(answer.result).toBe('已记录 #L1。对应请求 #1（用户消息，省略 request_ref 时取最近一条）。')
    await session.flush()
    const entries = readLedger(box)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.seq).toBe(1)
    expect(entries[0]?.window).toBe(1)
    expect(entries[0]?.request_ref).toBe(1)
    expect(entries[0]?.next_step).toBe('继续改样式')
  })

  test('reports a missing anchor file, an unmatched match and an ambiguous match', async () => {
    const box = makeIo()
    box.files.set('src/Button.tsx', 'line one\nconst dup = 1\nconst dup = 1\n')
    const session = await freshSession(box)

    const missing = await session.ledgerAppend(
      { ...good, anchors: [{ path: 'src/none.ts', match: 'x', note: 'n' }] },
      env(10_000),
    )
    expect(missing.isError).toBe(true)
    expect(missing.result).toContain('文件不存在：src/none.ts')

    const unmatched = await session.ledgerAppend(
      { ...good, anchors: [{ path: 'src/Button.tsx', match: '这一行不存在', note: 'n' }] },
      env(10_000),
    )
    expect(unmatched.isError).toBe(true)
    expect(unmatched.result).toContain('找不到 match 这段原文')

    const ambiguous = await session.ledgerAppend(
      { ...good, anchors: [{ path: 'src/Button.tsx', match: 'const dup = 1', note: 'n' }] },
      env(10_000),
    )
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.result).toContain('出现多次')
    expect(box.files.has(`${DIR}/ledger.jsonl`)).toBe(false)
  })

  test('finds evidence in an earlier window by reading that shard back', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把按钮改成蓝色' })
    await session.ledgerAppend({ ...good, text: '开始' }, env(10_000))
    box.advance(1_000)
    await session.record({ uuid: 't1', role: 'tool', tool: 'Edit', path: 'src/a.ts', text: 'edited ok' })
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    expect(session.window()).toBe(2)
    await session.flush()

    // A session that only knows window 2 must pull history-w001.jsonl back in.
    const reloaded = createSession(DIR, box.io, DEFAULTS)
    const answer = await reloaded.ledgerAppend(
      { task_id: 'login-btn', title: '登录页按钮改蓝', status: 'done', text: '改完了', evidence: [2] },
      env(10_000),
    )
    expect(answer.isError).toBeUndefined()
    expect(answer.result).toContain('已记录 #L2。')
  })

  test('suggests a switch after a done entry only when nothing is open and the boundary fill is reached', async () => {
    const box = makeIo()
    const session = await freshSession(box)
    const done = { task_id: 'login-btn', title: '登录页按钮改蓝', status: 'done' as const, text: '改完了', evidence: [2] }

    const early = await session.ledgerAppend(done, env(10_000, 400_000))
    expect(early.result).toBe('已记录 #L1。对应请求 #1（用户消息，省略 request_ref 时取最近一条）。')
    expect(early.result).not.toContain('上下文已用')

    // The suggestion waits for 250k: a finished task alone is no reason to switch.
    const middle = await session.ledgerAppend({ ...done, task_id: 'login-btn-2' }, env(249_999, 400_000))
    expect(middle.result).toBe('已记录 #L2。对应请求 #1（用户消息，省略 request_ref 时取最近一条）。')

    const late = await session.ledgerAppend({ ...done, task_id: 'login-btn-3' }, env(250_000, 400_000))
    expect(late.result).toContain('上下文已用 250k/400k。如果当前任务刚告一段落')
    // The same sentence is never repeated by the reminder that follows the tool call.
    expect(session.reminder(env(250_000, 400_000))).toBeNull()
  })
})

describe('ledgerRead and historyTool', () => {
  test('serves home, current, archive and query views, and history search and read across windows', async () => {
    const box = makeIo()
    box.files.set('src/app.ts', 'const target = 3\n')
    const config: Config = { ...DEFAULTS, pageTokens: 100, recentRequests: 2 }
    const session = createSession(DIR, box.io, config)

    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '第一个请求' })
    await session.record({ uuid: 't1', role: 'tool', tool: 'Edit', path: 'src/app.ts', text: 'updated the target line' })
    await session.ledgerAppend(
      {
        task_id: 'old-done',
        title: '早先完成的任务',
        status: 'done',
        text: '说明文字'.repeat(30) + ' UNIQUEMARK',
        evidence: [2],
        request_ref: 1,
      },
      env(10_000),
    )
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '第二个请求' })
    await session.record({ uuid: 'p3', role: 'user', isPerson: true, text: '第三个请求' })
    await session.ledgerAppend(
      { task_id: 'open-1', title: '进行中的任务', status: 'in_progress', text: '在做', next_step: '接着做' },
      env(10_000),
    )
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    await session.flush()

    expect(session.window()).toBe(2)
    expect(readLedger(box, 'archive-001.jsonl').map(entry => entry.task_id)).toEqual(['old-done'])
    expect(readLedger(box).map(entry => entry.task_id)).toEqual(['open-1'])
    const events = parseJsonl<Record<string, unknown>>(box.files.get(`${DIR}/events.jsonl`) ?? '')
    expect(events).toHaveLength(1)
    expect(events[0]?.window).toBe(1)
    expect(events[0]?.trigger).toBe('manual')
    expect(events[0]?.requestsSinceSwitch).toBe(0)

    const current = await session.ledgerRead({ view: 'current' })
    expect(current.result).toContain('#L2 · open-1 · 进行中 · 进行中的任务 · 在做 · 下一步：接着做')
    expect(current.result).not.toContain('old-done')

    const archive = await session.ledgerRead({ view: 'archive:1' })
    expect(archive.result).toContain('old-done')
    expect((await session.ledgerRead({ view: 'archive:9' })).isError).toBe(true)
    expect((await session.ledgerRead({ view: 'nope' })).isError).toBe(true)

    const home = await session.ledgerRead({})
    expect(home.result).toContain('第 2 个窗口')
    expect(home.result).toContain('第二个请求')
    expect(home.result).toContain('进行中的任务')
    expect(home.result).toContain('第 1 页')

    const found = await session.ledgerRead({ query: 'old-done' })
    expect(found.result).toContain('#L1')
    expect(found.result).toContain('早先完成的任务')
    expect(found.result).toContain('#2')
    expect((await session.ledgerRead({ query: '不存在的词' })).result).toBe('没有匹配「不存在的词」的账本条目。')

    expect((await session.ledgerRead({ query: 'UNIQUEMARK' })).result).toContain('old-done')

    const reloaded = createSession(DIR, box.io, config)
    const search = await reloaded.historyTool({ action: 'search', query: 'updated' })
    expect(search.result).toContain('#2 w1 tool [Edit] [src/app.ts]：updated the target line')
    expect((await reloaded.historyTool({ action: 'search', query: '第三个请求' })).result).toContain('#4 w1 user')
    expect((await reloaded.historyTool({ action: 'search', query: 'zzz' })).result).toBe('第 1–2 个窗口里都没有匹配。')
    expect((await reloaded.historyTool({ action: 'search', query: '请求', window: 1 })).result).not.toContain('w2')
    expect((await reloaded.historyTool({ action: 'search', window: '2' })).isError).toBe(true)
    expect((await reloaded.historyTool({ action: 'list' })).isError).toBe(true)

    const read = await reloaded.historyTool({ action: 'read', seq: 2 })
    expect(read.result).toContain('#2 w1 tool [Edit] [src/app.ts] 共 23 字符')
    expect(read.result).toContain('updated the target line')
    const slice = await reloaded.historyTool({ action: 'read', seq: 2, offset: 0, length: 7 })
    expect(slice.result).toContain('共 23 字符，还有后续，用 offset 继续读')
    expect((await reloaded.historyTool({ action: 'read', seq: 99 })).isError).toBe(true)
    expect((await reloaded.historyTool({ action: 'read' })).isError).toBe(true)
  })
})

describe('requestSwitch', () => {
  const ready = async (box: Box, config: Config = DEFAULTS): Promise<Session> => {
    const session = await freshSession(box, config)
    await session.ledgerAppend(
      { task_id: 'login-btn', title: '登录页按钮改蓝', status: 'in_progress', text: '在做', next_step: '接着做' },
      env(10_000),
    )

    return session
  }

  test('refuses inside the cooldown, then allows when the arithmetic works out', async () => {
    const box = makeIo()
    const session = await ready(box)
    const early = session.requestSwitch({}, env(160_000, 1_000_000))
    expect(early.isError).toBe(true)
    expect(early.result).toContain('暂不换窗口：')
    expect(early.result).toContain('冷却门槛')

    for (let i = 0; i < DEFAULTS.cooldownRequests; i += 1) session.noteRequest()
    const soft = session.requestSwitch({}, env(160_000, 1_000_000))
    expect(soft.isError).toBeUndefined()
    expect(soft.result).toContain('已批准换窗口。请立即结束本回合')

    // With nothing pending, the arithmetic itself is what refuses.
    session.clearPending()
    const last = session.requestSwitch({ expect_more_work: false }, env(160_000, 1_000_000))
    expect(last.isError).toBe(true)
    expect(last.result).toContain('不划算')
  })

  test('refuses when the ledger is not fresh, and lets urgent through anyway', async () => {
    const box = makeIo()
    const config: Config = { ...DEFAULTS, cooldownRequests: 0 }
    const session = createSession(DIR, box.io, config)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把按钮改成蓝色' })
    box.advance(1_000)

    const stale = session.requestSwitch({}, env(90_000))
    expect(stale.isError).toBe(true)
    expect(stale.result).toContain('账本还不新')

    await session.ledgerAppend(
      { task_id: 'login-btn', title: '登录页按钮改蓝', status: 'in_progress', text: '在做', next_step: '接着做' },
      env(90_000),
    )
    const urgent = session.requestSwitch({ reason: '上下文快满了' }, env(90_000))
    expect(urgent.isError).toBeUndefined()
    expect(session.pending()).toMatchObject({ reason: '上下文快满了', at: 1_001_000 })

    box.advance(121_000)
    expect(session.pending()).toBeNull()
  })

  test('a second request while one is pending keeps the first approval untouched', async () => {
    const box = makeIo()
    const session = await ready(box, { ...DEFAULTS, cooldownRequests: 0 })
    const first = session.requestSwitch({ reason: '先申请' }, env(160_000, 1_000_000))
    expect(first.result).toContain('已批准换窗口')
    const held = session.pending()
    expect(held).not.toBeNull()

    box.advance(5_000)
    const again = session.requestSwitch({ reason: '再申请' }, env(160_000, 1_000_000))
    expect(again.result).toBe(first.result)
    expect(session.pending()).toEqual(held)
  })

  test('refuses past the hourly cap', async () => {
    const box = makeIo()
    const session = await ready(box)
    for (let i = 0; i < DEFAULTS.maxSwitchesPerHour; i += 1) {
      await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    }

    const refused = session.requestSwitch({}, env(160_000, 1_000_000))
    expect(refused.isError).toBe(true)
    expect(refused.result).toContain('达到上限')
  })
})

describe('buildHandoff and commitSwitch', () => {
  test('carries the request, the next step and numbered snippets that follow the file', async () => {
    const box = makeIo()
    box.files.set('src/app.ts', 'const a = 1\nconst b = 2\nconst target = 3\nconst d = 4\nconst e = 5\n')
    const config: Config = { ...DEFAULTS, snippetLines: 2 }
    const session = createSession(DIR, box.io, config)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把 target 改成 4' })
    await session.ledgerAppend(
      {
        task_id: 't1',
        title: '改 target',
        status: 'in_progress',
        text: '正在改',
        next_step: '把 target 改成 4',
        anchors: [{ path: 'src/app.ts', match: 'const target = 3', note: '目标行' }],
      },
      env(10_000),
    )

    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text).toContain('第 2 个窗口')
    expect(text).toContain('把 target 改成 4')
    expect(text).toContain('3\tconst target = 3')

    box.files.set('src/app.ts', '// 一行注释\n// 又一行注释\nconst a = 1\nconst b = 2\nconst target = 3\n')
    const moved = await session.buildHandoff({ isMidTurn: false })
    expect(moved).toContain('5\tconst target = 3')

    box.files.delete('src/app.ts')
    const gone = await session.buildHandoff({ isMidTurn: true })
    expect(gone).toContain('需重读')
    expect(session.window()).toBe(1)
  })

  test('commits a switch: window, events, a fresh shard, and lastPrefix/lastHandoff', async () => {
    const box = makeIo()
    const session = await freshSession(box)
    await session.noteRequest()
    const handoff = '一段交接内容'
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 123_456, handoffText: handoff })
    await session.flush()

    expect(session.window()).toBe(2)
    expect(readMeta(box).window).toBe(2)
    expect(readMeta(box).requestsSinceSwitch).toBe(0)
    expect(readMeta(box).lastHandoff).toBe(estimateTokens(handoff))

    const events = parseJsonl<Record<string, unknown>>(box.files.get(`${DIR}/events.jsonl`) ?? '')
    expect(events[0]?.tokensBefore).toBe(123_456)
    expect(events[0]?.handoffTokens).toBe(estimateTokens(handoff))

    session.notePrefix(50_000)
    const record = await session.record({ uuid: 'u9', role: 'assistant', text: '新窗口' })
    expect(record.window).toBe(2)
    await session.flush()
    // notePrefix only touches memory; the next queued meta write is what carries it to disk.
    expect(readMeta(box).lastPrefix).toBe(50_000 - estimateTokens(handoff))
    expect(windowRows(box, 2).map(row => row.seq)).toEqual([3])
    expect(windowRows(box, 1)).toHaveLength(2)
  })

  test('two switches with the first write still in flight keep both event lines', async () => {
    // An engine write is an RPC: the file only changes when it settles, so the
    // second switch reads the file before the first switch's line landed.
    const files = new Map<string, string>()
    const waiting: (() => void)[] = []
    const io: Io = {
      read: async path => {
        const text = files.get(path)
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return text
      },
      write: (path, text) =>
        new Promise<void>(resolve => {
          waiting.push(() => {
            files.set(path, text)
            resolve()
          })
        }),
      now: () => 1_000_000,
    }
    const session = createSession(DIR, io, DEFAULTS)
    await session.commitSwitch({ trigger: 'model', tokensBefore: 90_000, handoffText: '第一份' })
    await session.commitSwitch({ trigger: 'auto', tokensBefore: 80_000, handoffText: '第二份' })
    // Let the queue run, releasing each write it asks for; the queue starts the
    // next job in the same turn it finishes one, so nothing is left in flight.
    for (let spin = 0; spin < 100 && waiting.length > 0; spin += 1) {
      while (waiting.length > 0) waiting.shift()?.()
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()
    }
    while (waiting.length > 0) waiting.shift()?.()
    await session.flush()

    const events = parseJsonl<Record<string, unknown>>(files.get(`${DIR}/events.jsonl`) ?? '')
    expect(events.map(event => event.trigger)).toEqual(['model', 'auto'])
    expect(files.has(`${DIR}/handoff-w003.md`)).toBe(true)
  })
})

describe('a session rebuilt from the files', () => {
  test('still carries the window-1 request into the handoff and the home view', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把登录页的按钮改成蓝色' })
    box.advance(1_000)
    await session.ledgerAppend(
      { task_id: 'login-btn', title: '登录页按钮改蓝', status: 'in_progress', text: '在做', next_step: '接着做' },
      env(10_000),
    )
    await session.commitSwitch({ trigger: 'model', tokensBefore: 90_000, handoffText: '交接' })
    await session.flush()

    // Only window 2's shard is loaded: the request of window 1 must be read back.
    const reloaded = createSession(DIR, box.io, DEFAULTS)
    expect(await reloaded.buildHandoff({ isMidTurn: false })).toContain('把登录页的按钮改成蓝色')
    expect((await reloaded.ledgerRead({})).result).toContain('把登录页的按钮改成蓝色')
  })

  test('still protects the task of that request when the page turns', async () => {
    const box = makeIo()
    const config: Config = { ...DEFAULTS, pageTokens: 200 }
    const session = createSession(DIR, box.io, config)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '第一个请求' })
    await session.record({ uuid: 't1', role: 'tool', tool: 'Edit', path: 'src/a.ts', text: 'edited ok' })
    await session.ledgerAppend(
      {
        task_id: 'keep-me',
        title: '和第一个请求有关的任务',
        status: 'done',
        text: '说明文字'.repeat(30),
        evidence: [2],
        request_ref: 1,
      },
      env(10_000),
    )
    await session.commitSwitch({ trigger: 'model', tokensBefore: 90_000, handoffText: '交接' })
    await session.flush()

    const reloaded = createSession(DIR, box.io, config)
    await reloaded.record({ uuid: 'p2', role: 'user', isPerson: true, text: '第二个请求' })
    await reloaded.record({ uuid: 't2', role: 'tool', tool: 'Edit', path: 'src/b.ts', text: 'edited too' })
    await reloaded.ledgerAppend(
      { task_id: 'other', title: '第二个请求的任务', status: 'done', text: '另外的说明'.repeat(30), evidence: [4] },
      env(10_000),
    )
    await reloaded.commitSwitch({ trigger: 'auto', tokensBefore: 80_000, handoffText: '第二份交接' })
    await reloaded.flush()

    // The page is over its cap, so it turns: both tasks answer a request the new
    // window is still carrying, and neither may leave for the archive.
    expect(readLedger(box).map(entry => entry.task_id)).toEqual(['keep-me', 'other'])
    expect(box.files.has(`${DIR}/archive-001.jsonl`)).toBe(false)
  })
})

describe('ready', () => {
  test('brings in the state and the earlier requests the sync readers answer from', async () => {
    const box = makeIo()
    const first = createSession(DIR, box.io, DEFAULTS)
    await first.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把按钮改成蓝色' })
    await first.commitSwitch({ trigger: 'model', tokensBefore: 90_000, handoffText: '交接' })
    await first.flush()
    expect(readMeta(box).window).toBe(2)

    const reloaded = createSession(DIR, box.io, DEFAULTS)
    // Nothing is loaded yet, so the sync readers report the empty state.
    expect(reloaded.window()).toBe(1)
    expect(reloaded.latestPersonSeq()).toBeNull()

    await reloaded.ready()
    expect(reloaded.window()).toBe(2)
    expect(reloaded.latestPersonSeq()).toBe(1)
    expect(reloaded.isLedgerFresh()).toBe(false)
  })

  test('a session that never recorded anything is still usable after ready', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)

    await session.ready()
    expect(session.window()).toBe(1)
    expect(session.lastRequestAt()).toBeNull()
    expect(session.pending()).toBeNull()
  })
})

describe('looksLikePerson', () => {
  test('keeps the engine rows and the mod’s own notes off the person’s side', () => {
    expect(looksLikePerson('把登录页的按钮改成蓝色')).toBe(true)
    expect(looksLikePerson('<system-reminder>记住这一点</system-reminder>')).toBe(false)
    expect(looksLikePerson('<local-command-caveat>caveat</local-command-caveat>')).toBe(false)
    expect(looksLikePerson('<command-name>/ctx-mod</command-name>')).toBe(false)
    expect(looksLikePerson('<task-notification>一个子代理做完了</task-notification>')).toBe(false)
    expect(
      looksLikePerson('This session is being continued from a previous conversation that ran out of context'),
    ).toBe(false)
    expect(looksLikePerson('Caveat: the messages below were generated by the user')).toBe(false)
    expect(looksLikePerson('ctx-mod：已换到新的上下文窗口。')).toBe(false)
  })

  test('a project thread’s wake is the person’s only when a human wrote the message behind it', () => {
    const wake = (from: string, lead = ''): string =>
      `${lead}<wake reason="mention" current-time="2026-10-12T03:41:31Z">\n  <project id="chan_1" type="project">\n    <thread ts="cmsg_1">\n      <message trigger="true" from="${from}" trust="principal" id="cmsg_2" mention="true">删a吧</message>\n    </thread>\n  </project>\n</wake>`
    expect(looksLikePerson(wake('human'), true)).toBe(true)
    // An attached file's mention comes first when the message carried one.
    expect(looksLikePerson(wake('human', '@"C:\\uploads\\handoff.md" '), true)).toBe(true)
    expect(looksLikePerson(wake('agent'), true)).toBe(false)
    expect(looksLikePerson(wake('agent', '@"C:\\uploads\\handoff.md" '), true)).toBe(false)
    // An earlier message in the thread is context; the one that triggered the wake decides.
    const quoted = wake('agent').replace('<thread ts="cmsg_1">', '<thread ts="cmsg_1">\n      <message from="human" id="cmsg_0">先看看</message>')
    expect(looksLikePerson(quoted, true)).toBe(false)
  })

  test('without a confirmed source any opening `<` is doubted, as before', () => {
    expect(looksLikePerson('<task>修一下登录页</task>')).toBe(false)
    expect(looksLikePerson('<task>修一下登录页</task>', false)).toBe(false)
  })

  test('with a confirmed source only the engine’s own envelopes and notes are ruled out', () => {
    expect(looksLikePerson('<task>修一下登录页</task>', true)).toBe(true)
    expect(looksLikePerson('<div>把这段 HTML 改一下</div>', true)).toBe(true)
    for (const name of [
      'command-name',
      'command-message',
      'command-args',
      'local-command-stdout',
      'local-command-stderr',
      'local-command-caveat',
      'task-notification',
      'system-reminder',
    ]) {
      expect(looksLikePerson(`<${name}>x</${name}>`, true)).toBe(false)
    }
    expect(looksLikePerson('<command-name>/compact</command-name>', true)).toBe(false)
    expect(looksLikePerson('ctx-mod：已换到新的上下文窗口。', true)).toBe(false)
    expect(looksLikePerson('Caveat: the messages below were generated by the user', true)).toBe(false)
    expect(looksLikePerson('This session is being continued from a previous conversation', true)).toBe(false)
    expect(looksLikePerson(openingOf(3, false), true)).toBe(false)
  })
})

describe('stripInjected', () => {
  test('drops every leading reminder block and keeps what the person wrote', () => {
    expect(stripInjected('<system-reminder>记着这一点</system-reminder>')).toBe('')
    expect(stripInjected('<system-reminder>a</system-reminder>\n\n帮我改文件')).toBe('帮我改文件')
    expect(stripInjected('<system-reminder>a</system-reminder><system-reminder>b</system-reminder> 还有事')).toBe(
      '还有事',
    )
    expect(stripInjected('  <system-reminder>a</system-reminder>  ')).toBe('')
    expect(stripInjected('把按钮改成蓝色')).toBe('把按钮改成蓝色')
    // A block that never closes leaves the text alone: what follows it is unknown.
    expect(stripInjected('<system-reminder>没有闭合')).toBe('<system-reminder>没有闭合')
    expect(stripInjected('正文在前<system-reminder>x</system-reminder>')).toBe(
      '正文在前<system-reminder>x</system-reminder>',
    )
  })
})

describe('the tool input summary', () => {
  test('survives a reload, is searchable by the command and shows in the actions', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '看看仓库状态' })
    await session.record({ uuid: 't1', role: 'tool', tool: 'Bash', input: 'git status --short', text: 'clean' })
    await session.flush()

    const reloaded = createSession(DIR, box.io, DEFAULTS)
    const found = await reloaded.historyTool({ action: 'search', query: 'status --short' })
    expect(found.result).toContain('#2 w1 tool [Bash] git status --short')

    const handoff = await reloaded.buildHandoff({ isMidTurn: false })
    expect(handoff).toContain('- #2 Bash git status --short：clean')
  })

  test('a row written before the field existed still records, searches and renders', async () => {
    const box = makeIo()
    box.files.set(
      shardPath(1),
      '{"seq":1,"uuid":"t1","ts":1,"window":1,"role":"tool","tool":"Read","path":"a.ts","text":"old body"}\n',
    )
    box.files.set(`${DIR}/meta.json`, '{"seq":1,"window":1,"part":0}')
    const session = createSession(DIR, box.io, DEFAULTS)

    expect((await session.historyTool({ action: 'search', query: 'old body' })).result).toContain('#1 w1 tool [Read] [a.ts]')
    const handoff = await session.buildHandoff({ isMidTurn: false })
    expect(handoff).toContain('- #1 Read a.ts：old body')
  })
})

describe('a session a coordinator started', () => {
  const RELAY = '<relay from="coordinator" reason="spawn">先盘点可清理的东西，列清单等确认</relay>'
  const entry = {
    task_id: 'cleanup',
    title: '清理项目',
    status: 'in_progress' as const,
    text: '盘点了一半',
    next_step: '列出清单',
  }

  test('books before any person has spoken, pointing at the hand-off', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    // As the engine files it on the person's own machine: an origin it cannot name.
    await session.record({ uuid: 'r1', role: 'user', origin: 'unclassified', text: RELAY })
    await session.record({ uuid: 't1', role: 'tool', tool: 'Glob', text: 'files' })

    expect(session.latestPersonSeq()).toBeNull()
    expect(session.latestRelaySeq()).toBe(1)
    const answer = await session.ledgerAppend(entry, env(10_000))
    expect(answer.isError).toBeUndefined()
    // The receipt says which row the entry was bound to, and that it was a default.
    expect(answer.result).toBe('已记录 #L1。对应请求 #1（转交，省略 request_ref 时取最近一条）。')
    // The hand-off may be named outright too; a tool result still may not.
    expect((await session.ledgerAppend({ ...entry, text: '继续盘点', request_ref: 1 }, env(10_000))).result).toBe('已记录 #L2。对应请求 #1（转交）。')
    expect((await session.ledgerAppend({ ...entry, request_ref: 2 }, env(10_000))).result).toContain('不是真人请求')
    await session.flush()
    expect(readLedger(box).map(one => one.request_ref)).toEqual([1, 1])
  })

  test('books with nothing to point at, and a person’s later request takes over the default', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    // No origin the engine can name and no hand-off's opening: neither a person's nor a task's source.
    await session.record({ uuid: 'r1', role: 'user', origin: 'unclassified', text: '来路不明的一行' })

    expect((await session.ledgerAppend(entry, env(10_000))).result).toBe('已记录 #L1。没有可对应的请求（request_ref 记为 0）。')
    await session.record({ uuid: 'r2', role: 'user', origin: 'coordinator', text: RELAY })
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, origin: 'composer', text: '删 a 吧' })
    expect((await session.ledgerAppend({ ...entry, text: '删了 a' }, env(10_000))).result).toContain('对应请求 #3（用户消息')
    // New work handed over after the person spoke is the latest request in its turn.
    await session.record({ uuid: 'r3', role: 'user', origin: 'coordinator', text: RELAY })
    expect((await session.ledgerAppend({ ...entry, text: '接了新活' }, env(10_000))).result).toContain('对应请求 #4（转交')
    await session.flush()
    expect(readLedger(box).map(one => one.request_ref)).toEqual([0, 3, 4])
  })

  test('the handoff carries the hand-off while its task is open or nobody has spoken', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'r1', role: 'user', origin: 'coordinator', text: RELAY })

    const bare = await session.buildHandoff({ isMidTurn: false })
    expect(bare).toContain('## 最近的用户请求\n无')
    expect(bare).toContain('## 派发来的任务')
    expect(bare).toContain('先盘点可清理的东西')

    await session.ledgerAppend(entry, env(10_000))
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '删 a 吧' })
    const open = await session.buildHandoff({ isMidTurn: false })
    expect(open).toContain('删 a 吧')
    expect(open).toContain('先盘点可清理的东西')

    await session.record({ uuid: 't1', role: 'tool', tool: 'Bash', text: 'removed' })
    await session.ledgerAppend({ ...entry, status: 'done', text: '清完了', evidence: [3], next_step: '' }, env(10_000))
    const closed = await session.buildHandoff({ isMidTurn: false })
    expect(closed).not.toContain('派发来的任务')
  })

  test('a person’s session never shows a hand-off section', async () => {
    const box = makeIo()
    const session = await freshSession(box)
    await session.record({ uuid: 'n1', role: 'user', origin: 'task-notification', text: '<task-notification>done</task-notification>' })

    expect(session.latestRelaySeq()).toBeNull()
    expect(await session.buildHandoff({ isMidTurn: false })).not.toContain('派发来的任务')
  })
})

describe('the subagent section of the handoff', () => {
  test('rides between the home page and the working set, running agents first', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '派人干活' })

    const text = await session.buildHandoff({
      isMidTurn: false,
      agents: [
        { id: 'agent-2', type: 'worker', description: '改 hooks', state: 'idle' },
        { id: 'agent-1', type: 'Explore', description: '找测试底座', state: 'running' },
      ],
    })
    expect(text).toContain('## 子代理')
    expect(text.indexOf('## 子代理')).toBeGreaterThan(text.indexOf('## 最近的用户请求'))
    expect(text.indexOf('agent-1')).toBeLessThan(text.indexOf('agent-2'))
    expect(text).toContain('- agent-1（Explore，running）：找测试底座')
    expect(text).toContain('SendMessage')

    const without = await session.buildHandoff({ isMidTurn: false })
    expect(without).not.toContain('## 子代理')
  })

  test('with the engine listing none, the noted subagents are named as ended, newest first', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.noteAgent({ id: 'agent-old', type: 'worker', description: '先做的' })
    box.advance(1_000)
    await session.noteAgent({ id: 'agent-new', type: 'Explore', description: '后做的' })

    const text = await session.buildHandoff({ isMidTurn: false, agents: [] })
    expect(text).toContain('## 子代理')
    expect(text).toContain('- agent-new（Explore，已结束）：后做的')
    expect(text).toContain('- agent-old（worker，已结束）：先做的')
    expect(text.indexOf('agent-new')).toBeLessThan(text.indexOf('agent-old'))
  })

  test('an id the engine lists and the roster holds is named once, with the engine’s state; the rest follow it', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.noteAgent({ id: 'agent-1', type: 'worker', description: '改 hooks' })
    await session.noteAgent({ id: 'agent-2', type: 'Explore', description: '找底座' })

    const text = await session.buildHandoff({
      isMidTurn: false,
      agents: [{ id: 'agent-1', type: 'worker', description: '改 hooks', state: 'running' }],
    })
    expect(text.split('\n').filter(line => line.includes('agent-'))).toEqual([
      '- agent-1（worker，running）：改 hooks',
      '- agent-2（Explore，已结束）：找底座',
    ])
  })

  test('with neither the engine nor the roster holding one, there is no subagent section', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    expect(await session.buildHandoff({ isMidTurn: false, agents: [] })).not.toContain('## 子代理')
  })
})

describe('importMessages', () => {
  const old = [
    { role: 'user' as const, text: '把解析器改严一点', toolUses: [] },
    { role: 'user' as const, text: '<system-reminder>引擎自己的提醒</system-reminder>', toolUses: [] },
    {
      role: 'assistant' as const,
      text: '解析器改好了。',
      toolUses: [
        {
          tool: 'Read',
          input: { file_path: 'src/parser.ts' },
          text: 'export const parse = () => {}',
          isError: false,
        },
      ],
    },
    { role: 'user' as const, text: '再把错误信息也换掉', toolUses: [] },
    { role: 'assistant' as const, text: '错误信息已经换掉了。', toolUses: [] },
  ]

  test('copies an old conversation in, numbering it like the rows the mod records itself', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)

    // Five messages, and the answered Read is a row of its own.
    expect(await session.importMessages(old)).toBe(6)
    await session.flush()

    const found = await session.historyTool({ action: 'search', query: '解析器改严' })
    expect(found.result).toContain('#1 w1 user')
    expect(found.result).toContain('把解析器改严一点')
    expect((await session.historyTool({ action: 'search', query: 'export const parse' })).result).toContain(
      '#4 w1 tool [Read] [src/parser.ts]',
    )
    expect(readMeta(box).seq).toBe(6)
    expect(readMeta(box).activities).toHaveLength(1)

    // The handoff carries the person's own request, never the engine's reminder.
    const handoff = await session.buildHandoff({ isMidTurn: false })
    expect(handoff).toContain('把解析器改严一点')
    expect(handoff).not.toContain('引擎自己的提醒')
  })

  test('imports once and only into a session with nothing on disk', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    expect(await session.importMessages(old)).toBe(6)
    expect(await session.importMessages(old)).toBe(0)

    // A session that already has rows files the engine messages it cannot find among them.
    const other = makeIo()
    const used = createSession(DIR, other.io, DEFAULTS)
    await used.record({ uuid: 'p1', role: 'user', isPerson: true, text: '本 mod 自己记的第一条' })
    expect(await used.importMessages(old)).toBe(6)
    expect(await used.importMessages(old)).toBe(0)
  })
})

describe('a request whose row carries an injected head', () => {
  test('counts as a person request, but the home page shows only the person’s words', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({
      uuid: 'p1',
      role: 'user',
      isPerson: true,
      text: '<system-reminder>引擎自己的开场</system-reminder>\n\n帮我改文件',
    })
    await session.ledgerAppend(
      { task_id: 't1', title: '改文件', status: 'in_progress', text: '在做', next_step: '接着做' },
      env(10_000),
    )

    const home = await session.ledgerRead({})
    expect(home.result).toContain('帮我改文件')
    expect(home.result).not.toContain('引擎自己的开场')

    const handoff = await session.buildHandoff({ isMidTurn: false })
    expect(handoff).toContain('帮我改文件')
    expect(handoff).not.toContain('引擎自己的开场')

    // The row on disk keeps the whole text: the history is still complete.
    expect((await session.historyTool({ action: 'search', query: '引擎自己的开场' })).result).toContain('#1 w1')
  })
})

describe('buildHandoff with the previous reply', () => {
  test('carries the last assistant reply when no task is running', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把按钮改成蓝色' })
    await session.record({ uuid: 'a1', role: 'assistant', text: '改好了，用的是调色板里的蓝。' })

    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text).toContain('## 上一次助手的最后回复')
    expect(text).toContain('改好了，用的是调色板里的蓝。')
  })

  test('a short request names the reply it came after, skipping what the engine delivered in between', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把按钮改成蓝色' })
    await session.record({ uuid: 'a1', role: 'assistant', text: '改好了。要不要顺手把悬停色也换掉？' })
    await session.record({ uuid: 'd1', role: 'user', door: 'delivery', text: '后台通知：任务结束' })
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '可以' })
    await session.record({ uuid: 'a2', role: 'assistant', text: '悬停色也换了。' })

    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text).toContain('  - 回复的是助手 [#2]：改好了。要不要顺手把悬停色也换掉？')
    // The first request of the session answered nothing. Only the home page is
    // counted: the decisions section repeats the reply beside the answer it settled.
    expect(text.split('## 用户已定决策')[0].split('回复的是助手')).toHaveLength(2)
    expect((await session.ledgerRead({ view: 'home' })).result).toContain('回复的是助手 [#2]')
  })

  test('a second message in a row is not pointed at the reply the first one answered', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把按钮改成蓝色' })
    await session.record({ uuid: 'a1', role: 'assistant', text: '改好了。要不要顺手把悬停色也换掉？' })
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '可以' })
    await session.record({ uuid: 't1', role: 'tool', tool: 'Edit', text: '改了 Button.tsx' })
    await session.record({ uuid: 'p3', role: 'user', isPerson: true, door: 'delivery', name: 'queued_command', text: '用深一点的蓝' })

    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text.split('## 用户已定决策')[0].split('回复的是助手 [#2]')).toHaveLength(2)
    expect(text).toContain('（回合进行中插入）用深一点的蓝')
  })

  test('leaves the section out while a task is still running', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把按钮改成蓝色' })
    await session.record({ uuid: 'a1', role: 'assistant', text: '改了一半。' })
    await session.ledgerAppend(
      { task_id: 't1', title: '改按钮', status: 'in_progress', text: '在做', next_step: '继续' },
      env(10_000),
    )

    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text).not.toContain('上一次助手的最后回复')
    expect(text).toContain('继续')
  })

  test('cuts a long reply to its last 6000 characters behind a pointer', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把按钮改成蓝色' })
    await session.record({ uuid: 'a1', role: 'assistant', text: `${'A'.repeat(7_000)}TAILMARK` })

    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text).toContain('（前文已省略，用 history 工具查看 #2）')
    expect(text).toContain('TAILMARK')
    expect(text).not.toContain('A'.repeat(6_001))
  })

  test('reads the reply back from an earlier window after a reload', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把按钮改成蓝色' })
    await session.record({ uuid: 'a1', role: 'assistant', text: '改好了。' })
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    await session.flush()

    // Only window 2 is loaded: the reply of window 1 has to be pulled back in.
    const reloaded = createSession(DIR, box.io, DEFAULTS)
    expect(await reloaded.buildHandoff({ isMidTurn: false })).toContain('改好了。')
  })
})

describe('buildHandoff with the decisions the person settled', () => {
  test('carries a decision from an earlier window after newer requests push it out of the recent list', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '以后一律用 pnpm，不要用 npm。' })
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    for (let index = 0; index < DEFAULTS.recentRequests + 1; index += 1) {
      await session.record({ uuid: `q${index}`, role: 'user', isPerson: true, text: `第 ${index} 个新请求` })
    }

    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text).toContain('## 用户已定决策')
    expect(text).toContain('以后一律用 pnpm，不要用 npm。')
    // The home page itself has moved on: the section is the only place it survives.
    expect(text.split('## 最近的用户请求')[1]?.split('## 用户已定决策')[0]).not.toContain('pnpm')
  })


  test('a decision the person took back stops being carried, and history still has it', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '不要用 npm。' })
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '以后一律用 pnpm。' })
    expect(await session.buildHandoff({ isMidTurn: false })).toContain('不要用 npm。')

    const receipt = await session.decisionRevoke({ seq: 1 })
    expect(receipt.result).toContain('已撤销 #1 的决策')
    // The home page still lists the request itself; only the decisions section drops it.
    const section = (await session.buildHandoff({ isMidTurn: false })).split('## 用户已定决策')[1] ?? ''
    expect(section).not.toContain('不要用 npm。')
    expect(section).toContain('以后一律用 pnpm。')
    // The words stay in history: only the handoff stops carrying them.
    expect((await session.historyTool({ action: 'read', seq: 1 })).result).toContain('不要用 npm。')
  })

  test('a revoke names what replaced it, survives a reload, and says when there was nothing to revoke', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '不要用 npm。' })
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '以后一律用 pnpm。' })
    await session.record({ uuid: 't1', role: 'tool', tool: 'Read', text: 'ok' })
    const replaced = await session.decisionRevoke({ seq: 1, by: 2, reason: '改用 pnpm' })
    expect(replaced.result).toContain('由 #2 取代')
    const nothing = await session.decisionRevoke({ seq: 3 })
    expect(nothing.result).toContain('没有抽取到决策')
    expect(nothing.isError).not.toBe(true)
    await session.flush()

    const reloaded = createSession(DIR, box.io, DEFAULTS)
    const section = (await reloaded.buildHandoff({ isMidTurn: false })).split('## 用户已定决策')[1] ?? ''
    expect(section).not.toContain('不要用 npm。')
    expect(section).toContain('以后一律用 pnpm。')
  })

  test('a bad seq is refused without writing anything', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '不要用 npm。' })
    const refused = await session.decisionRevoke({ seq: 'abc' })
    expect(refused.isError).toBe(true)
    expect(refused.result).toContain('seq')
    expect(box.files.has(`${DIR}/decisions.jsonl`)).toBe(false)
  })

  test('a decision from the last two windows survives a tiny budget', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, { ...DEFAULTS, decisionChars: 245 })
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '不要用方案一，这一条是较长的说明文字。' })
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '不要用方案二，这一条是较长的说明文字。' })
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接二' })
    await session.record({ uuid: 'p3', role: 'user', isPerson: true, text: '不要用方案三，这一条是较长的说明文字。' })

    const section = (await session.buildHandoff({ isMidTurn: false })).split('## 用户已定决策')[1] ?? ''
    expect(section).toContain('不要用方案三，这一条是较长的说明文字。')
    expect(section).toContain('不要用方案二，这一条是较长的说明文字。')
    expect(section).not.toContain('不要用方案一')
    expect(section).toContain('已省略 1 条')
  })

  test('a reloaded session still finds the decision in the window it no longer holds in memory', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '不要动 vite.config。' })
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '继续' })
    await session.flush()

    const reloaded = createSession(DIR, box.io, DEFAULTS)
    const text = await reloaded.buildHandoff({ isMidTurn: false })
    // Only window 2 was read when the session loaded; the decision sits in window 1.
    expect(reloaded.window()).toBe(2)
    expect(text).toContain('## 用户已定决策')
    expect(text).toContain('不要动 vite.config。')
  })
})

describe('activity', () => {
  test('queues a meta write so the last file touch survives the turn', async () => {
    const box = makeIo()
    const session = await freshSession(box)
    session.activity('Edit', { file_path: 'src/a.ts' }, 2, false)
    await session.flush()

    expect(readMeta(box).activities).toHaveLength(1)
  })

  test('the handoff shows file paths relative to the working directory while meta.json keeps them absolute', async () => {
    const box = makeIo()
    const session = createSession(DIR, { ...box.io, cwd: () => 'C:\\proj' }, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '改一下解析器' })
    await session.record({ uuid: 't1', role: 'tool', tool: 'Edit', text: 'ok', path: 'C:\\proj\\src\\a.ts' })
    session.activity('Edit', { file_path: 'C:\\proj\\src\\a.ts' }, 2, false)
    await session.flush()

    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text).toContain('路径相对工作目录 C:\\proj')
    expect(text).toContain('src\\a.ts · 读 0 次/改 1 次')
    expect(text).not.toContain('C:\\proj\\src\\a.ts')
    // The stored form is unchanged.
    expect(JSON.stringify(readMeta(box).activities)).toContain('C:\\\\proj\\\\src\\\\a.ts')
    // Without a working directory the handoff keeps the absolute path.
    const plain = createSession(DIR, box.io, DEFAULTS)
    expect(await plain.buildHandoff({ isMidTurn: false })).toContain('C:\\proj\\src\\a.ts')
  })
})

/** The roster rows as meta.json holds them. */
const rosterOf = (box: Box): Record<string, unknown>[] =>
  (readMeta(box).roster ?? []) as Record<string, unknown>[]

describe('the roster of subagents the main loop started', () => {
  test('keeps what was noted across a reload, and a repeat of an id updates its row', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.noteAgent({ id: 'a1', type: 'worker', description: '改 hooks', model: 'haiku' })
    box.advance(1_000)
    await session.noteAgent({ id: 'a2', type: 'Explore', description: '找测试底座' })
    await session.noteAgent({ id: 'a1', type: 'worker', description: '改 hooks 第二遍' })
    await session.flush()

    const rows = rosterOf(box)
    expect(rows.map(row => row.id)).toEqual(['a1', 'a2'])
    expect(rows[0]?.description).toBe('改 hooks 第二遍')
    expect(rows[0]?.model).toBeUndefined()
    expect(rows[1]?.window).toBe(1)
    expect(rows[1]?.ts).toBe(1_001_000)

    const reloaded = createSession(DIR, box.io, DEFAULTS)
    const text = await reloaded.buildHandoff({ isMidTurn: false })
    expect(text).toContain('- a1（worker，已结束）：改 hooks 第二遍')
    expect(text).toContain('- a2（Explore，已结束）：找测试底座')
  })

  test('agentEnded tags a noted row once, and an id never noted writes nothing', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.noteAgent({ id: 'a1', type: 'worker', description: '改 hooks' })
    await session.flush()
    const before = box.files.get(`${DIR}/meta.json`)

    await session.agentEnded('ghost')
    await session.flush()
    expect(box.files.get(`${DIR}/meta.json`)).toBe(before)

    await session.agentEnded('a1')
    await session.flush()
    expect(rosterOf(box)[0]?.ended).toBe(true)
    expect(box.files.get(`${DIR}/meta.json`)).not.toBe(before)

    const again = box.files.get(`${DIR}/meta.json`)
    await session.agentEnded('a1')
    await session.flush()
    expect(box.files.get(`${DIR}/meta.json`)).toBe(again)
  })

  test('a repeat of a noted id clears its ended tag', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.noteAgent({ id: 'a1', type: 'worker', description: '改 hooks' })
    await session.agentEnded('a1')
    await session.noteAgent({ id: 'a1', type: 'worker', description: '续用' })
    await session.flush()
    expect(rosterOf(box)[0]?.ended).toBeUndefined()
  })

  test('keeps the newest fifty and drops the oldest', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    for (let i = 1; i <= 51; i += 1) {
      await session.noteAgent({ id: `a${i}`, type: 'worker', description: `任务${i}` })
    }
    await session.flush()

    const ids = rosterOf(box).map(row => row.id)
    expect(ids).toHaveLength(50)
    expect(ids[0]).toBe('a2')
    expect(ids[ids.length - 1]).toBe('a51')
  })

  test('a meta.json from before the roster opens with an empty one, and a damaged row is dropped alone', async () => {
    const box = makeIo()
    box.files.set(`${DIR}/meta.json`, JSON.stringify({ window: 1, seq: 0, lastPrefix: null }))
    const session = createSession(DIR, box.io, DEFAULTS)
    expect(session.window()).toBe(1)
    expect(await session.buildHandoff({ isMidTurn: false })).not.toContain('## 子代理')

    box.files.set(
      `${DIR}/meta.json`,
      JSON.stringify({
        window: 1,
        roster: [
          { id: 'ok', type: 'worker', description: '完好的一行', window: 1, ts: 5 },
          { id: 3, type: 'worker', description: 'id 不是文本', window: 1, ts: 5 },
          'not a row',
          { id: 'bad-window', type: 'worker', description: '窗口不是数', window: '1', ts: 5 },
        ],
      }),
    )
    const reloaded = createSession(DIR, box.io, DEFAULTS)
    const text = await reloaded.buildHandoff({ isMidTurn: false })
    expect(text).toContain('- ok（worker，已结束）：完好的一行')
    expect(text).not.toContain('bad-window')
    expect(text.split('\n').filter(line => line.startsWith('- ')).length).toBe(1)
  })
})

describe('isLedgerFresh and lastRequestAt', () => {
  test('is stale until an entry lands after the latest person prompt', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)

    expect(session.isLedgerFresh()).toBe(false)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '开始' })
    expect(session.isLedgerFresh()).toBe(false)
    await session.ledgerAppend(
      { task_id: 't1', title: '做事情', status: 'in_progress', text: '在做', next_step: '接着做' },
      env(10_000),
    )
    expect(session.isLedgerFresh()).toBe(true)

    // A later person prompt outruns the entry: the ledger is stale again.
    box.advance(1_000)
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '换个事情' })
    expect(session.isLedgerFresh()).toBe(false)
    await session.ledgerAppend(
      { task_id: 't2', title: '新任务', status: 'in_progress', text: '在做新的', next_step: '接着做' },
      env(10_000),
    )
    expect(session.isLedgerFresh()).toBe(true)
  })

  test('gives the time noteRequest last stamped, and null before the first', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)

    expect(session.lastRequestAt()).toBeNull()
    session.noteRequest()
    expect(session.lastRequestAt()).toBe(1_000_000)
    box.advance(2_500)
    session.noteRequest()
    expect(session.lastRequestAt()).toBe(1_002_500)
  })

  test('the time of the last request survives a reload, so a reopened session still sees its cache go cold', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.ready()
    session.noteRequest()
    await session.flush()

    const reopened = createSession(DIR, box.io, DEFAULTS)
    await reopened.ready()
    expect(reopened.lastRequestAt()).toBe(1_000_000)
  })
})

describe('a write that never lands', () => {
  test('an archive page that failed to write says so when it is read', async () => {
    const files = new Map<string, string>()
    const io: Io = {
      read: async path => {
        const text = files.get(path)
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return text
      },
      write: async (path, text) => {
        if (path.includes('archive-')) throw new Error('write refused')

        files.set(path, text)
      },
      now: () => 1_000_000,
    }
    const config: Config = { ...DEFAULTS, pageTokens: 100, recentRequests: 0 }
    const session = createSession(DIR, io, config)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '第一个请求' })
    await session.record({ uuid: 't1', role: 'tool', tool: 'Edit', path: 'src/a.ts', text: 'edited ok' })
    await session.ledgerAppend(
      {
        task_id: 'old-task',
        title: '早先完成的任务',
        status: 'done',
        text: '说明文字'.repeat(30),
        evidence: [2],
        request_ref: 1,
      },
      env(10_000),
    )
    await session.commitSwitch({ trigger: 'auto', tokensBefore: 90_000, handoffText: '交接' })
    await session.flush()

    // The page never landed, so it is not listed at all and the entries stay in the ledger.
    const answer = await session.ledgerRead({ view: 'archive:1' })
    expect(answer.isError).toBe(true)
    expect(answer.result).toContain('没有找到归档页')
    expect((await session.ledgerRead({ view: 'current' })).result).toContain('old-task')
    expect((await session.ledgerRead({ view: 'archive:9' })).result).toContain('没有找到归档页')
  })
})

describe('status', () => {
  test('shows the fill, the window and the counters', async () => {
    const box = makeIo()
    const session = await freshSession(box)
    await session.ledgerAppend(
      { task_id: 'open-1', title: '进行中的任务', status: 'in_progress', text: '在做', next_step: '接着做' },
      env(10_000),
    )
    session.noteRequest()
    const line = session.status(env(50_000, 100_000))
    expect(line).toContain('ctx 50% · 50k/100k · w1')
    expect(line).toContain('距上次换窗口 1 次请求')
    expect(line).toContain('本小时已换窗口 0 次')
    expect(line).toContain('进行中任务 1 个')
  })
})

type Usage = { input: number; read: number; write: number }

/** A ToolSearch row that loaded `loaded`, as the register records it. */
const loadRow = async (session: Session, loaded: string[]): Promise<void> => {
  await session.record({ uuid: 'ts', role: 'tool', tool: 'ToolSearch', loaded, text: `已加载：${loaded.join('、')}` })
}

/** One deferred load, judged the way the register judges it: the request before it, the load, the request after it. */
const judgeLoad = async (session: Session, before: Usage, loaded: string[], after: Usage): Promise<void> => {
  await session.noteStep(before)
  await loadRow(session, loaded)
  await session.noteStep(after)
}

describe('the loads that rebuilt the cache', () => {
  test('a load whose next request read far less is recorded with the tokens that request wrote', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await judgeLoad(
      session,
      { input: 0, read: 234_264, write: 0 },
      ['mcp__computer-use__screenshot'],
      { input: 0, read: 50_621, write: 202_702 },
    )
    await session.flush()
    expect(readMeta(box).costlyLoads).toEqual({ 'mcp__computer-use__*': 202_702 })
  })

  test('a smaller window that a load rebuilt is recorded too', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await judgeLoad(session, { input: 0, read: 0, write: 63_181 }, ['WebSearch'], { input: 0, read: 50_714, write: 28_616 })
    await session.flush()
    expect(readMeta(box).costlyLoads).toEqual({ WebSearch: 28_616 })
  })

  test('a load whose next request still read nearly the whole context is not recorded', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await judgeLoad(
      session,
      { input: 0, read: 221_207, write: 0 },
      ['mcp__computer-use__screenshot'],
      { input: 0, read: 221_205, write: 7_531 },
    )
    await session.flush()
    expect(readMeta(box).costlyLoads).toEqual({})
  })

  test('only the first load of a group in a window can rebuild, so a later one keeps the first measure', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await judgeLoad(
      session,
      { input: 0, read: 234_264, write: 0 },
      ['mcp__computer-use__screenshot'],
      { input: 0, read: 50_621, write: 202_702 },
    )
    await judgeLoad(
      session,
      { input: 0, read: 253_323, write: 0 },
      ['mcp__computer-use__click'],
      { input: 0, read: 253_000, write: 100 },
    )
    await session.flush()
    expect(readMeta(box).costlyLoads).toEqual({ 'mcp__computer-use__*': 202_702 })
  })

  test('a request that follows two groups loaded in one step is not blamed on either', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await judgeLoad(
      session,
      { input: 0, read: 234_264, write: 0 },
      ['mcp__computer-use__screenshot', 'WebFetch'],
      { input: 0, read: 50_621, write: 202_702 },
    )
    await session.flush()
    expect(readMeta(box).costlyLoads).toEqual({})
    expect(session.costlyGroups()).toEqual({})
    expect(box.files.has('/costly.json')).toBe(false)
  })

  test('a request with no load pending only moves the context on, and the next load is judged against it', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.noteStep({ input: 0, read: 100_000, write: 0 })
    await session.noteStep({ input: 0, read: 90_000, write: 0 })
    await loadRow(session, ['WebFetch'])
    // Against 90k this read is no rebuild; against the 100k before that it would have been one.
    await session.noteStep({ input: 0, read: 85_000, write: 1_000 })
    await session.flush()
    expect(readMeta(box).costlyLoads).toEqual({})
  })

  test('the first request of a new window judges no load, whatever the window before it held', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.noteStep({ input: 0, read: 100_000, write: 0 })
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 100_000, handoffText: '交接' })
    await loadRow(session, ['mcp__computer-use__screenshot'])
    await session.noteStep({ input: 0, read: 1_000, write: 50_000 })
    await session.flush()
    expect(readMeta(box).costlyLoads).toEqual({})
  })

  test('an old meta.json opens with no costly loads, and a damaged entry is dropped alone', async () => {
    const old = makeIo()
    old.files.set(`${DIR}/meta.json`, JSON.stringify({ window: 1, seq: 0, lastPrefix: null }))
    const fromOld = createSession(DIR, old.io, DEFAULTS)
    expect(fromOld.window()).toBe(1)
    await judgeLoad(fromOld, { input: 0, read: 100_000, write: 0 }, ['WebFetch'], { input: 0, read: 40_000, write: 60_000 })
    await fromOld.flush()
    expect(readMeta(old).costlyLoads).toEqual({ WebFetch: 60_000 })

    const damaged = makeIo()
    damaged.files.set(
      `${DIR}/meta.json`,
      JSON.stringify({
        window: 1,
        seq: 0,
        lastPrefix: null,
        costlyLoads: { ok: 9_000, zero: 0, negative: -3, text: 'x', missing: null },
      }),
    )
    const reloaded = createSession(DIR, damaged.io, DEFAULTS)
    await judgeLoad(reloaded, { input: 0, read: 100_000, write: 0 }, ['WebSearch'], { input: 0, read: 40_000, write: 60_000 })
    await reloaded.flush()
    expect(readMeta(damaged).costlyLoads).toEqual({ ok: 9_000, WebSearch: 60_000 })
  })
})

describe('the deferred tools a rebuild made costly, in the handoff', () => {
  /** A window with a person's request and a screenshot whose load rebuilt the cache (117386 written again). */
  const rebuiltScreenshot = async (session: Session): Promise<void> => {
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '抓一个网页，再截图' })
    await session.noteStep({ input: 6, read: 0, write: 150_000 })
    await loadRow(session, ['mcp__computer-use__screenshot'])
    await session.noteStep({ input: 0, read: 50_714, write: 117_386 })
    await session.record({ uuid: 'c1', role: 'tool', tool: 'mcp__computer-use__screenshot', text: '截图' })
  }

  test('with no load measured as a rebuild the handoff has no such section', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '抓一个网页' })
    await loadRow(session, ['WebFetch'])
    await session.record({ uuid: 'c1', role: 'tool', tool: 'WebFetch', text: 'page body' })

    expect(await session.buildHandoff({ isMidTurn: false })).not.toContain('加载时会重建缓存的延迟工具')
  })

  test('only the groups a rebuild made costly are named, with what they rewrote', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await rebuiltScreenshot(session)
    // WebFetch is loaded and used too, but its load reads nearly the whole context: not costly.
    await loadRow(session, ['WebFetch'])
    await session.noteStep({ input: 0, read: 168_000, write: 100 })
    await session.record({ uuid: 'c2', role: 'tool', tool: 'WebFetch', text: 'page' })

    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text).toContain('## 加载时会重建缓存的延迟工具')
    expect(text).toContain('- mcp__computer-use__*（上个窗口调用 1 次；上次加载后重写了约 11.7 万 token）')
    expect(text).not.toContain('- WebFetch（上个窗口调用')
  })

  test('the costly loads survive a reload, so a window after a restart still names them', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await rebuiltScreenshot(session)
    await session.flush()

    const reloaded = createSession(DIR, box.io, DEFAULTS)
    const text = await reloaded.buildHandoff({ isMidTurn: false })
    expect(text).toContain('- mcp__computer-use__*（上个窗口调用 1 次；上次加载后重写了约 11.7 万 token）')
  })
})

const DAY_MS = 24 * 3_600_000
const SHARED_PATH = '/costly.json'

/** The groups of the cross-session table as the file holds them, or none when there is no file. */
const groupsOf = (box: Box): Record<string, Record<string, number>> =>
  (JSON.parse(box.files.get(SHARED_PATH) ?? '{"groups":{}}') as { groups: Record<string, Record<string, number>> }).groups

/** The file a session writes its own cross-session measures to: one per session, beside the older table. */
const ownPath = (name: string): string => `/costly/${name}.json`

/** The groups in one session's own file, or none when it has not written one. */
const measuresOf = (box: Box, name: string): Record<string, unknown> =>
  (JSON.parse(box.files.get(ownPath(name)) ?? '{"groups":{}}') as { groups: Record<string, unknown> }).groups

const COMPUTER_READ = { input: 0, read: 234_264, write: 0 }
const COMPUTER_AFTER = { input: 0, read: 50_621, write: 202_702 }

describe('the cross-session costly table', () => {
  test('a group measured in one session is known to another under the same mod directory', async () => {
    const box = makeIo()
    const first = createSession(DIR, box.io, DEFAULTS)
    await judgeLoad(first, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER)
    await first.flush()
    expect(JSON.parse(box.files.get(ownPath('ctx')) ?? '{}')).toEqual({
      version: 1,
      groups: { 'mcp__computer-use__*': { write: 202_702, context: 234_264, at: 1_000_000 } },
    })

    // '/other' and '/ctx' both have the parent '/', so they read the same measures.
    const second = createSession('/other', box.io, DEFAULTS)
    await second.ready()
    expect(second.costlyGroups()).toEqual({ 'mcp__computer-use__*': 202_702 })
  })

  test('the newest measure of a group wins, whichever session wrote it, and a session keeps its own until it measures again', async () => {
    const box = makeIo()
    const first = createSession(DIR, box.io, DEFAULTS)
    await judgeLoad(first, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER)
    await first.flush()
    // Another session measured the same group later, with a lower rewrite.
    box.files.set(
      ownPath('other'),
      JSON.stringify({ version: 1, groups: { 'mcp__computer-use__*': { write: 100_000, context: 150_000, at: 1_005_000 } } }),
    )
    // A session that measured nothing itself sees the newer figure.
    const third = createSession('/third', box.io, DEFAULTS)
    await third.ready()
    expect(third.costlyGroups()).toEqual({ 'mcp__computer-use__*': 100_000 })
    // The measuring session keeps its own figure: its meta.json carries it across a reload.
    const reloaded = createSession(DIR, box.io, DEFAULTS)
    await reloaded.ready()
    expect(reloaded.costlyGroups()).toEqual({ 'mcp__computer-use__*': 202_702 })
    expect(first.costlyGroups()).toEqual({ 'mcp__computer-use__*': 202_702 })
  })

  test('a measure older than thirty days is ignored, and a rebuild that happens again is recorded again', async () => {
    const box = makeIo()
    box.files.set(
      ownPath('other'),
      JSON.stringify({
        version: 1,
        groups: {
          'mcp__computer-use__*': { write: 117_386, context: 150_006, at: 1_000_000 - 30 * DAY_MS - 1 },
          WebFetch: { write: 60_000, context: 150_000, at: 1_000_000 - 30 * DAY_MS },
        },
      }),
    )
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.ready()
    // Exactly thirty days is still inside the window; one millisecond past it is not.
    expect(session.costlyGroups()).toEqual({ WebFetch: 60_000 })

    await judgeLoad(session, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER)
    await session.flush()
    expect(session.costlyGroups()).toEqual({ WebFetch: 60_000, 'mcp__computer-use__*': 202_702 })
    expect(measuresOf(box, 'ctx')['mcp__computer-use__*']).toEqual({ write: 202_702, context: 234_264, at: 1_000_000 })
  })

  test('a session that runs past thirty days drops its own stale measure when it writes again', async () => {
    const box = makeIo()
    box.files.set(ownPath('ctx'), JSON.stringify({ version: 1, groups: { WebFetch: { write: 60_000, context: 150_000, at: 1_000_000 } } }))
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.ready()
    box.advance(30 * DAY_MS + 1)
    await judgeLoad(session, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER)
    await session.flush()
    expect(Object.keys(measuresOf(box, 'ctx'))).toEqual(['mcp__computer-use__*'])
  })

  test('a session file that is not JSON is left as it is, the failure is reported, and the session still counts its own measure', async () => {
    const box = makeIo()
    box.files.set(ownPath('ctx'), '{ not json')
    const reported: string[] = []
    const session = createSession(DIR, { ...box.io, onWriteError: path => reported.push(path) }, DEFAULTS)
    await session.ready()
    expect(session.costlyGroups()).toEqual({})
    expect((await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '你好' })).seq).toBe(1)

    await judgeLoad(session, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER)
    await session.flush()
    // The file could not be trusted, so it is left byte for byte as it was; the failure is reported, not thrown.
    expect(box.files.get(ownPath('ctx'))).toBe('{ not json')
    expect(reported).toContain(ownPath('ctx'))
    expect(session.costlyGroups()).toEqual({ 'mcp__computer-use__*': 202_702 })
    expect(session.unsaved()).toEqual([])
  })

  test('the older shared table is only read: a damaged one is skipped and never written', async () => {
    const box = makeIo()
    box.files.set(SHARED_PATH, '{ not json')
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.ready()
    expect(session.costlyGroups()).toEqual({})

    await judgeLoad(session, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER)
    await session.flush()
    expect(box.files.get(SHARED_PATH)).toBe('{ not json')
    expect(session.costlyGroups()).toEqual({ 'mcp__computer-use__*': 202_702 })
  })

  test('recording a group writes only this session’s file, so another session’s measures stay as they are', async () => {
    const box = makeIo()
    const first = createSession(DIR, box.io, DEFAULTS)
    await first.ready()
    // Written after `first` loaded: only a read of the directory can see it, and only this session’s file is written by `first`.
    const other = createSession('/other', box.io, DEFAULTS)
    await judgeLoad(other, { input: 0, read: 100_000, write: 0 }, ['WebFetch'], { input: 0, read: 40_000, write: 60_000 })
    await other.flush()

    await judgeLoad(first, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER)
    await first.flush()
    expect(measuresOf(box, 'other')).toEqual({ WebFetch: { write: 60_000, context: 100_000, at: 1_000_000 } })
    expect(Object.keys(measuresOf(box, 'ctx'))).toEqual(['mcp__computer-use__*'])
  })
})

describe('the cross-session measures under concurrent sessions and failed reads', () => {
  /** A box whose engine can rename, as a temp file written and renamed over the session file needs. */
  const renamingBox = () => {
    const box = makeIo()
    const calls = { renamed: [] as string[] }
    const io: Io = {
      ...box.io,
      rename: async (from, to) => {
        calls.renamed.push(`${from} -> ${to}`)
        const text = box.files.get(from)
        if (text === undefined) throw new Error('ENOENT')
        box.files.set(to, text)
        box.files.delete(from)
      },
      remove: async path => {
        box.files.delete(path)
      },
    }

    return { box, io, calls }
  }

  test('two sessions measuring different groups at the same time both land, each in its own file', async () => {
    const box = makeIo()
    const first = createSession(DIR, box.io, DEFAULTS)
    const second = createSession('/other', box.io, DEFAULTS)
    await Promise.all([
      judgeLoad(first, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER),
      judgeLoad(second, { input: 0, read: 100_000, write: 0 }, ['WebFetch'], { input: 0, read: 40_000, write: 60_000 }),
    ])
    await Promise.all([first.flush(), second.flush()])

    expect(Object.keys(measuresOf(box, 'ctx'))).toEqual(['mcp__computer-use__*'])
    expect(Object.keys(measuresOf(box, 'other'))).toEqual(['WebFetch'])
    const reloaded = createSession(DIR, box.io, DEFAULTS)
    await reloaded.ready()
    expect(reloaded.costlyGroups()).toEqual({ 'mcp__computer-use__*': 202_702, WebFetch: 60_000 })
  })

  test('a session file is written through a temp file renamed over it, and no temp file is left behind', async () => {
    const { box, io, calls } = renamingBox()
    const session = createSession(DIR, io, DEFAULTS)
    await judgeLoad(session, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER)
    await session.flush()

    expect(calls.renamed).toHaveLength(1)
    expect(calls.renamed[0]).toMatch(/^\/costly\/ctx\.json\..+\.tmp -> \/costly\/ctx\.json$/)
    expect(Object.keys(measuresOf(box, 'ctx'))).toEqual(['mcp__computer-use__*'])
    expect([...box.files.keys()].some(path => path.endsWith('.tmp'))).toBe(false)
  })

  test('a session file that fails to read is not an empty one: it stays as it was, the failure is reported, the measure is not recorded', async () => {
    const box = makeIo()
    box.files.set(ownPath('ctx'), JSON.stringify({ version: 1, groups: { WebFetch: { write: 60_000, context: 100_000, at: 999_000 } } }))
    const original = box.files.get(ownPath('ctx'))
    const reported: string[] = []
    const failing: Io = {
      ...box.io,
      read: async path => {
        if (path === ownPath('ctx')) throw new Error('EBUSY: resource busy or locked')

        return box.io.read(path)
      },
      exists: async () => true,
      onWriteError: path => reported.push(path),
    }
    const session = createSession(DIR, failing, DEFAULTS)
    await session.ready()
    await judgeLoad(session, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER)
    await session.flush()

    expect(box.files.get(ownPath('ctx'))).toBe(original)
    expect(reported).toContain(ownPath('ctx'))
    // The session still counts its own measure; the file simply does not carry it.
    expect(session.costlyGroups()).toEqual({ 'mcp__computer-use__*': 202_702 })
  })

  test('a read that fails and that the engine says is a missing file is written as a new file', async () => {
    const box = makeIo()
    const failing: Io = {
      ...box.io,
      read: async () => {
        throw new Error('ENOENT: no such file')
      },
      exists: async () => false,
    }
    const session = createSession(DIR, failing, DEFAULTS)
    await judgeLoad(session, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER)
    await session.flush()

    expect(box.files.get(ownPath('ctx'))).toContain('mcp__computer-use__*')
  })

  test('a session writes without any lock file, so it never waits on another session', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await judgeLoad(session, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER)
    await session.flush()

    expect([...box.files.keys()].filter(path => path.includes('.lock'))).toEqual([])
  })

  test('a write that fails after the temp file is written leaves the session file alone, and the temp file is removed', async () => {
    const box = makeIo()
    const original = JSON.stringify({ version: 1, groups: { WebFetch: { write: 60_000, context: 100_000, at: 999_000 } } })
    box.files.set(ownPath('ctx'), original)
    const reported: string[] = []
    const io: Io = {
      ...box.io,
      rename: async () => {
        throw new Error('EPERM: operation not permitted')
      },
      remove: async path => {
        box.files.delete(path)
      },
      onWriteError: path => reported.push(path),
    }
    const session = createSession(DIR, io, DEFAULTS)
    await session.ready()
    await judgeLoad(session, COMPUTER_READ, ['mcp__computer-use__screenshot'], COMPUTER_AFTER)
    await session.flush()

    expect(box.files.get(ownPath('ctx'))).toBe(original)
    expect([...box.files.keys()].some(path => path.endsWith('.tmp'))).toBe(false)
    expect(reported).toContain(ownPath('ctx'))
  })
})

describe('the gate on a load that rebuilds the cache', () => {
  const SHOT = 'select:mcp__computer-use__screenshot'
  const MEASURED_READ = { input: 0, read: 150_006, write: 0 }
  const MEASURED_AFTER = { input: 0, read: 50_714, write: 117_386 }

  /** A session whose table holds the computer-use group, measured in window 1, now in window 2 with no load yet. */
  const measuredElsewhere = async (box: Box, dir = DIR): Promise<Session> => {
    const session = createSession(dir, box.io, DEFAULTS)
    await judgeLoad(session, MEASURED_READ, ['mcp__computer-use__screenshot'], MEASURED_AFTER)
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 150_006, handoffText: '交接' })

    return session
  }

  /** The measured window, plus a fresh ledger entry in this one, so a switch is only held by the cooldown or the gate. */
  const windowWithLedger = async (box: Box): Promise<Session> => {
    const session = await measuredElsewhere(box)
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '继续截图' })
    box.advance(1_000)
    await session.ledgerAppend({ task_id: 'shot', title: '截图', status: 'in_progress', text: '在做', next_step: '接着做' }, env(10_000))

    return session
  }

  test('a context at or below the gate, or unknown, lets the load through', async () => {
    const box = makeIo()
    const session = await measuredElsewhere(box)
    expect(session.gateLoad(SHOT, DEFAULTS.gateMinTokens)).toBeNull()
    expect(session.gateLoad(SHOT, undefined)).toBeNull()
    expect(session.gateLoad(42, 200_000)).toBeNull()
  })

  test('a load past the gate is held back, naming the group, its rewrite and the context', async () => {
    const box = makeIo()
    const session = await measuredElsewhere(box)
    const text = session.gateLoad(SHOT, 152_006)
    expect(text).toContain('先不加载：加载 mcp__computer-use__* 会让整段对话的缓存重建（上次加载后重写了约 11.7 万 token），当前上下文 152k。')
    expect(text).toContain('换窗后第一步用 ToolSearch 加载 mcp__computer-use__*')
  })

  test('a group is held back once per window, and a group no table names is never held back', async () => {
    const box = makeIo()
    const session = await measuredElsewhere(box)
    expect(session.gateLoad(SHOT, 152_006)).not.toBeNull()
    expect(session.gateLoad(SHOT, 152_006)).toBeNull()
    expect(session.gateLoad('select:WebSearch', 152_006)).toBeNull()
  })

  test('a group this window already loaded is not held back', async () => {
    const box = makeIo()
    const session = await measuredElsewhere(box)
    await loadRow(session, ['mcp__computer-use__screenshot'])
    expect(session.gateLoad(SHOT, 152_006)).toBeNull()
  })

  test('a new window may hold the same group back again', async () => {
    const box = makeIo()
    const session = await measuredElsewhere(box)
    expect(session.gateLoad(SHOT, 152_006)).not.toBeNull()
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 152_006, handoffText: '交接' })
    expect(session.gateLoad(SHOT, 152_006)).not.toBeNull()
  })

  test('a switch made in front of a held-back load is approved at once, where the same switch without one is cooled down', async () => {
    const held = await windowWithLedger(makeIo())
    expect(held.gateLoad(SHOT, 152_006)).not.toBeNull()
    const approved = held.requestSwitch({}, env(160_000, 1_000_000))
    expect(approved.isError).toBeUndefined()
    expect(approved.result).toContain('已批准换窗口')

    const plain = await windowWithLedger(makeIo())
    const refused = plain.requestSwitch({}, env(160_000, 1_000_000))
    expect(refused.isError).toBe(true)
    expect(refused.result).toContain('冷却门槛')
  })

  test('the hourly cap refuses the switch even in front of a held-back load', async () => {
    const box = makeIo()
    const session = await windowWithLedger(box)
    for (let i = 0; i < DEFAULTS.maxSwitchesPerHour; i += 1) {
      await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    }
    await session.record({ uuid: 'p3', role: 'user', isPerson: true, text: '再来一次' })
    box.advance(1_000)
    await session.ledgerAppend({ task_id: 'shot', title: '截图', status: 'in_progress', text: '在做', next_step: '接着做' }, env(10_000))

    expect(session.gateLoad(SHOT, 152_006)).not.toBeNull()
    const refused = session.requestSwitch({}, env(160_000, 1_000_000))
    expect(refused.isError).toBe(true)
    expect(refused.result).toContain('达到上限')
  })

  test('a load the model makes itself clears the hold: no bypass for the next switch, and no reason in the handoff', async () => {
    const box = makeIo()
    const session = await windowWithLedger(box)
    expect(session.gateLoad(SHOT, 152_006)).not.toBeNull()
    await loadRow(session, ['mcp__computer-use__screenshot'])

    expect(await session.buildHandoff({ isMidTurn: false })).not.toContain('## 这次换窗口的原因')
    const refused = session.requestSwitch({}, env(160_000, 1_000_000))
    expect(refused.isError).toBe(true)
    expect(refused.result).toContain('冷却门槛')
  })

  test('a switch made after a held-back load names the group in the handoff, and the next window does not', async () => {
    const box = makeIo()
    const session = await windowWithLedger(box)
    expect(session.gateLoad(SHOT, 152_006)).not.toBeNull()
    expect(session.requestSwitch({}, env(160_000, 1_000_000)).result).toContain('已批准换窗口')

    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text).toContain('## 这次换窗口的原因')
    expect(text).toContain('换窗口是为了加载 mcp__computer-use__*：第一步先用一次 ToolSearch 加载它，再继续账本里的下一步。')
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 160_000, handoffText: text })
    expect(await session.buildHandoff({ isMidTurn: false })).not.toContain('## 这次换窗口的原因')
  })
})


describe('writes that fail', () => {
  /** A box whose writes throw while `failing` says so; `reported` collects the paths `onWriteError` heard of. */
  const flaky = (failing: (path: string) => boolean = () => true) => {
    const box = makeIo()
    const control = { failing, reported: [] as string[], throwInReporter: false }
    const io: Io = {
      ...box.io,
      write: async (path, text) => {
        if (control.failing(path)) throw new Error('EIO')
        await box.io.write(path, text)
      },
      onWriteError: path => {
        control.reported.push(path)
        if (control.throwInReporter) throw new Error('reporter broke')
      },
    }

    return { box, control, io }
  }

  const entry = {
    task_id: 't1',
    title: '改按钮',
    status: 'in_progress',
    text: '开始改',
    next_step: '继续',
  }

  test('ledger_append still answers, says the ledger is not on disk and is not an error; flush returns', async () => {
    const { box, io } = flaky()
    const session = createSession(DIR, io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把登录页的按钮改成蓝色' })
    const answer = await session.ledgerAppend(entry, env(10_000))

    expect(answer.isError).toBeUndefined()
    expect(answer.result).toContain('已记录 #L1')
    expect(answer.result).toContain('没能写进磁盘')
    await session.flush()
    expect(session.unsaved()).toEqual([segmentName(1, 1), 'ledger.jsonl', 'meta.json'].sort())
    expect(box.files.size).toBe(0)
  })

  test('the cross-session file failing to write is reported but is not one of the session files', async () => {
    const { control, io } = flaky(path => path === '/costly/ctx.json')
    const session = createSession(DIR, io, DEFAULTS)
    await session.noteStep({ input: 6, read: 150_000, write: 0 })
    await session.record({
      uuid: 't1',
      role: 'tool',
      tool: 'ToolSearch',
      text: 'loaded',
      loaded: ['mcp__computer-use__screenshot'],
    })
    await session.noteStep({ input: 6, read: 50_714, write: 117_386 })
    await session.flush()

    expect(control.reported).toContain('/costly/ctx.json')
    // The table is not what a new window is rebuilt from, so it never blocks a switch.
    expect(session.unsaved()).toEqual([])
  })

  test('once writes work again flush retries, and the disk matches the memory', async () => {
    const { box, control, io } = flaky()
    const session = createSession(DIR, io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把登录页的按钮改成蓝色' })
    await session.ledgerAppend(entry, env(10_000))
    await session.flush()
    expect(session.unsaved()).toHaveLength(3)

    control.failing = () => false
    await session.flush()
    expect(session.unsaved()).toEqual([])
    expect(windowRows(box, 1).map(row => row.seq)).toEqual([1])
    expect(readLedger(box).map(one => one.task_id)).toEqual(['t1'])
    expect(readMeta(box).window).toBe(1)
  })

  test('the retry does not put old text over a newer write', async () => {
    const { box, control, io } = flaky()
    const session = createSession(DIR, io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把登录页的按钮改成蓝色' })
    await session.ledgerAppend(entry, env(10_000))
    control.failing = () => false
    await session.ledgerAppend({ ...entry, text: '第二次' }, env(10_000))
    await session.flush()

    expect(readLedger(box).map(one => one.text)).toEqual(['开始改', '第二次'])
    expect(session.unsaved()).toEqual([])
  })

  test('onWriteError hears the path of a failed write, and its own failure changes nothing', async () => {
    const { control, io } = flaky()
    control.throwInReporter = true
    const session = createSession(DIR, io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把登录页的按钮改成蓝色' })
    const answer = await session.ledgerAppend(entry, env(10_000))

    expect(answer.result).toContain('没能写进磁盘')
    expect(control.reported).toContain(`${DIR}/ledger.jsonl`)
    expect(session.unsaved()).toContain('ledger.jsonl')
  })

  test('status mentions the unsaved files and stops once they are written', async () => {
    const { control, io } = flaky()
    const session = createSession(DIR, io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把登录页的按钮改成蓝色' })
    await session.ledgerAppend(entry, env(10_000))

    expect(session.status(env(10_000))).toMatch(/ · 有 \d+ 个文件没写进磁盘$/)
    control.failing = () => false
    await session.flush()
    expect(session.status(env(10_000))).not.toContain('没写进磁盘')
  })

  test('a failing archive page keeps the entries in the ledger, and the next switch archives them', async () => {
    const { box, control, io } = flaky(path => path.endsWith('archive-001.jsonl'))
    const config: Config = { ...DEFAULTS, pageTokens: 100, recentRequests: 2 }
    const session = createSession(DIR, io, config)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '第一个请求' })
    await session.record({ uuid: 't1', role: 'tool', tool: 'Edit', path: 'src/app.ts', text: 'edited ok' })
    await session.ledgerAppend(
      { task_id: 'old-done', title: '早先完成的任务', status: 'done', text: '说明文字'.repeat(30), evidence: [2], request_ref: 1 },
      env(10_000),
    )
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '第二个请求' })
    await session.record({ uuid: 'p3', role: 'user', isPerson: true, text: '第三个请求' })
    await session.ledgerAppend(
      { task_id: 'open-1', title: '进行中的任务', status: 'in_progress', text: '在做', next_step: '接着做' },
      env(10_000),
    )
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    await session.flush()

    expect(readLedger(box).map(one => one.task_id)).toEqual(['old-done', 'open-1'])
    expect(readMeta(box).archive).toEqual([])
    expect(box.files.has(`${DIR}/archive-001.jsonl`)).toBe(false)
    expect(readMeta(box).window).toBe(2)

    control.failing = () => false
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接二' })
    await session.flush()
    expect(readLedger(box, 'archive-001.jsonl').map(one => one.task_id)).toEqual(['old-done'])
    expect(readLedger(box).map(one => one.task_id)).toEqual(['open-1'])
    expect((readMeta(box).archive as unknown[]).length).toBe(1)
  })
})


describe('the ledger entry a session stores', () => {
  const anchor = { path: 'src/a.ts', match: 'const a = 1', note: '这里' }
  const base = { task_id: 't1', title: '改文件', status: 'in_progress', text: '在做' }

  test('records how far the history reached, and refuses an empty text or a missing next step', async () => {
    const box = makeIo()
    const session = await freshSession(box)
    expect((await session.ledgerAppend({ ...base, text: '  ', next_step: '继续' }, env(10_000))).isError).toBe(true)
    const noStep = await session.ledgerAppend(base, env(10_000))
    expect(noStep.isError).toBe(true)
    expect(noStep.result).toContain('必须写 next_step')

    await session.ledgerAppend({ ...base, next_step: '继续' }, env(10_000))
    await session.flush()
    expect(readLedger(box)[0]?.through).toBe(2)
  })

  test('an omitted next_step and anchors are stored as omitted; given ones and [] are stored as given', async () => {
    const box = makeIo()
    box.files.set('src/a.ts', 'const a = 1\n')
    const session = await freshSession(box)
    await session.ledgerAppend({ ...base, next_step: '跑测试', anchors: [anchor] }, env(10_000))
    await session.ledgerAppend({ ...base, text: '第二步' }, env(10_000))
    await session.ledgerAppend({ ...base, text: '第三步', next_step: '改文档' }, env(10_000))
    await session.ledgerAppend({ ...base, text: '第四步', anchors: [] }, env(10_000))
    await session.ledgerAppend({ ...base, status: 'done', text: '做完了', evidence: [2] }, env(10_000))
    await session.flush()

    const entries = readLedger(box)
    // The carry-over is read when the ledger is shown, so the handoff can say where it came from.
    expect(entries.map(entry => entry.next_step)).toEqual(['跑测试', undefined, '改文档', undefined, undefined])
    expect('anchors' in (entries[1] ?? {})).toBe(false)
    expect(entries[3]?.anchors).toEqual([])
    expect('anchors' in (entries[4] ?? {})).toBe(false)
  })

  test('the handoff names the entry a carried next step and anchors came from, and a clear removes them', async () => {
    const box = makeIo()
    box.files.set('src/a.ts', 'const a = 1\n')
    const session = await freshSession(box)
    await session.ledgerAppend({ ...base, next_step: '跑测试', anchors: [anchor] }, env(10_000))
    await session.ledgerAppend({ ...base, text: '补记' }, env(10_000))

    const carried = await session.buildHandoff({ isMidTurn: false })
    expect(carried).toContain('下一步（沿用 #L1 的记录，可能已过时）：跑测试')
    expect(carried).toContain('任务 t1（沿用 #L1 的记录，可能已过时） · src/a.ts:1')
    expect(carried.split('沿用 #L1 的记录，可能已过时').length - 1).toBe(2)

    await session.ledgerAppend({ ...base, status: 'blocked', text: '卡住了', next_step: '', anchors: [] }, env(10_000))
    const cleared = await session.buildHandoff({ isMidTurn: false })
    expect(cleared).not.toContain('跑测试')
    expect(cleared).not.toContain('沿用')

    await session.ledgerAppend({ ...base, status: 'done', text: '做完了', evidence: [2] }, env(10_000))
    expect(await session.buildHandoff({ isMidTurn: false })).not.toContain('沿用')
  })
})

describe('historyTool search range', () => {
  /** Window 5 with one distinctive word in `where`, and one ordinary row in every window. */
  const windows = async (where: number): Promise<Session> => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    for (let window = 1; window <= 5; window += 1) {
      await session.record({ uuid: `p${window}`, role: 'user', isPerson: true, text: `第${window}窗口的请求` })
      if (window === where) await session.record({ uuid: 'r', role: 'tool', tool: 'Bash', text: 'RAREWORD only here' })
      if (window < 5) await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    }
    await session.flush()

    return session
  }

  test('a word only in an older window is found by walking back, and the range is stated', async () => {
    const session = await windows(2)
    expect(session.window()).toBe(5)
    const found = (await session.historyTool({ action: 'search', query: 'RAREWORD' })).result
    expect(found).toContain('w2 tool [Bash]')
    expect(found).toContain('（搜了第 2–5 个窗口；第 1 个窗口没搜，要搜用 window 指定）')
  })

  test('the recent windows alone are reported with what was left out only when they hit', async () => {
    const session = await windows(4)
    const found = (await session.historyTool({ action: 'search', query: 'RAREWORD' })).result
    expect(found).toContain('w4 tool [Bash]')
    expect(found).toContain('（搜了第 3–5 个窗口；第 1–2 个窗口没搜，要搜用 window 指定）')
  })

  test('walking back to window 1 has searched everything, so no range line is added', async () => {
    const session = await windows(1)
    const found = (await session.historyTool({ action: 'search', query: 'RAREWORD' })).result
    expect(found).toContain('w1 tool [Bash]')
    expect(found).not.toContain('没搜')
    expect(found).not.toContain('搜了第')
  })

  test('nothing anywhere says every window was searched', async () => {
    const session = await windows(1)
    expect((await session.historyTool({ action: 'search', query: 'NOSUCHWORD' })).result).toBe('第 1–5 个窗口里都没有匹配。')
  })

  test('a given window is searched alone and never walked back from', async () => {
    const session = await windows(1)
    const miss = (await session.historyTool({ action: 'search', query: 'RAREWORD', window: 3 })).result
    expect(miss).toBe('第 3 个窗口里没有匹配（只搜了这个窗口）。')
    expect((await session.historyTool({ action: 'search', query: 'RAREWORD', window: 1 })).result).toContain('w1 tool [Bash]')
  })
})

describe('the steps taken since the last ledger entry', () => {
  const open = { task_id: 'login-btn', title: '登录页按钮改蓝', status: 'in_progress', text: '在做', next_step: '接着做' }
  const config: Config = { ...DEFAULTS, cooldownRequests: 0 }
  let counter = 0

  const steps = async (session: Session, count: number, tool = 'Bash'): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
      counter += 1
      await session.record({ uuid: `step-${counter}`, role: 'tool', tool, text: 'ok' })
    }
  }

  const booked = async (box: Box, cfg: Config = config): Promise<Session> => {
    const session = await freshSession(box, cfg)
    await session.ledgerAppend(open, env(10_000))

    return session
  }

  const ask = (session: Session) => session.requestSwitch({}, env(160_000, 1_000_000))

  test('five steps pass, six are refused with the entry, the count and the range, and a new entry lets it through', async () => {
    const box = makeIo()
    const session = await booked(box)
    await steps(session, 5)
    expect(ask(session).isError).toBeUndefined()
    session.clearPending()

    await steps(session, 1)
    const refused = ask(session)
    expect(refused.isError).toBe(true)
    expect(refused.result).toContain('最近一次记账（#L1）之后又有 6 个工具结果没有记进账本（#3–#8）')
    expect(refused.result).toContain('先用 ledger_append 写明这些步骤的结论')

    await session.ledgerAppend({ ...open, text: '补记' }, env(10_000))
    expect(ask(session).isError).toBeUndefined()
  })

  test('without any entry in the window the refusal says so', async () => {
    const box = makeIo()
    const session = await freshSession(box, config)
    const refused = ask(session)
    expect(refused.isError).toBe(true)
    expect(refused.result).toContain('还没有记过账')
  })

  test('this mod’s own tool results are not steps', async () => {
    const box = makeIo()
    const session = await booked(box)
    await steps(session, 5)
    await steps(session, 10, 'mcp__ctx-mod__history')
    expect(ask(session).isError).toBeUndefined()
  })

  test('an entry without through is compared by time', async () => {
    const box = makeIo()
    const session = await booked(box, { ...config, freshTailSteps: 1 })
    box.advance(1_000)
    await steps(session, 2)
    await session.flush()
    const stripped = readLedger(box).map(entry => {
      const { through: _through, ...rest } = entry

      return rest
    })
    box.files.set(`${DIR}/ledger.jsonl`, stripped.map(entry => JSON.stringify(entry)).join('\n') + '\n')

    const reloaded = createSession(DIR, box.io, { ...config, freshTailSteps: 1 })
    await reloaded.ready()
    const refused = ask(reloaded)
    expect(refused.isError).toBe(true)
    expect(refused.result).toContain('之后又有 2 个工具结果')
  })

  test('canSkipSummary allows 25 steps, refuses 26, and refuses a window without an entry', async () => {
    const box = makeIo()
    const session = await booked(box)
    await steps(session, 25)
    expect(session.canSkipSummary()).toBe(true)
    await steps(session, 1)
    expect(session.canSkipSummary()).toBe(false)

    const bare = await freshSession(makeIo())
    expect(bare.canSkipSummary()).toBe(false)
  })

  test('the handoff lists the whole uncovered stretch, up to 25, and owns up to it', async () => {
    const actionLines = (text: string): number => (text.match(/^- #\d+ Bash/gm) ?? []).length
    const box = makeIo()
    const session = await booked(box)
    await steps(session, 12)
    const twelve = await session.buildHandoff({ isMidTurn: false })
    expect(twelve).toContain('## 账本没覆盖到的部分')
    expect(twelve).toContain('最近一次记账（#L1）之后还有 12 个工具结果没有记进账本（#3–#14）')
    expect(actionLines(twelve)).toBe(12)

    await steps(session, 6)
    expect(actionLines(await session.buildHandoff({ isMidTurn: false }))).toBe(18)
    await steps(session, 20)
    const capped = await session.buildHandoff({ isMidTurn: false })
    expect(actionLines(capped)).toBe(25)
    expect(capped).toContain('38 个工具结果')
  })

  test('with no entry the handoff says the window never booked, and with no tail it has no such section', async () => {
    const box = makeIo()
    const session = await freshSession(box, config)
    await steps(session, 3)
    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text).toContain('上个窗口里没有记过账，有 4 个工具结果（#2–#5）只在历史里')

    const quiet = await booked(makeIo())
    expect(await quiet.buildHandoff({ isMidTurn: false })).not.toContain('账本没覆盖到的部分')
  })
})


describe('held messages', () => {
  const heldFile = (box: Box): { items: { id: number; text: string; at: number }[] } =>
    JSON.parse(box.files.get(`${DIR}/held.json`) ?? '{"items":[]}') as { items: { id: number; text: string; at: number }[] }

  test('hold writes the message down, a new session still has it, and release clears file and memory', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.ready()
    const first = await session.hold('第一句')
    const second = await session.hold('第二句')
    expect([first, second]).toEqual([1, 2])
    expect(heldFile(box).items.map(item => item.text)).toEqual(['第一句', '第二句'])
    expect(heldFile(box).items[0]?.at).toBe(1_000_000)

    const reopened = createSession(DIR, box.io, DEFAULTS)
    await reopened.ready()
    expect(reopened.heldItems().map(item => item.id)).toEqual([1, 2])

    await reopened.release(1)
    await reopened.release(99)
    expect(reopened.heldItems().map(item => item.text)).toEqual(['第二句'])
    expect(heldFile(box).items.map(item => item.text)).toEqual(['第二句'])
    // The copy a caller gets cannot change what the session holds.
    reopened.heldItems()[0]!.text = '改了'
    expect(reopened.heldItems()[0]?.text).toBe('第二句')
  })

  test('a write that fails gives null, holds nothing, and leaves nothing to retry', async () => {
    const box = makeIo()
    let failing = true
    const io: Io = {
      ...box.io,
      write: async (path, text) => {
        if (failing) throw new Error('EIO')
        await box.io.write(path, text)
      },
    }
    const session = createSession(DIR, io, DEFAULTS)
    await session.ready()
    expect(await session.hold('丢不得')).toBeNull()
    expect(session.heldItems()).toEqual([])
    expect(session.unsaved()).toEqual([])

    failing = false
    await session.flush()
    expect(box.files.has(`${DIR}/held.json`)).toBe(false)
    expect(await session.hold('这次行')).toBe(1)
  })

  test('a held.json that is not JSON, or has the wrong shape, leaves the session usable', async () => {
    for (const text of ['{ not json', '[1,2]', '{"items":"x"}', '{"items":[null,{"id":"a"},{"id":3,"text":"好","at":5}]}']) {
      const box = makeIo()
      box.files.set(`${DIR}/held.json`, text)
      const session = createSession(DIR, box.io, DEFAULTS)
      await session.ready()
      expect(session.heldItems().map(item => item.text)).toEqual(text.includes('"好"') ? ['好'] : [])
      expect(await session.hold('新的')).not.toBeNull()
    }
  })
})

describe('rows from the other doors', () => {
  test('are filed with their door, and the background ones stay out of a default search', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'd1', role: 'user', door: 'delivery', text: '子代理 a1 做完了：产物在 out.txt' })
    await session.record({ uuid: 'a1', role: 'user', door: 'attachment', name: 'nested_memory', text: '背景里有 out.txt 的说明' })
    await session.record({ uuid: 'q1', role: 'user', door: 'attachment', name: 'queued_command', text: '顺便看下 out.txt' })
    await session.record({ uuid: 'h1', role: 'user', door: 'hook-context', text: '钩子给的 out.txt 上下文' })
    await session.flush()

    const rows = windowRows(box, 1)
    expect(rows.map(row => row.door)).toEqual(['delivery', 'attachment', 'attachment', 'hook-context'])
    expect(rows[1]?.name).toBe('nested_memory')

    const found = (await session.historyTool({ action: 'search', query: 'out.txt' })).result
    expect(found).toContain('#1 w1 user <delivery>')
    expect(found).toContain('#3 w1 user <attachment/queued_command>')
    expect(found).not.toContain('#2 ')
    expect(found).not.toContain('#4 ')

    expect((await session.historyTool({ action: 'search', query: 'out.txt', door: 'hook-context' })).result).toContain('#4 ')
    expect((await session.historyTool({ action: 'search', query: 'out.txt', door: 'attachment' })).result).toContain('#2 ')
    expect((await session.historyTool({ action: 'read', seq: 2 })).result).toContain('背景里有')
    expect((await session.historyTool({ action: 'search', door: 5 })).isError).toBe(true)
  })

  test('are never a person request, the last reply or a step', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把按钮改成蓝色' })
    await session.record({ uuid: 'r1', role: 'assistant', text: '真正的回答：按钮已经是蓝色' })
    await session.record({ uuid: 'd1', role: 'assistant', door: 'compaction', text: '引擎塞进来的助手角色行' })
    await session.record({ uuid: 'd2', role: 'user', door: 'delivery', text: '后台通知：任务结束' })

    const handoff = await session.buildHandoff({ isMidTurn: false })
    expect(handoff).toContain('真正的回答')
    expect(handoff).not.toContain('引擎塞进来的助手角色行')
    expect(handoff).not.toContain('后台通知')
    expect(session.latestPersonSeq()).toBe(1)
    expect(handoff).not.toContain('账本没覆盖到的部分')
  })

  test('a mid-turn message of the person, filed as one, is a request of its own', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'q1', role: 'user', isPerson: true, door: 'attachment', name: 'queued_command', text: '等一下，先改登录页' })
    expect(session.latestPersonSeq()).toBe(1)
    expect(await session.buildHandoff({ isMidTurn: false })).toContain('等一下，先改登录页')
  })
})

describe('a tool call’s arguments in full', () => {
  const longCommand = `echo ${'x'.repeat(500)} && grep needle-only-in-args file.txt`

  test('are read back whole with field input, and found by a search', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    const args = `command: ${longCommand}\ndescription: 跑一下`
    await session.record({ uuid: 't1', role: 'tool', tool: 'Bash', input: longCommand.slice(0, 300), args, callId: 'call-1', text: 'done' })
    await session.flush()

    const read = (await session.historyTool({ action: 'read', seq: 1, field: 'input' })).result
    expect(read).toContain('调用参数')
    expect(read).toContain(longCommand)
    expect(read).toContain('description: 跑一下')
    expect((await session.historyTool({ action: 'read', seq: 1 })).result).toContain('done')
    expect(windowRows(box, 1)[0]?.callId).toBe('call-1')

    const found = (await session.historyTool({ action: 'search', query: 'needle-only-in-args' })).result
    expect(found).toContain('#1 w1 tool [Bash]')
    expect(found).toContain('needle-only-in-args')
    // Paging works as it does for the text.
    const page = (await session.historyTool({ action: 'read', seq: 1, field: 'input', offset: 0, length: 10 })).result
    expect(page).toContain('还有后续')
  })

  test('an older row with only the summary says so', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 't1', role: 'tool', tool: 'Bash', input: 'ls -la', text: 'listing' })
    await session.record({ uuid: 'u1', role: 'user', text: '一句话' })
    const old = (await session.historyTool({ action: 'read', seq: 1, field: 'input' })).result
    expect(old).toContain('旧记录')
    expect(old).toContain('ls -la')
    expect((await session.historyTool({ action: 'read', seq: 2, field: 'input' })).result).toContain('没有记录调用参数')
    expect((await session.historyTool({ action: 'read', seq: 1, field: 'nope' })).isError).toBe(true)
  })
})

describe('a field too long for its row', () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'

  test('keeps its head in the row and its whole text in part files, paged to the last character', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    const text = `${'x'.repeat(299_997)}END`
    const row = await session.record({ uuid: 't1', role: 'tool', tool: 'Read', text })
    await session.flush()

    expect(row.text.length).toBeLessThan(200_100)
    expect(row.overflow?.text).toEqual({ chars: 300_000, parts: 1 })
    expect(box.files.get(`${DIR}/big-1-text-0.txt`)).toBe(text)
    // Nothing else sees more than the head: the shard row is the clipped one.
    expect(windowText(box, 1)).not.toContain('END')

    const tail = (await session.historyTool({ action: 'read', seq: 1, offset: 299_990, length: 20 })).result
    expect(tail).toContain('共 300000 字符')
    expect(tail.endsWith('xxxxxEND')).toBe(true)
    expect(tail).not.toContain('还有后续')
    // The search reaches the overflow when the head does not match, and says where.
    const found = (await session.historyTool({ action: 'search', query: 'xxxEND' })).result
    expect(found).toContain('xxxEND')
    expect(found).toContain('[overflow text offset=299994]')
  })

  test('reads across a part boundary, and a pair that straddles it stays whole', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    const plain = alphabet.repeat(96_154)
    const first = await session.record({ uuid: 't1', role: 'tool', tool: 'Read', text: plain })
    expect(first.overflow?.text).toEqual({ chars: plain.length, parts: 3 })
    const paired = `${'a'.repeat(999_999)}😀${'b'.repeat(1_500)}`
    const second = await session.record({ uuid: 't2', role: 'tool', tool: 'Read', text: paired })
    expect(second.overflow?.text?.cuts).toEqual([999_999])
    await session.flush()
    expect(box.files.get(`${DIR}/big-2-text-0.txt`)?.length).toBe(999_999)

    const across = (await session.historyTool({ action: 'read', seq: 1, offset: 999_995, length: 10 })).result
    expect(across.endsWith(`\n${plain.slice(999_995, 1_000_005)}`)).toBe(true)
    const pair = (await session.historyTool({ action: 'read', seq: 2, offset: 999_990, length: 20 })).result
    expect(pair.endsWith(`\n${paired.slice(999_990, 1_000_010)}`)).toBe(true)
  })

  test('arguments past their limit spill the same way and read with field input', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    const args = `prompt: ${'p'.repeat(79_990)}THE-END`
    const row = await session.record({ uuid: 't1', role: 'tool', tool: 'Agent', args, text: 'ok' })
    await session.flush()
    expect(row.overflow?.args?.chars).toBe(args.length)
    expect(box.files.get(`${DIR}/big-1-args-0.txt`)).toBe(args)
    const tail = (await session.historyTool({ action: 'read', seq: 1, field: 'input', offset: args.length - 20, length: 100 })).result
    expect(tail.endsWith('THE-END')).toBe(true)
  })

  test('says so when a part cannot be read, and gives the head instead of pretending', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 't1', role: 'tool', tool: 'Read', text: 'y'.repeat(250_000) })
    await session.flush()
    box.files.delete(`${DIR}/big-1-text-0.txt`)

    const lost = (await session.historyTool({ action: 'read', seq: 1, offset: 0, length: 20 })).result
    expect(lost).toContain('这一段原文没有写进磁盘')
    expect(lost).toContain('yyyyyyyy')
  })

  test('search skips a missing part and says which one instead of failing', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 't1', role: 'tool', tool: 'Read', text: `${'y'.repeat(249_990)}SEARCH-ONLY` })
    await session.flush()
    box.files.delete(`${DIR}/big-1-text-0.txt`)

    const found = await session.historyTool({ action: 'search', query: 'SEARCH-ONLY' })
    expect(found.isError).toBeUndefined()
    expect(found.result).toContain('没有匹配')
    expect(found.result).toContain('#1 的 overflow text 第 0 段文件缺失，已跳过')
  })

  test('search skips a truncated part and says it was cut short', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    const text = `${'y'.repeat(249_990)}TRUNCATED-TAIL`
    await session.record({ uuid: 't1', role: 'tool', tool: 'Read', text })
    await session.flush()
    const path = `${DIR}/big-1-text-0.txt`
    box.files.set(path, (box.files.get(path) ?? '').slice(0, 1000))

    const found = await session.historyTool({ action: 'search', query: 'TRUNCATED-TAIL' })
    expect(found.isError).toBeUndefined()
    expect(found.result).toContain(`内容被截短（1000/${text.length} 字符）`)
    expect(found.result).toContain('已跳过')
  })
  test('a part that failed to write is reported, kept in memory and written by the next flush', async () => {
    const box = makeIo()
    let isBroken = true
    const io: Io = {
      ...box.io,
      write: async (path, text) => {
        if (isBroken && path.includes('/big-')) throw new Error('EIO')
        box.files.set(path, text)
      },
    }
    const session = createSession(DIR, io, DEFAULTS)
    const text = `${'z'.repeat(249_990)}LAST-BYTES`
    await session.record({ uuid: 't1', role: 'tool', tool: 'Read', text })
    await session.flush()
    expect(session.unsaved()).toEqual(['big-1-text-0.txt'])
    // Still readable in this process while the disk refuses it.
    const meanwhile = (await session.historyTool({ action: 'read', seq: 1, offset: 249_990, length: 10 })).result
    expect(meanwhile).toContain('LAST-BYTES')

    isBroken = false
    await session.flush()
    expect(session.unsaved()).toEqual([])
    expect(box.files.get(`${DIR}/big-1-text-0.txt`)).toBe(text)
  })

  test('part files are not history shards: the numbering still comes back from the shards', async () => {
    const box = makeIo()
    box.files.set(shardPath(1), '{"seq":4,"uuid":"u","ts":1,"window":1,"role":"user","text":"旧"}\n')
    box.files.set(`${DIR}/big-99-text-0.txt`, 'x')
    box.files.set(`${DIR}/big-7-args-0.txt`, 'y')
    const session = createSession(DIR, box.io, DEFAULTS)
    const row = await session.record({ uuid: 'u2', role: 'user', text: '新' })
    expect(row.seq).toBe(5)
    expect(row.window).toBe(1)
  })
})

describe('history write amplification counters', () => {
  test('after several appends the physical bytes are at least the logical bytes', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    for (let index = 0; index < 5; index += 1) {
      await session.record({ uuid: `u${index}`, role: 'user', text: `第 ${index} 行 ${'x'.repeat(200)}` })
    }
    await session.flush()

    const line = session.historyWriteStats()
    expect(line).toMatch(/^history 写入：逻辑 [\d.]+ KB \/ 实际 [\d.]+ KB（WAF=[\d.]+），写盘 \d+ 次/)
    const logical = Number(/逻辑 ([\d.]+) KB/.exec(line)?.[1])
    const physical = Number(/实际 ([\d.]+) KB/.exec(line)?.[1])
    expect(logical).toBeGreaterThan(0)
    expect(physical).toBeGreaterThanOrEqual(logical)
    expect(Number(/写盘 (\d+) 次/.exec(line)?.[1])).toBeGreaterThan(0)
  })
})

describe('importMessages into a session that has history', () => {
  const user = (text: string) => ({ role: 'user' as const, text, toolUses: [] })
  const call = (callId: string, text: string) => ({
    role: 'assistant' as const,
    text: '',
    toolUses: [{ tool: 'Bash', callId, input: { command: 'ls' }, args: 'command: ls', text }],
  })

  test('files only the two messages after the last one it knows', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    const before = [user('把解析器改严一点，错误信息也要换掉'), call('c1', 'listing'), { role: 'assistant' as const, text: '已经改好了，下一步看测试。', toolUses: [] }]
    expect(await session.importMessages(before)).toBe(3)

    const tail = [user('停用期间我又提了一个新请求'), { role: 'assistant' as const, text: '收到，这是停用期间的回答。', toolUses: [] }]
    expect(await session.importMessages([...before, ...tail])).toBe(2)
    await session.flush()
    const rows = windowRows(box, 1)
    expect(rows.map(row => row.text)).toEqual([
      '把解析器改严一点，错误信息也要换掉',
      'listing',
      '已经改好了，下一步看测试。',
      '停用期间我又提了一个新请求',
      '收到，这是停用期间的回答。',
    ])
    expect(rows[1]?.callId).toBe('c1')
    expect(rows[1]?.args).toBe('command: ls')
    // Nothing is filed twice, however often the same conversation comes round.
    expect(await session.importMessages([...before, ...tail])).toBe(0)
    expect(await session.importMessages([...before, ...tail])).toBe(0)
  })

  test('lines a row without a call id up by the [#n] the mod put on its result', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '一句和引擎里写法不同的话' })
    await session.record({ uuid: 't1', role: 'tool', tool: 'Bash', text: 'listing' })
    const messages = [call('engine-id', 'listing\n[#2]'), user('停用期间的一条新消息，没有记录')]
    expect(await session.importMessages(messages)).toBe(1)
    expect((await session.historyTool({ action: 'search', query: '停用期间的一条' })).result).toContain('#3 w1 user')
    expect(await session.importMessages(messages)).toBe(0)
  })

  test('a number that is not one of its rows does not pass for a known message', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '只有这一条' })
    expect(await session.importMessages([call('x', 'out\n[#99]')])).toBe(1)
  })

  test('words count as known only from twelve characters when one only contains the other', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '好的，继续\n做吧' })
    await session.record({ uuid: 'a1', role: 'assistant', text: '这是一段足够长的助手回复，用来对齐。' })
    // Equal once the whitespace is gone.
    expect(await session.importMessages([user('好的，继续做吧')])).toBe(0)
    // Shorter than twelve and only contained: not the same message.
    expect(await session.importMessages([user('好的')])).toBe(1)
    // Long enough and contained.
    expect(await session.importMessages([user('前缀 这是一段足够长的助手回复，用来对齐。 后缀')])).toBe(0)
  })

  test('the handoff’s own opening is not taken for the person’s words', async () => {
    expect(looksLikePerson(openingOf(3, false))).toBe(false)
    expect(looksLikePerson(openingOf(12, true))).toBe(false)
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    expect(await session.importMessages([user(openingOf(2, false))])).toBe(1)
    expect(session.latestPersonSeq()).toBeNull()
  })
})

describe('the cold-cache hold-back on resuming a subagent', () => {
  const HOUR = 3_600_000

  /** A subagent that ran a large request and ended, with the clock then moved on by `idleMs`. */
  const endedAgent = async (idleMs: number, tokens = 190_000, name?: string) => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.noteAgent({ id: 'a1', type: 'worker', description: '改 hooks', ...(name === undefined ? {} : { name }) })
    box.advance(1_000)
    await session.agentStep('a1', tokens)
    await session.agentEnded('a1')
    await session.flush()
    box.advance(idleMs)

    return { box, session }
  }

  test('the roster row keeps lastActiveAt and contextTokens, written when the turn ends', async () => {
    const { box } = await endedAgent(0)
    const row = rosterOf(box)[0]
    expect(row?.contextTokens).toBe(190_000)
    expect(row?.lastActiveAt).toBe(1_001_000)
    expect(row?.ended).toBe(true)
  })

  test('a cold, large, ended subagent is held back once, and the same send goes through the second time', async () => {
    const { session } = await endedAgent(3 * HOUR)
    const first = await session.coldResend('a1', '继续')
    expect(first).toContain('闲置 3 小时')
    expect(first).toContain('19.0 万')
    expect(first).toContain('原样再发一次')
    expect(await session.coldResend('a1', '继续')).toBeNull()
  })

  test('a different body within the resend window also goes through; the pair is then spent', async () => {
    const { box, session } = await endedAgent(3 * HOUR)
    expect(await session.coldResend('a1', '一')).not.toBeNull()
    box.advance(5 * 60_000)
    expect(await session.coldResend('a1', '二')).toBeNull()
    expect(await session.coldResend('a1', '三')).not.toBeNull()
  })

  test('a name matches as well as an id, and a trailing [ref] is ignored', async () => {
    const { session } = await endedAgent(3 * HOUR, 190_000, 'scout')
    expect(await session.coldResend('scout [ab12]', 'x')).not.toBeNull()
  })

  test('a hot, a small, a running or an unknown recipient is not held back', async () => {
    const hot = await endedAgent(30 * 60_000)
    expect(await hot.session.coldResend('a1', 'x')).toBeNull()

    const small = await endedAgent(3 * HOUR, 20_000)
    expect(await small.session.coldResend('a1', 'x')).toBeNull()

    const box = makeIo()
    const running = createSession(DIR, box.io, DEFAULTS)
    await running.noteAgent({ id: 'a1', type: 'worker', description: '在跑' })
    await running.agentStep('a1', 190_000)
    box.advance(3 * HOUR)
    expect(await running.coldResend('a1', 'x')).toBeNull()

    expect(await small.session.coldResend('nobody', 'x')).toBeNull()
  })

  test('the thresholds come from the config', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, { ...DEFAULTS, agentColdMinutes: 5, agentColdMinTokens: 1_000 })
    await session.noteAgent({ id: 'a1', type: 'worker', description: 'x' })
    await session.agentStep('a1', 2_000)
    await session.agentEnded('a1')
    box.advance(6 * 60_000)
    expect(await session.coldResend('a1', 'x')).toContain('闲置 6 分钟')
  })

  test('a resume stamps the row and clears ended', async () => {
    const { box, session } = await endedAgent(3 * HOUR)
    await session.agentResumed('a1')
    await session.flush()
    const row = rosterOf(box)[0]
    expect(row?.ended).toBeUndefined()
    expect(row?.lastActiveAt).toBe(1_001_000 + 3 * HOUR)
  })

  test('the handoff tells an ended subagent idle time and cache state', async () => {
    const cold = await endedAgent(3 * HOUR)
    const coldText = await cold.session.buildHandoff({ isMidTurn: false, agents: [] })
    expect(coldText).toContain('- a1（worker，已结束；闲置 3 小时，缓存已冷，约 19.0 万 token）：改 hooks')

    const hot = await endedAgent(10 * 60_000)
    const hotText = await hot.session.buildHandoff({ isMidTurn: false, agents: [] })
    expect(hotText).toContain('闲置 10 分钟，缓存可能仍热')
  })

  test('a row from before the new fields loads and is never held back', async () => {
    const box = makeIo()
    const first = createSession(DIR, box.io, DEFAULTS)
    await first.noteAgent({ id: 'a1', type: 'worker', description: '旧' })
    await first.agentEnded('a1')
    await first.flush()
    const meta = readMeta(box)
    meta.roster = [{ id: 'a1', type: 'worker', description: '旧', window: 1, ts: 1, ended: true }]
    box.files.set(`${DIR}/meta.json`, JSON.stringify(meta))
    box.advance(5 * HOUR)
    const second = createSession(DIR, box.io, DEFAULTS)
    expect(await second.coldResend('a1', 'x')).toBeNull()
  })
})
