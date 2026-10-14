// How full the context window is, and the arithmetic behind moving to a new
// one. Pure decisions only: no clock of its own (every `now` is passed in) and
// no engine calls, so the whole file can be tested as plain functions.

import type { CacheState, Config } from './types.ts'

export type Level = 'none' | 'boundary' | 'soft' | 'urgent'

/** The engine compacts on its own this far below the window; switching wants that room back. */
const THRESHOLD_MARGIN = 33_000

/**
 * The limit the fill is measured against: the engine's own auto-compact
 * threshold when it reports a usable one, otherwise the configured window less
 * the margin the engine keeps for itself.
 */
export const limitOf = (autoCompactThreshold: number | undefined, config: Config): number =>
  autoCompactThreshold !== undefined && autoCompactThreshold > 0
    ? autoCompactThreshold
    : Math.max(1, config.compactWindow - THRESHOLD_MARGIN)

/** A whole percent for the status line; a limit of zero means no fill rather than no reading. */
export const percentOf = (tokens: number, limit: number): number =>
  limit <= 0 ? 0 : Math.floor((tokens / limit) * 100)

/**
 * How loud the reminder is: a high percent outranks a task boundary, and the
 * boundary only counts once there are enough tokens for a switch to be worth it.
 */
export const levelOf = (tokens: number, limit: number, config: Config): Level => {
  const percent = percentOf(tokens, limit)
  if (percent >= config.urgentPct) return 'urgent'
  if (percent >= config.softPct) return 'soft'
  if (percent >= config.boundaryPct) return 'boundary'

  return 'none'
}

/** The status line, which must still name the window when the token count is not known yet. */
export const describeFill = (
  tokens: number | undefined,
  limit: number,
  window: number,
): string => {
  if (tokens === undefined) return `ctx ? · w${window}`
  const k = (n: number): number => Math.round(n / 1000)

  return `ctx ${percentOf(tokens, limit)}% · ${k(tokens)}k/${k(limit)}k · w${window}`
}

export type Judgement = {
  isWorth: boolean
  savingPerRequest: number
  switchCost: number
  breakEvenRequests: number
  /** One Chinese sentence carrying the numbers the decision came from. */
  reason: string
}

/**
 * Whether the switch pays for itself: the prefix and the handoff are written
 * again (a cache write) while the context they replace would otherwise be read
 * on every remaining request, so the saving has to beat the cost inside the
 * requests the session has left, with a safety margin on top.
 */
export const judgeSwitch = (
  input: { before: number; prefix: number; handoff: number; reread: number; remainingRequests: number },
  config: Config,
): Judgement => {
  const savingPerRequest = Math.max(0, input.before - (input.prefix + input.handoff)) * config.wRead
  const switchCost = (input.handoff + input.reread) * config.wWrite
  const breakEvenRequests = savingPerRequest > 0 ? switchCost / savingPerRequest : Infinity
  const isWorth = input.remainingRequests >= breakEvenRequests * config.breakEvenSafety

  return {
    isWorth,
    savingPerRequest,
    switchCost,
    breakEvenRequests,
    reason: reasonOf(input, config, savingPerRequest, switchCost, breakEvenRequests, isWorth),
  }
}

const reasonOf = (
  input: { before: number; prefix: number; handoff: number; remainingRequests: number },
  config: Config,
  savingPerRequest: number,
  switchCost: number,
  breakEvenRequests: number,
  isWorth: boolean,
): string => {
  const saving = Math.round(savingPerRequest)
  const cost = Math.round(switchCost)
  if (savingPerRequest <= 0) {
    return `换窗口省不下 token：当前上下文 ${input.before} 不比「稳定前缀 ${input.prefix} + 交接 ${input.handoff}」多。`
  }
  if (isWorth) {
    return `每次请求省约 ${saving} token 当量，切换一次约 ${cost}，${breakEvenRequests.toFixed(1)} 次请求回本，剩余 ${input.remainingRequests} 次够用。`
  }

  return `每次请求省约 ${saving} token 当量，切换一次约 ${cost}，需 ${breakEvenRequests.toFixed(1)} 次请求回本（含 ${config.breakEvenSafety} 倍余量为 ${(breakEvenRequests * config.breakEvenSafety).toFixed(1)} 次），剩余 ${input.remainingRequests} 次不够。`
}

