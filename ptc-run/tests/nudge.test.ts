import { describe, expect, test } from 'claude-code/testing'
import { __test, register } from '../hooks/register'

// Feature 1: the reminder on consecutive single-step requests. The counting rules are pure (__test.observeNudge);
// the engine side (only the main session, one line per batch, a new turn starts over) is driven through the hooks.

type Handler = { name: string; opts?: unknown; fn: (...a: unknown[]) => unknown }

const wire = (env: Record<string, string> = {}, options: Record<string, unknown> = {}) => {
  const list: Handler[] = []
  const on = (name: string, a: unknown, b?: unknown) => {
    const fn = (typeof a === 'function' ? a : b) as (...x: unknown[]) => unknown
    list.push({ name, opts: typeof a === 'function' ? undefined : a, fn })
    const chain = { catch: () => chain }
    return chain
  }
  ;(register as unknown as (o: unknown, opt: unknown) => void)(on, options)
  const $ = {
    env: { get: async (n: string) => env[n] },
    session: { cwd: async () => 'C:/work/proj', id: async () => 'sid-nudge', messages: async () => [] },
    tool: { register: async () => ({}), call: async (v: unknown) => v },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    ui: { log: () => undefined },
    agent: { list: async () => [] },
  }
  const find = (name: string, opts?: unknown) => {
    const h = list.find(x => x.name === name && (opts === undefined || JSON.stringify(x.opts) === JSON.stringify(opts)))
    if (h === undefined) throw new Error('no handler ' + name)
    return h
  }
  let seq = 0
  const start = async () => {
    await find('session.start').fn($, { cwd: 'C:/work/proj' }, async () => ({}))
  }
  const step = async (tools: string[], agentId?: string) => {
    const index = seq++
    const result = { turnId: 't1', index, answer: '', toolUses: tools.map(t => ({ tool: t, input: {} })) }
    const gen = find('turn.step').fn($, { turnId: 't1', index, agentId }, async function* () { return result }) as AsyncGenerator
    let out = await gen.next()
    while (!out.done) out = await gen.next()
    return out.value
  }
  const batch = async (agentId?: string, ctx: readonly string[] = ['base']) => {
    return (await find('classic.PostToolBatch').fn($, { agent_id: agentId }, async () => ({ additionalContext: ctx }))) as {
      additionalContext?: readonly string[]
    }
  }
  const prompt = async () => {
    await find('prompt.submit').fn($, {}, async (e: unknown) => e)
  }
  return { start, step, batch, prompt, list }
}

