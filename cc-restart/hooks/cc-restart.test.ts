import { mock, test, expect } from 'claude-code/testing'
import {
  DEFAULT_MESSAGE,
  INTERRUPTED_MESSAGE,
  MAX_AGE_MS,
  buildPending,
  digestFromLines,
  judgeTranscript,
  workingMessage,
} from './register.ts'

type Any = any

const DIR = 'C:/virtual/cc-restart'
const MARKER = `${DIR}/pending.json`
const WAKE_PLAN = `${DIR}/wake-plan.json`
const LOCAL = 'C:/Users/test/AppData/Local'
const REGISTRY = `${LOCAL}/Claude-Data/claude_pzs8sxrjxfjjc/claude-code-sessions/acc1/ws1/scheduled-tasks.json`
const slashed = (path: string): string => path.replace(/\\/g, '/')

function setup(on: Any) {
  const files = new Map<string, string>()
  const texts: string[] = []
  const consumed: string[] = []
  let currentId = 'session-a'
  on('fs.read', (_$: Any, e: Any) => {
    const text = files.get(slashed(e.path))
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', (_$: Any, e: Any) => {
    files.set(slashed(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$: Any, e: Any) => ({
    value: files.has(slashed(e.path)) || slashed(e.path).endsWith('/restart-claude.ps1'),
  }))
  // Directories are derived from the files written, so a registry file under
  // .../claude-code-sessions/<account>/<workspace>/ is listed by $.fs.list.
  on('fs.list', (_$: Any, e: Any) => {
    const dir = slashed(String(e.path ?? '')).replace(/\/+$/, '')
    const kinds = new Map<string, 'file' | 'dir'>()
    for (const key of files.keys()) {
      if (!key.startsWith(`${dir}/`)) continue
      const rest = key.slice(dir.length + 1)
      const name = rest.split('/')[0] ?? ''
      if (!name) continue
      if (rest.includes('/')) kinds.set(name, 'dir')
      else if (!kinds.has(name)) kinds.set(name, 'file')
    }
    return {
      value: [...kinds].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  const queue: string[] = []
  on('session.id', () => ({ value: queue.length ? queue.shift() : currentId }))
  on('session.cwd', () => ({ value: 'D:/work' }))
  on('session.start', (_$: Any, e: Any) => ({ cwd: e.cwd }))
  let discoverAnswer = '[]'
  const tails = new Map<string, string>()
  const done = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$: Any, e: Any) => {
    const argv: string[] = e.argv ?? []
    if (argv.includes('-Consume')) {
      const sid = argv[argv.indexOf('-SessionId') + 1]
      const items = JSON.parse(files.get(MARKER) ?? '[]')
      const kept = items.filter((item: Any) => item.sessionId !== sid)
      consumed.push(sid ?? '')
      if (kept.length === 0) files.delete(MARKER)
      else files.set(MARKER, JSON.stringify(kept))
      return done()
    }
    if (argv.includes('-Discover')) return done(discoverAnswer)
    if (argv.includes('-Tail')) {
      const transcript = argv[argv.indexOf('-Transcript') + 1] ?? ''
      return done(tails.get(slashed(transcript)) ?? '')
    }
    return done()
  })
  on('prompt.submit', (_$: Any, e: Any) => {
    texts.push(e.text)
    return { text: e.text }
  })
  on('tool.register', () => ({ value: { tool: 'restart_cc' } }))
  mock.env(on, { USERPROFILE: 'C:/Users/test', LOCALAPPDATA: LOCAL, CC_RESTART_DIR: DIR })
  return {
    files,
    texts,
    consumed,
    setId: (id: string) => {
      currentId = id
    },
    setIds: (ids: string[]) => {
      queue.push(...ids)
    },
    setDiscover: (answer: string) => {
      discoverAnswer = answer
    },
    setTail: (transcript: string, text: string) => {
      tails.set(slashed(transcript), text)
    },
    setWakePlan: (plan: { taskId: string; ts: number }) => {
      files.set(WAKE_PLAN, JSON.stringify(plan))
    },
    setScheduledTasks: (tasks: Any[], file = REGISTRY) => {
      files.set(slashed(file), JSON.stringify({ scheduledTasks: tasks }))
    },
  }
}

function entry(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-a',
    cwd: 'D:/work',
    wake: true,
    message: 'mine',
    ts: Date.now(),
    ...over,
  }
}

const start = ($: Any) => $.session.start({ cwd: 'D:/work', surface: null, isInteractive: false })

test('多条目只唤醒自己那一条，并删掉自己', async ($, on) => {
  const s = setup(on)
  s.files.set(MARKER, JSON.stringify([entry({ message: 'mine' }), entry({ sessionId: 'session-b', message: 'other' })]))
  await start($)
  expect(s.texts).toEqual(['mine'])
  expect(s.consumed).toEqual(['session-a'])
  const left = JSON.parse(s.files.get(MARKER) ?? 'null')
  expect(left.map((item: Any) => item.sessionId)).toEqual(['session-b'])
})

test('wake=false 的不提交，但自己的条目被删掉', async ($, on) => {
  const s = setup(on)
  s.files.set(MARKER, JSON.stringify([entry({ wake: false, message: '' })]))
  await start($)
  expect(s.texts).toHaveLength(0)
  expect(s.files.has(MARKER)).toBe(false)
})

test('并发处理：两个会话各删自己的，别的条目不丢', async ($, on) => {
  const s = setup(on)
  s.files.set(MARKER, JSON.stringify([entry({ message: 'mine-a' }), entry({ sessionId: 'session-b', message: 'mine-b' })]))
  s.setIds(['session-a', 'session-b'])
  await Promise.all([start($), start($)])
  expect([...s.texts].sort()).toEqual(['mine-a', 'mine-b'])
  expect([...s.consumed].sort()).toEqual(['session-a', 'session-b'])
  expect(s.files.has(MARKER)).toBe(false)
})

test('超过 10 分钟：不提交，自己的条目仍被删掉', async ($, on) => {
  const s = setup(on)
  s.files.set(MARKER, JSON.stringify([entry({ ts: Date.now() - MAX_AGE_MS - 1000 })]))
  await start($)
  expect(s.texts).toHaveLength(0)
  expect(s.files.has(MARKER)).toBe(false)
})

test('没有标记文件：什么都不做', async ($, on) => {
  const s = setup(on)
  await start($)
  expect(s.texts).toHaveLength(0)
})

// ---- real transcript shapes (jsonl lines as the engine writes them) ----
const assistantTool = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', cwd: 'D:/work', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const userResult = (toolUseId: string, text: string) =>
  JSON.stringify({ type: 'user', cwd: 'D:/work', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } })
const assistantText = (text: string) =>
  JSON.stringify({ type: 'assistant', cwd: 'D:/work', message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } })
