import type { Ttl } from './pricing.ts'

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type KeeperConfig = {
  minCacheReadTokens: number
  ttl5mKeepaliveAtSec: number
  ttl1hKeepaliveAtSec: number
  maxRateLimitPercent: number
  maxConsecutiveProbeFailures: number
}

export type KeeperState = {
  enabled: boolean
  isTurnRunning: boolean
  isProbing: boolean
  isRunActive: boolean
  /** When the last request that touched the main cache STARTED, in ms. */
  lastActivityAt: number | null
  /** Cache read + written by that request: the prefix worth keeping. */
  cachedPrefixTokens: number
  consecutiveFailures: number
  /** Keepalives since the last real request. */
  idleKeepalives: number
  /** Keepalives allowed per idle stretch; null when nothing bounds them. */
  idleKeepaliveBudget: number | null
  /** Set by a cache-invalidating change until a real request hits again. */
  pausedReason: string | null
  ttl: Ttl | null
}

export const TTL_MS: Record<Ttl, number> = { '5m': 300_000, '1h': 3_600_000 }

export type WaitReason =
  | 'disabled'
  | 'experiment'
  | 'busy'
  | 'paused'
  | 'ttl-unknown'
  | 'no-baseline'
  | 'prefix-too-small'
  | 'expired'
  | 'break-even'
  | 'not-due'

export type Decision =
  | { action: 'fire' }
  | { action: 'wait'; reason: WaitReason; dueInMs?: number }
  | { action: 'stop'; reason: string }

export const initialKeeperState = (enabled: boolean): KeeperState => ({
  enabled,
  isTurnRunning: false,
  isProbing: false,
  isRunActive: false,
  lastActivityAt: null,
  cachedPrefixTokens: 0,
  consecutiveFailures: 0,
  idleKeepalives: 0,
  idleKeepaliveBudget: null,
  pausedReason: null,
  ttl: null,
})

export const keepaliveAtMs = (ttl: Ttl, config: KeeperConfig): number =>
  (ttl === '5m' ? config.ttl5mKeepaliveAtSec : config.ttl1hKeepaliveAtSec) *
  1000

/**
 * Whether a window stops the keeper. Only the 5-hour window does: the weekly
 * one resets too far away to wait out, and while it still has room a stopped
 * keeper costs a full rewrite of the prefix, the dearer way to spend it. Once
 * it is spent the keepalives fail and the failure count stops the keeper.
 */
export const isOverStopLine = (limit: RateLimit, config: KeeperConfig): boolean =>
  limit.kind === 'five_hour' && limit.percentUsed >= config.maxRateLimitPercent

/**
 * The keeper and config `decide` should see when pings are not capped: no idle
 * budget, and, past the stop line, no 5-hour percent limit either. Every other
 * stop condition, and the TTL expiry, stay as they were.
 */
export const unboundedView = (
  state: KeeperState,
  config: KeeperConfig,
  { isUnboundedBudget, isPastStopLine }: {
    isUnboundedBudget: boolean
    isPastStopLine: boolean
  },
): { keeper: KeeperState; config: KeeperConfig } => ({
  keeper: isUnboundedBudget ? { ...state, idleKeepaliveBudget: null } : state,
  config: isPastStopLine
    ? { ...config, maxRateLimitPercent: Number.POSITIVE_INFINITY }
    : config,
})

/**
 * Whether to refresh the cache now. A keepalive is only ever a read of a
 * live entry: once the TTL has run out it would be a full rewrite, so the
 * keeper waits for a real request instead.
 */
export const decide = (
  state: KeeperState,
  now: number,
  config: KeeperConfig,
  rateLimits: readonly RateLimit[],
): Decision => {
  if (!state.enabled) return { action: 'wait', reason: 'disabled' }
  if (state.isRunActive) return { action: 'wait', reason: 'experiment' }
  if (state.consecutiveFailures >= config.maxConsecutiveProbeFailures) {
    return {
      action: 'stop',
      reason: `${state.consecutiveFailures} consecutive keepalives failed or missed`,
    }
  }
  if (state.isTurnRunning || state.isProbing) {
    return { action: 'wait', reason: 'busy' }
  }
  if (state.pausedReason !== null) return { action: 'wait', reason: 'paused' }
  if (state.ttl === null) return { action: 'wait', reason: 'ttl-unknown' }
  if (state.lastActivityAt === null) {
    return { action: 'wait', reason: 'no-baseline' }
  }
  if (state.cachedPrefixTokens < config.minCacheReadTokens) {
    return { action: 'wait', reason: 'prefix-too-small' }
  }
  const over = rateLimits.find(limit => isOverStopLine(limit, config))
  if (over !== undefined) {
    return {
      action: 'stop',
      reason: `${over.kind} is at ${over.percentUsed}% (limit ${config.maxRateLimitPercent}%)`,
    }
  }
  const idle = now - state.lastActivityAt
  if (idle >= TTL_MS[state.ttl]) return { action: 'wait', reason: 'expired' }
  if (
    state.idleKeepaliveBudget !== null &&
    state.idleKeepalives >= state.idleKeepaliveBudget
  ) {
    return { action: 'wait', reason: 'break-even' }
  }
  const dueInMs = keepaliveAtMs(state.ttl, config) - idle
  if (dueInMs > 0) return { action: 'wait', reason: 'not-due', dueInMs }

  return { action: 'fire' }
}

