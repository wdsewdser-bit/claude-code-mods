// Suite for `hooks/register.ts`: the engine wiring. Everything beneath the mod is
// the test's own: the clock, the environment, the file system, the session's own
// figures and the tools the mod registers.

import type { On, SessionCompactResult, TurnStepResult, TurnUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { briefOf } from '../hooks/register.ts'

const START = Date.parse('2026-10-10T00:00:00.000Z')
const HOME = 'C:\\Users\\someone'

/** One row the engine already holds when the mod starts on a session. */
type OldMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: { tool: string; input?: Record<string, unknown>; text?: string; isError?: boolean }[]
}

type World = {
  clock: MockClock
  files: Map<string, string>
  /** The conversation `$.session.messages()` answers with; empty until a test sets it. */
  messages: OldMessage[]
  /** The names the mod registered, in order. */
  tools: string[]
  commands: string[]
  /** Commands `$.command.run` was called with, in order. */
  runs: string[]
  /** How often core's own compaction ran. */
  coreCompactions: number
  logs: string[]
  /** The fill `$.session.usage()` reports; none until a test sets it. */
  usage: { tokens: number | undefined }
  /** Whether the bottom's `command.run` then raises a `manual` compaction, as the engine would. */
  compactsOnRun: boolean
  /** What that compaction answered with. */
  answered: SessionCompactResult | undefined
  /** The session id `$.session.id()` answers with; a test may move to another. */
  sessionId: string
  /** What `command.run` throws with, when a test wants the compaction to fail. */
  runError: unknown
  /** Files `$.fs.read` answers with; empty unless a test puts one here, so every other read is denied as before. */
  readable: Map<string, string>
  /** What `$.agent.list()` answers with. */
  agents: { id: string; type: string; description: string; status: string }[]
  /** What the bottom answers `agent.spawn` with: the started agent, or a `{ deny }` refusal. */
  spawnAnswer: Record<string, unknown>
  /** The usage the bottom answers `turn.step` with: what the model request cost, as the API reported it. */
  stepUsage: TurnUsage | null
  /** Whether every s.write is refused, as a full or broken disk would. */
  failWrites: boolean
  /** What the bottom does with a prompt another plugin submits (the mod's own re-submission): let it in, drop it, or throw. */
  resubmit: 'enter' | 'drop' | 'throw'
  /** The texts of the system lines the mod put in the conversation. */
  notices: string[]
  /** The texts the bottom saw from a plugin, in order. */
  resubmits: string[]
  /** The texts the bottom saw from anyone, in order. */
  submits: string[]
  /** What cache-keeper's published state reads as; none until a test sets it. */
  keeper: Record<string, unknown> | null
}

const slashed = (path: string): string => path.replaceAll('\\', '/')

/** The file a write put there, found by its tail (the engine spells paths its own way). */
const fileAt = (w: World, tail: string): string | undefined => {
  const wanted = slashed(tail)
  for (const [path, text] of w.files) {
    if (path.endsWith(wanted)) return text
  }

  return undefined
}

const namesEndingWith = (w: World, tail: string): string[] =>
  [...w.files.keys()].filter(path => path.endsWith(tail))

/**
 * Everything beneath the mod: the clock, the environment, the file system (in
 * memory), the session's figures, the tools and commands it registers, and the
 * events the engine raises at it.
 */
const world = (
  on: On,
  id: string,
  env: Readonly<Record<string, string>> = {},
  now = START,
): World => {
  const w: World = {
    clock: mock.clock(on, { now }),
    files: new Map(),
    readable: new Map(),
    messages: [],
    tools: [],
    commands: [],
    runs: [],
    coreCompactions: 0,
    logs: [],
    usage: { tokens: undefined },
    compactsOnRun: false,
    answered: undefined,
    sessionId: id,
    runError: undefined,
    agents: [],
    spawnAnswer: { model: 'haiku', agentId: 'a1' },
    stepUsage: null,
    failWrites: false,
    resubmit: 'enter',
    notices: [],
    resubmits: [],
    submits: [],
    keeper: null,
  }
  mock.env(on, { USERPROFILE: HOME, ...env })
  on('fs.write', (_$, e) => {
    if (w.failWrites) return { deny: 'EIO: write failed' } as never
    w.files.set(slashed(e.path), e.text)

    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const text = w.readable.get(slashed(e.path))

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : ({ value: text } as never)
  })
  // Like every bottom answer, wrapped once more: the read itself is { value, version }.
  on('state.get', () => ({ value: { value: w.keeper ?? undefined, version: 1 } }) as never)
  on('session.id', () => ({ value: w.sessionId }))
  on('session.messages', () => ({ value: w.messages }) as never)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        window: 1_000_000,
        ...(w.usage.tokens === undefined ? {} : { tokens: w.usage.tokens }),
      },
      rateLimits: [],
    },
  }))
  on('agent.list', () => ({ value: w.agents }) as never)
  on('agent.spawn', () => w.spawnAnswer as never)
  on('tool.register', (_$, e) => {
    w.tools.push(e.name)

    return { value: { tool: e.name } } as never
  })
  on('command.register', (_$, e) => {
    w.commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)

    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    w.submits.push(e.text)
    if ((e.origin as { kind: string }).kind === 'plugin') {
      w.resubmits.push(e.text)
      if (w.resubmit === 'drop') return { drop: 'another plugin refused it' }
      if (w.resubmit === 'throw') throw new Error('submit failed')
    }

    return { text: e.text }
  })
  // Only watches: an answer that skips next would keep the row out of the mod's own hook.
  on('session.append', (_$, e, next) => {
    const message = e.message as { type?: string; content?: { text?: string }[] }
    if (message.type === 'system') w.notices.push(message.content?.[0]?.text ?? '')

    return next(e)
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  // The engine's model request, as the bottom answers it: a stream of nothing, then the response.
  on('turn.step', async function* (_$, e) {
    const answer: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: 'OK',
      toolUses: [],
      stopReason: 'end_turn',
      usage: w.stepUsage,
    }

    return answer
  })
  on('command.run', async ($, e) => {
    w.runs.push(e.command)
    if (w.runError !== undefined) throw w.runError
    if (e.command === 'compact' && w.compactsOnRun) {
      // The engine's own `/compact`: what core raises once the command returns.
      w.answered = (await $.session.compact({
        trigger: 'manual',
        messages: [{ role: 'user', text: 'the conversation so far', toolUses: [] }],
      } as never)) as SessionCompactResult
    }

    return { text: '' }
  })
  on('tool.call', () => ({ result: 'the tool ran' }))
  on('session.compact', () => {
    w.coreCompactions += 1

    return { messages: [{ role: 'user', text: 'a summary', toolUses: [] }] }
  })

  return w
}

const boot = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/work', surface: null, isInteractive: true })
}

type CallResult = { result?: unknown; deny?: unknown; isError?: unknown; text?: unknown }

const callTool = async ($: Engine, e: Readonly<Record<string, unknown>>): Promise<CallResult> =>
  (await $.tool.call(e as never)) as unknown as CallResult

const textOf = (r: CallResult): string =>
  [r.result, r.deny, r.text].filter(part => part !== undefined).map(part => String(part)).join('\n')

/** One row the engine hands `session.append`. */
const append = async ($: Engine, e: Readonly<Record<string, unknown>>): Promise<unknown> =>
  await $.session.append(e as never)

/** A person's own prompt: submitted, then appended as the engine stores it. */
const personRequest = async ($: Engine, text: string, id: string): Promise<void> => {
  await $.prompt.submit({
    text,
    wait: false,
    origin: { kind: 'composer' },
  } as never)
  await append($, {
    message: { type: 'user', content: [{ type: 'text', text }] },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: id,
  })
}

/** A non-person prompt row: nothing was submitted, and the origin says nothing. */
const strayPrompt = async ($: Engine, text: string, id: string): Promise<void> => {
  await append($, {
    message: { type: 'user', content: [{ type: 'text', text }] },
    door: 'prompt',
    origin: { kind: 'unclassified' },
    uuid: id,
  })
}

