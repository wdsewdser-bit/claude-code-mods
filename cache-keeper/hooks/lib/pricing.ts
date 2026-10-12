export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type CacheSplit = {
  ephemeral_5m_input_tokens: number
  ephemeral_1h_input_tokens: number
}

export type Ttl = '5m' | '1h'

export type Price = {
  input: number
  write5m: number
  write1h: number
  read: number
  output: number
}

// USD per million tokens, platform.claude.com/docs/en/about-claude/pricing as
// read on 2026-10-08. The API's prices: never a subscription's quota weights.
// A third element is a prompt length the row only applies above: Haiku 5.5 is
// priced by prompt length, so its long-prompt row comes first.
const PRICES: readonly (readonly [RegExp, Price, number?])[] = [
  [/opus-5-5/, { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 }],
  [/sonnet-5-5/, { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 }],
  [/haiku-5-5/, { input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 }, 100_000],
  [/haiku-5-5/, { input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5 }],
  [/haiku-4-5/, { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 }],
]

export const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

export const priceFor = (model: string, promptTokens = 0): Price | undefined =>
  PRICES.find(
    ([pattern, , above]) =>
      pattern.test(model) && (above === undefined || promptTokens > above),
  )?.[1]

export type CostBasis =
  | 'split'
  | 'assumed-5m'
  | 'assumed-1h'
  | 'no-cache-write'
  | 'unpriced-model'

export type Cost = { usd: number | null; basis: CostBasis }

/**
 * What the request would cost on the API. Cache writes are priced from the
 * 5m/1h split when the transcript gave one, and `cache_creation_input_tokens`
 * is then never added again; without a split the whole write is priced at
 * `assumedTtl` (1h, the dearer, when even that is unknown).
 */
export const apiEquivalentCost = (
  model: string,
  usage: Usage,
  split: CacheSplit | null,
  assumedTtl: Ttl | null,
): Cost => {
  const price = priceFor(
    model,
    usage.input_tokens +
      usage.cache_read_input_tokens +
      usage.cache_creation_input_tokens,
  )
  if (price === undefined) return { usd: null, basis: 'unpriced-model' }
  const base =
    usage.input_tokens * price.input +
    usage.cache_read_input_tokens * price.read +
    usage.output_tokens * price.output
  const splitTotal =
    split === null
      ? 0
      : split.ephemeral_5m_input_tokens + split.ephemeral_1h_input_tokens
  if (split !== null && splitTotal > 0) {
    const writes =
      split.ephemeral_5m_input_tokens * price.write5m +
      split.ephemeral_1h_input_tokens * price.write1h
    return { usd: (base + writes) / 1_000_000, basis: 'split' }
  }
  if (usage.cache_creation_input_tokens === 0) {
    return { usd: base / 1_000_000, basis: 'no-cache-write' }
  }
  const isFiveMinute = assumedTtl === '5m'
  const writes =
    usage.cache_creation_input_tokens *
    (isFiveMinute ? price.write5m : price.write1h)
  return {
    usd: (base + writes) / 1_000_000,
    basis: isFiveMinute ? 'assumed-5m' : 'assumed-1h',
  }
}

/**
 * How many keepalive reads cost as much, on the API, as the one cache rewrite
 * they avoid: (write - read) / read, whole reads. Undefined for an unpriced
 * model.
 */
export const breakEvenKeepalives = (
  model: string,
  ttl: Ttl,
): number | undefined => {
  const price = priceFor(model)
  if (price === undefined) return undefined
  const write = ttl === '5m' ? price.write5m : price.write1h
  // whole micro-dollars, so 4.8 / 0.2 is 24 and not 23.999
  return Math.floor(
    Math.round((write - price.read) * 1000) / Math.round(price.read * 1000),
  )
}