const notification = (taskId: string, toolUseId: string) =>
  JSON.stringify({
    type: 'user',
    cwd: 'D:/work',
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>C:\\Temp\\x.output</output-file>\n<status>completed</status>\n</task-notification>`,
    },
  })

const BASH_BG = 'Command running in background with ID: bq25oyz93. Output is being written to: C:\\Temp\\bq25oyz93.output. You will be notified when it completes.'
const DELEGATE_START = '[delegate pro · 后台任务 bg-mvfeek2b] 已启动。完成后会自动通知你（结果和 agent ID 都在结果里）。'
const DELEGATE_DONE = 'The delegate plugin sent a message: 【delegate 后台任务 bg-mvfeek2b 完成】 [delegate pro · work · agent 1234 · 20 轮 · 100 秒] 做完了。'

test('真实格式：回合已结束，但后台 Bash 与 delegate 都还没回 → wake', () => {
  const digest = digestFromLines([
    assistantTool('toolu_bash1', 'Bash', { command: 'npm test', description: '跑测试', run_in_background: true }),
    userResult('toolu_bash1', BASH_BG),
    assistantTool('toolu_del1', 'mcp__delegate__delegate_pro', { task: '审查代码' }),
    userResult('toolu_del1', DELEGATE_START),
    assistantText('先等这两个后台任务回来。'),
  ])
  const verdict = judgeTranscript(digest)
  expect(verdict.state).toBe('working')
  expect(verdict.interrupted.map(item => item.id)).toEqual(['bq25oyz93', 'bg-mvfeek2b'])
  expect(verdict.interrupted.map(item => item.type)).toEqual(['bash', 'delegate'])
  expect(verdict.reason).toContain('bq25oyz93')
  expect(verdict.reason).toContain('bg-mvfeek2b')
})

test('真实格式：后台 Bash 有 task-notification，delegate 有完成通知 → idle', () => {
  const digest = digestFromLines([
    assistantTool('toolu_bash1', 'Bash', { command: 'npm test', description: '跑测试', run_in_background: true }),
    userResult('toolu_bash1', BASH_BG),
    assistantTool('toolu_del1', 'mcp__delegate__delegate_pro', { task: '审查代码' }),
    userResult('toolu_del1', DELEGATE_START),
    assistantText('先等这两个后台任务回来。'),
    notification('bq25oyz93', 'toolu_bash1'),
    JSON.stringify({ type: 'user', cwd: 'D:/work', message: { role: 'user', content: DELEGATE_DONE } }),
    assistantText('两个都回来了，收尾完成。'),
  ])
  const verdict = judgeTranscript(digest)
  expect(verdict.state).toBe('idle')
  expect(verdict.interrupted).toHaveLength(0)
})

test('真实格式：后台子代理 run_in_background 未回 → wake', () => {
  const digest = digestFromLines([
    assistantTool('toolu_ag1', 'Agent', { description: '代理A', run_in_background: true }),
    userResult('toolu_ag1', ''),
    assistantText('等子代理回来。'),
  ])
  const verdict = judgeTranscript(digest)
  expect(verdict.state).toBe('working')
  expect(verdict.interrupted.map(item => item.type)).toEqual(['agent'])
})

const AGENT_ID = 'a36942c516868522d'
const AGENT_LAUNCH =
  'Async agent launched successfully. The agent is working in the background. agentId: a36942c516868522d (internal ID - do not mention to user. Use SendMessage with to: \'a36942c516868522d\' to continue this agent.)'
const AGENT_SUMMARY = 'Background agent "第十一次巡检 B 组" didn\'t finish before the restart.'
// Real completion notice for a background agent: content is a plain string and it
// carries only <task-id> (the agentId), never <tool-use-id>.
const agentDone = (agentId: string) =>
  JSON.stringify({
    type: 'user',
    cwd: 'D:/work',
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${agentId}</task-id>\n<output-file>C:\\Temp\\tasks\\${agentId}.output</output-file>\n<status>stopped</status>\n<summary>${AGENT_SUMMARY}</summary>\n</task-notification>`,
    },
  })

