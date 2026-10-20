import { describe, expect, test } from 'claude-code/testing'

import {
  describeFill,
  gateSwitch,
  isCold,
  judgeSwitch,
  levelOf,
  limitOf,
  percentOf,
  shouldContinue,
} from '../hooks/lib/usage.ts'
import type { Judgement, Level } from '../hooks/lib/usage.ts'
import { DEFAULTS } from '../hooks/lib/types.ts'
import type { CacheState } from '../hooks/lib/types.ts'

const LIMIT = 367_000
const cache = (extra: Partial<CacheState> = {}): CacheState => ({
  lastActivityAt: null,
  ttl: '1h',
  expiresAt: null,
  cachedPrefixTokens: 0,
  isEnabled: true,
  pausedReason: null,
  bridgePhase: 'idle',
  ...extra,
})

const worth: Judgement = {
  isWorth: true,
  savingPerRequest: 6_500,
  switchCost: 15_000,
  breakEvenRequests: 15_000 / 6_500,
  reason: '每次请求省约 6500 token 当量，切换一次约 15000，2.3 次请求回本，剩余 9 次够用。',
}

const gateInput = (extra: Partial<Parameters<typeof gateSwitch>[0]> = {}) => ({
  requestsSinceSwitch: 40,
  switchTimes: [] as readonly number[],
  now: 1_000_000,
  hasFreshLedger: true,
  level: 'soft' as Level,
  judgement: worth as Judgement | null,
  ...extra,
})

describe('usage arithmetic', () => {
  test('limitOf trusts a positive engine threshold and falls back below the window otherwise', () => {
    expect(limitOf(LIMIT, DEFAULTS)).toBe(LIMIT)
    expect(limitOf(undefined, DEFAULTS)).toBe(LIMIT)
    expect(limitOf(0, DEFAULTS)).toBe(LIMIT)
    expect(limitOf(500_000, DEFAULTS)).toBe(500_000)
    // A window too small to leave the margin room still reads as a usable limit.
    expect(limitOf(undefined, { ...DEFAULTS, compactWindow: 20_000 })).toBe(1)
  })

  test('percentOf floors, and a limit of zero reads as no fill', () => {
    expect(percentOf(228_400, LIMIT)).toBe(62)
    expect(percentOf(LIMIT, LIMIT)).toBe(100)
    expect(percentOf(0, LIMIT)).toBe(0)
    expect(percentOf(1_000, 0)).toBe(0)
  })

  test('levelOf steps through none, boundary, soft and urgent at their absolute fills', () => {
    // At a 400k limit none of the fills is capped, so these are the configured numbers.
    const at = (tokens: number): Level => levelOf(tokens, 400_000, DEFAULTS)
    expect(at(0)).toBe('none')
    expect(at(249_999)).toBe('none')
    expect(at(250_000)).toBe('boundary')
    expect(at(299_999)).toBe('boundary')
    expect(at(300_000)).toBe('soft')
    expect(at(349_999)).toBe('soft')
    expect(at(350_000)).toBe('urgent')
    expect(at(400_000)).toBe('urgent')
  })

  test('no fill sits closer than 30k to the limit', () => {
    // A 300k limit caps soft and urgent at 270k, so 270k is already urgent.
    expect(levelOf(249_999, 300_000, DEFAULTS)).toBe('none')
    expect(levelOf(250_000, 300_000, DEFAULTS)).toBe('boundary')
    expect(levelOf(269_999, 300_000, DEFAULTS)).toBe('boundary')
    expect(levelOf(270_000, 300_000, DEFAULTS)).toBe('urgent')
    // A 280k limit caps every fill at 250k: the first one is urgent.
    expect(levelOf(249_999, 280_000, DEFAULTS)).toBe('none')
    expect(levelOf(250_000, 280_000, DEFAULTS)).toBe('urgent')
  })

  test('describeFill names the window even without a token count', () => {
    expect(describeFill(228_400, LIMIT, 3)).toBe('ctx 62% · 228k/367k · w3')
    expect(describeFill(undefined, LIMIT, 3)).toBe('ctx ? · w3')
    // k is rounded, not floored.
    expect(describeFill(228_600, LIMIT, 1)).toBe('ctx 62% · 229k/367k · w1')
  })
})

