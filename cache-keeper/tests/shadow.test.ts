import { describe, expect, test } from 'claude-code/testing'

import { boot, command, events, START, turn, world } from './world.ts'

const FIVE = { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }
const SHADOW = { timeoutMs: 20_000, options: { shadowMode: true } }
const OFF = { timeoutMs: 20_000 }

const shadows = (w: ReturnType<typeof world>) =>
  events(w).filter(row => row.kind === 'shadow')

describe('shadow mode', () => {
  test('sends nothing and records three would-have keepalives per idle stretch', SHADOW, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')

    await w.clock.advance(245_000)
    expect(w.forks).toHaveLength(0)
    expect(w.sent).toHaveLength(0)
    expect(shadows(w)).toHaveLength(1)
    expect(shadows(w)[0]).toMatchObject({
      kind: 'shadow',
      source: 'shadow',
      result: 'would_have_keepalive',
      shadow_would_have: true,
      shadow_prefix_tokens: 50_200,
      shadow_keepalive_index: 1,
      shadow_ttl: '5m',
      timestamp: new Date(START + 245_000).toISOString(),
      api_equivalent_usd: null,
    })

    await w.clock.advance(1_200_000)
    expect(shadows(w)).toHaveLength(3)
    expect(w.forks).toHaveLength(0)
    expect(await command($, 'status')).toContain('shadow: on')
  })

  test('records the real recovery gap when the next request arrives', SHADOW, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await w.clock.advance(245_000)
    await w.clock.advance(1_200_000)
    await w.clock.advance(100_000)
    await turn($, 't2', 'back')

    const recovery = events(w).find(row => row.kind === 'recovery')
    expect(recovery).toMatchObject({
      source: 'recovery',
      result: 'recovery',
      shadow_recovery_sec: 1_545,
      shadow_keepalive_index: 3,
      shadow_last_would_have_at: START + 735_000,
      api_equivalent_usd: null,
    })

    // The next idle stretch starts over from the real request.
    await w.clock.advance(245_000)
    const again = shadows(w)
    expect(again).toHaveLength(4)
    expect(again[3]).toMatchObject({ shadow_keepalive_index: 1 })
  })

  test('leaves the real keeper state untouched', SHADOW, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await w.clock.advance(245_000)
    await w.clock.advance(1_200_000)

    const saved = w.store.get('s:aaaaaaaa-1111') as Record<string, unknown>
    expect(saved.lastActivityAt).toBe(START)
    expect(saved.idleKeepalives).toBe(0)
    expect(saved.shadowKeepalives).toBe(3)
    expect(saved.shadowWouldHave).toBe(3)
  })

  test('off by default: a real keepalive fires and no shadow row is written', OFF, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await turn($, 't1', 'hello')
    await w.clock.advance(245_000)

    expect(w.forks).toHaveLength(1)
    expect(shadows(w)).toHaveLength(0)
    expect(events(w).some(row => row.kind === 'recovery')).toBe(false)
  })

  test('a finished subagent gets a would-have row instead of a send', SHADOW, async ($, on) => {
    const w = world(on, FIVE)
    w.agents = [
      { id: 'agent-1', description: 'helper', type: 'general', status: 'completed' },
    ]
    await boot($)
    await turn($, 't1', 'hello')
    await turn($, 't2', 'do the thing', 'agent-1')
    await w.clock.advance(245_000)

    expect(w.sent).toHaveLength(0)
    const agent = shadows(w).find(row => row.agent_id === 'agent-1')
    expect(agent).toMatchObject({
      shadow_prefix_tokens: 50_200,
      shadow_keepalive_index: 1,
      shadow_ttl: '5m',
    })
  })
})
