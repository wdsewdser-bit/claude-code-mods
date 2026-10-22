// Suite for `hooks/register.ts`: the engine wiring. Everything beneath the mod
// is the test's own: the clock, the environment, the model's answers and the
// tools it calls.

import type { On, TurnStepResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const START = Date.parse('2026-10-20T00:00:00.000Z')
const MODEL = 'claude-opus-5-5'

type Use = { tool: string; input?: Record<string, unknown> }

type World = {
  clock: MockClock
  /** The tool uses the next model request answers with. */
  next: Use[]
  /** The index of the next request. */
  index: number
  /** The tool calls that ran, in order. */
  ran: string[]
  /** The refusals the mod gave, in order. */
  refusals: { tool: string; reason: string }[]
  /** The batches whose injected context named the mod. */
  notices: string[]
  /** Every tool call the engine raised, refused or not. */
  calls: number
}

const world = (on: On, env: Readonly<Record<string, string>> = {}): World => {
  const w: World = {
    clock: mock.clock(on, { now: START }),
    next: [],
    index: 0,
    ran: [],
    refusals: [],
    notices: [],
    calls: 0,
  }
  mock.env(on, env)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.log', () => ({ value: undefined }))
  // The engine's own answer for the batch: the mods' injected context comes back on top of it.
  on('classic.PostToolBatch', () => ({ value: {} }))
  // The engine's model request, as the bottom answers it: the tool uses the test
  // put there, and nothing else.
  on('turn.step', async function* (_$, e) {
    const answer = {
      turnId: e.turnId,
      index: e.index,
      answer: 'OK',
      toolUses: w.next as never,
      stopReason: 'end_turn',
      usage: null,
    } as TurnStepResult

    return answer
  })
  on('tool.call', (_$, e) => {
    w.ran.push(String(e.tool))

    return { result: 'ran' }
  })

  return w
}

const boot = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/work', surface: null, isInteractive: true })
}

/** One model request of the main thread (or of a subagent, with an id). */
const request = async ($: Engine, w: World, uses: (string | Use)[], agentId?: string): Promise<void> => {
  w.next = uses.map(use => (typeof use === 'string' ? { tool: use, input: {} } : use))
  const index = w.index
  w.index += 1
  const step = $.turn.step({
    turnId: 't1',
    index,
    model: MODEL,
    effort: 'medium',
    messageCount: 1,
    ...(agentId === undefined ? {} : { agentId }),
  })
  for await (const chunk of step) void chunk
}

type CallResult = { deny?: string; result?: unknown }

const call = async (
  $: Engine,
  w: World,
  tool: string,
  input: Record<string, unknown> = {},
  agentId?: string,
): Promise<CallResult> => {
  const answer = (await $.tool.call({
    tool,
    tool_use_id: `u${w.calls}`,
    ...input,
    ...(agentId === undefined ? {} : { agentId }),
  } as never)) as unknown as CallResult
  w.calls += 1
  if (typeof answer?.deny === 'string') w.refusals.push({ tool, reason: answer.deny })

  return answer
}

/** The batch's end, as the engine raises it: what the mod injects comes back here. */
const batch = async ($: Engine, w: World, agentId?: string): Promise<void> => {
  const answer = await $.classic.PostToolBatch({
    hook_event_name: 'PostToolBatch',
    tool_calls: [],
    tool_name: 'Read',
    ...(agentId === undefined ? {} : { agent_id: agentId }),
  } as never)
  const text = JSON.stringify(answer ?? '')
  if (text.includes('dispatch-gate')) w.notices.push(text)
}

/** One whole execution request of the main thread: the model asks, the tool runs, the batch ends. */
const exec = async ($: Engine, w: World, tool = 'Edit', input: Record<string, unknown> = {}): Promise<CallResult> => {
  await request($, w, [{ tool, input }])
  const answer = await call($, w, tool, input)
  await batch($, w)

  return answer
}

/** One Claude subagent dispatch, as the engine sees it: a request and its Agent call. */
const dispatch = async ($: Engine, w: World): Promise<CallResult> => {
  await request($, w, ['Agent'])
  const answer = await call($, w, 'Agent', { prompt: 'do it', description: 'work' })
  await batch($, w)

  return answer
}

