import { describe, expect, test } from 'claude-code/testing'

import { decide, initialKeeperState, unboundedView } from '../hooks/lib/keeper.ts'
import type { KeeperConfig, KeeperState, RateLimit } from '../hooks/lib/keeper.ts'
import { boot, command, events, START, turn, usage, world } from './world.ts'

const FIVE = { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }
// Most tests pin the keeper off until started and unbounded, whatever the manifest's defaults.
const LONG = { timeoutMs: 20_000, options: { enabled: false, maxIdleKeepalives: 0 } }
const DEFAULTS = { timeoutMs: 20_000 }
const saved = (extra: Record<string, unknown>) => ({
  at: START,
  enabled: false,
  lastActivityAt: null,
  cachedPrefixTokens: 0,
  ...extra,
})

describe('keeper', () => {
  test('by default keeps a session warm unasked, three times per idle stretch', DEFAULTS, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await w.clock.advance(245_000)
    expect(w.forks).toHaveLength(1)
    await w.clock.advance(1_200_000)
    expect(w.forks).toHaveLength(3)
    await turn($, 't2', 'back')
    await w.clock.advance(245_000)
    expect(w.forks).toHaveLength(4)
  })

  test('a stop someone asked for outlives a reload', DEFAULTS, async ($, on) => {
    const w = world(on, FIVE)
    w.store.set('s:aaaaaaaa-1111', saved({ isEnabledDecided: true }))
    await boot($)
    await turn($, 't1', 'hello')
    await w.clock.advance(290_000)
    expect(w.forks).toHaveLength(0)
  })

  test('a session saved before the default changed follows the new default', DEFAULTS, async ($, on) => {
    const w = world(on, FIVE)
    w.store.set('s:aaaaaaaa-1111', saved({}))
    await boot($)
    await turn($, 't1', 'hello')
    await w.clock.advance(290_000)
    expect(w.forks).toHaveLength(1)
  })

  test('observes but never forks until it is started', LONG, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await w.clock.advance(280_000)
    expect(w.forks).toHaveLength(0)
    expect(events(w)).toHaveLength(1)
    expect(events(w)[0]).toMatchObject({
      kind: 'step',
      source: 'user',
      ttl_requested: '5m',
      cache_read_input_tokens: 50_000,
      model: 'claude-opus-5-5',
      effort: 'medium',
      claude_code_version: '2.1.288',
    })
  })

  test('writes under the home directory, one place for every session', LONG, async ($, on) => {
    const w = world(on, { ...FIVE, USERPROFILE: 'C:\\Users\\someone' })
    await boot($)
    await turn($, 't1', 'hello')
    expect([...w.files.keys()]).toEqual([
      'C:/Users/someone/.claude/cache-keeper/raw/events-aaaaaaaa-1111-0.jsonl',
    ])
    expect(await command($, 'status')).toContain(
      'data: C:\\Users\\someone\\.claude\\cache-keeper',
    )
  })

  test('refreshes a 5m cache 4:05 after the last request started', LONG, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    expect(await command($, 'start')).toContain('keeper on')
    await w.clock.advance(240_000)
    expect(w.forks).toHaveLength(0)
    await w.clock.advance(5_000)
    expect(w.forks).toEqual(['Reply with OK only.'])

    const keeper = events(w).find(row => row.kind === 'keeper')
    expect(keeper).toMatchObject({
      source: 'keeper',
      result: 'hit',
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 0,
      timestamp: new Date(START + 245_000).toISOString(),
    })
    expect(keeper?.rate_limits_before).toEqual([
      { kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-06T05:00:00Z' },
    ])
    expect(keeper?.rate_limits_after).toHaveLength(1)
    expect(keeper?.api_equivalent_usd).toBeGreaterThan(0)
  })

  test('each hit renews the wait, and a real turn restarts it', LONG, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await command($, 'start')
    await w.clock.advance(490_000)
    expect(w.forks).toHaveLength(2)
    await w.clock.advance(100_000)
    await turn($, 't2', 'more')
    await w.clock.advance(240_000)
    expect(w.forks).toHaveLength(2)
    await w.clock.advance(5_000)
    expect(w.forks).toHaveLength(3)
  })

  test('never pays to rewrite a cache that already expired', LONG, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await w.clock.advance(360_000)
    await command($, 'start')
    await w.clock.advance(600_000)
    expect(w.forks).toHaveLength(0)
    expect(await command($, 'status')).toContain('已过期')
  })

  test('leaves a small prefix alone', LONG, async ($, on) => {
    const w = world(on, FIVE)
    w.stepUsage = usage(10_000, 100)
    await boot($)
    await turn($, 't1', 'hello')
    await command($, 'start')
    await w.clock.advance(290_000)
    expect(w.forks).toHaveLength(0)
  })

  test('waits while a turn is running', LONG, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await command($, 'start')
    await $.turn.start({ text: 'long one', turnId: 't2' })
    await w.clock.advance(290_000)
    expect(w.forks).toHaveLength(0)
  })

  test('stops after two keepalives in a row missed', LONG, async ($, on) => {
    const w = world(on, FIVE)
    w.forkUsage = [usage(0, 0, 50_000)]
    await boot($)
    await turn($, 't1', 'hello')
    await command($, 'start')
    await w.clock.advance(290_000)
    expect(w.forks).toHaveLength(2)
    expect(w.toasts.join('\n')).toContain('cache-keeper stopped')
    expect(await command($, 'status')).toContain('keeper off')
    await w.clock.advance(600_000)
    expect(w.forks).toHaveLength(2)
  })

  test('stops instead of forking once the 5-hour window is nearly spent', LONG, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await command($, 'start')
    w.limits = [{ kind: 'five_hour', percentUsed: 91 }]
    await w.clock.advance(290_000)
    expect(w.forks).toHaveLength(0)
    expect(w.toasts.join('\n')).toContain('five_hour is at 91%')
  })

  test('keeps forking however full the weekly window is', LONG, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await command($, 'start')
    w.limits = [
      { kind: 'five_hour', percentUsed: 10 },
      { kind: 'seven_day', percentUsed: 99 },
    ]
    await w.clock.advance(290_000)
    expect(w.forks).toHaveLength(1)
    expect(w.toasts.join('\n')).not.toContain('seven_day')
  })

  test(
    'stops refreshing an idle cache at the configured budget',
    { ...LONG, options: { maxIdleKeepalives: 2 } },
    async ($, on) => {
      const w = world(on, FIVE)
      await boot($)
      await turn($, 't1', 'hello')
      await command($, 'start')
      await w.clock.advance(600_000)
      expect(w.forks).toHaveLength(2)
      expect(await command($, 'status')).toContain('保活不划算')
      await w.clock.advance(900_000)
      expect(w.forks).toHaveLength(2)
    },
  )

  test('with no TTL requested, schedules by the TTL the transcript shows', LONG, async ($, on) => {
    const w = world(on)
    await boot($)
    await turn($, 't1', 'hello')
    await command($, 'start')
    await w.clock.advance(290_000)
    expect(w.forks).toHaveLength(0)
    expect(await command($, 'status')).toContain('TTL 未知')

    w.files.set(
      '/t/session.jsonl',
      `${JSON.stringify({
        type: 'assistant',
        requestId: 'req_2',
        timestamp: new Date(START + 290_000).toISOString(),
        isSidechain: false,
        message: {
          id: 'msg_2',
          model: 'claude-opus-5-5',
          usage: {
            ...usage(50_000, 200),
            cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
          },
          diagnostics: { cache_miss_reason: 'ttl_expired' },
        },
      })}\n`,
    )
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/session.jsonl' } as never)
    await turn($, 't2', 'again')
    const matched = events(w).find(row => row.turn_id === 't2')
    expect(matched).toMatchObject({
      ephemeral_5m_input_tokens: 200,
      ephemeral_1h_input_tokens: 0,
      ttl_observed: '5m',
      cache_miss_reason: 'ttl_expired',
      cost_basis: 'split',
    })
    await w.clock.advance(245_000)
    expect(w.forks).toHaveLength(1)
  })

  test('a manual probe reports what the cache served', LONG, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    const text = await command($, 'probe')
    expect(text).toContain('probe: hit')
    expect(text).toContain('cache read 50000')
    expect(text).toContain('five_hour 10% -> 10%')
    expect(w.forks).toHaveLength(1)
  })

  test('a model change pauses the keeper until a request hits again', LONG, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await command($, 'start')
    const step = $.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 3 })
    for await (const chunk of step) void chunk
    expect(await command($, 'status')).toContain('暂停（model or effort changed）')
    await w.clock.advance(290_000)
    expect(w.forks).toHaveLength(0)
  })
})