describe('judgeSwitch', () => {
  const base = { before: 300_000, prefix: 30_000, handoff: 10_000, reread: 5_000 }

  test('prices the saving per request against the cost of rebuilding the cache', () => {
    const at3 = judgeSwitch({ ...base, remainingRequests: 3 }, DEFAULTS)
    expect(at3.savingPerRequest).toBe(6_500)
    // A write is billed at 1.25: 15k tokens of handoff and reread.
    expect(at3.switchCost).toBe(18_750)
    expect(at3.breakEvenRequests).toBe(18_750 / 6_500)
    expect(Math.round(at3.breakEvenRequests * 10_000) / 10_000).toBe(2.8846)
    expect(at3.isWorth).toBe(false)
    expect(at3.reason).toContain('6500')
    expect(at3.reason).toContain('18750')

    // 4 requests is past 2.88 break-even but not past 2.88 * 1.5 = 4.33.
    expect(judgeSwitch({ ...base, remainingRequests: 4 }, DEFAULTS).isWorth).toBe(false)
    const at5 = judgeSwitch({ ...base, remainingRequests: 5 }, DEFAULTS)
    expect(at5.isWorth).toBe(true)
    expect(Math.round(at5.breakEvenRequests * DEFAULTS.breakEvenSafety * 10_000) / 10_000).toBe(4.3269)
  })

  test('a switch that saves nothing never pays off', () => {
    const flat = judgeSwitch({ ...base, before: 40_000, remainingRequests: 100 }, DEFAULTS)
    expect(flat.savingPerRequest).toBe(0)
    expect(flat.breakEvenRequests).toBe(Infinity)
    expect(flat.isWorth).toBe(false)
    expect(flat.reason).toContain('省不下')
    // A thin saving still needs its 600 requests back, so it stays not worth it.
    const thin = judgeSwitch({ ...base, before: 41_000, remainingRequests: 100 }, DEFAULTS)
    expect(thin.savingPerRequest).toBe(25)
    expect(thin.breakEvenRequests).toBe(750)
    expect(thin.isWorth).toBe(false)
  })
})

describe('isCold', () => {
  const now = 5_000_000

  test('an explicit expiry decides it', () => {
    expect(isCold({ now, cache: cache({ expiresAt: now }), lastRequestAt: null }, DEFAULTS)).toBe(true)
    expect(isCold({ now, cache: cache({ expiresAt: now + 1 }), lastRequestAt: null }, DEFAULTS)).toBe(false)
  })

  test('without an expiry the last request does, and an unknown one counts as warm', () => {
    expect(isCold({ now, cache: cache(), lastRequestAt: null }, DEFAULTS)).toBe(false)
    expect(isCold({ now, cache: null, lastRequestAt: null }, DEFAULTS)).toBe(false)
    expect(isCold({ now, cache: null, lastRequestAt: now - 3_600_000 }, DEFAULTS)).toBe(true)
    expect(isCold({ now, cache: null, lastRequestAt: now - 3_599_999 }, DEFAULTS)).toBe(false)
  })

  test('a five-minute cache without an expiry is cold after five minutes, not an hour', () => {
    const fiveMin = cache({ ttl: '5m' })
    expect(isCold({ now, cache: fiveMin, lastRequestAt: now - 300_000 }, DEFAULTS)).toBe(true)
    expect(isCold({ now, cache: fiveMin, lastRequestAt: now - 299_999 }, DEFAULTS)).toBe(false)
  })
})