/** One tool result row, after a call of that tool was seen. */
const toolResult = async ($: Engine, toolUseId: string, id: string, body: string): Promise<unknown> =>
  await append($, {
    message: {
      type: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: body }],
    },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'unknown' },
    uuid: id,
  })

const ledger = (e: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
  tool: 'mcp__ctx-mod__ledger_append',
  tool_use_id: 'ledger-1',
  ...e,
})

const history = (e: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
  tool: 'mcp__ctx-mod__history',
  tool_use_id: 'hist-1',
  ...e,
})

const compact = async ($: Engine, trigger: string): Promise<SessionCompactResult> =>
  (await $.session.compact({
    trigger,
    messages: [{ role: 'user', text: 'the conversation so far', toolUses: [] }],
  } as never)) as SessionCompactResult

const messagesOf = (result: SessionCompactResult): readonly { text?: string }[] => {
  const held = result as { messages?: readonly { text?: string }[] }

  return held.messages ?? []
}

/** The turn's end, as the engine raises it after an answer. */
const endTurn = async ($: Engine, reason: string): Promise<void> => {
  await $.turn.complete({
    answer: 'OK',
    durationMs: 1,
    isAborted: false,
    turnId: 'turn-1',
    reason,
  } as never)
}

/** The main loop starts a subagent: the call the engine raises as `agent.spawn`, with the given fields over the defaults. */
const spawn = async ($: Engine, e: Readonly<Record<string, unknown>>): Promise<unknown> =>
  await $.agent.spawn({
    tool_use_id: 'agent-call-1',
    prompt: '改 register',
    description: '改 register',
    subagentType: 'worker',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'sonnet',
    background: false,
    fork: false,
    ...e,
  } as never)

/** A subagent's own turn ends, as the engine raises `turn.complete` for that agent's loop. */
const endSubagentTurn = async ($: Engine, agentId: string): Promise<void> => {
  await $.turn.complete({
    answer: 'OK',
    durationMs: 1,
    isAborted: false,
    turnId: `sub-${agentId}`,
    reason: 'answer',
    agentId,
  } as never)
}

/** The handoff an automatic compaction answers with, as one text. */
const handoffOf = async ($: Engine): Promise<string> =>
  messagesOf(await compact($, 'auto'))
    .map(message => message.text ?? '')
    .join('\n')

/** The usage of one model request, as the API reports it: the cache figures are what the rebuild measure reads. */
const usageOf = (input: number, read: number, write: number): TurnUsage => ({
  input_tokens: input,
  output_tokens: 1,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  model: 'haiku',
})

/** One model request of a loop, run through the chain as the engine runs it: its chunks are read off, and the result is what came back. */
const step = async ($: Engine, index: number, agentId?: string, turnId = 'turn-main'): Promise<TurnStepResult> => {
  const stream = $.turn.step({
    turnId,
    index,
    model: 'haiku',
    messageCount: 1,
    ...(agentId === undefined ? {} : { agentId }),
  })
  // Read to the end: the last `next` that reports done carries what the chain returned.
  let read = await stream.next()
  while (!read.done) read = await stream.next()

  return read.value
}

/** The model loads the screenshot tool with ToolSearch: the call, then the result naming it as a reference. */
const loadScreenshot = async ($: Engine, callId: string): Promise<void> => {
  await callTool($, { tool: 'ToolSearch', tool_use_id: callId, query: 'select:mcp__computer-use__screenshot' })
  await append($, {
    message: {
      type: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: callId,
          content: [{ type: 'tool_reference', tool_name: 'mcp__computer-use__screenshot' }],
        },
      ],
    },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'ToolSearch' },
    uuid: `row-${callId}`,
  })
}

/** Arms the session, has a person ask, and books a fresh ledger entry. */
const armedWithFreshLedger = async ($: Engine, request: string): Promise<void> => {
  await personRequest($, request, 'person-1')
  const booked = await callTool(
    $,
    ledger({ tool_use_id: 'ledger-armed', task_id: 't1', title: '工作', status: 'in_progress', text: '开始', next_step: '继续做下一步' }),
  )
  expect(booked.isError).toBeUndefined()
}

test('with CTX_MOD unset a compaction reaches core and nothing is written', async ($, on) => {
  const w = world(on, 's-unset')
  await boot($)
  await compact($, 'auto')
  expect(w.coreCompactions).toBe(1)
  expect(w.files.size).toBe(0)
})

test('armed, session.start registers four tools and the ctx-mod command', async ($, on) => {
  const w = world(on, 's-armed', { CTX_MOD: '1' })
  await boot($)
  expect(w.tools).toHaveLength(4)
  // The engine namespaces these to `mcp__ctx-mod__<name>`; the bottom sees the
  // declared name, which is what the mod's own `tool.call` matchers are built from.
  expect(w.tools).toContain('context')
  expect(w.tools).toContain('ledger_append')
  expect(w.tools).toContain('ledger_read')
  expect(w.tools).toContain('history')
  expect(w.commands).toContain('ctx-mod')
})

test('armed, a subagent call of every tool is refused as main-thread only', async ($, on) => {
  const w = world(on, 's-agent', { CTX_MOD: '1' })
  await boot($)
  const calls = [
    ledger({ tool_use_id: 'agent-1', agentId: 'agent-7', task_id: 't1', title: '工作', status: 'in_progress', text: '开始', next_step: '接着做' }),
    { tool: 'mcp__ctx-mod__ledger_read', tool_use_id: 'agent-2', agentId: 'agent-7' },
    history({ tool_use_id: 'agent-3', agentId: 'agent-7', action: 'search', query: 'x' }),
    { tool: 'mcp__ctx-mod__context', tool_use_id: 'agent-4', agentId: 'agent-7', action: 'status' },
  ]
  for (const call of calls) {
    const refused = await callTool($, call)
    expect(refused.isError, `tool ${String(call.tool)}`).toBe(true)
    expect(textOf(refused)).toContain('只能由主会话调用')
  }
  // A refused call must not have reached the disk either.
  expect(w.files.size).toBe(0)
})

test('armed, a tool result that carries non-text blocks is left exactly as it came', async ($, on) => {
  world(on, 's-mixed', { CTX_MOD: '1' })
  await boot($)
  await callTool($, { tool: 'ToolSearch', tool_use_id: 'tu-search', query: 'select:X' })
  const content = [{ type: 'tool_reference', tool_name: 'X' }]
  const stored = await append($, {
    message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-search', content }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'ToolSearch' },
    uuid: 'row-mixed',
  })
  // The API refuses tool references mixed with any other content.
  expect(JSON.stringify(stored)).not.toContain('[#')
  expect(JSON.stringify(stored)).toContain('tool_reference')
})

test('armed, a tool result row is numbered and its text reaches the window shard',async ($, on) => {
  const w = world(on, 's-number', { CTX_MOD: '1' })
  await boot($)
  await callTool($, { tool: 'Read', tool_use_id: 'tu-read', file_path: '/work/a.ts' })
  const stored = await toolResult($, 'tu-read', 'row-1', 'the file body')
  expect(JSON.stringify(stored)).toContain('[#1]')
  await w.clock.settle()
  const shard = fileAt(w, 'history-w001.jsonl')
  expect(shard).toBeDefined()
  expect(shard ?? '').toContain('the file body')
})

test('armed, a submitted prompt appended as a prompt row counts as a person request', async ($, on) => {
  const w = world(on, 's-person', { CTX_MOD: '1' })
  await boot($)
  await personRequest($, '把解析器改严一点', 'person-1')
  const booked = await callTool(
    $,
    ledger({ tool_use_id: 'ledger-person', task_id: 't1', title: '解析器', status: 'in_progress', text: '开始改', next_step: '接着做' }),
  )
  expect(booked.isError).toBeUndefined()
  expect(textOf(booked)).toContain('已记录')
  await w.clock.settle()
  expect(fileAt(w, 'ledger.jsonl')).toBeDefined()
})

test('armed, a prompt row that was never submitted is not a person request', async ($, on) => {
  const w = world(on, 's-stray', { CTX_MOD: '1' })
  await boot($)
  await strayPrompt($, '这条没人提交过', 'row-1')
  const booked = await callTool(
    $,
    ledger({ tool_use_id: 'ledger-stray', task_id: 't1', title: '解析器', status: 'in_progress', text: '开始改', next_step: '接着做' }),
  )
  expect(booked.isError).toBe(true)
  expect(textOf(booked)).toContain('校验')
})

