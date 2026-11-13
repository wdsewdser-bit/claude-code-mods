import { describe, expect, test } from 'claude-code/testing'

import {
  backfillRoundOf,
  fitBackfillInput,
  isBackfillPending,
  mayTry,
  MAX_TEXT_CHARS,
  noteAttempt,
  parseBackfillOutput,
  pendingOf,
  PENDING_FILE,
  stateOf,
  taskLinesOf,
  withBackfillPrefix,
} from '../hooks/lib/backfill.ts'
import { renderHome, tasksOf } from '../hooks/lib/ledger.ts'
import { createSession } from '../hooks/lib/session.ts'
import type { Env, Io, Session } from '../hooks/lib/session.ts'
import { DEFAULTS, parseJsonl } from '../hooks/lib/types.ts'
import type { HistoryRecord, LedgerEntry } from '../hooks/lib/types.ts'

const DIR = '/ctx'
const out = (): Env => ({ tokens: 10_000, limit: 100_000, cache: null, fiveHourPercent: undefined })

/** Which round a check named, and why it named none: the union says one or the other. */
const roundOf = (check: ReturnType<typeof backfillRoundOf>) => ('round' in check ? check.round : undefined)
const reasonOf = (check: ReturnType<typeof backfillRoundOf>) => ('reason' in check ? check.reason : '')

const person = (seq: number, text = '改登录页'): HistoryRecord => ({
  seq,
  uuid: `p${seq}`,
  ts: 1_000 + seq * 1_000,
  window: 1,
  role: 'user',
  isPerson: true,
  text,
})

const tool = (seq: number, name = 'Edit', text = 'ok'): HistoryRecord => ({
  seq,
  uuid: `t${seq}`,
  ts: 1_000 + seq * 1_000,
  window: 1,
  role: 'tool',
  tool: name,
  text,
})

const reply = (seq: number, text = '改好了'): HistoryRecord => ({
  seq,
  uuid: `a${seq}`,
  ts: 1_000 + seq * 1_000,
  window: 1,
  role: 'assistant',
  text,
})

const entryOf = (extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  task_id: 'fix-login',
  title: '改登录页',
  status: 'in_progress',
  text: '改了按钮',
  seq: 1,
  ts: 2_000,
  window: 1,
  request_ref: 1,
  next_step: '接着改表单',
  ...extra,
})

type Box = {
  files: Map<string, string>
  io: Io
  advance: (ms: number) => void
}

/** The host's file system in memory; `remove` is left out when a host cannot delete. */
const makeIo = (withRemove = true): Box => {
  const files = new Map<string, string>()
  let clock = 100_000
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
  if (withRemove) {
    io.remove = async path => {
      files.delete(path)
    }
  }

  return { files, io, advance: ms => (clock += ms) }
}

/** One round that did work and never booked it: #1 the person's ask, #2-#4 three calls, #5 the next ask. */
const sessionWithRound = async (box: Box): Promise<Session> => {
  const session = createSession(DIR, box.io, DEFAULTS)
  await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '把登录页的按钮改成蓝色' })
  box.advance(1_000)
  await session.record({ uuid: 't2', role: 'tool', tool: 'Edit', path: 'src/login.ts', text: 'edited ok' })
  await session.record({ uuid: 't3', role: 'tool', tool: 'Bash', text: 'tests pass' })
  await session.record({ uuid: 't4', role: 'tool', tool: 'Read', path: 'src/login.ts', text: 'read the form' })
  box.advance(1_000)
  await session.record({ uuid: 'p5', role: 'user', isPerson: true, text: '接着做' })

  return session
}

const ledgerOf = (box: Box, name = 'ledger.jsonl'): LedgerEntry[] =>
  parseJsonl<LedgerEntry>(box.files.get(`${DIR}/${name}`) ?? '')

const pendingOfRound = (entries: Partial<LedgerEntry>[]): unknown => ({
  round: 1,
  window: 1,
  ts: 4_000,
  through: 4,
  entries: entries.map(entry => ({
    task_id: 'fix-login',
    title: '改登录页',
    status: 'in_progress',
    text: '按钮改成了蓝色，测试通过',
    ...entry,
  })),
})

