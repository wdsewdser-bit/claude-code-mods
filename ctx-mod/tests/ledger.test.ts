import { describe, expect, test } from 'claude-code/testing'

import { archiveName, hasFreshEntry, pageOf, renderHome, stamp, tasksOf, turnPage, validate } from '../hooks/lib/ledger.ts'
import type { ArchivePage, ValidateContext } from '../hooks/lib/ledger.ts'
import { DEFAULTS, estimateTokens } from '../hooks/lib/types.ts'
import type { Anchor, HistoryRecord, LedgerEntry, LedgerInput, TaskStatus } from '../hooks/lib/types.ts'

const meta = { seq: 9, ts: 9_000, window: 2, latestPersonSeq: 1 }
const wrong = (value: unknown): LedgerInput => value as LedgerInput

const person = (extra: Partial<HistoryRecord> = {}): HistoryRecord => ({
  seq: 1,
  uuid: 'u-1',
  ts: 1_000,
  window: 1,
  role: 'user',
  isPerson: true,
  text: '请把登录页改一下',
  ...extra,
})

const tool = (extra: Partial<HistoryRecord> = {}): HistoryRecord => ({
  seq: 10,
  uuid: 'u-10',
  ts: 3_000,
  window: 1,
  role: 'tool',
  tool: 'Edit',
  text: 'file updated',
  ...extra,
})

const from = (rows: readonly HistoryRecord[]) => (seq: number): HistoryRecord | undefined =>
  rows.find(row => row.seq === seq)

const entry = (extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  task_id: 't1',
  title: '改登录页',
  status: 'in_progress',
  text: '正在改登录页',
  seq: 1,
  ts: 2_000,
  window: 1,
  request_ref: 1,
  ...extra,
})

const input = (extra: Partial<LedgerInput> = {}): LedgerInput => ({
  task_id: 't1',
  title: '改登录页',
  status: 'in_progress',
  text: '正在改登录页',
  // An in_progress entry must name its next step now, so the default input does.
  next_step: '接着改表单',
  ...extra,
})

const context = (extra: Partial<ValidateContext> = {}): ValidateContext => ({
  entries: [],
  history: () => undefined,
  latestPersonSeq: 1,
  checkAnchor: () => 'ok',
  config: DEFAULTS,
  ...extra,
})

