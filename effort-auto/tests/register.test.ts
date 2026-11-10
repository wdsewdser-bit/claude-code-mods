// Suite for `hooks/register.ts`: the engine wiring. Everything beneath the mod
// is the test's own — the environment, the file system, the registered tools,
// the prompt a person submits and the model request that reports the effort it
// was sent with.

import type { On, TurnStepResult, TurnUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const HOME = '/home/someone'
const FULL = 'mcp__effort-auto__effort'

type Spec = { name: string; description?: string; inputSchema?: unknown }

type World = {
  files: Map<string, string>
  readable: Map<string, string>
  tools: string[]
  specs: Spec[]
  logs: string[]
  /** The effort every request reached the bottom with, in order. */
  efforts: (string | number | undefined)[]
  /** Every tool the bottom was asked to run, in order. */
  calls: string[]
  /** What the bottom answers a named tool with; anything else runs. */
  answers: Map<string, unknown>
  stepUsage: TurnUsage | null
  /** Whether every write is refused, as a full disk would. */
  failWrites: boolean
}

/** Everything beneath the mod: env, files, session id, tools, prompt and request. */
const world = (on: On, env: Readonly<Record<string, string>> = {}, id = 's1'): World => {
  const w: World = {
    files: new Map(),
    readable: new Map(),
    tools: [],
    specs: [],
    logs: [],
    efforts: [],
    calls: [],
    answers: new Map(),
    stepUsage: null,
    failWrites: false,
  }
  mock.env(on, { USERPROFILE: HOME, ...env })
  on('fs.write', (_$, e) => {
    if (w.failWrites) return { deny: 'EIO: write failed' } as never
    w.files.set(e.path, e.text)

    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const text = w.readable.get(e.path)

    return text === undefined ? { deny: 'ENOENT: ' + e.path } : ({ value: text } as never)
  })
  on('session.id', () => ({ value: id }))
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)

    return { value: undefined }
  })
  on('tool.register', (_$, e) => {
    w.tools.push(e.name)
    w.specs.push(e as unknown as Spec)

    return { value: { tool: e.name } } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  // The engine's model request: the effort is what the chain above passed down.
  on('turn.step', async function* (_$, e) {
    w.efforts.push(e.effort)
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
  on('tool.call', (_$, e) => {
    w.calls.push(String(e.tool))

    return (w.answers.get(String(e.tool)) ?? { result: 'the tool ran' }) as never
  })

  return w
}

const boot = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/work', surface: null, isInteractive: true })
}

const startTurn = async ($: Engine, turnId: string): Promise<void> => {
  await $.turn.start({ text: 'go', turnId })
}

type StepOptions = {
  agentId?: string
  turnId?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh'
  /** A model without effort: the request carries none. */
  unsupported?: boolean
}

/** One model request of a loop, read to the end as the engine reads it. */
const step = async ($: Engine, index: number, options: StepOptions = {}): Promise<TurnStepResult> => {
  const input = {
    turnId: options.turnId ?? 'turn-1',
    index,
    model: 'haiku',
    messageCount: 1,
    ...(options.unsupported === true ? {} : { effort: options.effort ?? 'low' }),
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
  }
  const stream = $.turn.step(input as never)
  let read = await stream.next()
  while (!read.done) read = await stream.next()

  return read.value
}

type CallResult = { result?: unknown; isError?: unknown; text?: unknown; context?: readonly string[] }

const callTool = async ($: Engine, e: Readonly<Record<string, unknown>>): Promise<CallResult> =>
  (await $.tool.call(e as never)) as unknown as CallResult

const textOf = (result: CallResult): string =>
  [result.result, result.text].filter(part => part !== undefined).map(part => String(part)).join('\n')

const effortCall = (e: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
  tool: FULL,
  tool_use_id: 'effort-1',
  ...e,
})

const usageOf = (): TurnUsage =>
  ({
    input_tokens: 100,
    output_tokens: 5,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 10,
    model: 'claude-haiku-5-5',
    thinking_tokens: 7,
  }) as unknown as TurnUsage

const rowsOf = (w: World): Record<string, unknown>[] => {
  for (const [path, text] of w.files) {
    if (!path.replaceAll('\\', '/').endsWith('/.claude/effort-auto/steps-s1.jsonl')) continue

    return text
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>)
  }

  return []
}

test('disabled: no tool, no rules, every request keeps the effort it came with', async ($, on) => {
  const w = world(on)
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0, { effort: 'high' })
  await step($, 1, { effort: 'high' })
  expect(w.tools).toHaveLength(0)
  expect(w.specs).toHaveLength(0)
  expect(w.efforts).toEqual(['high', 'high'])
  expect(w.files.size).toBe(0)
})