describe('gateSwitch', () => {
  test('the hourly cap refuses every level, and counts only the last hour', () => {
    const now = 1_000_000
    const at = (offset: number): number => now - offset
    const capped = gateInput({
      now,
      level: 'urgent',
      switchTimes: [at(1), at(1_000), at(2_000), at(3_000)],
    })
    const denied = gateSwitch(capped, DEFAULTS)
    expect(denied.isAllowed).toBe(false)
    if (!denied.isAllowed) expect(denied.reason).toContain('上限 4 次')

    // A switch exactly an hour old is outside the window, so one slot is free.
    const room = gateSwitch(
      { ...capped, switchTimes: [at(3_600_000), at(1), at(1_000), at(2_000)] },
      DEFAULTS,
    )
    expect(room.isAllowed).toBe(true)
  })

  test('the cooldown holds back every level but urgent', () => {
    const soft = gateSwitch(gateInput({ requestsSinceSwitch: 5, level: 'soft' }), DEFAULTS)
    expect(soft.isAllowed).toBe(false)
    if (!soft.isAllowed) expect(soft.reason).toContain('冷却')
    // One request short of 30 is still too early.
    expect(gateSwitch(gateInput({ requestsSinceSwitch: 29 }), DEFAULTS).isAllowed).toBe(false)
    expect(gateSwitch(gateInput({ requestsSinceSwitch: 30 }), DEFAULTS).isAllowed).toBe(true)
    expect(gateSwitch(gateInput({ requestsSinceSwitch: 0, level: 'urgent' }), DEFAULTS).isAllowed).toBe(true)
  })

  test('a stale ledger stops it, urgent included', () => {
    const stale = gateSwitch(gateInput({ hasFreshLedger: false }), DEFAULTS)
    expect(stale.isAllowed).toBe(false)
    if (!stale.isAllowed) expect(stale.reason).toContain('ledger_append')
    const urgent = gateSwitch(
      gateInput({ hasFreshLedger: false, level: 'urgent', requestsSinceSwitch: 100 }),
      DEFAULTS,
    )
    expect(urgent.isAllowed).toBe(false)
  })

  test('without a payoff it refuses, and says why', () => {
    const none = gateSwitch(gateInput({ judgement: null }), DEFAULTS)
    expect(none.isAllowed).toBe(false)
    if (!none.isAllowed) expect(none.reason).toContain('估算')

    const cheap = gateSwitch(
      gateInput({ judgement: { ...worth, isWorth: false, reason: '剩余 1 次不够回本。' } }),
      DEFAULTS,
    )
    expect(cheap.isAllowed).toBe(false)
    if (!cheap.isAllowed) expect(cheap.reason).toContain('剩余 1 次不够回本。')
  })

  test('a quiet hour, a warm session, a fresh ledger and a payoff let it through', () => {
    const allowed = gateSwitch(gateInput(), DEFAULTS)
    expect(allowed.isAllowed).toBe(true)
    // The boundary level is judged the same way as soft.
    expect(gateSwitch(gateInput({ level: 'boundary' }), DEFAULTS).isAllowed).toBe(true)
  })
})

describe('gateSwitch for a load held back by the gate', () => {
  test('a switch in front of a load skips the cooldown and the payoff, but not the hourly cap or the ledger', () => {
    const notWorth: Judgement = { ...worth, isWorth: false }
    expect(gateSwitch(gateInput({ requestsSinceSwitch: 0, judgement: notWorth }), DEFAULTS).isAllowed).toBe(false)
    expect(gateSwitch(gateInput({ requestsSinceSwitch: 0, judgement: notWorth, isForLoad: true }), DEFAULTS).isAllowed).toBe(true)
    expect(gateSwitch(gateInput({ requestsSinceSwitch: 0, judgement: null, isForLoad: true }), DEFAULTS).isAllowed).toBe(true)

    const capped = gateInput({ requestsSinceSwitch: 0, isForLoad: true, switchTimes: [999_000, 999_100, 999_200, 999_300] })
    expect(gateSwitch(capped, DEFAULTS).isAllowed).toBe(false)
    const stale = gateSwitch(gateInput({ requestsSinceSwitch: 0, isForLoad: true, hasFreshLedger: false }), DEFAULTS)
    expect(stale.isAllowed).toBe(false)
  })
})

describe('shouldContinue', () => {
  test('a wrap-up waits for the person instead of resuming by itself', () => {
    expect(shouldContinue(10, cache({ bridgePhase: 'wrapped' }), DEFAULTS)).toBe(false)
    expect(shouldContinue(10, cache(), DEFAULTS)).toBe(true)
    expect(shouldContinue(10, null, DEFAULTS)).toBe(true)
  })

  test('a nearly spent 5-hour window never continues', () => {
    expect(shouldContinue(89.9, null, DEFAULTS)).toBe(true)
    expect(shouldContinue(90, null, DEFAULTS)).toBe(false)
    expect(shouldContinue(undefined, null, DEFAULTS)).toBe(true)
  })
})


describe('gateSwitch with a reason the ledger is stale', () => {
  test('without a staleReason the sentence is the fixed one, and with one the reason leads', () => {
    const fixed = gateSwitch(gateInput({ hasFreshLedger: false }), DEFAULTS)
    expect(fixed).toEqual({
      isAllowed: false,
      reason: '账本还不新：先用 ledger_append 把已完成并有依据的进度、下一步和关键文件记进台账，再换窗口。',
    })

    const own = gateSwitch(
      gateInput({ hasFreshLedger: false, staleReason: '账本还不新：最近一次记账（#L27）之后又有 12 个工具结果没有记进账本（#640–#655）。' }),
      DEFAULTS,
    )
    expect(own).toEqual({
      isAllowed: false,
      reason:
        '账本还不新：最近一次记账（#L27）之后又有 12 个工具结果没有记进账本（#640–#655）。先用 ledger_append 写明这些步骤的结论、下一步和关键文件，再换窗口。',
    })
    // A fresh ledger ignores the reason.
    expect(gateSwitch(gateInput({ staleReason: '不会用到' }), DEFAULTS).isAllowed).toBe(true)
  })
})