const FIVE_MINUTES_SEC = 300

/**
 * Whether the cached prefix is certainly gone: an explicit expiry settles it,
 * and otherwise the last request decides — an unknown last request counts as
 * warm, because pinging a live cache is cheap and dropping a live one is not.
 */
export const isCold = (
  input: { now: number; cache: CacheState | null; lastRequestAt: number | null },
  config: Config,
): boolean => {
  if (input.cache !== null && input.cache.expiresAt !== null) {
    return input.now >= input.cache.expiresAt
  }
  if (input.lastRequestAt === null) return false
  // A cache that says it lives five minutes (overage) must not be held to the hour.
  const lifetimeSec = input.cache?.ttl === '5m' ? FIVE_MINUTES_SEC : config.cacheTtlSec

  return input.now - input.lastRequestAt >= lifetimeSec * 1000
}

export type Gate = { isAllowed: true } | { isAllowed: false; reason: string }

/**
 * Whether this is a moment the model may switch windows at: rate limits first
 * (they are the person's budget, not a preference), then the cooldown that
 * stops a session from rebuilding its cache on every request, then the ledger
 * that makes a new window able to pick the work up, and only then the payoff —
 * with `urgent` allowed to skip everything but the hourly cap and the ledger.
 */
export const gateSwitch = (
  input: {
    requestsSinceSwitch: number
    switchTimes: readonly number[]
    now: number
    hasFreshLedger: boolean
    level: Level
    judgement: Judgement | null
    /** A switch the gate asked for in front of a load: it skips the cooldown and the payoff, like urgent. */
    isForLoad?: boolean
    /** Why the ledger is not fresh, when the caller knows better than the fixed sentence. */
    staleReason?: string
  },
  config: Config,
): Gate => {
  const recent = input.switchTimes.filter(at => at > input.now - 3_600_000 && at <= input.now).length
  if (recent >= config.maxSwitchesPerHour) {
    return {
      isAllowed: false,
      reason: `最近一小时已换窗口 ${recent} 次，达到上限 ${config.maxSwitchesPerHour} 次，现在不再换。`,
    }
  }
  const skipsPayoff = input.level === 'urgent' || input.isForLoad === true
  if (input.requestsSinceSwitch < config.cooldownRequests && !skipsPayoff) {
    return {
      isAllowed: false,
      reason: `距上次换窗口只过了 ${input.requestsSinceSwitch} 次请求，未到冷却门槛 ${config.cooldownRequests} 次（当前级别 ${input.level}，只有 urgent 能越过冷却）。`,
    }
  }
  if (!input.hasFreshLedger) {
    return {
      isAllowed: false,
      reason:
        input.staleReason === undefined
          ? '账本还不新：先用 ledger_append 把已完成并有依据的进度、下一步和关键文件记进台账，再换窗口。'
          : `${input.staleReason}先用 ledger_append 写明这些步骤的结论、下一步和关键文件，再换窗口。`,
    }
  }
  if (skipsPayoff) return { isAllowed: true }
  if (input.judgement === null) {
    return { isAllowed: false, reason: '没有交接成本的估算，判断不了换窗口是否划算，先不换。' }
  }
  if (!input.judgement.isWorth) {
    return { isAllowed: false, reason: `换窗口不划算：${input.judgement.reason}` }
  }

  return { isAllowed: true }
}

/**
 * Whether a fresh window may carry on by itself: not after a wrap-up handoff
 * (that one waits for the person) and not while the 5-hour window is nearly
 * spent, where the next switch would just repeat the same wrap-up.
 */
export const shouldContinue = (
  fiveHourPercent: number | undefined,
  cache: CacheState | null,
  config: Config,
): boolean => {
  if (cache?.bridgePhase === 'wrapped') return false
  if (fiveHourPercent !== undefined && fiveHourPercent >= config.noContinueAtPercent) return false

  return true
}