test('armed, history filters by tool_name and never by the envelope tool', async ($, on) => {
  const w = world(on, 's-history', { CTX_MOD: '1' })
  await boot($)
  await callTool($, { tool: 'Read', tool_use_id: 'tu-read', file_path: '/work/a.ts' })
  await toolResult($, 'tu-read', 'row-1', 'needle read')
  await callTool($, { tool: 'Bash', tool_use_id: 'tu-bash', command: 'ls' })
  await toolResult($, 'tu-bash', 'row-2', 'needle bash')
  await w.clock.settle()

  const filtered = await callTool($, history({ tool_use_id: 'hist-read', action: 'search', query: 'needle', tool_name: 'Read' }))
  expect(textOf(filtered)).toContain('needle read')
  expect(textOf(filtered)).not.toContain('needle bash')

  const unfiltered = await callTool($, history({ tool_use_id: 'hist-all', action: 'search', query: 'needle' }))
  expect(textOf(unfiltered)).toContain('needle read')
  expect(textOf(unfiltered)).toContain('needle bash')
})

test('armed, context new is approved on urgent fill and later calls are refused', async ($, on) => {
  const w = world(on, 's-switch', { CTX_MOD: '1' })
  w.usage.tokens = 340_000
  await boot($)
  await armedWithFreshLedger($, '先看一眼上下文')
  const approved = await callTool($, { tool: 'mcp__ctx-mod__context', tool_use_id: 'ctx-1', action: 'new' })
  expect(textOf(approved)).toContain('已批准')
  const later = await callTool($, { tool: 'Read', tool_use_id: 'tu-late', file_path: '/work/b.ts' })
  expect(textOf(later)).toContain('换窗口')
})

test('armed, an automatic compaction with a fresh ledger switches windows in place', async ($, on) => {
  const w = world(on, 's-handoff', { CTX_MOD: '1' })
  await boot($)
  await personRequest($, '把解析器改成严格的', 'person-1')
  await callTool(
    $,
    ledger({ tool_use_id: 'ledger-1', task_id: 't1', title: '解析器', status: 'in_progress', text: '开始改', next_step: '接上严格标志' }),
  )
  const result = await compact($, 'auto')
  expect(w.coreCompactions).toBe(0)
  const messages = messagesOf(result)
  expect(messages).toHaveLength(1)
  expect(String(messages[0]?.text)).toContain('把解析器改成严格的')
  expect(String(messages[0]?.text)).toContain('接上严格标志')
  await w.clock.settle()
  expect(namesEndingWith(w, 'handoff-w002.md')).toHaveLength(1)
})

test('briefOf summarizes the calls whose result never spells them out, and nothing else', () => {
  expect(briefOf('Bash', { command: 'git   status\n--short' })).toBe('git status --short')
  expect(briefOf('PowerShell', { command: 'ls' })).toBe('ls')
  expect(briefOf('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src')
  expect(briefOf('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  expect(briefOf('Agent', { subagent_type: 'worker', description: '改 hooks' })).toBe('worker: 改 hooks')
  expect(briefOf('SendMessage', { to: 'worker', summary: '继续' })).toBe('to worker: 继续')
  expect(briefOf('SendMessage', { to: 'worker', message: 'x'.repeat(200) })).toBe(`to worker: ${'x'.repeat(120)}`)
  expect(briefOf('ToolSearch', { query: 'select:X' })).toBe('select:X')
  expect(briefOf('WebFetch', { url: 'https://a.example' })).toBe('https://a.example')
  // Read, Edit and Write already carry their path on the row; nothing else is known.
  expect(briefOf('Read', { file_path: 'a.ts' })).toBeUndefined()
  expect(briefOf('Task', { description: 'x' })).toBeUndefined()
  expect(briefOf('Bash', { command: 42 })).toBeUndefined()
  expect(briefOf('Bash', { command: 'y'.repeat(400) })?.length).toBe(300)
})

test('armed, the handoff names the subagents that were running', async ($, on) => {
  const w = world(on, 's-agents', { CTX_MOD: '1' })
  w.agents.push({ id: 'agent-42', type: 'worker', description: '改 register', status: 'running' })
  await boot($)
  await personRequest($, '把交接补上子代理', 'person-1')
  await callTool(
    $,
    ledger({ tool_use_id: 'ledger-1', task_id: 't1', title: '交接', status: 'in_progress', text: '在做', next_step: '补子代理' }),
  )
  const result = await compact($, 'auto')
  const text = messagesOf(result)
    .map(message => message.text ?? '')
    .join('\n')
  expect(text).toContain('## 子代理')
  expect(text).toContain('agent-42')
  expect(text).toContain('SendMessage')
})

test('armed, a subagent the main loop started is named as ended once its own turn completes', async ($, on) => {
  world(on, 's-roster', { CTX_MOD: '1' })
  await boot($)
  await armedWithFreshLedger($, '把子代理的名单带过去')
  expect(await spawn($, {})).toEqual({ model: 'haiku', agentId: 'a1' })
  await endSubagentTurn($, 'a1')

  const text = await handoffOf($)
  expect(text).toContain('## 子代理')
  expect(text).toContain('- a1（worker，已结束）：改 register')
  expect(text).toContain('要继续某个子代理（已结束的也可以）')
})

test('armed, a spawn from inside a subagent and a fork are not named in the handoff', async ($, on) => {
  world(on, 's-roster-skip', { CTX_MOD: '1' })
  await boot($)
  await armedWithFreshLedger($, '嵌套的派发和 fork 不进名单')
  expect(await spawn($, { parentAgentId: 'agent-parent' })).toEqual({ model: 'haiku', agentId: 'a1' })
  expect(await spawn($, { fork: true })).toEqual({ model: 'haiku', agentId: 'a1' })

  expect(await handoffOf($)).not.toContain('## 子代理')
})

test('armed, a spawn the engine refuses is not named, and the refusal reaches the caller as it was', async ($, on) => {
  const w = world(on, 's-roster-deny', { CTX_MOD: '1' })
  w.spawnAnswer = { deny: '这个子代理类型不允许' }
  await boot($)
  await armedWithFreshLedger($, '被拒的派发不进名单')
  expect(await spawn($, {})).toEqual({ deny: '这个子代理类型不允许' })

  expect(await handoffOf($)).not.toContain('## 子代理')
})

test('armed, a deferred tool loaded and used but never measured as a rebuild is not handed to the next one', async ($, on) => {
  const w = world(on, 's-loaded', { CTX_MOD: '1' })
  await boot($)
  await personRequest($, '把截图流程跑通', 'person-1')
  await callTool(
    $,
    ledger({ tool_use_id: 'ledger-1', task_id: 't1', title: '截图', status: 'in_progress', text: '在做', next_step: '截一张图' }),
  )
  await callTool($, { tool: 'ToolSearch', tool_use_id: 'tu-load', query: 'select:mcp__computer-use__screenshot,WebFetch' })
  // Two references and no text: the row is named by what it loaded, and keeps the list.
  await append($, {
    message: {
      type: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu-load',
          content: [
            { type: 'tool_reference', tool_name: 'mcp__computer-use__screenshot' },
            { type: 'tool_reference', tool_name: 'WebFetch' },
          ],
        },
      ],
    },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'ToolSearch' },
    uuid: 'row-load',
  })
  await callTool($, { tool: 'mcp__computer-use__screenshot', tool_use_id: 'tu-shot' })
  await toolResult($, 'tu-shot', 'row-shot', 'screen captured')
  await w.clock.settle()
  const shard = fileAt(w, 'history-w001.jsonl') ?? ''
  expect(shard).toContain('已加载：mcp__computer-use__screenshot、WebFetch')
  expect(shard).toContain('"loaded":["mcp__computer-use__screenshot","WebFetch"]')

  const result = await compact($, 'auto')
  const text = messagesOf(result)
    .map(message => message.text ?? '')
    .join('\n')
  // Loaded and used, but no model request measured a rebuild: nothing is advised.
  expect(text).not.toContain('加载时会重建缓存的延迟工具')
  expect(text).not.toContain('上个窗口加载并用过的延迟工具')
})

