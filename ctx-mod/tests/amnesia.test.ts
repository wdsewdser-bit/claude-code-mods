import { describe, expect, test } from 'claude-code/testing'

import { createSession } from '../hooks/lib/session.ts'
import type { Env, Io } from '../hooks/lib/session.ts'
import { activitiesOf, writesInResult } from '../hooks/lib/workset.ts'
import { renderHome } from '../hooks/lib/ledger.ts'
import { DEFAULTS } from '../hooks/lib/types.ts'
import type { HistoryRecord, LedgerEntry } from '../hooks/lib/types.ts'

// The cases a real session lost across windows: an edit made through a variable path in another
// repository, a stale task list crowding out current work, and facts only an older window held.

const DIR = '/ctx'

const env = (tokens: number | undefined, limit = 100_000): Env => ({ tokens, limit, cache: null, fiveHourPercent: undefined })

type Git = (args: readonly string[], cwd: string) => Promise<{ code: number; stdout: string; stderr?: string }>

const makeIo = (git?: Git): { io: Io; files: Map<string, string>; advance: (ms: number) => void } => {
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
      return [...files.keys()].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map(path => path.slice(prefix.length))
    },
    ...(git === undefined ? {} : { git }),
  }

  return { io, files, advance: ms => (clock += ms) }
}

/** A git that knows one repository at C:/mods with the given dirty files (relative paths). */
const fakeGit = (dirty: readonly string[], fail = false): Git => async (args, cwd) => {
  if (args[0] === 'rev-parse') {
    return cwd.toLowerCase().startsWith('c:/mods') ? { code: 0, stdout: 'C:/mods\n' } : { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
  }
  if (fail) return { code: 1, stdout: '', stderr: 'boom' }

  return { code: 0, stdout: dirty.map(file => ` M ${file}`).join('\n') }
}

const EDIT_CODE = [
  'const f="C:/mods/delegate/hooks/register.tsx";',
  'tools.edit({path:f,old:`a`,new:`b`});',
].join('\n')

describe('writes a run_code program made', () => {
  test('a path held in a variable, joined with +, or in a template is still the file written', () => {
    const meta = { seq: 5, window: 1, isError: false }
    expect(activitiesOf('mcp__ptc-run__run_code', { code: EDIT_CODE }, meta).map(a => [a.path, a.op])).toEqual([
      ['C:/mods/delegate/hooks/register.tsx', 'edit'],
    ])
    const joined = 'const r = "C:/mods/ctx/"; tools.write({ path: r + "a.ts", content: "x" }); tools.edit({ path: `${r}b.ts`, old: "a", new: "b" })'
    expect(activitiesOf('mcp__ptc-run__run_code', { code: joined }, meta).map(a => a.path)).toEqual(['C:/mods/ctx/a.ts', 'C:/mods/ctx/b.ts'])
    // A name bound to two different strings is not guessed at.
    const twice = 'let p = "a.ts"; p = "b.ts"; let p = "c.ts"; tools.edit({ path: p, old: "a", new: "b" })'
    expect(activitiesOf('mcp__ptc-run__run_code', { code: twice }, meta)).toEqual([])
  })

  test('the write list in a result names files the program text hides, even when the program failed', () => {
    const result = '本程序已生效的写操作：\n- replace src/a.ts ×2\n- edit C:/mods/b.ts（共 3 处，行 1,2,3）\n\nError: boom'
    expect(writesInResult(result)).toEqual(['src/a.ts', 'C:/mods/b.ts'])
    const multi = '注意：以下写操作一次改了多处，确认每处都是有意改的：\n- replace src/c.ts（共 2 处，行 1,2）\n\nok'
    expect(writesInResult(multi)).toEqual(['src/c.ts'])
    const found = activitiesOf('mcp__ptc-run__run_code', { code: 'tools.replace({glob:"**/*.ts",pattern:"x",replacement:"y"})', root: 'C:/mods' }, { seq: 9, window: 2, isError: true }, result)
    expect(found.map(a => [a.path, a.isError])).toEqual([
      ['C:/mods/src/a.ts', false],
      ['C:/mods/b.ts', false],
    ])
  })
})

describe('the handoff lists what this session changed and has not committed', () => {
  const build = async (git: Git | undefined) => {
    const box = makeIo(git)
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '修 AGY 续用' })
    const row = await session.record({ uuid: 't1', role: 'tool', tool: 'mcp__ptc-run__run_code', text: 'ok' })
    session.activity('mcp__ptc-run__run_code', { code: EDIT_CODE }, row.seq, false, 'ok')
    const memo = await session.record({ uuid: 't2', role: 'tool', tool: 'Write', path: 'D:/notes/m.md', text: 'ok' })
    session.activity('Write', { file_path: 'D:/notes/m.md' }, memo.seq, false)

    return { box, session, seq: row.seq }
  }

  test('an own edit still dirty in git is named with its window and seq; others are only counted', async () => {
    const { session, seq } = await build(fakeGit(['delegate/hooks/register.tsx', 'other/x.ts']))
    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text).toContain('## 本会话改过、仍未提交的文件')
    expect(text).toContain(`C:/mods/delegate/hooks/register.tsx（第 1 窗口 #${seq} 最后一次改）`)
    expect(text).toContain('另有 1 个未提交改动不在本会话的写入记录里')
    // A file outside any repository is not claimed as uncommitted.
    expect(text).not.toContain('m.md（')
  })

  test('a committed edit is not listed, a git failure lists it as unchecked, and no git means no section', async () => {
    expect(await (await build(fakeGit([]))).session.buildHandoff({ isMidTurn: false })).not.toContain('仍未提交的文件')
    const failed = await (await build(fakeGit([], true))).session.buildHandoff({ isMidTurn: false })
    expect(failed).toContain('git 没能核对（报错或超时），可能仍未提交：C:/mods/delegate/hooks/register.tsx')
    expect(await (await build(undefined)).session.buildHandoff({ isMidTurn: false })).not.toContain('仍未提交的文件')
  })

  test('the write survives a window switch and is listed in a later handoff', async () => {
    const { box, session, seq } = await build(fakeGit(['delegate/hooks/register.tsx']))
    await session.ledgerAppend({ task_id: 't', title: '修', status: 'in_progress', text: '改了', next_step: '提交' }, env(10_000))
    await session.flush()
    // A new session object reads the same disk, as a reload does.
    const again = createSession(DIR, box.io, DEFAULTS)
    const text = await again.buildHandoff({ isMidTurn: false })
    expect(text).toContain(`#${seq} 最后一次改`)
  })

  test('a switch is held while this window wrote a file the ledger does not mention', async () => {
    const { box, session } = await build(fakeGit(['delegate/hooks/register.tsx']))
    await session.ledgerAppend({ task_id: 't', title: '修', status: 'in_progress', text: '开始', next_step: '改' }, env(10_000))
    box.advance(1_000)
    const late = await session.record({ uuid: 't3', role: 'tool', tool: 'Edit', path: 'C:/mods/z.ts', text: 'ok' })
    session.activity('Edit', { file_path: 'C:/mods/z.ts', new_string: 'x' }, late.seq, false)
    const held = session.requestSwitch({}, env(90_000))
    expect(held.isError).toBe(true)
    expect(held.result).toContain(`C:/mods/z.ts（#${late.seq}）`)
  })
})

