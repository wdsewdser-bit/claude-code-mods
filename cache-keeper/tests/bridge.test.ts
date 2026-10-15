import { describe, expect, test } from 'claude-code/testing'

import {
  BACKGROUND_MAX_MS,
  countInFlight,
  initialBridge,
  isBackgroundBusy,
  needsPing,
  resumeVerdict,
  shouldHandoff,
  shouldWrap,
  windowKey,
} from '../hooks/lib/bridge.ts'
import type { Bridge } from '../hooks/lib/bridge.ts'
import { boot, command, START, turn, world } from './world.ts'

const ONE_HOUR = { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }
const DEFAULTS = { timeoutMs: 30_000 }
const RESET = START + 2 * 3_600_000
const HIGH = (percent: number, at = RESET) => [
  { kind: 'five_hour', percentUsed: percent, resetsAt: new Date(at).toISOString() },
]

const wrapped = (extra: Partial<Bridge> = {}): Bridge => ({
  ...initialBridge(),
  phase: 'wrapped',
  resetAtMs: RESET,
  wrapAt: START,
  ...extra,
})

describe('bridge logic', () => {
  const base = {
    isEnabled: true,
    isBridgeOn: true,
    isRunActive: false,
    bridge: initialBridge(),
    limits: HIGH(91),
    now: START + 60_000,
    lastRealAt: START,
    ttl: '1h' as const,
    atPercent: 90,
    isBackgroundBusy: false,
    isTurnRunning: false,
  }

  test('wraps at the threshold for a session worked in within its TTL', () => {
    expect(shouldWrap(base)).toBe(true)
    expect(shouldWrap({ ...base, limits: HIGH(89) })).toBe(false)
  })

  test('a session waiting on background work is not idle, however quiet the main thread', () => {
    const quiet = { ...base, now: START + 1_800_000 }
    expect(shouldWrap(quiet)).toBe(false)
    expect(shouldWrap({ ...quiet, isBackgroundBusy: true })).toBe(true)
    expect(shouldWrap({ ...quiet, isBackgroundBusy: true, lastRealAt: null })).toBe(false)
  })

  test('a turn still running is worked in, however long it has run since the last message', () => {
    const quiet = { ...base, now: START + 1_800_000 }
    expect(shouldWrap(quiet)).toBe(false)
    expect(shouldWrap({ ...quiet, isTurnRunning: true })).toBe(true)
    expect(shouldWrap({ ...quiet, isTurnRunning: true, isRunActive: true })).toBe(false)
  })

  test('background work tracks its launches and gives up on lost ones', () => {
    expect(isBackgroundBusy(0, START, START + 1_000)).toBe(false)
    expect(isBackgroundBusy(1, null, START + 1_000)).toBe(false)
    expect(isBackgroundBusy(2, START, START + 1_000)).toBe(true)
    expect(isBackgroundBusy(1, START, START + BACKGROUND_MAX_MS - 1)).toBe(true)
    expect(isBackgroundBusy(1, START, START + BACKGROUND_MAX_MS)).toBe(false)
  })

  test('the Stop hook list of in-flight tasks is the count of background work', () => {
    expect(countInFlight([])).toBe(0)
    expect(countInFlight([{ id: 'a' }, { id: 'b' }])).toBe(2)
  })

  test('never wakes an old session, a subagent-only one, or a window already wrapped', () => {
    expect(shouldWrap({ ...base, now: START + 3_700_000 })).toBe(false)
    expect(shouldWrap({ ...base, now: START + 1_800_000 })).toBe(false)
    expect(shouldWrap({ ...base, lastRealAt: null })).toBe(false)
    expect(
      shouldWrap({
        ...base,
        bridge: { ...initialBridge(), window: new Date(RESET).toISOString() },
      }),
    ).toBe(false)
    expect(shouldWrap({ ...base, isEnabled: false })).toBe(false)
  })

  test('the seven-day window alone never starts it', () => {
    expect(
      shouldWrap({
        ...base,
        limits: [{ kind: 'seven_day', percentUsed: 99, resetsAt: new Date(RESET).toISOString() }],
      }),
    ).toBe(false)
  })

  test('asks for a handoff once per weekly window, only where work is going on', () => {
    const week = START + 3 * 86_400_000
    const weekly = (percent: number, at = week) => [
      { kind: 'seven_day', percentUsed: percent, resetsAt: new Date(at).toISOString() },
    ]
    const ask = {
      isRunActive: false,
      bridge: initialBridge(),
      limits: weekly(98),
      now: START + 60_000,
      lastRealAt: START,
      ttl: '1h' as const,
      atPercent: 98,
      isBackgroundBusy: false,
      isTurnRunning: false,
    }
    expect(shouldHandoff(ask)).toBe(true)
    expect(shouldHandoff({ ...ask, now: START + 1_800_000 })).toBe(false)
    expect(shouldHandoff({ ...ask, now: START + 1_800_000, isBackgroundBusy: true })).toBe(true)
    expect(shouldHandoff({ ...ask, limits: weekly(97) })).toBe(false)
    expect(shouldHandoff({ ...ask, limits: HIGH(99) })).toBe(false)
    expect(shouldHandoff({ ...ask, atPercent: 0 })).toBe(false)
    expect(shouldHandoff({ ...ask, lastRealAt: null })).toBe(false)
    expect(shouldHandoff({ ...ask, now: START + 700_000 })).toBe(false)
    const told = { ...initialBridge(), weeklyWindow: windowKey(week) }
    expect(shouldHandoff({ ...ask, bridge: told })).toBe(false)
    // The same window read a few milliseconds apart is still the same window.
    expect(shouldHandoff({ ...ask, bridge: told, limits: weekly(99, week + 75) })).toBe(false)
    expect(shouldHandoff({ ...ask, bridge: told, limits: weekly(98, week + 7 * 86_400_000) })).toBe(true)
  })

  test('a cache that outlives the resume needs no further ping', () => {
    expect(needsPing(wrapped(), RESET - 1_800_000, '1h')).toBe(false)
    expect(needsPing(wrapped(), START, '1h')).toBe(true)
  })

  test('resumes after the reset, unless the person took over', () => {
    const at = (offset: number) => RESET + offset
    expect(resumeVerdict(wrapped(), at(5_000), [], 90)).toBe('wait')
    expect(resumeVerdict(wrapped(), at(30_000), HIGH(5), 90)).toBe('resume')
    expect(resumeVerdict(wrapped(), at(30_000), HIGH(95), 90)).toBe('wait')
    expect(resumeVerdict(wrapped(), at(400_000), HIGH(95), 90)).toBe('resume')
    expect(resumeVerdict(wrapped({ isTakenOver: true }), at(30_000), HIGH(5), 90)).toBe('skip')
  })
})