test('armed, a main-loop request that read far less right after a deferred load names that load in the handoff', async ($, on) => {
  const w = world(on, 's-rebuild', { CTX_MOD: '1' })
  await boot($)
  await armedWithFreshLedger($, '把截图流程跑通')
  // The first request carries 150006 tokens of context, all of it written to the cache.
  w.stepUsage = usageOf(6, 0, 150_000)
  expect((await step($, 0)).usage).toEqual(usageOf(6, 0, 150_000))
  await loadScreenshot($, 'tu-load')
  await callTool($, { tool: 'mcp__computer-use__screenshot', tool_use_id: 'tu-shot' })
  await toolResult($, 'tu-shot', 'row-shot', 'screen captured')
  // The next request reads 50714 of it and writes 117386 again: the load rebuilt the cache.
  w.stepUsage = usageOf(0, 50_714, 117_386)
  expect((await step($, 1)).usage).toEqual(usageOf(0, 50_714, 117_386))

  const text = await handoffOf($)
  expect(text).toContain('## 加载时会重建缓存的延迟工具')
  expect(text).toContain('- mcp__computer-use__*（上个窗口调用 1 次；上次加载后重写了约 11.7 万 token）')
  expect(text).not.toContain('上个窗口加载并用过的延迟工具')
})

test('armed, a ToolSearch that would rebuild the cache is held back past the gate, and the second try goes through', async ($, on) => {
  const w = world(on, 's-gate', { CTX_MOD: '1' })
  // The table another session left beside the mod's directories: the session's directory is
  // HOME/.claude/ctx-mod/<id>, so the table sits one level up.
  w.readable.set(
    'C:/Users/someone/.claude/ctx-mod/costly.json',
    JSON.stringify({
      version: 1,
      groups: { 'mcp__computer-use__*': { write: 117_386, context: 150_006, at: Date.now() } },
    }),
  )
  await boot($)
  w.usage.tokens = 152_006

  const held = await callTool($, { tool: 'ToolSearch', tool_use_id: 'tu-gate-1', query: 'select:mcp__computer-use__screenshot' })
  expect(held.deny).toContain('先不加载：加载 mcp__computer-use__* 会让整段对话的缓存重建')
  // The refused call never reached the tool: the bottom's own answer is absent.
  expect(held.result).toBeUndefined()

  const again = await callTool($, { tool: 'ToolSearch', tool_use_id: 'tu-gate-2', query: 'select:mcp__computer-use__screenshot' })
  expect(again.deny).toBeUndefined()
  expect(again.result).toBe('the tool ran')
})

test('armed, a subagent request is passed through and never measured as the main loop', async ($, on) => {
  const w = world(on, 's-step-agent', { CTX_MOD: '1' })
  await boot($)
  await armedWithFreshLedger($, '子代理的请求不计入主循环')
  w.stepUsage = usageOf(6, 0, 150_000)
  await step($, 0)
  await loadScreenshot($, 'tu-load')
  // The subagent's request reads far less, but it is not this loop's cache: the load stays pending.
  w.stepUsage = usageOf(0, 50_714, 117_386)
  expect((await step($, 0, 'agent-7')).usage).toEqual(usageOf(0, 50_714, 117_386))
  // The main loop's next request reads nearly all of its context: no rebuild.
  w.stepUsage = usageOf(0, 150_000, 100)
  await step($, 1)
  await callTool($, { tool: 'mcp__computer-use__screenshot', tool_use_id: 'tu-shot' })
  await toolResult($, 'tu-shot', 'row-shot', 'screen captured')

  expect(await handoffOf($)).not.toContain('加载时会重建缓存的延迟工具')
})

test('armed, a prompt that is only the engine’s reminder is nobody’s request', async ($, on) => {
  world(on, 's-injected', { CTX_MOD: '1' })
  await boot($)
  await append($, {
    message: {
      type: 'user',
      content: [{ type: 'text', text: '<system-reminder>引擎自己的开场</system-reminder>' }],
    },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'row-1',
  })
  const booked = await callTool(
    $,
    ledger({ tool_use_id: 'l1', task_id: 't1', title: '工作', status: 'in_progress', text: '开始', next_step: '接着做' }),
  )
  expect(booked.isError).toBe(true)
  expect(textOf(booked)).toContain('校验')
})

/** Whether a ledger entry could be booked after this one prompt: it only can once a person's request is on record. */
const bookable = async ($: Engine, id: string): Promise<boolean> => {
  const booked = await callTool(
    $,
    ledger({ tool_use_id: `l-${id}`, task_id: 't1', title: '工作', status: 'in_progress', text: '开始', next_step: '接着做' }),
  )

  return booked.isError !== true
}

const promptFrom = async ($: Engine, text: string, id: string, origin: { kind: string }): Promise<void> => {
  await append($, {
    message: { type: 'user', content: [{ type: 'text', text }] },
    door: 'prompt',
    origin,
    uuid: id,
  })
}

test('armed, a composer prompt that opens with a tag is still the person’s request', async ($, on) => {
  world(on, 's-tag-person', { CTX_MOD: '1' })
  await boot($)
  await promptFrom($, '<task>把登录页的按钮改成蓝色</task>', 'row-tag', { kind: 'composer' })
  expect(await bookable($, 'tag')).toBe(true)
})

test('armed, a slash command typed in the composer is not a request', async ($, on) => {
  world(on, 's-tag-command', { CTX_MOD: '1' })
  await boot($)
  await promptFrom($, '<command-name>/compact</command-name>', 'row-cmd', { kind: 'composer' })
  expect(await bookable($, 'cmd')).toBe(false)
})

test('armed, a tag-led prompt with no confirmed origin (an import) is not a request', async ($, on) => {
  world(on, 's-tag-stray', { CTX_MOD: '1' })
  await boot($)
  await strayPrompt($, '<task>把登录页的按钮改成蓝色</task>', 'row-stray')
  expect(await bookable($, 'stray')).toBe(false)
})

test('armed, the mod’s own continuation note is not a request even from a confirmed origin', async ($, on) => {
  world(on, 's-tag-own', { CTX_MOD: '1' })
  await boot($)
  await promptFrom($, 'ctx-mod：已换到新的上下文窗口，请继续。', 'row-own', { kind: 'composer' })
  expect(await bookable($, 'own')).toBe(false)
})

test('armed, the handoff a window opens with is found by the compaction door', async ($, on) => {
  world(on, 's-handoff-door', { CTX_MOD: '1' })
  await boot($)
  await promptFrom($, '这是第 2 个窗口，上一个窗口的对话不在上下文里。下面是代码生成的交接信息。', 'row-handoff', { kind: 'plugin' })
  await promptFrom($, '把登录页的按钮改成蓝色', 'row-ask', { kind: 'composer' })

  const byDoor = textOf(await callTool($, history({ tool_use_id: 'hist-door', action: 'search', door: 'compaction' })))
  expect(byDoor).toContain('这是第 2 个窗口')
  expect(byDoor).toContain('<compaction>')
  expect(byDoor).not.toContain('按钮改成蓝色')

  // Not background: a plain search still lists it.
  const plain = textOf(await callTool($, history({ tool_use_id: 'hist-plain', action: 'search', query: '交接信息' })))
  expect(plain).toContain('这是第 2 个窗口')
})

test('armed, a queued_command typed mid-turn that opens with a tag is the person’s request', async ($, on) => {
  const w = world(on, 's-queued-tag', { CTX_MOD: '1' })
  await boot($)
  await $.prompt.submit({ text: '<task>先把登录页改了</task>', wait: false, origin: { kind: 'composer' } } as never)
  await otherDoor(
    $,
    'attachment',
    { type: 'attachment', name: 'queued_command', role: 'user', isMeta: true, content: [{ type: 'text', text: '用户在回合中追加：<task>先把登录页改了</task>' }] },
    'r-qt',
  )
  await w.clock.settle()
  expect(fileAt(w, 'history-w001.jsonl') ?? '').toContain('"isPerson":true')
  expect(await bookable($, 'qt')).toBe(true)
})

