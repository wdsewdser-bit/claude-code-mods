import { describe, expect, test } from 'claude-code/testing'

import { extractDecisions, renderDecisions } from '../hooks/lib/decisions.ts'
import { createSession } from '../hooks/lib/session.ts'
import type { Io } from '../hooks/lib/session.ts'
import {
  applyNoter,
  buildNoterBatch,
  cursorOf,
  estimateTokens,
  notedFromLines,
  NOTER_INPUT_TOKENS,
  parseNoterOutput,
  renderNoted,
} from '../hooks/lib/noter.ts'
import type { NotedDecision } from '../hooks/lib/noter.ts'
import { DEFAULTS } from '../hooks/lib/types.ts'
import type { Config, HistoryRecord } from '../hooks/lib/types.ts'

const at = (seq: number): number => 1_700_000_000_000 + seq * 1_000

const person = (seq: number, text: string, window = 1): HistoryRecord => ({
  seq,
  uuid: `p${seq}`,
  ts: at(seq),
  window,
  role: 'user',
  isPerson: true,
  text,
})

const assistantRow = (seq: number, text: string, window = 1): HistoryRecord => ({
  seq,
  uuid: `a${seq}`,
  ts: at(seq),
  window,
  role: 'assistant',
  text,
})

const noted = (seq: number, quote: string, note: string, window = 1): NotedDecision => ({
  seq,
  ts: at(seq),
  window,
  quote,
  note,
  kind: 'rule',
})

describe('buildNoterBatch', () => {
  test('takes only the person’s messages after the cursor, oldest first', () => {
    const batch = buildNoterBatch(
      [
        person(1, '以后一律用 pnpm。'),
        assistantRow(2, '好的。'),
        person(3, '不要动 vite.config。'),
      ],
      1,
    )
    expect(batch.batchRows.map(row => row.seq)).toEqual([3])
    expect(batch.nextCursor).toBe(3)
    expect(batch.input).toContain('[#3 w1 ')
    expect(batch.input).not.toContain('[#1 w1 ')
    expect(batch.input.startsWith('<data>\n【已有决策清单】')).toBe(true)
    expect(batch.input).toContain('【新的用户消息】')
    expect(batch.input).toContain('以上是记录。现在按系统提示的规则输出 JSON 对象，不要输出别的。')
  })

  test('stops at the character ceiling, and still takes one message when even that is too big', () => {
    const body = 'x'.repeat(600)
    const rows = [person(1, body), person(2, body), person(3, body)]
    const batch = buildNoterBatch(rows, 0, 700)
    expect(batch.batchRows.map(row => row.seq)).toEqual([1])
    expect(batch.nextCursor).toBe(1)

    const tiny = buildNoterBatch(rows, 0, 10)
    expect(tiny.batchRows.map(row => row.seq)).toEqual([1])
  })

  test('carries the end of the reply a short message answers', () => {
    const reply = `先说结论：${'很长的说明'.repeat(80)}悬停色要不要也换掉？`
    const batch = buildNoterBatch([assistantRow(1, reply), person(2, '可以')], 0)
    const tail = reply.slice(reply.length - 260)
    expect(batch.input).toContain('↳答的是助手：')
    expect(batch.input).toContain(tail)
  })

  test('drops the engine reminder and keeps only the head of a paste, marked', () => {
    const paste = '<pasted_content id="x">' + 'y'.repeat(2000) + '</pasted_content>'
    const batch = buildNoterBatch(
      [person(1, `<system-reminder>不要当真</system-reminder>\n${paste}\n以后一律用 pnpm。`)],
      0,
    )
    expect(batch.input).not.toContain('不要当真')
    expect(batch.input).toContain('〔粘贴〕')
    expect(batch.input).toContain('〔/粘贴〕')
    expect(batch.input).toContain('以后一律用 pnpm。')
    const kept = (batch.input.match(/y/g) ?? []).length
    expect(kept).toBe(800)
  })

  test('a longer existing list leaves fewer characters for the new messages', () => {
    const rows = Array.from({ length: 60 }, (_unused, index) => person(index + 1, `消息${index}：${'内容'.repeat(600)}`))
    const short = buildNoterBatch(rows, 0, 40_000, [noted(1, '原话一', '短清单里的一条')])
    const long = buildNoterBatch(
      rows,
      0,
      40_000,
      Array.from({ length: 260 }, (_item, index) => noted(index + 1, '原话', `第${index}条决策${'说明'.repeat(90)}`)),
    )
    expect(short.batchRows.length).toBeGreaterThan(20)
    expect(long.batchRows.length).toBeLessThan(short.batchRows.length)
    // Even a list at its shortest leaves room for at least one message.
    expect(long.batchRows.length).toBeGreaterThanOrEqual(1)
  })

  test('names the decisions already noted, so one can be revoked by its number', () => {
    const batch = buildNoterBatch([person(5, '还是用 npm 吧。')], 3, 40_000, [
      noted(2, '以后一律用 pnpm', '包管理器定为 pnpm'),
    ])
    expect(batch.input).toContain('#2 包管理器定为 pnpm（原话：以后一律用 pnpm）')
    // Nothing noted yet says so, rather than leaving a blank section.
    const empty = buildNoterBatch([person(5, '还是用 npm 吧。')], 3)
    expect(empty.input).toContain('【已有决策清单】\n（空）')
  })
})