describe('validate', () => {
  test('a plain in_progress entry passes and the four statuses each have a passing shape', () => {
    const rows = [person(), tool()]
    expect(validate(input(), context())).toEqual([])
    expect(
      validate(input({ status: 'blocked', next_step: '等用户确认' }), context()),
    ).toEqual([])
    expect(
      validate(
        input({ status: 'done', evidence: [10] }),
        context({ history: from(rows) }),
      ),
    ).toEqual([])
    expect(
      validate(
        input({ status: 'superseded', superseded_by: 't2' }),
        context(),
      ),
    ).toEqual([])
  })

  test('checks every rule and reports them all at once', () => {
    const problems = validate(
      input({ task_id: '坏 id', title: '  ', status: 'finished' as TaskStatus, text: 'x'.repeat(1_501) }),
      context(),
    )
    expect(problems.length).toBeGreaterThanOrEqual(4)
    expect(problems.join('\n')).toContain('task_id')
    expect(problems.join('\n')).toContain('title')
    expect(problems.join('\n')).toContain('status')
    expect(problems.join('\n')).toContain('text')
    expect(problems.join('\n')).toContain('1501')
  })

  test('rejects a task_id outside the allowed shape and an over-long title', () => {
    expect(validate(input({ task_id: 'a b' }), context())).toHaveLength(1)
    expect(validate(input({ task_id: '' }), context())).toHaveLength(1)
    expect(validate(input({ task_id: 'a'.repeat(65) }), context())).toHaveLength(1)
    expect(validate(input({ title: 'x'.repeat(201) }), context())).toHaveLength(1)
    expect(validate(input({ title: 'x'.repeat(200) }), context())).toEqual([])
  })

  test('done demands evidence that exists, is a tool result, and is not an error', () => {
    const rows = [
      person(),
      tool({ seq: 11, ts: 1_500 }),
      tool({ seq: 12, isError: true }),
      person({ seq: 13 }),
    ]
    const missing = validate(input({ status: 'done' }), context({ history: from(rows) }))
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain('evidence')
    expect(validate(input({ status: 'done', evidence: [99] }), context({ history: from(rows) }))[0]).toContain(
      '不存在',
    )
    expect(validate(input({ status: 'done', evidence: [12] }), context({ history: from(rows) }))[0]).toContain(
      '报错',
    )
    expect(validate(input({ status: 'done', evidence: [13] }), context({ history: from(rows) }))[0]).toContain(
      'role',
    )
  })

  test('evidence must not predate the task it proves', () => {
    const rows = [person({ ts: 5_000 }), tool({ seq: 11, ts: 4_000 }), tool({ seq: 12, ts: 6_000 })]
    const later = validate(
      input({ status: 'done', evidence: [11] }),
      context({ history: from(rows), latestPersonSeq: 1 }),
    )
    expect(later).toHaveLength(1)
    expect(later[0]).toContain('早于')

    const seen = validate(
      input({ status: 'done', evidence: [11] }),
      context({ history: from(rows), entries: [entry({ ts: 4_500 })] }),
    )
    expect(seen).toHaveLength(1)

    expect(
      validate(
        input({ status: 'done', evidence: [12] }),
        context({ history: from(rows), latestPersonSeq: 1 }),
      ),
    ).toEqual([])
    // With no task start anywhere the time rule has nothing to compare against.
    const undated = validate(
      input({ status: 'done', evidence: [11] }),
      context({ history: from(rows), latestPersonSeq: null }),
    )
    expect(undated.join('\n')).not.toContain('早于')
  })

  test('superseded needs another task to point at', () => {
    expect(validate(input({ status: 'superseded' }), context())[0]).toContain('superseded_by')
    expect(
      validate(input({ status: 'superseded', superseded_by: '  ' }), context())[0],
    ).toContain('superseded_by')
    expect(
      validate(input({ task_id: 't1', status: 'superseded', superseded_by: 't1' }), context())[0],
    ).toContain('不能是任务自己')
  })

  test('request_ref must be a person prompt or the hand-off that gave the task', () => {
    const rows = [
      person(),
      person({ seq: 2, uuid: 'u-2', role: 'assistant', isPerson: undefined }),
      person({ seq: 3, uuid: 'u-3', isPerson: undefined, origin: 'coordinator', text: '<relay from="coordinator">清理项目</relay>' }),
      person({ seq: 4, uuid: 'u-4', isPerson: undefined, origin: 'task-notification', text: '<task-notification>done</task-notification>' }),
      // As the engine files a hand-off on the person's machine: no origin it can name, told by its opening.
      person({ seq: 5, uuid: 'u-5', isPerson: undefined, origin: 'unclassified', text: '<relay from="coordinator" reason="spawn">清理项目</relay>' }),
      // An imported row carries no origin at all, and a reminder may sit before the tag.
      person({ seq: 6, uuid: 'u-6', isPerson: undefined, text: '<system-reminder>开场</system-reminder>\n<relay session="s1" from="coordinator">清理项目</relay>' }),
      // Unnamed origin, other words: nobody's task.
      person({ seq: 7, uuid: 'u-7', isPerson: undefined, origin: 'unclassified', text: '来路不明的一行' }),
      // The tag quoted by a row another origin vouches for, or outside the prompt door, is not a hand-off.
      person({ seq: 8, uuid: 'u-8', isPerson: undefined, origin: 'peer', text: '<relay from="coordinator">清理项目</relay>' }),
      person({ seq: 9, uuid: 'u-9', isPerson: undefined, door: 'attachment', text: '<relay from="coordinator">清理项目</relay>' }),
    ]
    expect(validate(input({ request_ref: 2 }), context({ history: from(rows) }))[0]).toContain('不是真人')
    expect(validate(input({ request_ref: 99 }), context({ history: from(rows) }))[0]).toContain('不存在')
    expect(validate(input({ request_ref: 1 }), context({ history: from(rows) }))).toEqual([])
    expect(validate(input({ request_ref: 3 }), context({ history: from(rows) }))).toEqual([])
    expect(validate(input({ request_ref: 4 }), context({ history: from(rows) }))[0]).toContain('不是真人')
    expect(validate(input({ request_ref: 5 }), context({ history: from(rows) }))).toEqual([])
    expect(validate(input({ request_ref: 6 }), context({ history: from(rows) }))).toEqual([])
    for (const seq of [7, 8, 9]) {
      expect(validate(input({ request_ref: seq }), context({ history: from(rows) }))[0]).toContain('不是真人')
    }
  })

  test('an omitted request_ref is never refused, whatever the session has seen', () => {
    expect(validate(input(), context({ latestPersonSeq: null }))).toEqual([])
    expect(validate(input(), context({ latestPersonSeq: null, latestRelaySeq: 3 }))).toEqual([])
  })

  test('evidence is dated against the hand-off when no person has asked', () => {
    const rows = [
      person({ seq: 1, isPerson: undefined, origin: 'coordinator', ts: 5_000 }),
      tool({ seq: 11, ts: 4_000 }),
      tool({ seq: 12, ts: 6_000 }),
    ]
    const relayOnly = { history: from(rows), latestPersonSeq: null, latestRelaySeq: 1 }
    const early = validate(input({ status: 'done', evidence: [11] }), context(relayOnly))[0]
    expect(early).toContain('早于')
    // The refusal names the row the evidence was measured against, and how to point elsewhere.
    expect(early).toContain('默认对应的请求 #1')
    expect(validate(input({ status: 'done', evidence: [11], request_ref: 1 }), context(relayOnly))[0]).toContain('request_ref 指向的 #1')
    const booked = context({ ...relayOnly, entries: [entry({ seq: 3, ts: 4_500 })] })
    expect(validate(input({ status: 'done', evidence: [11] }), booked)[0]).toContain('第一条记录 #L3')
    expect(validate(input({ status: 'done', evidence: [12] }), context(relayOnly))).toEqual([])
  })

  test('anchors are capped, kept non-empty, and checked against the file', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      path: 'a.ts',
      match: `line ${index}`,
      note: '',
    }))
    expect(validate(input({ anchors: many }), context())[0]).toContain('最多 8 个')

    const blank = validate(input({ anchors: [{ path: ' ', match: '', note: '' }] }), context())
    expect(blank.join('\n')).toContain('path')
    expect(blank.join('\n')).toContain('match')

    const longMatch = validate(
      input({ anchors: [{ path: 'a.ts', match: 'x'.repeat(301), note: '' }] }),
      context(),
    )
    expect(longMatch[0]).toContain('300')

    const at = (check: 'missing-file' | 'no-match' | 'ambiguous') =>
      validate(input({ anchors: [{ path: 'a.ts', match: 'const x', note: '' }] }), context({ checkAnchor: () => check }))
    expect(at('missing-file')[0]).toContain('文件不存在')
    expect(at('no-match')[0]).toContain('找不到')
    expect(at('ambiguous')[0]).toContain('多次')
  })
})

describe('stamp', () => {
  test('fills seq, time, window and the request the entry belongs to', () => {
    const stamped = stamp(input(), { seq: 7, ts: 9_000, window: 2, latestPersonSeq: 5 })
    expect(stamped.seq).toBe(7)
    expect(stamped.ts).toBe(9_000)
    expect(stamped.window).toBe(2)
    expect(stamped.request_ref).toBe(5)
  })

  test('an explicit request_ref wins, and a missing person prompt falls back to 0', () => {
    expect(stamp(input({ request_ref: 3 }), { seq: 1, ts: 1, window: 1, latestPersonSeq: 5 }).request_ref).toBe(3)
    expect(stamp(input(), { seq: 1, ts: 1, window: 1, latestPersonSeq: null }).request_ref).toBe(0)
  })

  test('an omitted request_ref takes whichever came last, the person’s prompt or the hand-off', () => {
    const at = { seq: 1, ts: 1, window: 1 }
    expect(stamp(input(), { ...at, latestPersonSeq: null, latestRelaySeq: 4 }).request_ref).toBe(4)
    expect(stamp(input(), { ...at, latestPersonSeq: 2, latestRelaySeq: 4 }).request_ref).toBe(4)
    expect(stamp(input(), { ...at, latestPersonSeq: 6, latestRelaySeq: 4 }).request_ref).toBe(6)
    expect(stamp(input(), { ...at, latestPersonSeq: null, latestRelaySeq: null }).request_ref).toBe(0)
  })

  test('optional fields left out are absent, never undefined', () => {
    const stamped = stamp(input({ next_step: '跑测试' }), {
      seq: 1,
      ts: 1,
      window: 1,
      latestPersonSeq: 5,
    })
    expect(stamped.next_step).toBe('跑测试')
    expect('anchors' in stamped).toBe(false)
    expect('evidence' in stamped).toBe(false)
    expect('superseded_by' in stamped).toBe(false)
    expect((Object.values(stamped) as unknown[]).includes(undefined)).toBe(false)
    expect(JSON.parse(JSON.stringify(stamped))).toEqual(stamped)
  })
})