test('armed, a person’s prompt survives an injected head and the handoff drops it', async ($, on) => {
  world(on, 's-injected-2', { CTX_MOD: '1' })
  await boot($)
  await append($, {
    message: {
      type: 'user',
      content: [
        {
          type: 'text',
          text: '<system-reminder>引擎自己的开场</system-reminder>\n\n把登录页的按钮改成蓝色',
        },
      ],
    },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'row-2',
  })
  await callTool(
    $,
    ledger({ tool_use_id: 'l1', task_id: 't1', title: '按钮', status: 'in_progress', text: '在做', next_step: '接着改' }),
  )
  const result = await compact($, 'auto')
  const text = messagesOf(result)
    .map(message => message.text ?? '')
    .join('\n')
  expect(text).toContain('把登录页的按钮改成蓝色')
  expect(text).not.toContain('引擎自己的开场')
})

test('armed, an automatic compaction with a stale ledger keeps core and adds the handoff', async ($, on) => {
  const w = world(on, 's-stale', { CTX_MOD: '1' })
  await boot($)
  const result = await compact($, 'auto')
  expect(w.coreCompactions).toBe(1)
  const messages = messagesOf(result)
  expect(messages).toHaveLength(2)
  expect(messages[0]?.text).toBe('a summary')
})

test('armed, the turn after an approved switch runs the compact command', async ($, on) => {
  const w = world(on, 's-turn', { CTX_MOD: '1' })
  w.usage.tokens = 340_000
  await boot($)
  await armedWithFreshLedger($, '先看一眼上下文')
  const approved = await callTool($, { tool: 'mcp__ctx-mod__context', tool_use_id: 'ctx-1', action: 'new' })
  expect(textOf(approved)).toContain('已批准')
  await endTurn($, 'answer')
  expect(w.runs).toContain('compact')
})

test('armed, a compact that threw leaves the next tool call free', async ($, on) => {
  const w = world(on, 's-threw', { CTX_MOD: '1' })
  w.usage.tokens = 340_000
  w.runError = new Error('the compact command blew up')
  await boot($)
  await armedWithFreshLedger($, '先看一眼上下文')
  const approved = await callTool($, { tool: 'mcp__ctx-mod__context', tool_use_id: 'ctx-1', action: 'new' })
  expect(textOf(approved)).toContain('已批准')
  await endTurn($, 'answer')
  // The failure reached the mod (it logged it) rather than being swallowed below.
  expect(w.logs.join('\n')).toContain('turn.complete')
  const later = await callTool($, { tool: 'Read', tool_use_id: 'tu-after', file_path: '/work/b.ts' })
  expect(later.deny).toBeUndefined()
  expect(textOf(later)).toContain('the tool ran')
})

test('armed, session.end leaves the module state a later session must not inherit', async ($, on) => {
  const w = world(on, 's-first', { CTX_MOD: '1' })
  await boot($)
  await personRequest($, '旧窗口里的请求', 'person-1')
  await callTool(
    $,
    ledger({ tool_use_id: 'ledger-1', task_id: 't1', title: '工作', status: 'in_progress', text: '开始', next_step: '继续' }),
  )
  // An automatic compaction arms the next request's prefix, and no window ends after it.
  await compact($, 'auto')
  w.usage.tokens = 120_000
  await $.session.end({ sessionId: 's-first' } as never)

  w.sessionId = 's-second'
  await boot($)
  await callTool($, { tool: 'Read', tool_use_id: 'tu-1', file_path: '/work/a.ts' })
  // A row writes meta.json; no model step ran in the second session, so no prefix was sampled for it.
  await personRequest($, '新窗口里的请求', 'person-2')
  await w.clock.settle()
  const meta = fileAt(w, 'ctx-mod/s-second/meta.json')
  expect(meta).toBeDefined()
  expect((JSON.parse(meta ?? '{}') as { lastPrefix?: unknown }).lastPrefix).toBeNull()
})

/** The saved meta of the session; a person row is what makes the mod write it. */
const metaAfterRow = async ($: Engine, w: World, id: string): Promise<{ requestsSinceSwitch?: number; lastPrefix?: number | null }> => {
  await personRequest($, '落一行', id)
  await w.clock.settle()

  return JSON.parse(fileAt(w, `ctx-mod/${w.sessionId}/meta.json`) ?? '{}') as { requestsSinceSwitch?: number; lastPrefix?: number | null }
}

test('armed, one step with three ordinary tool calls is one request, not three', async ($, on) => {
  const w = world(on, 's-req-tools', { CTX_MOD: '1' })
  await boot($)
  w.stepUsage = null
  for (const n of [1, 2, 3]) await callTool($, { tool: 'Read', tool_use_id: `tu-r${n}`, file_path: `/work/${n}.ts` })
  expect((await metaAfterRow($, w, 'p-r0')).requestsSinceSwitch).toBe(0)
  await step($, 0, undefined, 'turn-req-tools')
  expect((await metaAfterRow($, w, 'p-r1')).requestsSinceSwitch).toBe(1)
})

test('armed, a text-only step counts as a request, with or without usage', async ($, on) => {
  const w = world(on, 's-req-text', { CTX_MOD: '1' })
  await boot($)
  w.stepUsage = null
  await step($, 0, undefined, 'turn-req-text')
  expect((await metaAfterRow($, w, 'p-t1')).requestsSinceSwitch).toBe(1)
  w.stepUsage = usageOf(6, 100, 0)
  await step($, 1, undefined, 'turn-req-text')
  expect((await metaAfterRow($, w, 'p-t2')).requestsSinceSwitch).toBe(2)
})

test('armed, a subagent step is not a request of the main loop', async ($, on) => {
  const w = world(on, 's-req-agent', { CTX_MOD: '1' })
  await boot($)
  await step($, 0, 'agent-7', 'turn-req-agent')
  await step($, 1, 'agent-7', 'turn-req-agent')
  expect((await metaAfterRow($, w, 'p-a1')).requestsSinceSwitch).toBe(0)
})

test('armed, the same turn and step index seen twice is counted once', async ($, on) => {
  const w = world(on, 's-req-twice', { CTX_MOD: '1' })
  await boot($)
  await step($, 0, undefined, 'turn-req-twice')
  await step($, 0, undefined, 'turn-req-twice')
  expect((await metaAfterRow($, w, 'p-w1')).requestsSinceSwitch).toBe(1)
  await step($, 1, undefined, 'turn-req-twice')
  expect((await metaAfterRow($, w, 'p-w2')).requestsSinceSwitch).toBe(2)
})

test('armed, the first step after a switch samples the prefix even when it calls no tool', async ($, on) => {
  const w = world(on, 's-req-prefix', { CTX_MOD: '1' })
  await boot($)
  await armedWithFreshLedger($, '换窗后第一步不调工具')
  await compact($, 'auto')
  w.stepUsage = usageOf(6, 0, 80_000)
  await step($, 0, undefined, 'turn-req-prefix')
  const meta = await metaAfterRow($, w, 'p-x1')
  // The handoff's own size comes off the 80006 the request carried.
  expect(typeof meta.lastPrefix).toBe('number')
  expect(meta.lastPrefix ?? 0).toBeGreaterThan(0)
  expect(meta.lastPrefix ?? 0).toBeLessThan(80_006)
  expect(meta.requestsSinceSwitch).toBe(1)
})

/** `/ctx-mod <args>`, as the composer runs the command. */
const runCommand = async ($: Engine, args?: string): Promise<string> => {
  const result = (await $.command.run({ command: 'ctx-mod', ...(args === undefined ? {} : { args }) } as never)) as {
    text?: string
  }

  return String(result.text ?? '')
}

test('armed, the conversation the mod never saw is imported when the session opens', async ($, on) => {
  const w = world(on, 's-old', { CTX_MOD: '1' })
  w.messages = [
    { role: 'user', text: '早先的请求：把解析器改严一点', toolUses: [] },
    { role: 'assistant', text: '已经改好了。', toolUses: [] },
  ]
  await boot($)
  await w.clock.settle()
  const found = await callTool($, history({ tool_use_id: 'hist-old', action: 'search', query: '解析器改严' }))
  expect(textOf(found)).toContain('早先的请求：把解析器改严一点')
  expect(fileAt(w, 'history-w001.jsonl')).toContain('把解析器改严')
})