const CAPPED = { ...LONG, options: { enabled: false, maxIdleKeepalives: 2 } }
const view = { isUnboundedBudget: true, isPastStopLine: true }
const warm: KeeperState = {
  ...initialKeeperState(true),
  ttl: '5m',
  lastActivityAt: 0,
  cachedPrefixTokens: 50_000,
  idleKeepalives: 5,
  idleKeepaliveBudget: 2,
}
const rules: KeeperConfig = {
  minCacheReadTokens: 40_000,
  ttl5mKeepaliveAtSec: 245,
  ttl1hKeepaliveAtSec: 3120,
  maxRateLimitPercent: 90,
  maxConsecutiveProbeFailures: 2,
}
const hot: RateLimit[] = [{ kind: 'five_hour', percentUsed: 95 }]

describe('anchor view', () => {
  test('a plain keeper is capped by the idle budget and the stop line', () => {
    expect(decide(warm, 250_000, rules, [])).toEqual({ action: 'wait', reason: 'break-even' })
    expect(decide({ ...warm, idleKeepalives: 0 }, 250_000, rules, hot)).toMatchObject({ action: 'stop' })
  })

  test('keeps firing past the idle budget', () => {
    const v = unboundedView(warm, rules, view)
    expect(decide(v.keeper, 250_000, v.config, [])).toEqual({ action: 'fire' })
  })

  test('does not stop at the 5-hour stop line', () => {
    const v = unboundedView({ ...warm, idleKeepalives: 0 }, rules, view)
    expect(decide(v.keeper, 250_000, v.config, hot)).toEqual({ action: 'fire' })
  })

  test('an expired cache is still not rewritten', () => {
    const v = unboundedView(warm, rules, view)
    expect(decide(v.keeper, 300_000, v.config, [])).toEqual({ action: 'wait', reason: 'expired' })
  })

  test('other stops still apply', () => {
    const v = unboundedView({ ...warm, consecutiveFailures: 2 }, rules, view)
    expect(decide(v.keeper, 250_000, v.config, [])).toMatchObject({ action: 'stop' })
    const small = unboundedView({ ...warm, cachedPrefixTokens: 1000 }, rules, view)
    expect(decide(small.keeper, 250_000, small.config, [])).toEqual({ action: 'wait', reason: 'prefix-too-small' })
  })

  test('without either flag the inputs come back untouched', () => {
    const v = unboundedView(warm, rules, { isUnboundedBudget: false, isPastStopLine: false })
    expect(v.keeper).toBe(warm)
    expect(v.config).toBe(rules)
  })
})