describe('tasksOf', () => {
  test('one task keeps first-seen order and takes its latest title and status', () => {
    const entries = [
      entry({ task_id: 't1', title: '改登录页', status: 'in_progress', seq: 1, ts: 100 }),
      entry({ task_id: 't2', title: '写文档', status: 'in_progress', seq: 2, ts: 200 }),
      entry({ task_id: 't1', title: '改登录页并发邮件', status: 'done', seq: 3, ts: 300, evidence: [10] }),
    ]
    const tasks = tasksOf(entries)
    expect(tasks.map(task => task.taskId)).toEqual(['t1', 't2'])
    expect(tasks[0]?.title).toBe('改登录页并发邮件')
    expect(tasks[0]?.status).toBe('done')
    expect(tasks[0]?.first).toBe(entries[0])
    expect(tasks[0]?.latest).toBe(entries[2])
    expect(tasks[0]?.entries).toHaveLength(2)
    expect(tasks[1]?.first).toBe(entries[1])
  })
})

describe('hasFreshEntry', () => {
  test('only counts this window, at or after the mark', () => {
    const entries = [
      entry({ seq: 1, ts: 100, window: 1 }),
      entry({ seq: 2, ts: 500, window: 2 }),
    ]
    expect(hasFreshEntry(entries, 100, 1)).toBe(true)
    expect(hasFreshEntry(entries, 101, 1)).toBe(false)
    expect(hasFreshEntry(entries, 500, 2)).toBe(true)
    expect(hasFreshEntry(entries, 0, 2)).toBe(true)
    expect(hasFreshEntry([], 0, 2)).toBe(false)
  })
})

