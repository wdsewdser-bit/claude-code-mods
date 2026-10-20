// CACHE-02: estimate the net benefit of the keeper's keepalives from the
// transcripts this machine already has. Offline companion of the mod, run with
// Node 24+:
//
//   node scripts/keepalive-net.ts                                  all of ~/.claude/projects
//   node scripts/keepalive-net.ts --transcripts <dir|file>         a project or one session
//   node scripts/keepalive-net.ts --max-files 500 --json           more files, machine-readable
//   node scripts/keepalive-net.ts --max-bytes 50000000             allow bigger transcripts
//   node scripts/keepalive-net.ts --sort size --max-files 40       sample the longest sessions
//   node scripts/keepalive-net.ts --events ~/.claude/cache-keeper  also read shadow-mode events
//
// What it does, per consecutive pair of requests in a thread:
//   * only pairs whose gap is longer than the cache TTL are counted (a shorter
//     gap needed no keepalive);
//   * it simulates the keeper: a would-be keepalive every ttlKeepaliveSec,
//     at most maxIdleKeepalives, only for a prefix of at least minPrefixTokens;
//   * if the last simulated keepalive is within the TTL of the next real
//     request, that request's cache write is counted as saved: it would have
//     been a cache read instead;
//   * every simulated keepalive costs its cached prefix at the read price plus
//     the small input and output of the probe.
// The estimate is API-equivalent USD, not subscription quota.
//
// PRICES: USD per million tokens, from
// https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-08),
// the same table as hooks/lib/pricing.ts. Override with --prices '<json>',
// either an array of [regex, price] pairs or an object of the same.
// Haiku 5.5 is priced by prompt length; this script uses its short-prompt row.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { observedTtl } from '../hooks/lib/classify.ts'
import { parseTranscript } from '../hooks/lib/parser.ts'
import type { TranscriptRequest } from '../hooks/lib/parser.ts'
import type { Ttl } from '../hooks/lib/pricing.ts'
import { parseJsonl } from '../hooks/lib/report.ts'

type Price = {
  input: number
  write5m: number
  write1h: number
  read: number
  output: number
}

const DEFAULT_PRICES: readonly (readonly [RegExp, Price])[] = [
  [/opus-5-5/, { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 }],
  [/sonnet-5-5/, { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 }],
  [/haiku-5-5/, { input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5 }],
  [/haiku-4-5/, { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 }],
]

const TTL_MS: Record<Ttl, number> = { '5m': 300_000, '1h': 3_600_000 }
const args = process.argv.slice(2)

const fail = (message: string): never => {
  console.error(message)
  process.exit(2)
}