describe('backfillRoundOf', () => {
  test('the round that ended when the newest person message arrived is the one looked at', () => {
    const check = backfillRoundOf([person(1), tool(2), tool(3), tool(4), reply(5), person(6)])
    expect(roundOf(check)?.seq).toBe(1)
    expect(roundOf(check)?.rows.map(row => row.seq)).toEqual([1, 2, 3, 4, 5])
  })

  test('a round the main model booked itself is left alone', () => {
    const check = backfillRoundOf([
      person(1),
      tool(2),
      tool(3),
      tool(4),
      tool(5, 'mcp__ctx-mod__ledger_append'),
      person(6),
    ])
    expect(roundOf(check)).toBeUndefined()
    expect(reasonOf(check)).toContain('ledger_append')
  })

  test('fewer than three calls of work is too thin to book, and the ledger tools are not work', () => {
    expect(roundOf(backfillRoundOf([person(1), tool(2), tool(3), person(4)]))).toBeUndefined()
    const counted = backfillRoundOf([
      person(1),
      tool(2),
      tool(3),
      tool(4, 'mcp__ctx-mod__ledger_read'),
      person(5),
    ])
    expect(roundOf(counted)).toBeUndefined()
    expect(reasonOf(counted)).toContain('2 个动作')
  })

  test('the first prompt has no round behind it yet', () => {
    expect(roundOf(backfillRoundOf([person(1), tool(2), tool(3), tool(4)]))).toBeUndefined()
  })
})