describe('renderHome', () => {
  const requests = [
    person({ seq: 1, ts: 1_000, text: '先改登录页' }),
    person({ seq: 2, uuid: 'u-2', ts: 1_500, text: '再补一版文档' }),
  ]

  test('always carries every request verbatim, with its seq and time', () => {
    const text = renderHome({ window: 3, entries: [], requests, archive: [] }, DEFAULTS)
    expect(text).toContain('第 3 个窗口')
    expect(text).toContain('上一个是第 2 个')
    expect(text).toContain('[#1]')
    expect(text).toContain('先改登录页')
    expect(text).toContain('[#2]')
    expect(text).toContain('再补一版文档')
    expect(text).toContain('无')
  })

  test('the first window never talks about a previous one', () => {
    const text = renderHome({ window: 1, entries: [], requests, archive: [] }, DEFAULTS)
    expect(text).toContain('当前是第 1 个窗口')
    expect(text).not.toContain('上一个')
  })

  test('a hand-off is shown apart from the requests, and only when one is given', () => {
    const relay = person({ seq: 7, ts: 2_000, isPerson: undefined, origin: 'coordinator', text: '协调者：先盘点再清理' })
    const text = renderHome({ window: 2, entries: [], requests: [], relay, archive: [] }, DEFAULTS)
    expect(text).toContain('## 最近的用户请求\n无')
    expect(text).toContain('## 派发来的任务')
    expect(text).toContain('[#7]')
    expect(text).toContain('协调者：先盘点再清理')
    expect(text.indexOf('## 派发来的任务')).toBeLessThan(text.indexOf('## 进行中 / 受阻的任务'))

    expect(renderHome({ window: 2, entries: [], requests, archive: [] }, DEFAULTS)).not.toContain('派发来的任务')
  })

  test('an over-long request is cut and tells the model where to read the rest', () => {
    const long = person({ seq: 4, text: '甲'.repeat(2_500) })
    const text = renderHome({ window: 2, entries: [], requests: [long], archive: [] }, DEFAULTS)
    expect(text).toContain('原文更长，用 history 读 #4')
    expect(text).not.toContain('甲'.repeat(2_001))
  })

  test('a short request is shown with the reply it answered, a long one is not', () => {
    const reply: HistoryRecord = { seq: 7, uuid: 'a-7', ts: 900, window: 1, role: 'assistant', text: `方案有两个。\n${'乙'.repeat(400)}\n要不要我先申请换窗？` }
    const short = person({ seq: 8, text: '可以' })
    const long = person({ seq: 9, uuid: 'u-9', text: '丙'.repeat(31) })
    const answered = new Map([
      [8, reply],
      [9, reply],
    ])
    const text = renderHome({ window: 2, entries: [], requests: [short, long], answered, archive: [] }, DEFAULTS)
    const lines = text.split('\n').filter(line => line.includes('回复的是助手'))
    expect(lines).toHaveLength(1)
    expect(text.indexOf(lines[0] ?? '')).toBeGreaterThan(text.indexOf('[#8]'))
    expect(text.indexOf(lines[0] ?? '')).toBeLessThan(text.indexOf('[#9]'))
    // Where it opened and where it ended, on one line, with the number to read the rest by.
    expect(lines[0]).toContain('[#7]')
    expect(lines[0]).toContain('方案有两个。')
    expect(lines[0]).toContain('要不要我先申请换窗？')
    expect(lines[0]).not.toContain('乙'.repeat(300))
  })

  test('a request typed mid-turn says so', () => {
    const typed = person({ seq: 5, door: 'delivery', name: 'queued_command', text: '长消息是指？' })
    const text = renderHome({ window: 2, entries: [], requests: [person(), typed], archive: [] }, DEFAULTS)
    expect(text).toContain('（回合进行中插入）长消息是指？')
    expect(text.split('回合进行中插入')).toHaveLength(2)
  })

  test('open and blocked tasks come with their latest note and next step', () => {
    const entries = [
      entry({ task_id: 't1', status: 'in_progress', title: '改登录页', text: '已在改表单', next_step: '跑一遍测试', seq: 1, ts: 100 }),
      entry({ task_id: 't2', status: 'blocked', title: '部署', text: '等权限', seq: 2, ts: 200 }),
      entry({ task_id: 't3', status: 'done', title: '写日志', seq: 3, ts: 300, evidence: [10] }),
    ]
    const text = renderHome({ window: 2, entries, requests, archive: [] }, DEFAULTS)
    expect(text).toContain('t1')
    expect(text).toContain('跑一遍测试')
    expect(text).toContain('已在改表单')
    expect(text).toContain('t2')
    expect(text).toContain('等权限')
    expect(text).toContain('已完成')
    expect(text).toContain('写日志')
  })

  test('superseded tasks are told apart from the ones still to do', () => {
    const entries = [
      entry({ task_id: 't1', status: 'superseded', title: '旧登录页改法', superseded_by: 't2', seq: 1, ts: 100 }),
      entry({ task_id: 't2', status: 'in_progress', title: '新登录页改法', seq: 2, ts: 200 }),
    ]
    const text = renderHome({ window: 2, entries, requests, archive: [] }, DEFAULTS)
    expect(text).toContain('不要继续这些（已被取代）')
    expect(text).toContain('旧登录页改法')
    expect(text).toContain('t2')
    const section = text.slice(text.indexOf('不要继续这些'))
    expect(section).toContain('旧登录页改法')
    expect(section).not.toContain('新登录页改法')
  })

  test('archive pages are listed with their seq range and dates', () => {
    const archive: ArchivePage[] = [
      { page: 1, titles: ['旧任务'], fromSeq: 1, toSeq: 9, fromTs: 0, toTs: 86_400_000 },
    ]
    const text = renderHome({ window: 4, entries: [], requests, archive }, DEFAULTS)
    expect(text).toContain('归档目录')
    expect(text).toContain('第 1 页')
    expect(text).toContain('#1-9')
    expect(text).toContain('1970-01-01')
    expect(text).toContain('1970-01-02')
  })

  test('past the cap it drops the oldest extras but never the requests or open work', () => {
    const open = entry({
      task_id: 't-open',
      status: 'in_progress',
      title: '改登录页',
      text: '在改首页',
      next_step: '跑一遍测试',
      seq: 7,
      ts: 7_000,
    })
    const config = { ...DEFAULTS }
    const full = renderHome({ window: 2, entries: [open], requests, archive: [] }, DEFAULTS)
    config.homeTokens = estimateTokens(full) + 30

    const done = [1, 2, 3].map(index =>
      entry({
        task_id: `done-${index}`,
        status: 'done',
        title: '已完成的任务'.repeat(8) + index,
        text: '做完了',
        evidence: [10],
        seq: 10 + index,
        ts: 8_000 + index,
      }),
    )
    const archive: ArchivePage[] = [1, 2, 3].map(page => ({
      page,
      titles: ['归档标题'.repeat(10)],
      fromSeq: page * 10,
      toSeq: page * 10 + 9,
      fromTs: page * 86_400_000,
      toTs: page * 86_400_000 + 3_600_000,
    }))
    const text = renderHome({ window: 2, entries: [...done, open], requests, archive }, config)
    expect(estimateTokens(text)).toBeLessThanOrEqual(config.homeTokens)
    expect(text).toContain('先改登录页')
    expect(text).toContain('再补一版文档')
    expect(text).toContain('t-open')
    expect(text).toContain('跑一遍测试')
    expect(text).toContain('已省略')
  })

  test('a single note renders exactly as the latest line', () => {
    const entries = [entry({ task_id: 't1', text: '已在改表单', seq: 1, ts: 100, next_step: '跑一遍测试' })]
    const text = renderHome({ window: 2, entries, requests, archive: [] }, DEFAULTS)
    expect(text).toContain('- t1：改登录页（进行中）\n  - 最新：已在改表单\n  - 下一步：跑一遍测试')
    expect(text).not.toContain('记录（')
  })

  test('two notes from the same window show oldest first, numbered as the ledger reads them', () => {
    const entries = [
      entry({ task_id: 't1', text: '调研结论：走旧接口', seq: 12, ts: 100 }),
      entry({ task_id: 't1', text: '管线事实：两段式', seq: 13, ts: 200, next_step: '跑一遍测试' }),
    ]
    const text = renderHome({ window: 2, entries, requests, archive: [] }, DEFAULTS)
    expect(text).toContain('  - 记录（同一窗口写的 2 条，旧→新）：')
    expect(text).toContain('    - #L12：调研结论：走旧接口')
    expect(text).toContain('    - #L13：管线事实：两段式')
    expect(text.indexOf('#L12')).toBeLessThan(text.indexOf('#L13'))
    expect(text).not.toContain('  - 最新：')
    // The next step still comes from the latest note, after the notes.
    expect(text.indexOf('  - 下一步：跑一遍测试')).toBeGreaterThan(text.indexOf('#L13'))
  })

  test('three or more notes keep only the newest three', () => {
    const entries = [1, 2, 3, 4].map(index =>
      entry({ task_id: 't1', text: `第${index}条记录`, seq: index, ts: index * 100 }),
    )
    const text = renderHome({ window: 2, entries, requests, archive: [] }, DEFAULTS)
    expect(text).toContain('同一窗口写的 3 条')
    expect(text).not.toContain('第1条记录')
    expect(text).toContain('#L2：第2条记录')
    expect(text).toContain('#L4：第4条记录')
  })

  test('the combined text is held to 3000 characters and the oldest note goes first', () => {
    const entries = [
      entry({ task_id: 't1', text: '甲'.repeat(2_000), seq: 1, ts: 100 }),
      entry({ task_id: 't1', text: '乙'.repeat(900), seq: 2, ts: 200 }),
      entry({ task_id: 't1', text: '丙'.repeat(1_500), seq: 3, ts: 300 }),
    ]
    const text = renderHome({ window: 2, entries, requests, archive: [] }, DEFAULTS)
    expect(text).toContain('同一窗口写的 2 条')
    expect(text).not.toContain('#L1：')
    expect(text).toContain(`#L2：${'乙'.repeat(900)}`)
    expect(text).toContain(`#L3：${'丙'.repeat(1_500)}`)
  })

  test('a latest note over the budget on its own is still shown whole', () => {
    const entries = [
      entry({ task_id: 't1', text: '甲'.repeat(100), seq: 1, ts: 100 }),
      entry({ task_id: 't1', text: '丙'.repeat(3_500), seq: 2, ts: 200 }),
    ]
    const text = renderHome({ window: 2, entries, requests, archive: [] }, DEFAULTS)
    expect(text).toContain(`  - 最新：${'丙'.repeat(3_500)}`)
    expect(text).not.toContain('甲'.repeat(10))
  })

  test('notes from an earlier window fill what the latest window leaves, tagged with their window', () => {
    const entries = [
      entry({ task_id: 't1', text: '上个窗口的旧笔记', seq: 5, window: 1, ts: 100 }),
      entry({ task_id: 't1', text: '本窗口的新笔记', seq: 6, window: 2, ts: 200 }),
    ]
    const text = renderHome({ window: 3, entries, requests, archive: [] }, DEFAULTS)
    expect(text).toContain('    - #L5（第 1 个窗口）：上个窗口的旧笔记')
    expect(text).toContain('    - #L6：本窗口的新笔记')
    expect(text.indexOf('#L5')).toBeLessThan(text.indexOf('#L6'))
    expect(text).not.toContain('  - 最新：')
  })

  test('the earlier windows never push past the count cap, and the latest window is taken first', () => {
    const entries = [
      entry({ task_id: 't1', text: '窗口一甲', seq: 1, window: 1, ts: 100 }),
      entry({ task_id: 't1', text: '窗口一乙', seq: 2, window: 1, ts: 200 }),
      entry({ task_id: 't1', text: '窗口二甲', seq: 3, window: 2, ts: 300 }),
      entry({ task_id: 't1', text: '窗口二乙', seq: 4, window: 2, ts: 400 }),
    ]
    const text = renderHome({ window: 3, entries, requests, archive: [] }, DEFAULTS)
    expect(text).not.toContain('窗口一甲')
    expect(text).toContain('#L2（第 1 个窗口）：窗口一乙')
    expect(text).toContain('#L3：窗口二甲')
    expect(text).toContain('#L4：窗口二乙')
  })

  test('the 3000 character budget also holds across windows', () => {
    const entries = [
      entry({ task_id: 't1', text: '甲'.repeat(2_900), seq: 1, window: 1, ts: 100 }),
      entry({ task_id: 't1', text: '乙'.repeat(500), seq: 2, window: 2, ts: 200 }),
    ]
    const text = renderHome({ window: 3, entries, requests, archive: [] }, DEFAULTS)
    expect(text).not.toContain('甲'.repeat(10))
    expect(text).toContain(`  - 最新：${'乙'.repeat(500)}`)
  })
})