test('the 4th consecutive execution request earns one reminder', async ($, on) => {
  const w = world(on)
  await boot($)
  for (let i = 0; i < 3; i += 1) await exec($, w)
  expect(w.notices).toHaveLength(0)
  await exec($, w)
  expect(w.notices).toHaveLength(1)
  await exec($, w)
  await exec($, w)
  expect(w.notices).toHaveLength(1)
})

test('the 8th consecutive execution request is refused once, and the retry runs', async ($, on) => {
  const w = world(on)
  await boot($)
  for (let i = 0; i < 7; i += 1) await exec($, w)
  expect(w.refusals).toHaveLength(0)
  await request($, w, ['Edit'])
  const refused = await call($, w, 'Edit')
  expect(typeof refused.deny).toBe('string')
  expect(w.refusals).toHaveLength(1)
  const retry = await call($, w, 'Edit')
  expect(retry.deny === undefined).toBe(true)
  await batch($, w)
  // the next request runs as usual: one refusal per streak, never a deadlock
  await exec($, w)
  expect(w.refusals).toHaveLength(1)
  expect(w.ran).toContain('Edit')
})

test('a dispatch clears the count and leaves three read-only acceptance requests free', async ($, on) => {
  const w = world(on)
  await boot($)
  for (let i = 0; i < 3; i += 1) await exec($, w)
  const sent = await dispatch($, w)
  expect(sent.deny === undefined).toBe(true)
  for (let i = 0; i < 3; i += 1) await exec($, w, 'Read')
  expect(w.notices).toHaveLength(0)
  await exec($, w)
  expect(w.notices).toHaveLength(0)
  for (let i = 0; i < 3; i += 1) await exec($, w)
  expect(w.notices).toHaveLength(1)
})

test('bookkeeping neither counts nor clears the streak', async ($, on) => {
  const w = world(on)
  await boot($)
  for (let i = 0; i < 3; i += 1) await exec($, w)
  await request($, w, ['mcp__ctx-mod__ledger_append'])
  await call($, w, 'mcp__ctx-mod__ledger_append', { task_id: 't', status: 'done', text: 'x', evidence: '#1' })
  await batch($, w)
  await request($, w, ['mcp__ccd_turn__update_plan'])
  await call($, w, 'mcp__ccd_turn__update_plan', { plan: 'x' })
  await batch($, w)
  expect(w.notices).toHaveLength(0)
  await exec($, w)
  expect(w.notices).toHaveLength(1)
})

test("a subagent's own requests and calls are never gated", async ($, on) => {
  const w = world(on)
  await boot($)
  for (let i = 0; i < 12; i += 1) {
    await request($, w, ['Edit'], 'a1')
    const answer = await call($, w, 'Edit', {}, 'a1')
    expect(answer.deny === undefined).toBe(true)
    await batch($, w, 'a1')
  }
  expect(w.refusals).toHaveLength(0)
  expect(w.notices).toHaveLength(0)
})

test("a person's message clears the streak", async ($, on) => {
  const w = world(on)
  await boot($)
  for (let i = 0; i < 7; i += 1) await exec($, w)
  // the first stretch earned its reminder; the person's message starts another
  expect(w.notices).toHaveLength(1)
  await $.prompt.submit({ text: '继续', wait: false, origin: { kind: 'composer' } } as never)
  for (let i = 0; i < 3; i += 1) await exec($, w)
  expect(w.notices).toHaveLength(1)
  await exec($, w)
  expect(w.notices).toHaveLength(2)
})

test('a parallel batch counts as one request', async ($, on) => {
  const w = world(on)
  await boot($)
  for (let i = 0; i < 3; i += 1) await exec($, w)
  const reads: Use[] = Array.from({ length: 5 }, () => ({ tool: 'Read', input: {} }))
  await request($, w, reads)
  for (let i = 0; i < 5; i += 1) await call($, w, 'Read')
  await batch($, w)
  expect(w.notices).toHaveLength(1)
})