test('the environment alone turns it on, and session.start registers the one tool', async ($, on) => {
  const w = world(on, { EFFORT_AUTO: '1' })
  await boot($)
  expect(w.tools).toEqual(['effort'])
  const schema = w.specs[0]?.inputSchema as {
    properties?: { level?: { enum?: string[] } }
    required?: string[]
  }
  expect(schema.required).toEqual(['level'])
  expect(schema.properties?.level?.enum).toEqual(['medium', 'high', 'xhigh'])
  const description = w.specs[0]?.description ?? ''
  expect(description).toContain('主会话专属思考档位')
  expect(description).toContain('默认常驻 low')
  expect(description).toContain('可以和其他工具放在同一条消息里')
  expect(description).toContain('high 及以上一次最多 5 步')
  expect(description).toContain('每轮最多 4 次升档')
})

test('the description carries both caps as the manifest sets them', { options: { enabled: true, maxRaises: 2, maxHighSteps: 8 } }, async ($, on) => {
  const w = world(on)
  await boot($)
  const description = w.specs[0]?.description ?? ''
  expect(description).toContain('high 及以上一次最多 8 步')
  expect(description).toContain('每轮最多 2 次升档')
  expect(description).not.toContain('每轮最多 4 次升档')
})

test('every turn rests at low: a raise does not leak into the next one', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  await callTool($, effortCall({ level: 'xhigh' }))
  await step($, 1)
  await startTurn($, 'turn-2')
  await step($, 0, { turnId: 'turn-2' })
  expect(w.efforts).toEqual(['medium', 'xhigh', 'medium'])
  expect(rowsOf(w)[2]?.source).toBe('reset')
})

test('the tool lifts every request after it for its steps, then the resting level returns', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  const answer = await callTool($, effortCall({ level: 'high', steps: 2 }))
  expect(answer.isError).toBeUndefined()
  expect(textOf(answer)).toContain('已升到 high')
  expect(textOf(answer)).toContain('接下来 2 个请求')
  await step($, 1)
  await step($, 2)
  await step($, 3)
  expect(w.efforts).toEqual(['medium', 'high', 'high', 'low'])
  const rows = rowsOf(w)
  expect(rows.map(row => row.source)).toEqual(['reset', 'tool', 'tool', 'expire'])
})

test('steps default to three', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  const answer = await callTool($, effortCall({ level: 'medium' }))
  expect(textOf(answer)).toContain('接下来 3 个请求')
  await step($, 1)
  await step($, 2)
  await step($, 3)
  expect(w.efforts).toEqual(['medium', 'medium', 'medium', 'medium'])
})

test('high is held at five steps, whatever the model asks for', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  const answer = await callTool($, effortCall({ level: 'high', steps: 20 }))
  expect(textOf(answer)).toContain('接下来 5 个请求')
  expect(textOf(answer)).toContain('一次最多 5 步')
  for (let index = 1; index <= 6; index += 1) await step($, index)
  expect(w.efforts).toEqual(['medium', 'high', 'high', 'high', 'high', 'high', 'low'])
})

test('a turn accepts four raises and ignores the rest', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  for (let index = 1; index <= 4; index += 1) {
    const accepted = await callTool($, effortCall({ level: 'medium', steps: 1 }))
    expect(accepted.isError).toBeUndefined()
    await step($, index)
  }
  const refused = await callTool($, effortCall({ level: 'high', steps: 1 }))
  expect(refused.isError).toBeUndefined()
  expect(textOf(refused)).toContain('达到上限')
  await step($, 5)
  expect(w.efforts).toEqual(['medium', 'medium', 'medium', 'medium', 'medium', 'low'])
  const rows = rowsOf(w)
  expect(rows[5]?.source).toBe('cap')
  expect(rows[4]?.raises).toBe(4)
})

test('the raise limit is configurable', { options: { enabled: true, maxRaises: 1 } }, async ($, on) => {
  const w = world(on)
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  await callTool($, effortCall({ level: 'medium', steps: 1 }))
  await step($, 1)
  const refused = await callTool($, effortCall({ level: 'high', steps: 1 }))
  expect(textOf(refused)).toContain('达到上限')
  await step($, 2)
  expect(w.efforts).toEqual(['medium', 'medium', 'low'])
})

test('a single tool failure raises nothing and reminds nothing', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  w.answers.set('Read', { result: 'ENOENT: no such file', isError: true })
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  const answer = await callTool($, { tool: 'Read', tool_use_id: 'r1' })
  expect(answer.context).toBeUndefined()
  await step($, 1)
  expect(w.efforts).toEqual(['medium', 'low'])
  expect(rowsOf(w)[1]?.reminder).toBe(false)
})

test('two failures in a row inject the reminder and leave the level alone', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  w.answers.set('Read', { result: 'ENOENT: no such file', isError: true })
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  await callTool($, { tool: 'Read', tool_use_id: 'r1' })
  const second = await callTool($, { tool: 'Read', tool_use_id: 'r2' })
  expect(second.context?.[0]).toContain('连续两次工具报错')
  expect(second.context?.[0]).toContain('权限确认被拒')
  await step($, 1)
  await step($, 2)
  expect(w.efforts).toEqual(['medium', 'low', 'low'])
  const rows = rowsOf(w)
  expect(rows[1]?.reminder).toBe(true)
  expect(rows[1]?.source).toBe('default')
  expect(rows[2]?.reminder).toBe(false)
})