describe('renderHome with many open tasks', () => {
  const requests = [person({ seq: 1, ts: 1_000, text: '先改登录页' })]
  /** `count` open tasks whose first-seen order is the reverse of their recency: k1 is the oldest-touched, listed first. */
  const open = (count: number, extra: (index: number) => Partial<LedgerEntry> = () => ({})): LedgerEntry[] =>
    Array.from({ length: count }, (_, at) => {
      const index = at + 1

      return entry({ task_id: `k${index}`, title: `任务${index}`, text: `任务${index}的进展`, seq: index, ts: index * 100, next_step: `任务${index}的下一步`, ...extra(index) })
    })

  test('five open tasks are all shown in full, with no summary line', () => {
    const text = renderHome({ window: 2, entries: open(5), requests, archive: [] }, DEFAULTS)
    for (let index = 1; index <= 5; index += 1) expect(text).toContain(`  - 最新：任务${index}的进展`)
    expect(text).not.toContain('只显示了摘要')
    expect(text).not.toContain('最新 #L')
  })

  test('eight open tasks: the five newest in full, newest first, then three summaries and the count', () => {
    const text = renderHome({ window: 2, entries: open(8), requests, archive: [] }, DEFAULTS)
    for (const index of [8, 7, 6, 5, 4]) expect(text).toContain(`  - 最新：任务${index}的进展`)
    for (const index of [3, 2, 1]) {
      expect(text).toContain(`  - 最新 #L${index}：任务${index}的进展`)
      expect(text).toContain(`- k${index}：任务${index}（进行中）\n  - 最新 #L${index}：任务${index}的进展\n  - 下一步：任务${index}的下一步`)
      expect(text).not.toContain(`  - 最新：任务${index}的进展`)
    }
    const order = [8, 7, 6, 5, 4, 3, 2, 1].map(index => text.indexOf(`- k${index}：`))
    expect([...order].sort((left, right) => left - right)).toEqual(order)
    expect(text).toContain('（还有 3 个较早更新的任务只显示了摘要，完整记录用 ledger_read 按 task_id 查）')
    expect(text.indexOf('只显示了摘要')).toBeGreaterThan(text.indexOf('- k1：'))
  })

  test('a summary clips a long note and a long next step at 200 characters, and a carried next step keeps its source', () => {
    const entries = [
      entry({ task_id: 'old', title: '很早的', seq: 1, ts: 100, next_step: '旧计划' }),
      entry({ task_id: 'old', title: '很早的', seq: 2, ts: 150, text: '长'.repeat(300) }),
      entry({ task_id: 'far', title: '更早的', seq: 3, ts: 120, text: '短', next_step: '步'.repeat(250) }),
      ...open(5, index => ({ seq: 10 + index, ts: 1_000 + index })),
    ]
    const text = renderHome({ window: 2, entries, requests, archive: [] }, DEFAULTS)
    expect(text).toContain(`  - 最新 #L2：${'长'.repeat(200)}……`)
    expect(text).not.toContain('长'.repeat(201))
    expect(text).toContain('  - 下一步（沿用 #L1 的记录，可能已过时）：旧计划')
    expect(text).toContain(`  - 下一步：${'步'.repeat(200)}……`)
    expect(text).not.toContain('步'.repeat(201))
    expect(text).toContain('（还有 2 个较早更新的任务只显示了摘要')
  })

  test('eight tasks with three long notes each stay well under the cost of showing them all in full', () => {
    const long = (index: number): Partial<LedgerEntry>[] => [1, 2, 3].map(note => ({ task_id: `k${index}`, title: `任务${index}`, text: `${note}`.repeat(1_000), seq: index * 10 + note, ts: index * 100 + note, next_step: '继续' }))
    const entries = [1, 2, 3, 4, 5, 6, 7, 8].flatMap(index => long(index).map(extra => entry(extra)))
    const bounded = renderHome({ window: 2, entries, requests, archive: [] }, DEFAULTS)
    const fiveOnly = renderHome({ window: 2, entries: entries.filter(one => Number(one.task_id.slice(1)) > 3), requests, archive: [] }, DEFAULTS)
    // Three tasks beyond the five add only their short summaries, never their long notes.
    expect(estimateTokens(bounded)).toBeLessThan(estimateTokens(fiveOnly) + 400)
    expect(estimateTokens(bounded)).toBeLessThan(estimateTokens(fiveOnly) * 1.2)
    expect(bounded).toContain(`  - 最新 #L33：${'3'.repeat(200)}……`)
  })
})