describe('the handoff points at older windows for words in the latest requests', () => {
  test('an identifier from a request finds the earlier rows that name it', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, DEFAULTS)
    await session.record({ uuid: 'p1', role: 'user', isPerson: true, text: '先跑一下评测' })
    const old = await session.record({ uuid: 't1', role: 'tool', tool: 'Bash', text: 'long4 score 0.82' })
    await session.commitSwitch({ trigger: 'manual', tokensBefore: 90_000, handoffText: '交接' })
    await session.record({ uuid: 'p2', role: 'user', isPerson: true, text: '再看看 long4 的分数' })
    const text = await session.buildHandoff({ isMidTurn: false })
    expect(text).toContain(`- long4：#${old.seq}（第 1 窗口）`)
    // A word with nothing earlier gets no line, and the current window is not searched.
    expect(text).not.toContain('- 分数：')
  })
})

describe('stale open tasks', () => {
  const entry = (extra: Partial<LedgerEntry>): LedgerEntry =>
    ({ seq: 1, ts: 100, window: 1, task_id: 't', title: '任务', status: 'in_progress', text: '进展', ...extra }) as LedgerEntry
  const requests: HistoryRecord[] = [{ seq: 1, ts: 1, window: 1, role: 'user', isPerson: true, text: '继续' } as HistoryRecord]

  test('a task past the thresholds gets one line after the current ones, whatever its rank', () => {
    const entries = [
      entry({ task_id: 'old', title: '老任务', text: '很久以前的进展'.repeat(20), seq: 1, window: 1, next_step: '老的下一步' }),
      entry({ task_id: 'now', title: '新任务', text: '刚做的', seq: 2, window: 9, ts: 200, next_step: '接着做' }),
    ]
    const text = renderHome({ window: 10, entries, requests, archive: [], now: 300 }, DEFAULTS)
    expect(text).toContain('  - 最新：刚做的')
    expect(text).toContain('- old：老任务（进行中；最后实质更新：第 1 窗口，0 天前，可能已过时，提之前先确认） · 最新 #L1：')
    expect(text).not.toContain('老的下一步')
    expect(text).toContain('以上 1 个任务很久没有实质更新，只列一行')
    expect(text.indexOf('- old：')).toBeGreaterThan(text.indexOf('- now：'))
  })
})