test('a failure between the two ends the run', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  w.answers.set('Read', { result: 'nope', isError: true })
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  await callTool($, { tool: 'Read', tool_use_id: 'r1' })
  await callTool($, { tool: 'Bash', tool_use_id: 'b1' })
  w.answers.set('Bash', { result: { exitCode: 0 }, text: 'fine' })
  await callTool($, { tool: 'Bash', tool_use_id: 'b2' })
  const third = await callTool($, { tool: 'Read', tool_use_id: 'r2' })
  expect(third.context).toBeUndefined()
  await step($, 1)
  expect(rowsOf(w)[1]?.reminder).toBe(false)
})

test('a refusal is not a tool failure', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  w.answers.set('Read', { deny: 'the person said no' })
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  await callTool($, { tool: 'Read', tool_use_id: 'r1' })
  await callTool($, { tool: 'Read', tool_use_id: 'r2' })
  await step($, 1)
  expect(w.efforts).toEqual(['medium', 'low'])
  expect(rowsOf(w)[1]?.reminder).toBe(false)
})

test('a subagent loop is not touched, not counted and not logged', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  w.answers.set('Read', { result: 'nope', isError: true })
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  await callTool($, effortCall({ level: 'high', steps: 1 }))
  // The subagent's own loop: its request keeps the effort it came with.
  await step($, 0, { agentId: 'a1', effort: 'low' })
  await callTool($, { tool: 'Read', tool_use_id: 'sub-1', agentId: 'a1' })
  const second = await callTool($, { tool: 'Read', tool_use_id: 'sub-2', agentId: 'a1' })
  expect(second.context).toBeUndefined()
  await step($, 1)
  expect(w.efforts).toEqual(['medium', 'low', 'high'])
  const rows = rowsOf(w)
  expect(rows).toHaveLength(2)
  expect(rows.map(row => row.step)).toEqual([0, 1])
})

test('a subagent may not call the tool', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  const answer = await callTool($, effortCall({ level: 'high', agentId: 'a1' }))
  expect(answer.isError).toBe(true)
  await step($, 1)
  expect(w.efforts).toEqual(['medium', 'low'])
})

test('a level outside the three is refused, and low is not a raise', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  const wrong = await callTool($, effortCall({ level: 'max' }))
  expect(wrong.isError).toBe(true)
  const low = await callTool($, effortCall({ level: 'low' }))
  expect(low.isError).toBe(true)
  await step($, 1)
  expect(w.efforts).toEqual(['medium', 'low'])
})

test('a model without effort is passed through untouched, and logs nothing', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0, { unsupported: true })
  expect(w.efforts).toEqual([undefined])
  expect(rowsOf(w)).toHaveLength(0)
})

test('every step is logged with its level, its source, the raise and its usage', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  w.stepUsage = usageOf()
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  await callTool($, effortCall({ level: 'xhigh', steps: 1, reason: '跨文件推理' }))
  await step($, 1)
  const rows = rowsOf(w)
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({
    sessionId: 's1',
    turnId: 'turn-1',
    step: 0,
    effort: 'medium',
    source: 'reset',
    raises: 0,
    reminder: false,
    usage: { output: 5, thinking_tokens: 7 },
  })
  expect(typeof rows[0]?.at).toBe('string')
  expect(rows[1]).toMatchObject({
    turnId: 'turn-1',
    step: 1,
    effort: 'xhigh',
    source: 'tool',
    raises: 1,
    reason: '跨文件推理',
  })
})

test('the log path can be configured, and the environment wins', { options: { enabled: true, logPath: 'D:/tmp/from-config.jsonl' } }, async ($, on) => {
  const w = world(on, { EFFORT_AUTO_LOG: 'D:/tmp/from-env.jsonl' })
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  expect([...w.files.keys()].map(path => path.replaceAll('\\', '/'))).toEqual(['D:/tmp/from-env.jsonl'])
})

test('a log that cannot be written does not break the request', { options: { enabled: true } }, async ($, on) => {
  const w = world(on)
  w.failWrites = true
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0)
  const answer = await callTool($, effortCall({ level: 'high', steps: 1 }))
  expect(answer.isError).toBeUndefined()
  await step($, 1)
  expect(w.efforts).toEqual(['medium', 'high'])
  expect(w.logs.some(line => line.includes('effort-auto: log'))).toBe(true)
})

test('a session not resting on low is left alone: no first-step medium, no raise, no reminder', async ($, on) => {
  const w = world(on, { EFFORT_AUTO: '1' })
  await boot($)
  await startTurn($, 'turn-1')
  await step($, 0, { effort: 'high' })
  await step($, 1, { effort: 'high' })
  expect(w.efforts).toEqual(['high', 'high'])
  expect(w.files.size).toBe(0)
})
