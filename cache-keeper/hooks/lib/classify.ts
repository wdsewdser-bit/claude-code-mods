import type { CacheSplit, Ttl, Usage } from './pricing.ts'

export type ProbeResult = 'hit' | 'partial_hit' | 'miss' | 'cold'

/**
 * How much of a request's prompt the cache served. `cold` is a request that
 * carried no prompt tokens at all (none was made, or it failed).
 */
export const classifyUsage = (usage: Usage): ProbeResult => {
  const prompt =
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  if (prompt === 0) return 'cold'
  const share = usage.cache_read_input_tokens / prompt
  if (share >= 0.9) return 'hit'

  return share <= 0.1 ? 'miss' : 'partial_hit'
}

export type TtlReason = 'force_5m_env' | 'env' | 'setting' | 'automatic'

export type TtlRequest = { ttl: Ttl | null; reason: TtlReason }

const isTtl = (value: unknown): value is Ttl => value === '5m' || value === '1h'

const isOn = (value: string | undefined): boolean =>
  value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())

/**
 * The TTL the engine was asked for, in its own order of precedence:
 * FORCE_PROMPT_CACHING_5M, then the TTL variable, then the `promptCacheTtl`
 * setting. `automatic` leaves the choice to the engine (ttl null).
 */
export const requestedTtl = (source: {
  force5m?: string
  envTtl?: string
  settingTtl?: unknown
}): TtlRequest => {
  if (isOn(source.force5m)) return { ttl: '5m', reason: 'force_5m_env' }
  if (isTtl(source.envTtl)) return { ttl: source.envTtl, reason: 'env' }
  if (isTtl(source.settingTtl)) {
    return { ttl: source.settingTtl, reason: 'setting' }
  }

  return { ttl: null, reason: 'automatic' }
}

export type SubagentTtlRequest = {
  ttl: Ttl
  reason: Exclude<TtlReason, 'automatic'> | 'enable_1h_env' | 'default'
}

/**
 * The TTL the engine uses outside the main conversation (subagents, workflows,
 * helper requests): the same order with its own variable and setting, then
 * ENABLE_PROMPT_CACHING_1H, and five minutes when nothing asks for more. An
 * agent definition's own `cacheTtl` sits between the two and is not seen here.
 */
export const requestedSubagentTtl = (source: {
  force5m?: string
  envTtl?: string
  settingTtl?: unknown
  enable1h?: string
}): SubagentTtlRequest => {
  if (isOn(source.force5m)) return { ttl: '5m', reason: 'force_5m_env' }
  if (isTtl(source.envTtl)) return { ttl: source.envTtl, reason: 'env' }
  if (isTtl(source.settingTtl)) {
    return { ttl: source.settingTtl, reason: 'setting' }
  }
  if (isOn(source.enable1h)) return { ttl: '1h', reason: 'enable_1h_env' }

  return { ttl: '5m', reason: 'default' }
}

export type ObservedTtl = Ttl | 'mixed' | null

/** Which cache a request wrote to, read off its transcript row's split. */
export const observedTtl = (split: CacheSplit | null): ObservedTtl => {
  if (split === null) return null
  const wrote5m = split.ephemeral_5m_input_tokens > 0
  const wrote1h = split.ephemeral_1h_input_tokens > 0
  if (wrote5m && wrote1h) return 'mixed'
  if (wrote5m) return '5m'

  return wrote1h ? '1h' : null
}

/** The TTL to schedule by: what the log showed, else what was asked for. */
export const effectiveTtl = (
  requested: Ttl | null,
  observed: ObservedTtl,
): Ttl | null => (isTtl(observed) ? observed : requested)

export const isTtlMismatch = (
  requested: Ttl | null,
  observed: ObservedTtl,
): boolean => requested !== null && isTtl(observed) && observed !== requested