test('armed, /ctx-mod switch answers at once and asks for the compaction on the clock', async ($, on) => {
  const w = world(on, 's-manual', { CTX_MOD: '1' })
  w.compactsOnRun = true
  await boot($)
  await personRequest($, '把解析器改严一点', 'person-1')

  expect(await runCommand($, 'switch')).toContain('正在换到新窗口')
  // Nothing may run inside the hook itself: the command runs on a timer.
  expect(w.runs).toEqual([])

  await w.clock.advance(300)
  expect(w.runs).toContain('compact')
  // The engine raises `session.compact` from inside the command it runs; this
  // suite's bottom cannot (see the note at the end of this file), so what the mod
  // shows here is its failure branch: the compaction is logged and the person is
  // told the window stayed as it was. The one-message answer the engine raises on
  // that compaction is the same path `session.compact` below exercises.
  expect(w.logs.join('\n')).toContain('command.run switch')
  expect(namesEndingWith(w, 'handoff-w002.md')).toHaveLength(0)
})

test('armed, a manual compaction keeps core’s summary and appends the handoff after it', async ($, on) => {
  const w = world(on, 's-manual-handoff', { CTX_MOD: '1' })
  await boot($)
  await personRequest($, '把解析器改严一点', 'person-1')
  await callTool(
    $,
    ledger({ tool_use_id: 'ledger-manual', task_id: 't1', title: '解析器', status: 'in_progress', text: '开始改', next_step: '接着做' }),
  )

  const answer = await compact($, 'manual')
  expect(w.coreCompactions).toBe(1)
  const messages = messagesOf(answer)
  expect(messages).toHaveLength(2)
  expect(messages[0]?.text).toBe('a summary')
  expect(String(messages[1]?.text)).toContain('把解析器改严一点')
  await w.clock.settle()
  expect(namesEndingWith(w, 'handoff-w002.md')).toHaveLength(1)
})

test('armed, a bare /ctx-mod still prints the status and switches nothing', async ($, on) => {
  const w = world(on, 's-bare', { CTX_MOD: '1' })
  await boot($)
  await personRequest($, '看看状态', 'person-1')

  expect(await runCommand($)).toContain('ctx-mod 已启用')
  await w.clock.advance(300)
  expect(w.runs).toEqual([])
})

test('armed, /ctx-mod switch with nothing to hand over changes no window', async ($, on) => {
  const w = world(on, 's-empty', { CTX_MOD: '1' })
  await boot($)

  expect(await runCommand($, 'switch')).toContain('还没有可交接的内容')
  await w.clock.advance(300)
  expect(w.runs).toEqual([])
  expect(namesEndingWith(w, 'handoff-w002.md')).toHaveLength(0)
})

// NOT RUNNABLE in this suite: the kit refuses `$.session.compact` from a test's
// own hook ("its hooks module does not call it (host rule; the scan lists no
// calls)"), so the bottom of `command.run` cannot raise the compaction the
// engine would raise after `/compact`. Item 11 is therefore asserted on
// `command.run` alone, above. The test is kept here for when the bottom can.
// test('armed, the compact the turn end ran is answered by the mod, not by core', async ($, on) => {
//   const w = world(on, 's-turn-answer', { CTX_MOD: '1' })
//   w.usage.tokens = 340_000
//   w.compactsOnRun = true
//   await boot($)
//   await armedWithFreshLedger($, '先看一眼上下文')
//   const approved = await callTool($, { tool: 'mcp__ctx-mod__context', tool_use_id: 'ctx-2', action: 'new' })
//   expect(textOf(approved)).toContain('已批准')
//   await endTurn($, 'answer')
//   expect(w.coreCompactions).toBe(0)
//   expect(messagesOf(w.answered ?? { skip: 'none' })).toHaveLength(1)
//   await w.clock.settle()
//   expect(namesEndingWith(w, 'handoff-w002.md')).toHaveLength(1)
// })


test('armed, an automatic compaction with a fresh ledger but nothing on disk goes to core for the summary', async ($, on) => {
  const w = world(on, 's-nodisk', { CTX_MOD: '1' })
  w.failWrites = true
  await boot($)
  await personRequest($, '把解析器改成严格的', 'person-1')
  const booked = await callTool(
    $,
    ledger({ tool_use_id: 'ledger-1', task_id: 't1', title: '解析器', status: 'in_progress', text: '开始改', next_step: '接上严格标志' }),
  )
  expect(textOf(booked)).toContain('没能写进磁盘')

  const messages = messagesOf(await compact($, 'auto'))
  expect(w.coreCompactions).toBe(1)
  expect(messages).toHaveLength(2)
  expect(messages[0]?.text).toBe('a summary')
  expect(String(messages[1]?.text)).toContain('把解析器改成严格的')
  expect(w.logs.join('\n')).toContain('not on disk')
  expect(w.logs.join('\n')).toContain('ctx-mod: write ')
})

test('armed, writes that failed and then recovered still allow the switch without a summary', async ($, on) => {
  const w = world(on, 's-recovered', { CTX_MOD: '1' })
  w.failWrites = true
  await boot($)
  await personRequest($, '把解析器改成严格的', 'person-1')
  await callTool(
    $,
    ledger({ tool_use_id: 'ledger-1', task_id: 't1', title: '解析器', status: 'in_progress', text: '开始改', next_step: '接上严格标志' }),
  )
  w.failWrites = false

  const messages = messagesOf(await compact($, 'auto'))
  expect(w.coreCompactions).toBe(0)
  expect(messages).toHaveLength(1)
  expect(String(messages[0]?.text)).toContain('把解析器改成严格的')
})


test('armed, a fresh ledger with 26 steps after it sends the summary back to core, and the handoff owns up to the gap', async ($, on) => {
  const w = world(on, 's-tail-26', { CTX_MOD: '1' })
  await boot($)
  await armedWithFreshLedger($, '把解析器改成严格的')
  for (let i = 0; i < 26; i += 1) {
    await callTool($, { tool: 'Bash', tool_use_id: `tu-${i}`, command: 'ls' })
    await toolResult($, `tu-${i}`, `row-${i}`, 'listing')
  }

  const messages = messagesOf(await compact($, 'auto'))
  expect(w.coreCompactions).toBe(1)
  expect(messages).toHaveLength(2)
  expect(messages[0]?.text).toBe('a summary')
  expect(String(messages[1]?.text)).toContain('26 个工具结果')
})

test('armed, a fresh ledger with 25 steps after it still switches without a summary', async ($, on) => {
  const w = world(on, 's-tail-25', { CTX_MOD: '1' })
  await boot($)
  await armedWithFreshLedger($, '把解析器改成严格的')
  for (let i = 0; i < 25; i += 1) {
    await callTool($, { tool: 'Bash', tool_use_id: `tu-${i}`, command: 'ls' })
    await toolResult($, `tu-${i}`, `row-${i}`, 'listing')
  }

  const messages = messagesOf(await compact($, 'auto'))
  expect(w.coreCompactions).toBe(0)
  expect(messages).toHaveLength(1)
  expect(String(messages[0]?.text)).toContain('25 个工具结果')
})


/** A session whose cache is cold and whose context is large: the next person prompt is held back. */
const goCold = async ($: Engine, w: World): Promise<void> => {
  // An ordinary first prompt, before the context is large and the cache has expired.
  await personRequest($, '先做点事', 'person-1')
  w.usage.tokens = 150_000
  // The mock clock does not move the time the mod reads, so the cache is cold by an expiry long past.
  w.keeper = { expiresAt: 1, lastActivityAt: 0, ttl: '1h', cachedPrefixTokens: 0, isEnabled: true, pausedReason: null, bridgePhase: 'idle' }
}

const sayWhileCold = async ($: Engine, text: string): Promise<unknown> =>
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

const isDropped = (result: unknown): boolean => typeof result === 'object' && result !== null && 'drop' in result

const heldLeft = (w: World): string[] => {
  const raw = fileAt(w, 'held.json')

  return raw === undefined ? [] : (JSON.parse(raw) as { items: { text: string }[] }).items.map(item => item.text)
}