describe('parseNoterOutput', () => {
  const rows = [person(5, '以后一律用 pnpm。'), person(9, '不要动 vite.config。')]

  test('takes a valid answer, with the time and window of the message it came from', () => {
    const parsed = parseNoterOutput(
      '{"add":[{"seq":5,"quote":"以后一律用 pnpm","note":"包管理器定为 pnpm","kind":"rule"}],"revoke":[]}',
      rows,
      [],
    )
    expect(parsed.add).toEqual([
      { seq: 5, ts: at(5), window: 1, quote: '以后一律用 pnpm', note: '包管理器定为 pnpm', kind: 'rule' },
    ])
    expect(parsed.rejected).toEqual([])
  })

  test('reads the object out of a code fence and surrounding prose', () => {
    const parsed = parseNoterOutput(
      '好的，结果如下：\n```json\n{"add":[{"seq":9,"quote":"不要动 vite.config。","note":"vite 配置不改","kind":"rule"}]}\n```\n以上。',
      rows,
      [],
    )
    expect(parsed.add.map(decision => decision.seq)).toEqual([9])
  })

  test('drops a quote its message does not carry, a seq outside the batch, and a bad kind or note', () => {
    const parsed = parseNoterOutput(
      JSON.stringify({
        add: [
          { seq: 5, quote: '以后一律用 yarn', note: '说错了', kind: 'rule' },
          { seq: 7, quote: '以后一律用 pnpm', note: '不在这一批', kind: 'rule' },
          { seq: 5, quote: '以后一律用 pnpm', note: '种类不对', kind: 'opinion' },
          { seq: 5, quote: '以后一律用 pnpm', note: 'x'.repeat(201), kind: 'rule' },
          { seq: 5, quote: '以后  一律用 pnpm', note: '空格不影响', kind: 'rule' },
        ],
        revoke: [],
      }),
      rows,
      [],
    )
    expect(parsed.add.map(decision => decision.note)).toEqual(['空格不影响'])
    expect(parsed.rejected.map(rejection => rejection.reason)).toEqual([
      'quote 不是 #5 的原文',
      'seq 7 不是这一批里的消息',
      'kind 「opinion」不是 rule/choice/fact',
      'note 为空或超过 200 字',
    ])
  })

  test('checks both ends of a revoke: the seq is one already noted, the by is in this batch', () => {
    const parsed = parseNoterOutput(
      JSON.stringify({
        add: [],
        revoke: [
          { seq: 2, by: 5, reason: '改用 pnpm' },
          { seq: 8, by: 5, reason: '没有这一条' },
          { seq: 2, by: 8, reason: 'by 不在这一批' },
        ],
      }),
      rows,
      [noted(2, '以前用 npm', '包管理器定为 npm')],
    )
    expect(parsed.revoke).toEqual([{ seq: 2, by: 5, reason: '改用 pnpm' }])
    expect(parsed.rejected.map(rejection => rejection.reason)).toEqual([
      '撤销的 seq 8 不在已有清单里',
      '撤销的 by 8 不是这一批里的消息',
    ])
  })

  test('says the same decision once when the model repeats it', () => {
    const item = { seq: 5, quote: '以后一律用 pnpm', note: '包管理器定为 pnpm', kind: 'rule' }
    const parsed = parseNoterOutput(JSON.stringify({ add: [item, item], revoke: [] }), rows, [])
    expect(parsed.add).toHaveLength(1)
  })

  test('throws when there is no JSON object at all', () => {
    expect(() => parseNoterOutput('抱歉，这条我读不出来。', rows, [])).toThrow()
    expect(() => parseNoterOutput('{"add":[', rows, [])).toThrow()
  })
})

describe('applyNoter', () => {
  test('drops the revoked entries, adds the new ones and keeps the list by seq', () => {
    const existing = [noted(1, '用 npm', '包管理器定为 npm'), noted(4, '不要动 vite', 'vite 配置不动')]
    const next = applyNoter(existing, {
      add: [noted(9, '用 pnpm', '包管理器定为 pnpm')],
      revoke: [{ seq: 1, by: 9 }],
      rejected: [],
    })
    expect(next.map(decision => decision.seq)).toEqual([4, 9])
    expect(next.map(decision => decision.note)).toEqual(['vite 配置不动', '包管理器定为 pnpm'])
  })
})