test('a main-session-only command is not counted', async ($, on) => {
  const w = world(on)
  await boot($)
  for (let i = 0; i < 3; i += 1) await exec($, w)
  for (let i = 0; i < 5; i += 1) await exec($, w, 'Bash', { command: 'claude --version' })
  expect(w.notices).toHaveLength(0)
  expect(w.refusals).toHaveLength(0)
})

test('the 4th Claude subagent within an hour is refused once, and the retry runs', async ($, on) => {
  const w = world(on)
  await boot($)
  for (let i = 0; i < 3; i += 1) {
    const sent = await dispatch($, w)
    expect(sent.deny === undefined).toBe(true)
  }
  const refused = await dispatch($, w)
  expect(typeof refused.deny).toBe('string')
  expect(String(refused.deny)).toContain('合并')
  const retry = await dispatch($, w)
  expect(retry.deny === undefined).toBe(true)
  // the rest of the hour refuses no more
  for (let i = 0; i < 5; i += 1) {
    const sent = await dispatch($, w)
    expect(sent.deny === undefined).toBe(true)
  }
  expect(w.refusals).toHaveLength(1)
  // an hour later the window is empty again: three pass, the fourth is refused
  await w.clock.advance(61 * 60_000)
  for (let i = 0; i < 3; i += 1) {
    const sent = await dispatch($, w)
    expect(sent.deny === undefined).toBe(true)
  }
  const later = await dispatch($, w)
  expect(typeof later.deny).toBe('string')
  expect(w.refusals).toHaveLength(2)
})

test('delegating to DeepSeek is unlimited and clears the self-work count', async ($, on) => {
  const w = world(on)
  await boot($)
  for (let i = 0; i < 8; i += 1) {
    await request($, w, ['mcp__delegate__delegate_pro'])
    const sent = await call($, w, 'mcp__delegate__delegate_pro', { prompt: 'x' })
    expect(sent.deny === undefined).toBe(true)
    await batch($, w)
  }
  expect(w.refusals).toHaveLength(0)
  for (let i = 0; i < 3; i += 1) await exec($, w)
  await request($, w, ['mcp__delegate__delegate_flash'])
  await call($, w, 'mcp__delegate__delegate_flash', { prompt: 'x' })
  await batch($, w)
  for (let i = 0; i < 3; i += 1) await exec($, w)
  expect(w.notices).toHaveLength(0)
  await exec($, w)
  expect(w.notices).toHaveLength(1)
})

test('mode=off does nothing', async ($, on) => {
  const w = world(on, { DISPATCH_GATE_MODE: 'off' })
  await boot($)
  for (let i = 0; i < 12; i += 1) await exec($, w)
  for (let i = 0; i < 6; i += 1) await dispatch($, w)
  expect(w.refusals).toHaveLength(0)
  expect(w.notices).toHaveLength(0)
})

test('DISPATCH_GATE=0 turns it off', async ($, on) => {
  const w = world(on, { DISPATCH_GATE: '0' })
  await boot($)
  for (let i = 0; i < 10; i += 1) await exec($, w)
  expect(w.notices).toHaveLength(0)
  expect(w.refusals).toHaveLength(0)
})

test('mode=remind reminds but never refuses', async ($, on) => {
  const w = world(on, { DISPATCH_GATE_MODE: 'remind' })
  await boot($)
  for (let i = 0; i < 10; i += 1) await exec($, w)
  expect(w.notices).toHaveLength(1)
  expect(w.refusals).toHaveLength(0)
  for (let i = 0; i < 6; i += 1) await dispatch($, w)
  expect(w.refusals).toHaveLength(0)
})

test('session.end clears the streak', async ($, on) => {
  const w = world(on)
  await boot($)
  for (let i = 0; i < 7; i += 1) await exec($, w)
  expect(w.notices).toHaveLength(1)
  await $.session.end({ sessionId: 's1', reason: 'clear' } as never)
  for (let i = 0; i < 3; i += 1) await exec($, w)
  expect(w.notices).toHaveLength(1)
  expect(w.refusals).toHaveLength(0)
  await exec($, w)
  expect(w.notices).toHaveLength(2)
})