describe('anchor session', () => {
  test('keeps forking past the idle budget and reports unbounded', CAPPED, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await command($, 'start')
    expect(await command($, 'anchor on')).toContain('anchor on')
    await w.clock.advance(1_200_000)
    expect(w.forks.length).toBeGreaterThan(2)
    const status = await command($, 'status')
    expect(status).toContain('anchor on')
    expect(status).toContain('of unbounded')
    expect(status).not.toContain('保活不划算')
  })

  test('anchor off restores the cap and leaves the keeper on', CAPPED, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await command($, 'start')
    await command($, 'anchor on')
    expect(await command($, 'anchor off')).toContain('anchor off · keeper on')
    await w.clock.advance(1_200_000)
    expect(w.forks).toHaveLength(2)
  })

  test('anchor on starts a stopped keeper', CAPPED, async ($, on) => {
    world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    expect(await command($, 'anchor')).toBe('anchor off · keeper off')
    expect(await command($, 'anchor on')).toBe('anchor on · keeper on')
  })

  test('keeps forking at 95% of the 5-hour window', CAPPED, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await command($, 'anchor on')
    w.limits = [{ kind: 'five_hour', percentUsed: 95 }]
    await w.clock.advance(290_000)
    expect(w.forks).toHaveLength(1)
    expect(w.toasts.join('\n')).not.toContain('five_hour is at')
  })

  test('says once that the cache expired', CAPPED, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await w.clock.advance(360_000)
    await command($, 'anchor on')
    await w.clock.advance(600_000)
    expect(w.forks).toHaveLength(0)
    expect(w.toasts.filter(t => t.includes('anchor cache expired'))).toHaveLength(1)
  })

  test('survives a reload', CAPPED, async ($, on) => {
    const w = world(on, FIVE)
    w.store.set('s:aaaaaaaa-1111', saved({ isAnchor: true }))
    await boot($)
    expect(await command($, 'anchor')).toContain('anchor on')
  })
})