test('a held prompt is submitted again after the switch, and nothing stays on disk', async ($, on) => {
  const w = world(on, 's-held-ok', { CTX_MOD: '1' })
  await boot($)
  await goCold($, w)
  const result = await sayWhileCold($, '换完再说')
  expect(isDropped(result)).toBe(true)
  expect(heldLeft(w)).toEqual(['换完再说'])

  await w.clock.advance(300)
  await w.clock.settle()
  expect(w.runs.filter(run => run === 'compact')).toHaveLength(1)
  expect(w.resubmits).toEqual(['换完再说'])
  expect(w.notices).toEqual([])
  expect(heldLeft(w)).toEqual([])
})

test('a re-submission another plugin drops tells the person, with the words, and clears the shelf', async ($, on) => {
  const w = world(on, 's-held-drop', { CTX_MOD: '1' })
  w.resubmit = 'drop'
  await boot($)
  await goCold($, w)
  await sayWhileCold($, '这句不能丢')
  await w.clock.advance(300)
  await w.clock.settle()

  expect(w.notices).toEqual(['ctx-mod：换窗口后没能重新提交你的消息，请重发：这句不能丢'])
  expect(heldLeft(w)).toEqual([])
})

test('a re-submission that throws tells the person the same way', async ($, on) => {
  const w = world(on, 's-held-throw', { CTX_MOD: '1' })
  w.resubmit = 'throw'
  await boot($)
  await goCold($, w)
  await sayWhileCold($, '抛错也不能丢')
  await w.clock.advance(300)
  await w.clock.settle()

  expect(w.notices).toEqual(['ctx-mod：换窗口后没能重新提交你的消息，请重发：抛错也不能丢'])
  expect(heldLeft(w)).toEqual([])
  expect(w.logs.join('\n')).toContain('prompt.submit resubmit')
})

test('a message longer than the notice limit is cut with a count of what is not shown', async ($, on) => {
  const w = world(on, 's-held-long', { CTX_MOD: '1' })
  w.resubmit = 'drop'
  await boot($)
  await goCold($, w)
  await sayWhileCold($, 'x'.repeat(20_050))
  await w.clock.advance(300)
  await w.clock.settle()

  expect(w.notices).toEqual([`ctx-mod：换窗口后没能重新提交你的消息，请重发：${'x'.repeat(20_000)}（后面还有 50 个字符没有显示）`])
})

test('a second message while the switch runs queues behind it: one compaction, two submissions in order', async ($, on) => {
  const w = world(on, 's-held-two', { CTX_MOD: '1' })
  await boot($)
  await goCold($, w)
  expect(isDropped(await sayWhileCold($, '第一句'))).toBe(true)
  const second = await sayWhileCold($, '第二句')
  expect(isDropped(second)).toBe(true)
  expect(String((second as { drop?: unknown }).drop)).toContain('排在后面')
  expect(heldLeft(w)).toEqual(['第一句', '第二句'])

  await w.clock.advance(300)
  await w.clock.settle()
  expect(w.runs.filter(run => run === 'compact')).toHaveLength(1)
  expect(w.resubmits).toEqual(['第一句', '第二句'])
  expect(heldLeft(w)).toEqual([])
})

test('a held message that cannot be written down goes in as usual and no switch is asked for', async ($, on) => {
  const w = world(on, 's-held-nowrite', { CTX_MOD: '1' })
  await boot($)
  await goCold($, w)
  w.failWrites = true
  const result = await sayWhileCold($, '写不进盘')
  expect(isDropped(result)).toBe(false)
  expect(w.submits).toContain('写不进盘')
  await w.clock.advance(300)
  await w.clock.settle()
  expect(w.runs).toEqual([])
})

test('messages a former run left on the shelf are shown once, in order, not sent again', async ($, on) => {
  const w = world(on, 's-held-left', { CTX_MOD: '1' })
  w.readable.set(
    'C:/Users/someone/.claude/ctx-mod/s-held-left/held.json',
    JSON.stringify({ items: [{ id: 1, text: '旧的一句', at: 1 }, { id: 2, text: '旧的二句', at: 2 }] }),
  )
  await boot($)
  await personRequest($, '随便说点', 'person-1')
  await w.clock.settle()

  expect(w.notices).toEqual([
    'ctx-mod：上次换窗口时扣下的一条消息没有送达，请重发：旧的一句',
    'ctx-mod：上次换窗口时扣下的一条消息没有送达，请重发：旧的二句',
  ])
  expect(heldLeft(w)).toEqual([])
  expect(w.resubmits).toEqual([])
})

/** A row the engine files outside the three original doors. */
const otherDoor = async (
  $: Engine,
  door: string,
  message: Readonly<Record<string, unknown>>,
  id: string,
): Promise<unknown> => await append($, { message, door, origin: { kind: 'engine' }, uuid: id })

const searchHistory = async ($: Engine, e: Readonly<Record<string, unknown>>): Promise<string> =>
  textOf(await callTool($, history({ tool_use_id: 'hist-x', action: 'search', ...e })))

test('armed, rows from the other doors are filed with their door, and a notice is not', async ($, on) => {
  const w = world(on, 's-doors', { CTX_MOD: '1' })
  await boot($)
  await otherDoor($, 'delivery', { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: '子代理 a1 的结果：found-it' }] }, 'r-1')
  await otherDoor($, 'compaction', { type: 'user', role: 'user', content: [{ type: 'text', text: '压缩后的摘要 found-it' }] }, 'r-2')
  await otherDoor($, 'attachment', { type: 'attachment', name: 'nested_memory', role: 'user', content: [{ type: 'text', text: '背景记忆 found-it' }] }, 'r-3')
  await otherDoor($, 'notice', { type: 'system', name: 'local_command', content: [{ type: 'text', text: '本地命令 found-it' }] }, 'r-4')
  await otherDoor($, 'delivery', { type: 'user', role: 'user', content: [{ type: 'image', source: {} }, { type: 'image', source: {} }] }, 'r-5')
  await otherDoor($, 'delivery', { type: 'user', role: 'user', content: [] }, 'r-6')
  await w.clock.settle()

  const shard = fileAt(w, 'history-w001.jsonl') ?? ''
  expect(shard).toContain('"door":"delivery"')
  expect(shard).toContain('"door":"compaction"')
  expect(shard).toContain('"name":"nested_memory"')
  expect(shard).not.toContain('本地命令')
  expect(shard).toContain('[非文本内容：image×2]')
  expect(shard.trim().split('\n')).toHaveLength(4)

  const found = await searchHistory($, { query: 'found-it' })
  expect(found).toContain('<delivery>')
  expect(found).toContain('<compaction>')
  expect(found).not.toContain('背景记忆')
  expect(await searchHistory($, { query: 'found-it', door: 'attachment' })).toContain('背景记忆')
})

const styleText = (text: string): Readonly<Record<string, unknown>> => ({
  type: 'attachment',
  name: 'output_style',
  role: 'user',
  content: [{ type: 'text', text }],
})

const countOf = (text: string, needle: string): number => text.split(needle).length - 1

test('armed, a background attachment repeated unchanged in a window is filed once, and a changed body is filed again', async ($, on) => {
  const w = world(on, 's-bg-dedupe', { CTX_MOD: '1' })
  await boot($)
  await otherDoor($, 'attachment', styleText('BGSTYLE-A'), 'bg-1')
  await otherDoor($, 'attachment', styleText('BGSTYLE-A'), 'bg-2')
  await otherDoor($, 'attachment', styleText('BGSTYLE-A'), 'bg-3')
  await w.clock.settle()
  expect(countOf(fileAt(w, 'history-w001.jsonl') ?? '', 'BGSTYLE-A')).toBe(1)

  await otherDoor($, 'attachment', styleText('BGSTYLE-B'), 'bg-4')
  await w.clock.settle()
  const shard = fileAt(w, 'history-w001.jsonl') ?? ''
  expect(countOf(shard, 'BGSTYLE-A')).toBe(1)
  expect(countOf(shard, 'BGSTYLE-B')).toBe(1)

  // Back to the first body: it is not the last one filed any more, so it is a change.
  await otherDoor($, 'attachment', styleText('BGSTYLE-A'), 'bg-5')
  await w.clock.settle()
  expect(countOf(fileAt(w, 'history-w001.jsonl') ?? '', 'BGSTYLE-A')).toBe(2)
})