/** The main cache as another mod reads it under `$.state`'s `cache`. */
export type CacheState = {
  lastActivityAt: number | null
  ttl: Ttl | null
  expiresAt: number | null
  cachedPrefixTokens: number
  isEnabled: boolean
  pausedReason: string | null
  bridgePhase: 'idle' | 'wrapped'
}

export const cacheStateOf = (
  state: KeeperState,
  bridgePhase: 'idle' | 'wrapped',
): CacheState => ({
  lastActivityAt: state.lastActivityAt,
  ttl: state.ttl,
  expiresAt:
    state.lastActivityAt === null || state.ttl === null
      ? null
      : state.lastActivityAt + TTL_MS[state.ttl],
  cachedPrefixTokens: state.cachedPrefixTokens,
  isEnabled: state.enabled,
  pausedReason: state.pausedReason,
  bridgePhase,
})

/**
 * Whether the conversation is now far smaller than the prefix the keeper
 * tracks: it was compacted without the keeper's `session.compact` hook being
 * reached (another mod answered the compaction), so a keepalive would only
 * read a prefix nothing will ask for again.
 */
export const hasShrunk = (
  contextTokens: number | undefined,
  cachedPrefixTokens: number,
): boolean =>
  contextTokens !== undefined && contextTokens < cachedPrefixTokens / 2

/** One subagent's cache, as its own requests showed it. */
export type AgentTrack = {
  /** When its last request STARTED, in ms. */
  lastActivityAt: number
  /** Cache read + written by that request. */
  prefixTokens: number
  model: string
  /** Keepalives since its last real run. */
  keepalives: number
  isRunning: boolean
  /** When a keepalive was sent that its loop has not finished answering. */
  pingAt: number | null
  isPingAnswered: boolean
  /** That keepalive rewrote the entry instead of reading it. */
  isPingMissed: boolean
}

export type AgentDecision = 'fire' | 'wait' | 'forget'

/**
 * Whether to refresh a finished subagent's cache now, by the main keeper's
 * rule: only ever a read of a live entry, and `budget` times at most between
 * two real runs. An entry past its TTL is forgotten.
 */
export const decideAgent = (
  agent: AgentTrack,
  now: number,
  ttl: Ttl,
  config: KeeperConfig,
  budget: number,
): AgentDecision => {
  if (agent.isRunning || agent.pingAt !== null) return 'wait'
  const idle = now - agent.lastActivityAt
  if (idle >= TTL_MS[ttl]) return 'forget'
  if (agent.prefixTokens < config.minCacheReadTokens) return 'wait'
  if (agent.keepalives >= budget) return 'wait'

  return idle >= keepaliveAtMs(ttl, config) ? 'fire' : 'wait'
}

const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const thousands = (tokens: number): string => `${Math.round(tokens / 1000)}k`

/** The status line entry for a keeper outside an experiment. */
/** 等待原因的中文说明；没列出的原样显示。 */
const WAIT_TEXT: Record<string, string> = {
  disabled: '只观察',
  experiment: '实验中',
  busy: '对话进行中',
  'ttl-unknown': 'TTL 未知',
  'no-baseline': '还没有基线',
  'prefix-too-small': '前缀太小',
  expired: '已过期',
  'break-even': '保活不划算',
}

export const describeKeeper = (
  state: KeeperState,
  decision: Decision,
): string => {
  const ttl = state.ttl ?? 'TTL?'
  const prefix = thousands(state.cachedPrefixTokens)
  if (decision.action === 'stop') return '保活已停止'
  if (decision.action === 'fire') return `缓存 ${ttl} · ${prefix} · 保活中`
  if (decision.reason === 'not-due' && decision.dueInMs !== undefined) {
    return `缓存 ${ttl} · ${prefix} · ${clock(decision.dueInMs)} 后保活`
  }
  const why =
    decision.reason === 'paused'
      ? `暂停（${state.pausedReason}）`
      : WAIT_TEXT[decision.reason] ?? decision.reason

  return `缓存 ${ttl} · ${prefix} · ${why}`
}