describe('subagent keeper', () => {
  const HOUR = {
    CLAUDE_CODE_PROMPT_CACHE_TTL: '1h',
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h',
  }
  const done = (id: string) => ({
    id,
    description: 'a worker',
    type: 'general-purpose',
    status: 'completed',
  })
  const notice = (id: string) =>
    `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<result>OK</result>\n</task-notification>`

  test('refreshes a finished subagent twice, then lets it lapse', DEFAULTS, async ($, on) => {
    const w = world(on, HOUR)
    w.agents = [done('agent-1')]
    await boot($)
    await turn($, 't1', 'hello')
    await turn($, 'a1', '', 'agent-1')
    await w.clock.advance(3_115_000)
    expect(w.sent).toHaveLength(0)
    await w.clock.advance(5_000)
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]?.to).toContain('agent-1')
    expect(w.sent[0]?.text).toContain('reply with OK only')
    await turn($, 'a2', '', 'agent-1')
    await w.clock.advance(3_120_000)
    expect(w.sent).toHaveLength(2)
    await turn($, 'a3', '', 'agent-1')
    await w.clock.advance(7_200_000)
    expect(w.sent).toHaveLength(2)
    expect(await command($, 'status')).toContain('subagents: TTL 1h (env) · keepalives per subagent 2 · tracked 0 · hits 2 · misses 0')
    expect(events(w).filter(row => row.notes === 'subagent keepalive')).toHaveLength(2)
  })

  test('a real run of the subagent starts its count over', DEFAULTS, async ($, on) => {
    const w = world(on, HOUR)
    w.agents = [done('agent-1')]
    await boot($)
    await turn($, 'a1', '', 'agent-1')
    await w.clock.advance(3_120_000)
    await turn($, 'a2', '', 'agent-1')
    await w.clock.advance(3_120_000)
    await turn($, 'a3', '', 'agent-1')
    expect(w.sent).toHaveLength(2)
    await w.clock.advance(600_000)
    // the main model sent it more work
    await turn($, 'a4', '', 'agent-1')
    await w.clock.advance(3_120_000)
    expect(w.sent).toHaveLength(3)
  })

  test('schedules by five minutes when nothing asks for a longer subagent TTL', DEFAULTS, async ($, on) => {
    const w = world(on, FIVE)
    w.agents = [done('agent-1')]
    await boot($)
    await turn($, 'a1', '', 'agent-1')
    expect(await command($, 'agents')).toContain('subagents: TTL 5m (default)')
    await w.clock.advance(245_000)
    expect(w.sent).toHaveLength(1)
  })

  test('reads the subagent TTL setting', DEFAULTS, async ($, on) => {
    const w = world(on, FIVE)
    w.settings = { subagentPromptCacheTtl: '1h' }
    await boot($)
    expect(await command($, 'agents')).toContain('subagents: TTL 1h (setting)')
  })

  test('the notice that a pinged subagent finished never reaches the model', DEFAULTS, async ($, on) => {
    const w = world(on, HOUR)
    w.agents = [done('agent-1')]
    await boot($)
    await turn($, 'a1', '', 'agent-1')
    await w.clock.advance(3_120_000)
    expect(w.sent).toHaveLength(1)
    await turn($, 'a2', '', 'agent-1')
    const first = await $.prompt.submit({
      text: notice('agent-1'),
      wait: false,
      origin: { kind: 'task-notification' },
    } as never)
    expect(first.drop).toContain('kept subagent agent-1 warm')
    expect(w.submitted).toHaveLength(0)
    // its next notice is a real one
    const second = await $.prompt.submit({
      text: notice('agent-1'),
      wait: false,
      origin: { kind: 'task-notification' },
    } as never)
    expect(second.drop).toBeUndefined()
    expect(w.submitted).toHaveLength(1)
  })

  test('leaves alone what the engine does not list as a finished subagent', DEFAULTS, async ($, on) => {
    const w = world(on, HOUR)
    w.agents = [{ ...done('agent-2'), status: 'killed' }]
    await boot($)
    await turn($, 'a1', '', 'engine-fork')
    await turn($, 'a2', '', 'agent-2')
    await w.clock.advance(3_300_000)
    expect(w.sent).toHaveLength(0)
    expect(await command($, 'agents')).toContain('tracked 0')
  })

  test('keeps a foreground subagent, which the engine lists nowhere, by its saved transcript', DEFAULTS, async ($, on) => {
    const w = world(on, HOUR)
    w.files.set('/t/session/subagents/agent-fg-1.meta.json', '{"agentType":"general-purpose"}')
    await boot($)
    await turn($, 't1', 'hello')
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/session.jsonl' } as never)
    await turn($, 'a1', '', 'fg-1')
    await turn($, 'a2', '', 'engine-fork')
    await w.clock.advance(3_300_000)
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]?.to).toContain('fg-1')
  })

  test('skips a subagent too small to be worth a request', DEFAULTS, async ($, on) => {
    const w = world(on, HOUR)
    w.agents = [done('agent-1')]
    w.stepUsage = usage(20_000, 200)
    await boot($)
    await turn($, 'a1', '', 'agent-1')
    await w.clock.advance(3_300_000)
    expect(w.sent).toHaveLength(0)
  })

  test('a keepalive that missed is the last for that subagent', DEFAULTS, async ($, on) => {
    const w = world(on, HOUR)
    w.agents = [done('agent-1')]
    await boot($)
    await turn($, 'a1', '', 'agent-1')
    await w.clock.advance(3_120_000)
    expect(w.sent).toHaveLength(1)
    w.stepUsage = usage(0, 50_200)
    await turn($, 'a2', '', 'agent-1')
    await w.clock.advance(3_300_000)
    expect(w.sent).toHaveLength(1)
    expect(await command($, 'agents')).toContain('tracked 0 · hits 0 · misses 1')
  })

  test('sends nothing with the count at zero', { timeoutMs: 20_000, options: { subagentKeepalives: 0 } }, async ($, on) => {
    const w = world(on, HOUR)
    w.agents = [done('agent-1')]
    await boot($)
    await turn($, 'a1', '', 'agent-1')
    await w.clock.advance(3_300_000)
    expect(w.sent).toHaveLength(0)
  })

  test('agents ping refreshes every tracked subagent at once', DEFAULTS, async ($, on) => {
    const w = world(on, HOUR)
    w.agents = [done('agent-1')]
    await boot($)
    await turn($, 'a1', '', 'agent-1')
    expect(await command($, 'agents ping')).toContain('agent-1: sent')
    expect(w.sent).toHaveLength(1)
  })
})