describe('an omitted next_step and anchors mean unchanged', () => {
  const requests = [person({ seq: 1, ts: 1_000, text: '先改登录页' })]
  const anchor: Anchor = { path: 'src/a.ts', match: 'const a = 1', note: '这里' }

  test('tasksOf resolves to the newest entry that gave the field, and says which one', () => {
    const [task] = tasksOf([
      entry({ seq: 1, ts: 100, next_step: '跑测试', anchors: [anchor] }),
      entry({ seq: 2, ts: 200 }),
      entry({ seq: 3, ts: 300, next_step: '改文档' }),
      entry({ seq: 4, ts: 400 }),
    ])
    expect(task?.nextStep).toEqual({ value: '改文档', seq: 3, isInherited: true })
    expect(task?.anchors).toEqual({ value: [anchor], seq: 1, isInherited: true })

    const [own] = tasksOf([entry({ seq: 1, next_step: '自己的', anchors: [anchor] })])
    expect(own?.nextStep?.isInherited).toBe(false)
    expect(own?.anchors?.isInherited).toBe(false)
  })

  test('an empty string or an empty array clears and ends the search', () => {
    const [task] = tasksOf([
      entry({ seq: 1, ts: 100, next_step: '跑测试', anchors: [anchor] }),
      entry({ seq: 2, ts: 200, status: 'blocked', next_step: '', anchors: [] }),
      entry({ seq: 3, ts: 300, status: 'blocked' }),
    ])
    expect(task?.nextStep).toBeUndefined()
    expect(task?.anchors).toBeUndefined()
  })

  test('a done or superseded task carries nothing, and a closed entry stops the search', () => {
    const done = tasksOf([entry({ seq: 1, next_step: '跑测试', anchors: [anchor] }), entry({ seq: 2, status: 'done', evidence: [3] })])
    expect(done[0]?.nextStep).toBeUndefined()
    expect(done[0]?.anchors).toBeUndefined()
    const gone = tasksOf([entry({ seq: 1, next_step: '跑测试' }), entry({ seq: 2, status: 'superseded' })])
    expect(gone[0]?.nextStep).toBeUndefined()

    const reopened = tasksOf([
      entry({ seq: 1, next_step: '旧计划' }),
      entry({ seq: 2, status: 'done', evidence: [3] }),
      entry({ seq: 3 }),
    ])
    expect(reopened[0]?.nextStep).toBeUndefined()
  })

  test('the home page marks a carried next step with its source and leaves an own one alone', () => {
    const carried = renderHome(
      {
        window: 3,
        entries: [entry({ seq: 32, ts: 100, window: 1, next_step: '跑测试' }), entry({ seq: 33, ts: 200, window: 2, text: '补记' })],
        requests,
        archive: [],
      },
      DEFAULTS,
    )
    expect(carried).toContain('  - 下一步（沿用 #L32 的记录，可能已过时）：跑测试')

    const own = renderHome(
      { window: 3, entries: [entry({ seq: 32, ts: 100, next_step: '跑测试' })], requests, archive: [] },
      DEFAULTS,
    )
    expect(own).toContain('  - 下一步：跑测试')
    expect(own).not.toContain('沿用')

    const cleared = renderHome(
      { window: 3, entries: [entry({ seq: 1, next_step: '跑测试' }), entry({ seq: 2, status: 'blocked', next_step: '' })], requests, archive: [] },
      DEFAULTS,
    )
    expect(cleared).not.toContain('下一步')
  })

  test('validation counts a carried next step, but not one a clear removed', () => {
    const before = entry({ seq: 1, next_step: '跑测试' })
    const { next_step: _omitted, ...bare } = input()
    expect(validate(wrong(bare), context({ entries: [before] }))).toEqual([])
    const cleared = entry({ seq: 2, status: 'blocked', next_step: '' })
    expect(validate(wrong(bare), context({ entries: [before, cleared] })).join()).toContain('必须写 next_step')
  })
})