describe('renderNoted', () => {
  test('is empty with nothing noted, and otherwise one section in the shape the rules use', () => {
    expect(renderNoted([], 3_000)).toBe('')
    const text = renderNoted([noted(7, '以后一律用 pnpm', '包管理器定为 pnpm')], 3_000)
    const lines = text.split('\n')
    expect(lines[0]).toBe('## 用户已定决策')
    expect(lines[1]).toContain('原文照搬')
    expect(lines[2]).toBe(`- [#7] ${new Date(at(7)).toISOString()} 包管理器定为 pnpm（原话：以后一律用 pnpm）`)
  })

  test('drops the oldest entries past the ceiling and says how many', () => {
    const many = [1, 2, 3, 4, 5].map(seq => noted(seq, `原话${seq}`, `第${seq}条决策，说明文字长一些。`))
    const text = renderNoted(many, 260)
    expect(text).toContain('已省略')
    expect(text).toContain('第5条决策')
    expect(text).not.toContain('第1条决策')
  })

  test('merges what the rules found after the cursor into the same section', () => {
    const tail = extractDecisions([person(12, '不要用 npm。')])
    const text = renderNoted([noted(4, '以后一律用 pnpm', '包管理器定为 pnpm')], 3_000, 1, tail)
    expect(text.split('## 用户已定决策')).toHaveLength(2)
    expect(text).toContain('包管理器定为 pnpm（原话：以后一律用 pnpm）')
    expect(text).toContain('不要用 npm。')
    // One list, oldest first.
    expect(text.indexOf('[#4]')).toBeLessThan(text.indexOf('[#12]'))
  })
})

describe('the noted.jsonl a run leaves behind', () => {
  test('folds revokes in and skips a damaged line', () => {
    const text = [
      JSON.stringify(noted(1, '用 npm', '包管理器定为 npm')),
      'not json',
      JSON.stringify(noted(2, '不要动 vite', 'vite 配置不动')),
      JSON.stringify({ revoke: { seq: 1, by: 5 } }),
    ].join('\n')
    expect(notedFromLines(text).map(decision => decision.seq)).toEqual([2])
  })

  test('reads the cursor, and treats a damaged one as nothing noted yet', () => {
    expect(cursorOf(JSON.stringify({ cursorSeq: 42 }))).toBe(42)
    expect(cursorOf('{ not json')).toBe(0)
    expect(cursorOf(null)).toBe(0)
  })
})

/** A session over a map of files, the same shape tests/session.test.ts uses. */
const makeIo = (): { files: Map<string, string>; io: Io } => {
  const files = new Map<string, string>()
  let clock = 1_000_000
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
      return [...files.keys()]
        .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(path => path.slice(prefix.length))
    },
  }
  const advance = (ms: number): void => {
    clock += ms
  }
  void advance

  return { files, io }
}

const DIR = '/ctx'

describe('the decisions section with the switch off', () => {
  test('is exactly what the rules render, even when a note-taker list is on disk', async () => {
    const box = makeIo()
    box.files.set(
      `${DIR}/noted.jsonl`,
      `${JSON.stringify(noted(1, '以后一律用 pnpm', '包管理器定为 pnpm'))}\n`,
    )
    box.files.set(`${DIR}/noter-cursor.json`, JSON.stringify({ cursorSeq: 1 }))
    const session = createSession(DIR, box.io, DEFAULTS)
    const first = await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '以后一律用 pnpm。' })
    const second = await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '界面挺好看的。' })

    const text = await session.buildHandoff({ isMidTurn: false })
    const expected = renderDecisions(
      extractDecisions([first, second], new Set()),
      DEFAULTS.decisionChars,
      session.window() - 1,
    )
    expect(text).toContain(expected)
    expect(text).not.toContain('包管理器定为 pnpm')
  })
})