describe('single-step reminder: counting rules', () => {
  test('the second single-step request earns one reminder; the third does not', () => {
    const s = __test.newNudgeState()
    expect(__test.observeNudge(s, [{ tool: 'Read' }], 2)).toBeUndefined()
    const first = __test.observeNudge(s, [{ tool: 'Bash' }], 2)
    expect(typeof first).toBe('string')
    expect(first ?? '').toContain('已连续 2 次单步调用')
    expect(__test.observeNudge(s, [{ tool: 'Grep' }], 2)).toBeUndefined()
  })

  test('bookkeeping beside the one execution call neither counts nor breaks the streak', () => {
    const s = __test.newNudgeState()
    __test.observeNudge(s, [{ tool: 'Read' }], 2)
    const r = __test.observeNudge(s, [{ tool: 'mcp__ctx-mod__context' }, { tool: 'Read' }], 2)
    expect(typeof r).toBe('string')
    const s2 = __test.newNudgeState()
    const first = __test.observeNudge(s2, [{ tool: 'Read' }], 2)
    expect(first).toBeUndefined()
    // a request of bookkeeping alone changes nothing: still one step
    expect(__test.observeNudge(s2, [{ tool: 'mcp__ccd_turn__update_plan' }, { tool: 'ToolSearch' }], 2)).toBeUndefined()
    const r2 = __test.observeNudge(s2, [{ tool: 'mcp__effort-auto__effort' }, { tool: 'Read' }], 2)
    expect(typeof r2).toBe('string')
  })

  test('two execution tools in one request reset the streak', () => {
    const s = __test.newNudgeState()
    __test.observeNudge(s, [{ tool: 'Read' }], 2)
    expect(__test.observeNudge(s, [{ tool: 'Read' }, { tool: 'Bash' }], 2)).toBeUndefined()
    expect(s.streak).toBe(0)
    expect(__test.observeNudge(s, [{ tool: 'Read' }], 2)).toBeUndefined()
  })

  test('run_code and a dispatch reset the streak', () => {
    for (const reset of ['mcp__ptc-run__run_code', 'Agent', 'SendMessage', 'mcp__delegate__delegate_flash']) {
      const s = __test.newNudgeState()
      __test.observeNudge(s, [{ tool: 'Read' }], 2)
      expect(__test.observeNudge(s, [{ tool: reset }], 2)).toBeUndefined()
      expect(s.streak).toBe(0)
    }
  })

  test('after the first reminder only every four more steps remind again', () => {
    const s = __test.newNudgeState()
    const seen: number[] = []
    for (let i = 1; i <= 10; i++) {
      const r = __test.observeNudge(s, [{ tool: 'Read' }], 2)
      if (typeof r === 'string') seen.push(i)
    }
    expect(seen).toEqual([2, 6, 10])
  })

  test('the same step seen twice counts once', () => {
    const s = __test.newNudgeState()
    expect(__test.observeNudge(s, [{ tool: 'Read' }], 2, 't1:0')).toBeUndefined()
    expect(__test.observeNudge(s, [{ tool: 'Read' }], 2, 't1:0')).toBeUndefined()
    expect(typeof __test.observeNudge(s, [{ tool: 'Read' }], 2, 't1:1')).toBe('string')
  })

  test('nudgeAfter 0 turns it off, PTC_RUN_NUDGE overrides the option, and 0 turns it off there too', () => {
    expect(__test.configOf({ nudgeAfter: 0 }, undefined, undefined).nudgeAfter).toBe(0)
    expect(__test.configOf({ nudgeAfter: 5 }, undefined, undefined).nudgeAfter).toBe(5)
    expect(__test.configOf({ nudgeAfter: 5 }, '3', undefined).nudgeAfter).toBe(3)
    expect(__test.configOf({}, '0', undefined).nudgeAfter).toBe(0)
    expect(__test.configOf({}, 'x', undefined).nudgeAfter).toBe(2)
    expect(__test.configOf({}, undefined, '1000').bashMaxChars).toBe(1000)
    const s = __test.newNudgeState()
    for (let i = 0; i < 5; i++) expect(__test.observeNudge(s, [{ tool: 'Read' }], 0)).toBeUndefined()
  })

  test('the reminder asks for lib.def at the end', () => {
    expect(__test.nudgeText(3)).toContain('run_code')
    expect(__test.nudgeText(3).endsWith('重复出现的流程用 lib.def 登记。')).toBe(true)
  })
})

describe('single-step reminder: the hook', () => {
  test('the main session gets one line added to the batch context', { timeoutMs: 20000 }, async () => {
    const t = wire()
    await t.start()
    await t.step(['Read'])
    await t.step(['Read'])
    const r = await t.batch(undefined, ['other-plugin'])
    expect(r.additionalContext?.[0]).toBe('other-plugin')
    expect(String(r.additionalContext?.[1] ?? '')).toContain('已连续 2 次单步调用')
    // the reminder is spent: the next batch carries nothing new
    const again = await t.batch(undefined, ['other-plugin'])
    expect(again.additionalContext?.length).toBe(1)
  })

  test('a subagent step is never counted and never reminded', { timeoutMs: 20000 }, async () => {
    const t = wire()
    await t.start()
    for (let i = 0; i < 4; i++) await t.step(['Read'], 'ag-1')
    const main = await t.batch(undefined)
    expect(main.additionalContext?.length).toBe(1)
  })

  test('a new user message starts the count over', { timeoutMs: 20000 }, async () => {
    const t = wire()
    await t.start()
    await t.step(['Read'])
    await t.step(['Read'])
    await t.batch(undefined)
    await t.prompt()
    await t.step(['Read'])
    const r = await t.batch(undefined)
    expect(r.additionalContext?.length).toBe(1)
  })

  test('nudgeAfter 0 (option) injects nothing', { timeoutMs: 20000 }, async () => {
    const t = wire({}, { nudgeAfter: 0 })
    await t.start()
    for (let i = 0; i < 4; i++) await t.step(['Read'])
    const r = await t.batch(undefined)
    expect(r.additionalContext?.length).toBe(1)
  })

  test('PTC_RUN_NUDGE=0 turns it off, PTC_RUN_NUDGE=1 reminds after one step', { timeoutMs: 20000 }, async () => {
    const off = wire({ PTC_RUN_NUDGE: '0' })
    await off.start()
    for (let i = 0; i < 3; i++) await off.step(['Read'])
    const r1 = await off.batch(undefined)
    expect(r1.additionalContext?.length).toBe(1)
    const one = wire({ PTC_RUN_NUDGE: '1' })
    await one.start()
    await one.step(['Read'])
    const r2 = await one.batch(undefined)
    expect(String(r2.additionalContext?.[1] ?? '')).toContain('已连续 1 次单步调用')
  })
})