describe('turnPage', () => {
  const closed = entry({ task_id: 't-done', status: 'done', title: '做完的', evidence: [10], seq: 1, ts: 100, text: 'x'.repeat(80) })
  const bare = entry({ task_id: 't-bare', status: 'done', title: '没证据的', seq: 2, ts: 200, text: 'x'.repeat(80) })
  const dead = entry({ task_id: 't-dead', status: 'superseded', superseded_by: 't-open', seq: 3, ts: 300, text: 'x'.repeat(80) })
  const open = entry({ task_id: 't-open', status: 'in_progress', seq: 4, ts: 400, text: 'x'.repeat(80) })
  const stuck = entry({ task_id: 't-stuck', status: 'blocked', seq: 5, ts: 500, text: 'x'.repeat(80) })
  const kept = entry({ task_id: 't-keep', status: 'done', title: '保留的', evidence: [10], seq: 6, ts: 600, text: 'x'.repeat(80) })
  const all = [closed, bare, dead, open, stuck, kept]

  test('under the cap nothing moves and the rows are the same objects', () => {
    const { keep, moved } = turnPage([open], new Set(), DEFAULTS)
    expect(moved).toEqual([])
    expect(keep).toHaveLength(1)
    expect(keep[0]).toBe(open)
  })

  test('over the cap the closed tasks move whole, protected and open ones stay', () => {
    const { keep, moved } = turnPage(all, new Set(['t-keep']), { ...DEFAULTS, pageTokens: 10 })
    expect(moved.map(row => row.seq)).toEqual([1, 3])
    expect(keep.map(row => row.seq)).toEqual([2, 4, 5, 6])
    expect(moved[0]).toBe(closed)
    expect(keep.find(row => row.seq === 4)).toBe(open)
  })
})

describe('pageOf and archiveName', () => {
  test('an empty page has no range at all', () => {
    expect(pageOf(3, [])).toEqual({ page: 3, titles: [], fromSeq: 0, toSeq: 0, fromTs: 0, toTs: 0 })
  })

  test('a page lists each task once, by its latest title, in first-seen order', () => {
    const moved = [
      entry({ task_id: 't1', title: '旧标题', seq: 1, ts: 500 }),
      entry({ task_id: 't2', title: '另一个', seq: 2, ts: 100 }),
      entry({ task_id: 't1', title: '新标题', seq: 3, ts: 900 }),
    ]
    const page = pageOf(2, moved)
    expect(page.titles).toEqual(['新标题', '另一个'])
    expect(page.page).toBe(2)
    expect(page.fromSeq).toBe(1)
    expect(page.toSeq).toBe(3)
    expect(page.fromTs).toBe(100)
    expect(page.toTs).toBe(900)
  })

  test('archive files are numbered to three digits', () => {
    expect(archiveName(1)).toBe('archive-001.jsonl')
    expect(archiveName(12)).toBe('archive-012.jsonl')
    expect(archiveName(123)).toBe('archive-123.jsonl')
  })
})