describe('for other mods', () => {
  test('publishes the main cache under $.state', DEFAULTS, async ($, on) => {
    const w = world(on, FIVE)
    let value: { lastActivityAt: number | null; expiresAt: number | null } | undefined
    on('state.set', (_$, e, next) => {
      if (e.key === 'cache') value = e.value as typeof value
      return next(e)
    })
    await boot($)
    await turn($, 't1', 'hello')
    await w.clock.advance(5_000)
    expect(value).toMatchObject({
      ttl: '5m',
      cachedPrefixTokens: 50_200,
      isEnabled: true,
      pausedReason: null,
      bridgePhase: 'idle',
    })
    expect(value?.expiresAt).toBe((value?.lastActivityAt ?? 0) + 300_000)
  })

  test('never pings a prefix the conversation no longer holds', DEFAULTS, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    w.contextTokens = 5_000
    await w.clock.advance(290_000)
    expect(w.forks).toHaveLength(0)
    await turn($, 't2', 'back')
    await w.clock.advance(245_000)
    expect(w.forks).toHaveLength(1)
  })

  test('pauses on the boundary row of a compaction another mod answered', DEFAULTS, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await $.session.append({
      message: {
        type: 'system',
        name: 'compact_boundary',
        content: [{ type: 'text', text: 'Conversation compacted' }],
      },
      door: 'compaction',
      origin: { kind: 'engine' },
      uuid: 'row-1',
    } as never)
    await w.clock.advance(290_000)
    expect(w.forks).toHaveLength(0)
    await turn($, 't2', 'back')
    await w.clock.advance(245_000)
    expect(w.forks).toHaveLength(1)
  })
})