describe('bridge in a session', () => {
  test('wraps up at 95%, keeps the cache warm, resumes after the reset', DEFAULTS, async ($, on) => {
    const w = world(on, ONE_HOUR)
    await boot($)
    await turn($, 't1', 'work')
    w.limits = HIGH(96) as never
    await w.clock.advance(10_000)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('96%')
    await w.clock.advance(3_130_000)
    expect(w.forks.length).toBeGreaterThanOrEqual(1)
    w.limits = HIGH(3, RESET + 5 * 3_600_000) as never
    await w.clock.advance(4_200_000)
    expect(w.submitted).toHaveLength(2)
    expect(w.submitted[1]).toContain('重置')
    // One wrap per window: nothing more is sent.
    await w.clock.advance(600_000)
    expect(w.submitted).toHaveLength(2)
  })

  test('at 98% of the week asks once for a handoff document and keeps the keeper on', DEFAULTS, async ($, on) => {
    const w = world(on, ONE_HOUR)
    await boot($)
    await turn($, 't1', 'work')
    const week = new Date(START + 3 * 86_400_000).toISOString()
    w.limits = [
      { kind: 'five_hour', percentUsed: 10, resetsAt: new Date(RESET).toISOString() },
      { kind: 'seven_day', percentUsed: 98, resetsAt: week },
    ] as never
    await w.clock.advance(10_000)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('周额度已用 98%')
    expect(w.submitted[0]).toContain('HANDOFF.md')
    await w.clock.advance(3_130_000)
    expect(w.submitted).toHaveLength(1)
    expect(w.forks.length).toBeGreaterThanOrEqual(1)
    expect(w.toasts.join('\n')).not.toContain('stopped')
  })

  test('does not wake a session idle past its cache TTL', DEFAULTS, async ($, on) => {
    const w = world(on, ONE_HOUR)
    await boot($)
    await turn($, 't1', 'work')
    await w.clock.advance(4_000_000)
    w.limits = HIGH(95) as never
    await w.clock.advance(30_000)
    expect(w.submitted).toHaveLength(0)
  })

  test('stopping the keeper cancels the bridge and its resume', DEFAULTS, async ($, on) => {
    const w = world(on, ONE_HOUR)
    await boot($)
    await turn($, 't1', 'work')
    w.limits = HIGH(96) as never
    await w.clock.advance(10_000)
    expect(w.submitted).toHaveLength(1)
    await command($, 'stop')
    w.limits = HIGH(2, RESET + 5 * 3_600_000) as never
    await w.clock.advance(7_300_000)
    expect(w.submitted).toHaveLength(1)
  })
})