describe('review fixes', () => {
  const rows = [person(), tool()]
  const history = from(rows)

  test('anchors that are not an array are reported, not silently accepted', () => {
    const problems = validate(wrong({ ...input(), anchors: 'src/a.ts' }), context({ history }))
    expect(problems.join('\n')).toContain('anchors 必须是数组')
    expect('anchors' in stamp(wrong({ ...input(), anchors: 'src/a.ts' }), meta)).toBe(false)
  })

  test('anchor fields that are not strings are reported, one line per anchor', () => {
    const junk = [null, 7, 'x', { path: 1, match: 2, note: 3 }] as unknown as Anchor[]
    const problems = validate(input({ anchors: junk }), context({ history }))
    expect(problems.join('\n')).toContain('锚点 1 必须是对象')
    expect(problems.join('\n')).toContain('锚点 4 的 path、match、note 必须是字符串')
    // A missing note and an empty note are both fine; only its type is checked.
    expect(validate(input({ anchors: [{ path: 'a.ts', match: 'x', note: '' }] }), context({ history }))).toEqual([])
    expect(validate(input({ anchors: [{ path: 'a.ts', match: 'x' } as Anchor] }), context({ history }))).toEqual([])
    expect(validate(input({ anchors: [{ path: 'a.ts', match: 'x', note: 5 } as unknown as Anchor] }), context({ history }))[0]).toContain('note 必须是字符串')
  })

  test('stamp keeps each anchor down to its three string fields', () => {
    const extra = { path: 'a.ts', match: 'const x', note: '注释', extra: 1, nested: { a: 1 } }
    const kept = stamp(input({ anchors: [extra as unknown as Anchor] }), meta)
    expect(kept.anchors).toEqual([{ path: 'a.ts', match: 'const x', note: '注释' }])
    expect(Object.keys(kept.anchors?.[0] ?? {})).toEqual(['path', 'match', 'note'])

    const messy = stamp(input({ anchors: [{ path: 'a.ts', match: 'x' } as Anchor, 5 as unknown as Anchor] }), meta)
    expect(messy.anchors).toEqual([{ path: 'a.ts', match: 'x', note: '' }])
  })

  test('text and every optional field must be the type it claims', () => {
    const problems = validate(
      wrong({
        task_id: 't1',
        title: 'x',
        status: 'in_progress',
        text: 42,
        next_step: 5,
        superseded_by: {},
        evidence: 7,
        request_ref: '1',
      }),
      context({ history }),
    )
    expect(problems).toHaveLength(5)
    expect(problems.join('\n')).toContain('text 必须是字符串')
    expect(problems.join('\n')).toContain('next_step 必须是字符串')
    expect(problems.join('\n')).toContain('superseded_by 必须是字符串')
    expect(problems.join('\n')).toContain('evidence 必须是历史编号的数组')
    expect(problems.join('\n')).toContain('request_ref 必须是历史编号')
    // An empty or blank text is a string but no longer allowed: it must carry the step's point.
    expect(validate(input({ text: '' }), context({ history })).join('\n')).toContain('text 不能为空')
    expect(validate(input({ text: '  \n ' }), context({ history })).join('\n')).toContain('text 不能为空')
  })

  test('evidence entries and request_ref must be finite whole numbers', () => {
    const problems = validate(
      input({ evidence: [1.5, '2', Number.NaN, 99] as unknown as number[], request_ref: 2.5 }),
      context({ history }),
    )
    expect(problems.join('\n')).toContain('有 3 项不是')
    expect(problems.join('\n')).toContain('request_ref 必须是历史编号')
    expect(validate(input({ request_ref: Number.POSITIVE_INFINITY }), context({ history }))[0]).toContain('有限整数')
  })

  test('stamp drops values of the wrong type instead of writing them', () => {
    const stamped = stamp(
      wrong({
        task_id: 't1',
        title: 'x',
        status: 'in_progress',
        text: ['a'],
        next_step: 5,
        superseded_by: 7,
        evidence: [1.5, 7, 'x'],
        request_ref: 2.5,
      }),
      { seq: 1, ts: 1, window: 1, latestPersonSeq: 5 },
    )
    expect(stamped.text).toBe('')
    expect(stamped.request_ref).toBe(5)
    expect(stamped.evidence).toEqual([7])
    expect('next_step' in stamped).toBe(false)
    expect('superseded_by' in stamped).toBe(false)
  })

  test('no JSON-shaped input makes validate or stamp throw', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      42,
      'ledger',
      [],
      [1, 2],
      {},
      { task_id: 7, title: null, status: {}, text: [] },
      { task_id: 't', title: 'x', status: 'in_progress', text: 'ok', anchors: 'a.ts' },
      {
        task_id: 't',
        title: 'x',
        status: 'in_progress',
        text: 'ok',
        anchors: [null, 1, 'x', [{}], { path: {}, match: () => 1 }, { path: 'a', match: 'b', note: null }],
      },
      { task_id: 't', title: 'x', status: 'in_progress', text: 'ok', evidence: { 0: 1 } },
      { task_id: 't', title: 'x', status: 'in_progress', text: 'ok', evidence: [Number.NaN, 2.5, '3'] },
      { task_id: 't', title: 'x', status: 'done', text: 'ok', request_ref: { seq: 1 } },
      {
        task_id: { nested: { deep: true } },
        title: ['a'],
        status: 3,
        text: 'x'.repeat(5_000),
        next_step: [],
        superseded_by: {},
      },
      JSON.parse(
        '{"task_id":"t","title":"x","status":"in_progress","text":"ok","__proto__":{"polluted":1},"constructor":{"x":1}}',
      ),
      JSON.parse('{"task_id":"t","title":"x","status":{"toString":1},"text":"ok","anchors":[{"path":"a","match":"b","note":null}]}'),
    ]

    for (const bad of malformed) {
      const problems = validate(wrong(bad), context({ history }))
      expect(Array.isArray(problems)).toBe(true)
      expect(problems.every(problem => typeof problem === 'string')).toBe(true)

      const stamped = stamp(wrong(bad), meta)
      expect(typeof stamped.task_id).toBe('string')
      expect(typeof stamped.title).toBe('string')
      expect(typeof stamped.text).toBe('string')
      expect(typeof stamped.request_ref).toBe('number')
      for (const value of Object.values(stamped) as unknown[]) {
        expect(
          typeof value === 'string' || typeof value === 'number' || Array.isArray(value),
        ).toBe(true)
      }
    }
    // A "__proto__" key in the parsed input never reaches Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('the superseded cut-off is counted in the omission note', () => {
    const old = Array.from({ length: 7 }, (_, index) =>
      entry({
        task_id: `old-${index}`,
        status: 'superseded',
        title: `旧任务 ${index}`,
        superseded_by: 't-open',
        seq: 20 + index,
        ts: 1_000 + index,
      }),
    )
    const open = entry({ task_id: 't-open', status: 'in_progress', title: '当前任务', seq: 40, ts: 5_000 })
    const text = renderHome(
      { window: 2, entries: [...old, open], requests: [person()], archive: [] },
      DEFAULTS,
    )
    expect(text).toContain('已省略 2 条，用 ledger_read 查看')
    expect(text.split('\n').filter(line => line.startsWith('- 旧任务'))).toHaveLength(5)
    expect(text).toContain('当前任务')
  })

  test('the omission note counts dropped list items only', () => {
    const done = [1, 2, 3].map(index =>
      entry({
        task_id: `d${index}`,
        status: 'done',
        title: '完成任务'.repeat(20) + index,
        evidence: [10],
        seq: 50 + index,
        ts: 100 + index,
      }),
    )
    const open = entry({ task_id: 't-open', status: 'in_progress', title: '当前', seq: 60, ts: 900 })
    const full = renderHome(
      { window: 1, entries: [...done, open], requests: [person()], archive: [] },
      DEFAULTS,
    )
    const config = { ...DEFAULTS, homeTokens: estimateTokens(full) - 60 }
    const text = renderHome({ window: 1, entries: [...done, open], requests: [person()], archive: [] }, config)
    const shown = text.split('\n').filter(line => line.startsWith('- 完成任务')).length
    const note = /已省略 (\d+) 条/.exec(text)
    expect(note).not.toBeNull()
    expect(Number(note?.[1])).toBe(3 - shown)
    expect(estimateTokens(text)).toBeLessThanOrEqual(config.homeTokens)
    expect(text).toContain('请把登录页改一下')
    expect(text).toContain('t-open')
  })
})


describe('what a ledger entry must carry', () => {
  const meta = { seq: 1, ts: 1, window: 1, latestPersonSeq: 5 }

  test('stamp writes through when it is given, and leaves the field out when it is not', () => {
    expect(stamp(input(), { ...meta, through: 42 }).through).toBe(42)
    expect('through' in stamp(input(), meta)).toBe(false)
  })

  test('an empty or blank text is refused in every status', () => {
    const rows = [person(), tool()]
    for (const status of ['in_progress', 'blocked', 'done'] as const) {
      const problems = validate(
        input({ status, text: ' \n', evidence: [10], next_step: '下一步' }),
        context({ history: from(rows) }),
      )
      expect(problems.join('\n')).toContain('text 不能为空')
    }
  })

  test('an in_progress entry needs a next_step: given now, or left out while the task already has one', () => {
    const missing = 'status 是 in_progress，必须写 next_step：换窗口后要接着做的下一步。任务做完了就标 done。'
    expect(validate(input({ next_step: undefined }), context())).toEqual([missing])
    expect(validate(input({ next_step: '   ' }), context())).toEqual([missing])

    const earlier = [entry({ task_id: 't1', next_step: '跑测试' })]
    expect(validate(input({ next_step: undefined }), context({ entries: earlier }))).toEqual([])
    // An explicit empty string is a decision to drop it, not an omission.
    expect(validate(input({ next_step: '' }), context({ entries: earlier }))).toEqual([missing])
    // Another task's next step does not count.
    expect(validate(input({ task_id: 't2', next_step: undefined }), context({ entries: earlier }))).toEqual([missing])
    // A blocked entry does not need one.
    expect(validate(input({ status: 'blocked', next_step: undefined }), context())).toEqual([])
  })
})