describe('the decisions section with the switch on', () => {
  const openConfig: Config = { ...DEFAULTS, noter: true }

  test('carries the noted decisions plus what the rules find after its cursor, under one heading', async () => {
    const box = makeIo()
    box.files.set(
      `${DIR}/noted.jsonl`,
      `${JSON.stringify(noted(1, '以后一律用 pnpm。', '包管理器定为 pnpm'))}\n`,
    )
    box.files.set(`${DIR}/noter-cursor.json`, JSON.stringify({ cursorSeq: 1 }))
    const session = createSession(DIR, box.io, openConfig)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '以后一律用 pnpm。' })
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '不要动 vite.config。' })

    const text = await session.buildHandoff({ isMidTurn: false })
    const section = text.split('## 用户已定决策')[1] ?? ''
    expect(text.split('## 用户已定决策')).toHaveLength(2)
    expect(section).toContain('包管理器定为 pnpm（原话：以后一律用 pnpm。）')
    // The message the note-taker read does not go through the rules again: one line, not two.
    expect(section.match(/以后一律用 pnpm/g)).toHaveLength(1)
    expect(section).toContain('不要动 vite.config。')
  })

  test('a decision the person revokes goes, whether the note-taker or the rules found it', async () => {
    const box = makeIo()
    box.files.set(
      `${DIR}/noted.jsonl`,
      `${JSON.stringify(noted(1, '以后一律用 pnpm。', '包管理器定为 pnpm'))}\n`,
    )
    box.files.set(`${DIR}/noter-cursor.json`, JSON.stringify({ cursorSeq: 1 }))
    const session = createSession(DIR, box.io, openConfig)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '以后一律用 pnpm。' })
    // The note-taker found this one, so the rules alone would say there was nothing to revoke.
    const receipt = await session.decisionRevoke({ seq: 1 })
    expect(receipt.result).not.toContain('没有抽取到决策')

    const section = (await session.buildHandoff({ isMidTurn: false })).split('## 用户已定决策')[1] ?? ''
    expect(section).not.toContain('包管理器定为 pnpm')
  })
})
describe('the token budget', () => {
  test('counts characters with the margin the measurements ask for', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abc')).toBe(4)
    expect(estimateTokens('中文测试')).toBe(5)
    expect(NOTER_INPUT_TOKENS).toBe(70_000)
  })

  test('a turned-down budget scale shrinks the batch', () => {
    const rows = Array.from({ length: 60 }, (_unused, index) => person(index + 1, `消息${index}：${'内容'.repeat(600)}`))
    const whole = buildNoterBatch(rows, 0, 40_000, [], 1)
    const turnedDown = buildNoterBatch(rows, 0, 40_000, [], 0.5)
    expect(whole.batchRows.length).toBeGreaterThan(20)
    expect(turnedDown.batchRows.length).toBeLessThan(whole.batchRows.length)
    expect(turnedDown.batchRows.length).toBeGreaterThanOrEqual(1)
  })
})

describe('the existing list has three shapes', () => {
  /** `count` entries whose quote is `quoteChars` characters and whose note is `noteChars`. */
  const many = (count: number, quoteChars: number, noteChars: number): NotedDecision[] =>
    Array.from({ length: count }, (_unused, index) =>
      noted(index + 1, '原'.repeat(quoteChars), `笔记${'字'.repeat(Math.max(0, noteChars - 2))}`),
    )

  test('full when it fits, compact without the quotes when it does not, newest only when even that is too long', () => {
    const full = buildNoterBatch([person(400, '好的。')], 0, 40_000, many(5, 20, 20))
    expect(full.listTier).toBe('full')
    expect(full.input).toContain('（原话：')
    expect(full.listedSeq).toEqual([1, 2, 3, 4, 5])

    const compact = buildNoterBatch([person(400, '好的。')], 0, 40_000, many(20, 1_200, 20))
    expect(compact.listTier).toBe('compact')
    expect(compact.input).not.toContain('（原话：')
    expect(compact.input).toContain('#20 笔记')
    expect(compact.listedSeq).toHaveLength(20)

    const recent = buildNoterBatch([person(400, '好的。')], 0, 40_000, many(300, 10, 200))
    expect(recent.listTier).toBe('recent')
    expect(recent.listedSeq).toHaveLength(200)
    expect(recent.listedSeq[0]).toBe(101)
    expect(recent.input).toContain('（更早的 100 条未列出，本次不能撤销它们）')
    expect(recent.batchRows.map(row => row.seq)).toEqual([400])
  })

  test('a revoke of an entry the shortened list left out is dropped, not applied', () => {
    const existing = [noted(2, '以前用 npm', '包管理器定为 npm'), noted(9, '以后用 pnpm', '包管理器定为 pnpm')]
    const parsed = parseNoterOutput(
      JSON.stringify({ add: [], revoke: [{ seq: 2, by: 20 }, { seq: 9, by: 20 }] }),
      [person(20, '还是用 pnpm 吧。')],
      existing,
      [9],
    )
    expect(parsed.revoke).toEqual([{ seq: 9, by: 20 }])
    expect(parsed.rejected.map(rejection => rejection.reason)).toEqual(['撤销的 seq 2 未在本次清单里'])
    // Given the whole list, the same revoke is honoured.
    const whole = parseNoterOutput(
      JSON.stringify({ add: [], revoke: [{ seq: 2, by: 20 }] }),
      [person(20, '还是用 pnpm 吧。')],
      existing,
    )
    expect(whole.revoke).toEqual([{ seq: 2, by: 20 }])
  })
})