describe('parseBackfillOutput', () => {
  const tasks = tasksOf([entryOf()])

  test('done is lowered to in_progress, and evidence outside the round is dropped', () => {
    const parsed = parseBackfillOutput(
      JSON.stringify({
        entries: [
          { task_id: 'fix-login', status: 'done', text: '改完了', evidence: [2, 99, 'x'] },
        ],
      }),
      { tasks, actionSeqs: [2, 3, 4] },
    )
    expect(parsed.entries.length).toBe(1)
    expect(parsed.entries[0]?.status).toBe('in_progress')
    expect(parsed.entries[0]?.evidence).toEqual([2])
    expect(parsed.coerced).toBe(1)
  })

  test('evidence that is not in the round at all leaves none behind', () => {
    const parsed = parseBackfillOutput(
      JSON.stringify({ entries: [{ task_id: 'fix-login', status: 'blocked', text: '卡住了', evidence: [99] }] }),
      { tasks, actionSeqs: [2, 3, 4] },
    )
    expect(parsed.entries[0]?.evidence).toBeUndefined()
  })

  test('superseded is lowered too, and text is cut to the limit', () => {
    const parsed = parseBackfillOutput(
      JSON.stringify({ entries: [{ task_id: 'fix-login', status: 'superseded', text: 'x'.repeat(500) }] }),
      { tasks, actionSeqs: [] },
    )
    expect(parsed.entries[0]?.status).toBe('in_progress')
    expect(parsed.entries[0]?.text.length).toBe(MAX_TEXT_CHARS)
    expect(parsed.coerced).toBe(1)
  })

  test('the existing task keeps its own title and next step, and at most two records are kept', () => {
    const parsed = parseBackfillOutput(
      JSON.stringify({
        entries: [
          { task_id: 'fix-login', title: '另一个标题', status: 'in_progress', text: '一', next_step: '换成别的' },
          { task_id: 'fix-login', status: 'in_progress', text: '二' },
          { task_id: 'fix-login', status: 'in_progress', text: '三' },
        ],
      }),
      { tasks, actionSeqs: [] },
    )
    expect(parsed.entries.length).toBe(2)
    expect(parsed.entries[0]?.title).toBe('改登录页')
    expect(parsed.entries[0]?.next_step).toBeUndefined()
    expect(parsed.rejected.some(item => item.reason.includes('最多'))).toBe(true)
  })

  test('a new id is allowed once, and only when no existing task is the same line of work', () => {
    const parsed = parseBackfillOutput(
      JSON.stringify({
        entries: [
          { task_id: 'billing-export', title: '导出账单', status: 'in_progress', text: '加了导出', next_step: '接上分页' },
          { task_id: 'another-new', title: '别的', status: 'in_progress', text: '又起一个' },
        ],
      }),
      { tasks, actionSeqs: [] },
    )
    expect(parsed.entries.length).toBe(1)
    expect(parsed.entries[0]?.task_id).toBe('billing-export')
    expect(parsed.entries[0]?.next_step).toBe('接上分页')
    expect(parsed.rejected.some(item => item.reason.includes('最多新起一个'))).toBe(true)

    const family = parseBackfillOutput(
      JSON.stringify({ entries: [{ task_id: 'fix-login-2', title: '同族', status: 'in_progress', text: '换了个 id' }] }),
      { tasks, actionSeqs: [] },
    )
    expect(family.entries.length).toBe(0)
    expect(family.rejected.some(item => item.reason.includes('同族'))).toBe(true)
  })

  test('a record for a task that already ended is dropped, never written back as in_progress', () => {
    const closed = tasksOf([entryOf({ status: 'done', evidence: [2] })])
    const parsed = parseBackfillOutput(
      JSON.stringify({ entries: [{ task_id: 'fix-login', status: 'in_progress', text: '又动了它' }] }),
      { tasks: closed, actionSeqs: [] },
    )
    expect(parsed.entries.length).toBe(0)
    expect(parsed.rejected.some(item => item.reason.includes('已经结束'))).toBe(true)
  })

  test('no JSON at all throws, so nothing is booked on it', () => {
    let threw = false
    try {
      parseBackfillOutput('我读了这些动作，什么也没做。', { tasks, actionSeqs: [] })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('the input', () => {
  test('names the open tasks with what is still to do, and the ended ones by id', () => {
    const lines = taskLinesOf([
      entryOf(),
      entryOf({ task_id: 'old', title: '早先做完的', status: 'done', evidence: [2], seq: 2, ts: 3_000 }),
    ])
    expect(lines[0]).toContain('fix-login')
    expect(lines[0]).toContain('下一步：接着改表单')
    expect(lines.join('\n')).toContain('下一步')
    expect(lines.join('\n')).toContain('old｜早先做完的')
  })

  test('shrinks the action list so the estimate stays under the budget', () => {
    const rows: HistoryRecord[] = [person(1)]
    for (let index = 0; index < 400; index += 1) rows.push(tool(index + 2, 'Read', `结果行${index}：${'长'.repeat(400)}`))
    // One prompt after the long round, so that round is the finished one the run looks at.
    rows.push(person(500))
    const round = roundOf(backfillRoundOf(rows))
    expect(round === undefined).toBe(false)
    const fit = fitBackfillInput(round as never, ['fix-login｜改登录页｜in_progress'])
    expect(fit === undefined).toBe(false)
    expect(fit?.estimate !== undefined && fit.estimate <= 70_000).toBe(true)
    expect(fit?.actionSeqs.length !== undefined && fit.actionSeqs.length < 400).toBe(true)
    expect(fit?.text).toContain('【本轮动作】')
  })
})

describe('mergeBackfill', () => {
  test('a pending record joins the page with its own seq, the round\'s time and the backfill mark', async () => {
    const box = makeIo()
    const session = await sessionWithRound(box)
    box.files.set(`${DIR}/${PENDING_FILE}`, JSON.stringify(pendingOfRound([{}])))

    const merged = await session.mergeBackfill()
    await session.flush()

    expect(merged.added).toEqual([1])
    expect(merged.dropped).toEqual([])
    const ledger = ledgerOf(box)
    expect(ledger.length).toBe(1)
    expect(ledger[0]?.task_id).toBe('fix-login')
    expect(ledger[0]?.text).toBe(withBackfillPrefix('按钮改成了蓝色，测试通过'))
    expect(ledger[0]?.source).toBe('backfill')
    expect(ledger[0]?.request_ref).toBe(1)
    // The round's own moment, not this one: an old record must not make the ledger look fresh.
    expect(ledger[0]?.window).toBe(1)
    expect(ledger[0]?.ts).toBe(4_000)
    expect(session.isLedgerFresh()).toBe(false)
    expect(box.files.has(`${DIR}/${PENDING_FILE}`)).toBe(false)
    // The handoff a window opens with says, in words, that this note was added after the fact.
    const home = renderHome(
      { window: 1, entries: ledger, requests: [person(1)], archive: [] },
      { ...DEFAULTS, homeTokens: 100_000 },
    )
    expect(home).toContain('〔补记〕')
    expect(home).toContain('## 进行中 / 受阻的任务')
  })

  test('the task\'s next step, anchors and done_when are carried, not rewritten', async () => {
    const box = makeIo()
    const session = await sessionWithRound(box)
    box.files.set('src/login.ts', 'export const button = 1\nexport const form = 2\n')
    await session.ledgerAppend(
      {
        task_id: 'fix-login',
        title: '改登录页',
        status: 'in_progress',
        text: '按钮改好了',
        next_step: '接着改表单',
        done_when: '表单也能提交',
        anchors: [{ path: 'src/login.ts', match: 'const button', note: '改这里' }],
      },
      out(),
    )
    box.files.set(`${DIR}/${PENDING_FILE}`, JSON.stringify(pendingOfRound([{}])))
    await session.mergeBackfill()
    await session.flush()

    const logs = await session.ledgerRead({ query: 'fix-login' })
    expect(logs.result).toContain('〔补记〕')
    const task = tasksOf(ledgerOf(box)).find(found => found.taskId === 'fix-login')
    expect(task?.nextStep?.value).toBe('接着改表单')
    expect(task?.nextStep?.isInherited).toBe(true)
    expect(task?.doneWhen?.value).toBe('表单也能提交')
    expect(task?.anchors?.value.length).toBe(1)
  })

  test('a record for a task that ended in the meantime is dropped, and the task stays ended', async () => {
    const box = makeIo()
    const session = await sessionWithRound(box)
    await session.ledgerAppend(
      { task_id: 'fix-login', title: '改登录页', status: 'done', text: '做完了', evidence: [2], request_ref: 1 },
      out(),
    )
    box.files.set(`${DIR}/${PENDING_FILE}`, JSON.stringify(pendingOfRound([{}])))

    const merged = await session.mergeBackfill()
    await session.flush()

    expect(merged.added).toEqual([])
    expect(merged.dropped[0]?.reason).toContain('已经结束')
    const task = tasksOf(ledgerOf(box)).find(found => found.taskId === 'fix-login')
    expect(task?.status).toBe('done')
    const home = renderHome(
      { window: 1, entries: ledgerOf(box), requests: [person(1)], archive: [] },
      { ...DEFAULTS, homeTokens: 100_000 },
    )
    expect(home).toContain('## 已完成')
    expect(home).not.toContain('〔补记〕')
  })

  test('the same pending records are never booked twice', async () => {
    const box = makeIo(false)
    const session = await sessionWithRound(box)
    const pending = JSON.stringify(pendingOfRound([{}]))
    box.files.set(`${DIR}/${PENDING_FILE}`, pending)

    const first = await session.mergeBackfill()
    // A host that cannot delete leaves the file behind; the same records arrive again.
    box.files.set(`${DIR}/${PENDING_FILE}`, pending)
    const second = await session.mergeBackfill()
    await session.flush()

    expect(first.added).toEqual([1])
    expect(second.added).toEqual([])
    expect(second.dropped[0]?.reason).toContain('已经在账本里')
    expect(ledgerOf(box).length).toBe(1)
  })

  test('a merge and the main model\'s own append at the same moment never share a seq', async () => {
    const box = makeIo()
    const session = await sessionWithRound(box)
    box.files.set(`${DIR}/${PENDING_FILE}`, JSON.stringify(pendingOfRound([{}])))

    const [merged, appended] = await Promise.all([
      session.mergeBackfill(),
      session.ledgerAppend(
        { task_id: 'other', title: '另一件事', status: 'in_progress', text: '在做别的', next_step: '接着做' },
        out(),
      ),
    ])
    await session.flush()

    expect(merged.added.length).toBe(1)
    expect(appended.result).toContain('已记录')
    const ledger = ledgerOf(box)
    expect(ledger.length).toBe(2)
    expect(new Set(ledger.map(entry => entry.seq)).size).toBe(2)
    expect(ledger.map(entry => entry.task_id).sort()).toEqual(['fix-login', 'other'])
    // The file the queue wrote holds both, in seq order, one line each.
    const lines = (box.files.get(`${DIR}/ledger.jsonl`) ?? '').trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines.map(line => (JSON.parse(line) as LedgerEntry).seq)).toEqual([1, 2])
  })

  test('a pending file that is not this code\'s shape books nothing', async () => {
    const box = makeIo()
    const session = await sessionWithRound(box)
    box.files.set(`${DIR}/${PENDING_FILE}`, JSON.stringify({ round: 1, entries: [{ task_id: 'x' }] }))

    const merged = await session.mergeBackfill()
    await session.flush()

    expect(merged.added).toEqual([])
    expect(merged.dropped[0]?.reason).toContain('格式')
    expect(ledgerOf(box).length).toBe(0)
  })

  test('nothing pending is not an error and writes nothing', async () => {
    const box = makeIo()
    const session = await sessionWithRound(box)
    const merged = await session.mergeBackfill()
    expect(merged).toEqual({ added: [], dropped: [] })
    expect(box.files.has(`${DIR}/ledger.jsonl`)).toBe(false)
  })
})

describe('the state file', () => {
  test('a round is tried at most twice, and a booked one never again', () => {
    const empty = stateOf(null)
    expect(mayTry(empty, 7)).toBe(true)
    const once = noteAttempt(empty, 7, 'failed')
    expect(mayTry(once, 7)).toBe(true)
    const twice = noteAttempt(once, 7, 'failed')
    expect(mayTry(twice, 7)).toBe(false)
    const booked = noteAttempt(once, 7, 'ok')
    expect(mayTry(booked, 7)).toBe(false)
    // A damaged file says nothing was tried, which costs one call and no more.
    expect(stateOf('{ not json').rounds).toEqual({})
  })

  test('the pending shape the child writes is the one the parent accepts', () => {
    const round = { seq: 1, ts: 1_000, window: 1, person: person(1), rows: [person(1), tool(2), tool(3), tool(4)] }
    const pending = pendingOf(round, [{ task_id: 'fix-login', title: '改登录页', status: 'blocked', text: '卡住了' }])
    expect(isBackfillPending(pending)).toBe(true)
    expect(pending.ts).toBe(5_000)
    expect(pending.through).toBe(4)
    expect(pending.entries[0]?.text.startsWith('〔补记〕')).toBe(true)
  })
})