test('真实格式：后台子代理按 agentId 的 <task-id> 通知完成 → idle', () => {
  const digest = digestFromLines([
    assistantTool('toolu_01AaUeNmMgKovDDQr5hrjWWr', 'Agent', { description: '第十一次巡检 B 组', subagent_type: 'browser-worker', run_in_background: true, prompt: '巡检' }),
    userResult('toolu_01AaUeNmMgKovDDQr5hrjWWr', AGENT_LAUNCH),
    assistantText('子代理已启动，等它巡检完。'),
    agentDone(AGENT_ID),
    assistantText('巡检结果收到了，收尾完成。'),
  ])
  expect(digest.backgroundAgents.map(agent => agent.agentId)).toEqual([AGENT_ID])
  const verdict = judgeTranscript(digest)
  expect(verdict.state).toBe('idle')
  expect(verdict.interrupted).toHaveLength(0)
})

const agentInterim = (agentId: string) =>
  JSON.stringify({
    type: 'user',
    cwd: 'D:/work',
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<summary>Agent "重启测试" is waiting on its own background work</summary>\n<note>This agent stopped with background work of its own still running.</note>\n<result>OK</result>\n</task-notification>`,
    },
  })

test('后台子代理只有中间通知（自己的后台命令还在跑）→ 算中断', () => {
  const digest = digestFromLines([
    assistantTool('toolu_01AaUeNmMgKovDDQr5hrjWWr', 'Agent', { description: '第十一次巡检 B 组', run_in_background: true, prompt: '巡检' }),
    userResult('toolu_01AaUeNmMgKovDDQr5hrjWWr', AGENT_LAUNCH),
    agentInterim(AGENT_ID),
    assistantText('子代理还在等它的后台命令。'),
  ])
  const verdict = judgeTranscript(digest)
  expect(verdict.state).toBe('working')
  expect(verdict.interrupted.map(item => item.type)).toEqual(['agent'])
})

test('中间通知之后又来了最终通知 → 算完成', () => {
  const digest = digestFromLines([
    assistantTool('toolu_01AaUeNmMgKovDDQr5hrjWWr', 'Agent', { description: '第十一次巡检 B 组', run_in_background: true, prompt: '巡检' }),
    userResult('toolu_01AaUeNmMgKovDDQr5hrjWWr', AGENT_LAUNCH),
    agentInterim(AGENT_ID),
    agentDone(AGENT_ID),
    assistantText('收尾完成。'),
  ])
  const verdict = judgeTranscript(digest)
  expect(verdict.state).toBe('idle')
  expect(verdict.interrupted).toHaveLength(0)
})

test('真实格式：后台子代理有 agentId 但没有完成通知 → wake', () => {
  const digest = digestFromLines([
    assistantTool('toolu_01AaUeNmMgKovDDQr5hrjWWr', 'Agent', { description: '第十一次巡检 B 组', subagent_type: 'browser-worker', run_in_background: true, prompt: '巡检' }),
    userResult('toolu_01AaUeNmMgKovDDQr5hrjWWr', AGENT_LAUNCH),
    assistantText('子代理已启动，等它巡检完。'),
  ])
  expect(digest.backgroundAgents.map(agent => agent.agentId)).toEqual([AGENT_ID])
  const verdict = judgeTranscript(digest)
  expect(verdict.state).toBe('working')
  expect(verdict.interrupted.map(item => item.type)).toEqual(['agent'])
  expect(verdict.interrupted.map(item => item.id)).toEqual(['toolu_01AaUeNmMgKovDDQr5hrjWWr'])
  expect(verdict.reason).toContain('toolu_01AaUeNmMgKovDDQr5hrjWWr')
})

test('回合未结束（api-request / 未完成的 tool_use）→ wake', () => {
  expect(judgeTranscript(digestFromLines([assistantText('hi'), JSON.stringify({ type: 'api-request' })])).state).toBe('working')
  expect(
    judgeTranscript(digestFromLines([assistantTool('toolu_1', 'Bash', { command: 'ls' })])).state,
  ).toBe('working')
})

test('buildPending：只有一条发起条目，其他会话进 others', () => {
  const now = 1_700_000_000_000
  const entries = buildPending(
    { sessionId: 'me', cwd: 'D:/me', message: 'go' },
    [
      {
        sessionId: 'work',
        localId: 'local_work',
        title: '干活会话',
        cwd: 'D:/w',
        state: 'working',
        reason: 'r',
        interrupted: [{ type: 'bash', id: 'b1', detail: 'npm test' }],
      },
      { sessionId: 'idle', localId: null, title: '', cwd: 'D:/i', state: 'idle', reason: 'r', interrupted: [] },
      { sessionId: 'me', localId: 'local_me', title: '自己', cwd: 'D:/me', state: 'idle', reason: 'dup', interrupted: [] },
    ],
    now,
  )
  expect(entries).toHaveLength(1)
  const entry = entries[0]!
  expect(entry.sessionId).toBe('me')
  expect(entry.initiator).toBe(true)
  expect(entry.wake).toBe(true)
  expect(entry.others).toHaveLength(2)
  expect(entry.others?.[0]?.cliSessionId).toBe('work')
  expect(entry.others?.[0]?.localId).toBe('local_work')
  expect(entry.others?.[0]?.title).toBe('干活会话')
  expect(entry.others?.[0]?.wake).toBe(true)
  expect(entry.others?.[0]?.message).toContain('b1')
  expect(entry.others?.[1]?.wake).toBe(false)
  expect(entry.message).toContain('go')
  expect(entry.message).toContain('mcp__ccd_session_mgmt__list_sessions')
  expect(entry.message).toContain('mcp__ccd_session_mgmt__send_message')
  expect(entry.message).toContain('local_work')
  expect(entry.message).toContain('work')
})

test('buildPending：没有其他会话时消息就是调用者文字', () => {
  const entries = buildPending(
    { sessionId: 'me', cwd: 'D:/me', message: 'go' },
    [{ sessionId: 'me', localId: null, title: '', cwd: 'D:/me', state: 'idle', reason: 'dup', interrupted: [] }],
    1,
  )
  expect(entries).toHaveLength(1)
  expect(entries[0]?.others).toHaveLength(0)
  expect(entries[0]?.message).toBe('go')
})

test('workingMessage：没有具体任务时用默认中断文字', () => {
  expect(workingMessage([])).toBe(INTERRUPTED_MESSAGE)
  expect(DEFAULT_MESSAGE).toContain('[cc-restart]')
})

const IDLE_TAIL = [assistantText('做完了，等你下一步。')].join('\n')
const WORKING_TAIL = [
  assistantTool('toolu_bash1', 'Bash', { command: 'npm test', description: '跑测试', run_in_background: true }),
  userResult('toolu_bash1', BASH_BG),
  assistantTool('toolu_del1', 'mcp__delegate__delegate_pro', { task: '审查代码' }),
  userResult('toolu_del1', DELEGATE_START),
  assistantText('先等这两个后台任务回来。'),
].join('\n')

const WAKE_ID = `cc-restart-wake-${Date.now() + 60_000}`

test('restart_cc：写一条发起条目，others 列出干活与空闲会话', async ($, on) => {
  const s = setup(on)
  s.setDiscover(
    JSON.stringify([
      { sessionId: 'session-work', pid: 1, transcript: 'C:/t/work.jsonl', localId: 'local_work', title: '干活会话' },
      { sessionId: 'session-idle', pid: 2, transcript: 'C:/t/idle.jsonl', localId: 'local_idle', title: '空闲会话' },
    ]),
  )
  s.setTail('C:/t/work.jsonl', WORKING_TAIL)
  s.setTail('C:/t/idle.jsonl', IDLE_TAIL)
  s.setScheduledTasks([{ id: WAKE_ID, enabled: true }])
  const result = await $.tool.call({ tool: 'mcp__cc-restart__restart_cc' as never, input: { message: 'go', wakeTaskId: WAKE_ID } })
  const entries = JSON.parse(s.files.get(MARKER) ?? '[]')
  expect(entries).toHaveLength(1)
  const entry = entries[0]
  expect(entry.sessionId).toBe('session-a')
  expect(entry.initiator).toBe(true)
  expect(entry.others).toHaveLength(2)
  expect(entry.others[0].cliSessionId).toBe('session-work')
  expect(entry.others[0].localId).toBe('local_work')
  expect(entry.others[0].title).toBe('干活会话')
  expect(entry.others[0].wake).toBe(true)
  expect(entry.others[0].message).toContain('bq25oyz93')
  expect(entry.others[0].message).toContain('bg-mvfeek2b')
  expect(entry.others[1].wake).toBe(false)
  expect(entry.message).toContain('go')
  expect(entry.message).toContain('mcp__ccd_session_mgmt__list_sessions')
  expect(entry.message).toContain('mcp__ccd_session_mgmt__send_message')
  expect(entry.message).toContain('local_work')
  expect(entry.message).toContain('session-work')
  expect(entry.message).toContain(WAKE_ID)
  expect(JSON.stringify(result)).toContain('1 个需要你用 session 工具通知')
})

test('restart_cc：第一步把计划写进 wake-plan.json，只返回定时任务参数、不写标记、不重启', async ($, on) => {
  const s = setup(on)
  s.setDiscover(JSON.stringify([{ sessionId: 'session-a', pid: 9, transcript: '', localId: 'local_self', title: '我' }]))
  const result = await $.tool.call({ tool: 'mcp__cc-restart__restart_cc' as never, input: { message: 'go' } })
  expect(s.files.get(MARKER)).toBeUndefined()
  const text = JSON.stringify(result)
  expect(text).toContain('create_scheduled_task')
  expect(text).toContain('local_self')
  expect(text).toContain('cc-restart-wake-')
  expect(text).toContain('不需要 wakeTaskId')
  expect(text).toMatch(/fireAt=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)
  const plan = JSON.parse(s.files.get(WAKE_PLAN) ?? 'null')
  expect(plan.taskId).toMatch(/^cc-restart-wake-\d+$/)
  expect(typeof plan.ts).toBe('number')
})

test('restart_cc：唤醒任务快到点时拒绝重启', async ($, on) => {
  const s = setup(on)
  const stale = `cc-restart-wake-${Date.now() - 40_000}`
  s.setScheduledTasks([{ id: stale, enabled: true }])
  const result = await $.tool.call({ tool: 'mcp__cc-restart__restart_cc' as never, input: { wakeTaskId: stale } })
  expect(s.files.get(MARKER)).toBeUndefined()
  expect(JSON.stringify(result)).toContain('wake-task-too-close')
})

test('restart_cc：唤醒任务时间充足时正常重启', async ($, on) => {
  const s = setup(on)
  const id = `cc-restart-wake-${Date.now()}`
  s.setScheduledTasks([{ id, enabled: true }])
  await $.tool.call({ tool: 'mcp__cc-restart__restart_cc' as never, input: { wakeTaskId: id } })
  expect(JSON.parse(s.files.get(MARKER) ?? '[]')).toHaveLength(1)
})

test('restart_cc：找不到本会话 localId 时拒绝第一步', async ($, on) => {
  const s = setup(on)
  const result = await $.tool.call({ tool: 'mcp__cc-restart__restart_cc' as never, input: {} })
  expect(s.files.get(MARKER)).toBeUndefined()
  expect(JSON.stringify(result)).toContain('no-local-id')
})

test('restart_cc：发现不到会话时只有发起条目、others 为空', async ($, on) => {
  const s = setup(on)
  await $.tool.call({ tool: 'mcp__cc-restart__restart_cc' as never, input: { wakeTaskId: 'none' } })
  const entries = JSON.parse(s.files.get(MARKER) ?? '[]')
  expect(entries).toHaveLength(1)
  expect(entries[0].initiator).toBe(true)
  expect(entries[0].others).toEqual([])
  expect(entries[0].message).toContain('[cc-restart]')
})

test('restart_cc：有计划但注册表里没有该任务 → wake-task-missing，不写 MARKER', async ($, on) => {
  const s = setup(on)
  s.setWakePlan({ taskId: `cc-restart-wake-${Date.now()}`, ts: Date.now() })
  const result = await $.tool.call({ tool: 'mcp__cc-restart__restart_cc' as never, input: {} })
  expect(JSON.stringify(result)).toContain('wake-task-missing')
  expect(s.files.get(MARKER)).toBeUndefined()
})

test('restart_cc：注册表里有该任务 → 正常写 MARKER 并清掉 wake-plan.json', async ($, on) => {
  const s = setup(on)
  const taskId = `cc-restart-wake-${Date.now()}`
  s.setWakePlan({ taskId, ts: Date.now() })
  s.setScheduledTasks([{ id: taskId, enabled: true }])
  const result = await $.tool.call({ tool: 'mcp__cc-restart__restart_cc' as never, input: {} })
  const entries = JSON.parse(s.files.get(MARKER) ?? '[]')
  expect(entries).toHaveLength(1)
  expect(entries[0].sessionId).toBe('session-a')
  expect(entries[0].message).toContain(taskId)
  expect(JSON.stringify(result)).toContain(taskId)
  expect(s.files.get(WAKE_PLAN) ?? '').toBe('')
})

test('restart_cc：计划文件已过期 → 丢掉旧计划，重新走第一步、不写 MARKER', async ($, on) => {
  const s = setup(on)
  s.setDiscover(JSON.stringify([{ sessionId: 'session-a', pid: 9, transcript: '', localId: 'local_self', title: '我' }]))
  const taskId = `cc-restart-wake-${Date.now() - 40_000}`
  s.setWakePlan({ taskId, ts: Date.now() - 40_000 })
  const result = await $.tool.call({ tool: 'mcp__cc-restart__restart_cc' as never, input: {} })
  const text = JSON.stringify(result)
  expect(text).toContain('create_scheduled_task')
  expect(text).not.toContain(taskId)
  expect(s.files.get(MARKER)).toBeUndefined()
  expect(JSON.parse(s.files.get(WAKE_PLAN) ?? '{}').taskId).not.toBe(taskId)
})

test('restart_cc：注册表里的任务被禁用也算没建好', async ($, on) => {
  const s = setup(on)
  const taskId = `cc-restart-wake-${Date.now()}`
  s.setWakePlan({ taskId, ts: Date.now() })
  s.setScheduledTasks([{ id: taskId, enabled: false }])
  const result = await $.tool.call({ tool: 'mcp__cc-restart__restart_cc' as never, input: {} })
  expect(JSON.stringify(result)).toContain('wake-task-missing')
  expect(s.files.get(MARKER)).toBeUndefined()
})