const flag = (name: string): string | undefined => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value`)
  return value
}

const numberFlag = (name: string, fallback: number): number => {
  const raw = flag(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) fail(`${name} needs a number`)
  return value
}

const has = (name: string): boolean => args.includes(name)

const PRICES: (readonly [RegExp, Price])[] = (() => {
  const raw = flag('--prices')
  if (raw === undefined) return [...DEFAULT_PRICES]
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('--prices is not valid JSON')
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : Object.entries(parsed as Record<string, unknown>)
  const overrides: (readonly [RegExp, Price])[] = []
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      fail('--prices needs [regex, price] pairs')
    }
    const [pattern, value] = entry as [unknown, unknown]
    if (typeof pattern !== 'string' || typeof value !== 'object' || value === null) {
      fail('--prices needs [regex, price] pairs')
    }
    const one = value as Partial<Price>
    const keys: (keyof Price)[] = ['input', 'write5m', 'write1h', 'read', 'output']
    const price: Price = {
      input: 0,
      write5m: 0,
      write1h: 0,
      read: 0,
      output: 0,
    }
    for (const key of keys) {
      if (typeof one[key] !== 'number' || !Number.isFinite(one[key])) {
        fail(`--prices: ${pattern} is missing a numeric ${key}`)
      }
      price[key] = one[key] as number
    }
    overrides.push([new RegExp(pattern), price])
  }

  return overrides
})()

const priceFor = (model: string): Price | undefined =>
  PRICES.find(([pattern]) => pattern.test(model))?.[1]

const ttlOf = (request: TranscriptRequest, mode: string): Ttl | null => {
  if (mode === '5m' || mode === '1h') return mode
  if (mode !== 'auto') fail('--ttl must be 5m, 1h or auto')
  const observed = observedTtl(request.split)
  if (observed === '5m' || observed === '1h') return observed
  if (observed === 'mixed') return '1h'

  return null
}

const transcriptsUnder = (root: string, includeSubagents: boolean): string[] => {
  if (!existsSync(root)) fail(`no such path: ${root}`)
  if (statSync(root).isFile()) return [root]
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!includeSubagents && entry.name === 'subagents') continue
        if (entry.name === 'tool-results') continue
        walk(path)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push(path)
      }
    }
  }
  walk(root)

  return found
}

type Totals = {
  savedUsd: number
  costUsd: number
  fires: number
  gaps: number
  warm: number
  requests: number
}

type Bucket = Totals & { model: string }

const emptyTotals = (): Totals => ({
  savedUsd: 0,
  costUsd: 0,
  fires: 0,
  gaps: 0,
  warm: 0,
  requests: 0,
})

const minPrefix = numberFlag('--min-prefix', 40_000)
const maxIdle = numberFlag('--max-idle', 3)
const keepalive5m = numberFlag('--keepalive-5m', 245)
const keepalive1h = numberFlag('--keepalive-1h', 3_120)
const outputTokens = numberFlag('--output-tokens', 8)
const keepaliveInputTokens = numberFlag('--keepalive-input-tokens', 20)
const maxFiles = numberFlag('--max-files', 200)
const maxBytes = numberFlag('--max-bytes', 12_000_000)
const maxTotalBytes = numberFlag('--max-total-bytes', 200_000_000)
const ttlMode = flag('--ttl') ?? 'auto'
const includeSubagents = has('--include-subagents')

const sortMode = flag('--sort') ?? 'mtime'
if (sortMode !== 'mtime' && sortMode !== 'size') fail('--sort must be mtime or size')
const root = flag('--transcripts') ?? join(homedir(), '.claude', 'projects')
const candidates = transcriptsUnder(root, includeSubagents)
  .map(path => ({ path, mtimeMs: statSync(path).mtimeMs, bytes: statSync(path).size }))
  .sort((a, b) => (sortMode === 'size' ? b.bytes - a.bytes : b.mtimeMs - a.mtimeMs))
  .slice(0, maxFiles)
let skippedLarge = 0
let skippedBudget = 0
let budget = maxTotalBytes
const paths: string[] = []
for (const candidate of candidates) {
  if (candidate.bytes > maxBytes) {
    skippedLarge += 1
    continue
  }
  if (candidate.bytes > budget) {
    skippedBudget += 1
    continue
  }
  budget -= candidate.bytes
  paths.push(candidate.path)
}

const totals = emptyTotals()
const byModel = new Map<string, Bucket>()
const ttlCounts = { '5m': 0, '1h': 0 }
let pairs = 0
let unpriced = 0
let alreadyHit = 0
let defaultedTtl = 0
let earliest: string | null = null
let latest: string | null = null

for (const path of paths) {
  let parsed
  try {
    parsed = parseTranscript(readFileSync(path, 'utf8'))
  } catch {
    continue
  }
  const requests = parsed.requests
    .filter(request => includeSubagents || !request.isSidechain)
    .sort((a, b) => a.order - b.order)
  totals.requests += requests.length
  // The TTL that matters for a gap is the one the previous request wrote its
  // cache under. Requests that were pure hits carry no split, so remember the
  // last split the thread showed and carry it forward.
  const knownTtl: (Ttl | null)[] = []
  let lastKnown: Ttl | null = null
  for (const request of requests) {
    const observed = observedTtl(request.split)
    if (observed === '5m' || observed === '1h') lastKnown = observed
    else if (observed === 'mixed') lastKnown = '1h'
    knownTtl.push(lastKnown)
  }
  for (const request of requests) {
    if (request.timestamp === null) continue
    if (earliest === null || request.timestamp < earliest) earliest = request.timestamp
    if (latest === null || request.timestamp > latest) latest = request.timestamp
  }

  for (let index = 1; index < requests.length; index += 1) {
    const previous = requests[index - 1]!
    const next = requests[index]!
    if (previous.timestamp === null || next.timestamp === null) continue
    const gapMs = Date.parse(next.timestamp) - Date.parse(previous.timestamp)
    if (!Number.isFinite(gapMs) || gapMs <= 0) continue
    pairs += 1

    let ttl = ttlOf(next, ttlMode)
    if (ttl === null) ttl = knownTtl[index - 1] ?? knownTtl[index] ?? null
    if (ttl === null && ttlMode === 'auto') {
      ttl = '5m'
      defaultedTtl += 1
    }
    if (ttl === null) continue
    if (gapMs <= TTL_MS[ttl]) continue

    const prefix =
      previous.usage.input_tokens +
      previous.usage.cache_read_input_tokens +
      previous.usage.cache_creation_input_tokens
    if (prefix < minPrefix) continue

    const price = priceFor(next.model) ?? priceFor(previous.model)
    if (price === undefined) {
      unpriced += 1
      continue
    }

    ttlCounts[ttl] += 1
    const threshold = (ttl === '5m' ? keepalive5m : keepalive1h) * 1_000
    let lastFire: number | null = null
    let fires = 0
    let at = Date.parse(previous.timestamp)
    for (let one = 0; one < maxIdle; one += 1) {
      at += threshold
      if (at >= Date.parse(next.timestamp)) break
      lastFire = at
      fires += 1
    }
    const warm = lastFire !== null && Date.parse(next.timestamp) - lastFire < TTL_MS[ttl]
    // A request that already read the cache after the gap survived on its own
    // (a longer TTL, or activity the main-thread view hides). Do not credit a
    // keepalive for a rebuild that did not happen.
    const survived = next.usage.cache_read_input_tokens > 0
    const write = ttl === '5m' ? price.write5m : price.write1h
    const saved =
      warm && !survived
        ? (next.usage.cache_creation_input_tokens * (write - price.read)) / 1_000_000
        : 0
    const cost =
      (fires *
        (prefix * price.read +
          keepaliveInputTokens * price.input +
          outputTokens * price.output)) /
      1_000_000
    if (warm && survived) alreadyHit += 1

    const bucket = byModel.get(next.model) ?? {
      model: next.model,
      ...emptyTotals(),
    }
    for (const target of [totals, bucket]) {
      target.gaps += 1
      target.fires += fires
      target.savedUsd += saved
      target.costUsd += cost
      if (warm) target.warm += 1
    }
    byModel.set(next.model, bucket)
  }
}

const net = totals.savedUsd - totals.costUsd
const usd = (value: number): string => `$${value.toFixed(4)}`
const round = (value: number): number => Math.round(value * 10_000) / 10_000

// Shadow-mode events, when the person pointed at a data directory: the
// would-have rows and the real recovery gaps they recorded.
const eventsDir = flag('--events')
let shadow: Record<string, unknown> | null = null
if (eventsDir !== undefined) {
  const raw = join(eventsDir, 'raw')
  const rows = existsSync(raw)
    ? readdirSync(raw)
        .filter(name => name.startsWith('events-') && name.endsWith('.jsonl'))
        .flatMap(name => parseJsonl<Record<string, unknown>>(readFileSync(join(raw, name), 'utf8')))
    : []
  const wouldHave = rows.filter(row => row.kind === 'shadow')
  const recoveries = rows.filter(row => row.kind === 'recovery')
  const gaps = recoveries
    .map(row => row.shadow_recovery_sec)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  shadow = {
    wouldHaveKeepalives: wouldHave.length,
    recoveryRows: recoveries.length,
    recoverySecMean: gaps.length === 0 ? null : Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length),
    recoverySecMax: gaps.length === 0 ? null : Math.max(...gaps),
  }
}

const assumptions = {
  prices: 'API-equivalent USD per million tokens; source platform.claude.com/docs/en/about-claude/pricing, read 2026-10-08',
  ttl:
    ttlMode === 'auto'
      ? 'the last 5m/1h split the thread showed (mixed treated as 1h), else 5m'
      : ttlMode,
  ttlDefaultedGaps: defaultedTtl,
  keepalive5mSec: keepalive5m,
  keepalive1hSec: keepalive1h,
  maxIdleKeepalives: maxIdle,
  minPrefixTokens: minPrefix,
  keepaliveOutputTokens: outputTokens,
  keepaliveInputTokens,
  saved:
    'the cache_creation_input_tokens the next request actually wrote, priced as a read instead; only when it did not already read the cache',
  cost: 'each would-be keepalive reads the previous request\'s whole prompt at the read price',
  ignored: 'pairs whose gap is within the TTL, and prefixes under the minimum',
  notModelled: 'probe failures, rate limits, compactions, the engine\'s own eviction',
}

if (has('--json')) {
  console.log(
    JSON.stringify(
      {
        transcripts: paths.length,
        skippedOversize: skippedLarge,
        skippedOverBudget: skippedBudget,
        requests: totals.requests,
        pairs,
        gapsPastTtl: totals.gaps,
        ttl: ttlCounts,
        simulatedKeepalives: totals.fires,
        warmArrivals: totals.warm,
        savedUsd: round(totals.savedUsd),
        costUsd: round(totals.costUsd),
        netUsd: round(net),
        netPerGapUsd: totals.gaps === 0 ? null : round(net / totals.gaps),
        unpricedGaps: unpriced,
        gapsWithDefaultedTtl: defaultedTtl,
        warmButActuallyHit: alreadyHit,
        firstRequestAt: earliest,
        lastRequestAt: latest,
        byModel: [...byModel.values()].map(bucket => ({
          model: bucket.model,
          gaps: bucket.gaps,
          keepalives: bucket.fires,
          warm: bucket.warm,
          savedUsd: round(bucket.savedUsd),
          costUsd: round(bucket.costUsd),
          netUsd: round(bucket.savedUsd - bucket.costUsd),
        })),
        shadow,
        assumptions,
      },
      null,
      2,
    ),
  )
} else {
  console.log(`transcripts: ${paths.length} (${totals.requests} requests, ${pairs} consecutive pairs)`)
  if (skippedLarge > 0 || skippedBudget > 0) {
    console.log(`skipped for size: ${skippedLarge} over ${maxBytes} bytes, ${skippedBudget} past the ${maxTotalBytes}-byte budget`)
  }
  console.log(`idle gaps past the TTL: ${totals.gaps} (5m ${ttlCounts['5m']}, 1h ${ttlCounts['1h']})`)
  console.log(`simulated keepalives: ${totals.fires} · arrivals a keepalive would have kept warm: ${totals.warm}`)
  console.log(`saved cache rebuilds: ${usd(totals.savedUsd)}`)
  console.log(`keepalive requests:   ${usd(totals.costUsd)}`)
  console.log(`net:                  ${usd(net)}${totals.gaps === 0 ? '' : ` (${usd(net / totals.gaps)} per idle gap)`}`)
  if (unpriced > 0) console.log(`unpriced gaps skipped: ${unpriced}`)
  if (defaultedTtl > 0) console.log(`gaps with no visible split, assumed 5m: ${defaultedTtl}`)
  if (alreadyHit > 0) {
    console.log(`warm gaps that had already survived: ${alreadyHit} (no saving counted, the keepalive still costs)`)
  }
  if (earliest !== null) console.log(`requests from ${earliest} to ${latest}`)
  for (const bucket of [...byModel.values()].sort((a, b) => b.gaps - a.gaps)) {
    console.log(
      `  ${bucket.model}: ${bucket.gaps} gaps, ${bucket.fires} keepalives, saved ${usd(bucket.savedUsd)}, cost ${usd(bucket.costUsd)}, net ${usd(bucket.savedUsd - bucket.costUsd)}`,
    )
  }
  if (shadow !== null) {
    console.log(
      `shadow events: ${shadow.wouldHaveKeepalives} would-have keepalives, ${shadow.recoveryRows} recovery rows` +
        (shadow.recoverySecMean === null
          ? ''
          : `, recovery gap mean ${shadow.recoverySecMean}s, max ${shadow.recoverySecMax}s`),
    )
  }
  console.log('')
  console.log('assumptions:')
  for (const [key, value] of Object.entries(assumptions)) {
    console.log(`  ${key}: ${typeof value === 'number' ? value : value}`)
  }
}