test('armed, the same background body is filed again the first time it shows in a new window', async ($, on) => {
  const w = world(on, 's-bg-window', { CTX_MOD: '1' })
  await boot($)
  await personRequest($, '把解析器改严一点', 'person-bg')
  await otherDoor($, 'attachment', styleText('BGSTYLE-W'), 'bg-w1')
  await compact($, 'auto')
  await w.clock.settle()
  expect(namesEndingWith(w, 'handoff-w002.md')).toHaveLength(1)

  await otherDoor($, 'attachment', styleText('BGSTYLE-W'), 'bg-w2')
  await otherDoor($, 'attachment', styleText('BGSTYLE-W'), 'bg-w3')
  await w.clock.settle()
  expect(countOf(fileAt(w, 'history-w001.jsonl') ?? '', 'BGSTYLE-W')).toBe(1)
  expect(countOf(fileAt(w, 'history-w002.jsonl') ?? '', 'BGSTYLE-W')).toBe(1)
})

test('armed, only background rows are deduplicated: identical deliveries are all filed', async ($, on) => {
  const w = world(on, 's-bg-delivery', { CTX_MOD: '1' })
  await boot($)
  const delivery = { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: 'DELIVERED-SAME' }] }
  await otherDoor($, 'delivery', delivery, 'd-1')
  await otherDoor($, 'delivery', delivery, 'd-2')
  await w.clock.settle()
  expect(countOf(fileAt(w, 'history-w001.jsonl') ?? '', 'DELIVERED-SAME')).toBe(2)
})

test('armed, a message typed mid-turn that arrives as a queued_command is the person’s own request', async ($, on) => {
  const w = world(on, 's-queued', { CTX_MOD: '1' })
  await boot($)
  await $.prompt.submit({ text: '等一下，先把登录页改了', wait: false, origin: { kind: 'composer' } } as never)
  await otherDoor(
    $,
    'attachment',
    { type: 'attachment', name: 'queued_command', role: 'user', isMeta: true, content: [{ type: 'text', text: '用户在回合中追加：等一下，先把登录页改了' }] },
    'r-q',
  )
  // The words are the person's own in the row, not the engine's wrapper around them.
  await w.clock.settle()
  const shard = fileAt(w, 'history-w001.jsonl') ?? ''
  expect(shard).toContain('"isPerson":true')
  expect(shard).toContain('"name":"queued_command"')
  expect(shard).not.toContain('用户在回合中追加')
  const booked = await callTool(
    $,
    ledger({ tool_use_id: 'ledger-q', task_id: 't1', title: '登录页', status: 'in_progress', text: '开始', next_step: '接着做' }),
  )
  expect(booked.isError).toBeUndefined()
})

test('armed, a mid-turn message the engine files under the delivery door is the person’s own request', async ($, on) => {
  const w = world(on, 's-queued-delivery', { CTX_MOD: '1' })
  await boot($)
  await $.prompt.submit({ text: '等一下，先把登录页改了', wait: false, origin: { kind: 'sdk' } } as never)
  // The wrapper as a real session carried it.
  const wrapped =
    '<system-reminder>\nThe user sent a new message while you were working:\n等一下，先把登录页改了\n\n' +
    'This is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, ' +
    'rather than as a separate conversation turn. Address the message above as you continue this turn.\n</system-reminder>'
  await otherDoor(
    $,
    'delivery',
    { type: 'attachment', name: 'queued_command', role: 'user', isMeta: true, content: [{ type: 'text', text: wrapped }] },
    'r-qd',
  )
  await w.clock.settle()
  const rows = (fileAt(w, 'history-w001.jsonl') ?? '')
    .split('\n')
    .filter(line => line.includes('"name":"queued_command"'))
    .map(line => JSON.parse(line) as { isPerson?: boolean; door?: string; text?: string })
  expect(rows).toHaveLength(1)
  expect(rows[0]?.isPerson).toBe(true)
  expect(rows[0]?.door).toBe('delivery')
  expect(rows[0]?.text).toBe('等一下，先把登录页改了')
})

test('armed, a queued_command that matches no submitted words is an ordinary row', async ($, on) => {
  const w = world(on, 's-queued-other', { CTX_MOD: '1' })
  await boot($)
  await otherDoor(
    $,
    'attachment',
    { type: 'attachment', name: 'queued_command', role: 'user', content: [{ type: 'text', text: '<task-notification>子代理 a2 完成</task-notification>' }] },
    'r-n',
  )
  await w.clock.settle()
  const shard = fileAt(w, 'history-w001.jsonl') ?? ''
  expect(shard).toContain('task-notification')
  expect(shard).not.toContain('isPerson')
  const booked = await callTool(
    $,
    ledger({ tool_use_id: 'ledger-n', task_id: 't1', title: '工作', status: 'in_progress', text: '开始', next_step: '接着做' }),
  )
  expect(booked.isError).toBe(true)
})

test('armed, an Agent task and a long command are kept whole and read back with field input', async ($, on) => {
  const w = world(on, 's-args', { CTX_MOD: '1' })
  await boot($)
  const task = `请逐个检查 src 下的文件。\n${'细节说明。'.repeat(120)}\n最后汇报 only-in-the-task-text。`
  await callTool($, { tool: 'Agent', tool_use_id: 'tu-agent', prompt: task, description: '检查文件', subagent_type: 'explorer' })
  await toolResult($, 'tu-agent', 'row-a', '子代理已启动')
  const command = `echo ${'y'.repeat(400)} && echo only-in-the-command`
  await callTool($, { tool: 'Bash', tool_use_id: 'tu-bash', command })
  await toolResult($, 'tu-bash', 'row-b', 'ok')
  await w.clock.settle()

  const agent = textOf(await callTool($, history({ tool_use_id: 'hist-a', action: 'read', seq: 1, field: 'input' })))
  expect(agent).toContain(task)
  expect(agent).toContain('subagent_type: explorer')
  expect(agent).not.toContain('tool_use_id')
  const bash = textOf(await callTool($, history({ tool_use_id: 'hist-b', action: 'read', seq: 2, field: 'input' })))
  expect(bash).toContain('only-in-the-command')
  expect(await searchHistory($, { query: 'only-in-the-task-text' })).toContain('#1 w1 tool [Agent]')
  expect(fileAt(w, 'history-w001.jsonl')).toContain('"callId":"tu-agent"')
})

test('armed, a tool result with an image leaves a note in the row', async ($, on) => {
  const w = world(on, 's-image', { CTX_MOD: '1' })
  await boot($)
  await callTool($, { tool: 'Read', tool_use_id: 'tu-img', file_path: '/work/a.png' })
  await append($, {
    message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-img', content: [{ type: 'text', text: '图片说明' }, { type: 'image', source: {} }] }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Read' },
    uuid: 'row-img',
  })
  await w.clock.settle()
  expect(fileAt(w, 'history-w001.jsonl')).toContain('[非文本内容：image×1]')
})

test('armed, the engine messages after the last recorded one are filed when the session opens again', async ($, on) => {
  const w = world(on, 's-tail', { CTX_MOD: '1' })
  const dir = 'C:/Users/someone/.claude/ctx-mod/s-tail'
  w.readable.set(
    `${dir}/history-w001.jsonl`,
    `${JSON.stringify({ seq: 1, uuid: 'u1', ts: 1, window: 1, role: 'user', isPerson: true, text: '把解析器改严一点，错误信息也要换掉' })}\n`,
  )
  w.messages = [
    { role: 'user', text: '把解析器改严一点，错误信息也要换掉', toolUses: [] },
    { role: 'assistant', text: '停用期间做的回答', toolUses: [] },
  ]
  await boot($)
  await w.clock.settle()
  expect(w.logs.some(line => line.includes('补录了 1 条'))).toBe(true)
  expect(await searchHistory($, { query: '停用期间做的回答' })).toContain('#2 w1 assistant')
})