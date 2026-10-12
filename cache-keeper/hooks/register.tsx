import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import {
  describeBridge,
  fiveHour,
  handoffText,
  initialBridge,
  countInFlight,
  isBackgroundBusy,
  needsPing,
  resetMs,
  resumeText,
  resumeVerdict,
  sevenDay,
  shouldHandoff,
  shouldWrap,
  windowKey,
  wrapText,
} from './lib/bridge.ts'
import type { Bridge } from './lib/bridge.ts'

import {
  classifyUsage,
  effectiveTtl,
  isTtlMismatch,
  observedTtl,
  requestedSubagentTtl,
  requestedTtl,
} from './lib/classify.ts'
import type { ObservedTtl, SubagentTtlRequest, TtlRequest } from './lib/classify.ts'
import {
  buildPrompt,
  marker,
  planDurationSec,
  planNamed,
  PLANS,
  probePromptFor,
} from './lib/experiment.ts'
import type { Plan, StepKind } from './lib/experiment.ts'
import {
  cacheStateOf,
  decide,
  decideAgent,
  describeKeeper,
  hasShrunk,
  initialKeeperState,
  isOverStopLine,
  unboundedView,
} from './lib/keeper.ts'
import type {
  AgentTrack,
  Decision,
  KeeperConfig,
  KeeperState,
  RateLimit,
} from './lib/keeper.ts'
import { matchSplits, parseTranscript } from './lib/parser.ts'
import {
  apiEquivalentCost,
  breakEvenKeepalives,
  ZERO_USAGE,
} from './lib/pricing.ts'
import type { CacheSplit, Ttl, Usage } from './lib/pricing.ts'
import { parseJsonl, renderReport, summarize, toCsv } from './lib/report.ts'
import type { EventRow, RunRecord, RunStep } from './lib/report.ts'

const COMMAND = 'cache-keeper'
const TICK_MS = 5_000
const CHUNK_ROWS = 1_000
const MIN_VERSION = [2, 1, 242] as const
const DEFAULT_FIXTURE_TOKENS = 60_000
const STALE_MS = 14 * 24 * 3_600_000
// One place for every session, whatever project it runs in.
const DEFAULT_DATA_DIR = '~/.claude/cache-keeper'
const METER_KEY = 'meter:last'
// What the bar above the prompt reads: a write redraws it.
const barAtom = atom({ plugin: 'cache-keeper', key: 'bar' } as const, '')
// What another mod reads to tell a warm cache from a cold one.
const cacheAtom = atom(
  { plugin: 'cache-keeper', key: 'cache' } as const,
  cacheStateOf(initialKeeperState(false), 'idle'),
)
const METER_CARRY_MS = 120_000
// What a finished subagent is resumed with to have its cached prefix read
// again. It answers in its own loop; the notice of that never reaches the model.
const AGENT_PING =
  'Cache keepalive from the cache-keeper plugin. Nothing has changed and nothing is asked of you: reply with OK only and call no tools.'
const PING_TIMEOUT_MS = 120_000
const QUIET_MS = 600_000

type Config = KeeperConfig & {
  enabled: boolean
  dataDir: string
  maxIdleKeepalives: number
  subagentKeepalives: number
  bridgeEnabled: boolean
  bridgeAtPercent: number
  weeklyHandoffAtPercent: number
  probePrompt: string
  writeCsv: boolean
  writeJson: boolean
  showStatus: boolean
}

type Tag = {
  experimentId: string
  replicate: number
  note: StepKind
  stepIndex: number
}

type Run = {
  plan: string
  experimentId: string
  replicate: number
  nonce: string
  requestedAt: number
  /** When the build request started; the plan's steps count from it. */
  startedAt: number | null
  next: number
  isInFlight: boolean
  meterStart: RateLimit[]
  contamination: string[]
  warnings: string[]
  steps: RunStep[]
  fixtureTokens: number
}

type Session = {
  id: string
  version: string
  model: string
  effort: string
  requested: TtlRequest
  subagent: SubagentTtlRequest
  /** The subagents whose cache is worth keeping, by agent id. */
  agents: Map<string, AgentTrack>
  agentHits: number
  agentMisses: number
  agentFailures: number
  agentStopNote: string | null
  /** Pinged subagents whose notice of finishing is not for the model: id, when. */
  quiet: Map<string, number>
  observed: ObservedTtl
  keeper: KeeperState
  baseline: { model: string; effort: string } | null
  transcriptPath: string | null
  rows: EventRow[]
  chunk: number
  keeperHits: number
  keeperMisses: number
  run: Run | null
  pending: (Tag & { marker: string; since: number }) | null
  tags: Map<string, Tag>
  stopNote: string | null
  /** Whether the person, or an automatic stop, set the keeper on or off here. */
  isEnabledDecided: boolean
  lastStatus: string | undefined
  heartbeatAt: number
  /** The last user or assistant message of the main thread, in ms. */
  lastRealAt: number | null
  bridge: Bridge
  /** No keepalive before this: the fork found no request of this process to share yet. */
  forkRetryAt: number
  /** Background tasks this main thread launched whose task-notification has not come back. */
  backgroundPending: number
  /** When the last of them was launched, in ms. */
  backgroundSeenAt: number | null
  /** An anchor session is kept warm without the idle cap, to hold a shared prefix. */
  isAnchor: boolean
  /** The expiry of an anchor's cache was already announced; not saved. */
  isAnchorExpiryNoted: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const numberOf = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const stringOf = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value !== '' ? value : fallback

const booleanOf = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const attempt = async <T,>(run: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await run()
  } catch {
    return fallback
  }
}

const iso = (ms: number): string => new Date(ms).toISOString()

const minutes = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const readConfig = (options: PluginOptions): Config => ({
  enabled: booleanOf(options.enabled, true),
  dataDir: stringOf(options.dataDir, DEFAULT_DATA_DIR).replace(/[\\/]+$/, ''),
  minCacheReadTokens: numberOf(options.minCacheReadTokens, 40_000),
  ttl5mKeepaliveAtSec: numberOf(options.ttl5mKeepaliveAtSec, 245),
  ttl1hKeepaliveAtSec: numberOf(options.ttl1hKeepaliveAtSec, 3_120),
  maxRateLimitPercent: numberOf(options.maxRateLimitPercent, 90),
  maxConsecutiveProbeFailures: numberOf(options.maxConsecutiveProbeFailures, 2),
  maxIdleKeepalives: numberOf(options.maxIdleKeepalives, 3),
  bridgeEnabled: booleanOf(options.bridgeEnabled, true),
  bridgeAtPercent: numberOf(options.bridgeAtPercent, 90),
  weeklyHandoffAtPercent: numberOf(options.weeklyHandoffAtPercent, 98),
  subagentKeepalives: numberOf(options.subagentKeepalives, 2),
  probePrompt: stringOf(options.probePrompt, 'Reply with OK only.'),
  writeCsv: booleanOf(options.writeCsv, true),
  writeJson: booleanOf(options.writeJson, true),
  showStatus: booleanOf(options.showStatus, true),
})

const usageOf = (row: EventRow): Usage => ({
  input_tokens: row.input_tokens,
  output_tokens: row.output_tokens,
  cache_read_input_tokens: row.cache_read_input_tokens,
  cache_creation_input_tokens: row.cache_creation_input_tokens,
})

const splitOf = (row: EventRow): CacheSplit | null =>
  row.ephemeral_5m_input_tokens === null
    ? null
    : {
        ephemeral_5m_input_tokens: row.ephemeral_5m_input_tokens,
        ephemeral_1h_input_tokens: row.ephemeral_1h_input_tokens ?? 0,
      }

const isAtLeast = (version: string, floor: readonly number[]): boolean => {
  const parts = version.split(/[.-]/).map(Number)
  for (const [index, wanted] of floor.entries()) {
    const have = parts[index] ?? 0
    if (Number.isNaN(have)) return false
    if (have !== wanted) return have > wanted
  }

  return true
}

// Module state: one session per load. register() resets it, as a reload does.
let config: Config = readConfig({})
let booting: Promise<Session> | undefined
let carriedEnabled: boolean | undefined
let timer: Timer | undefined
let isTicking = false

const debug = ($: EngineInterface, error: unknown): void => {
  $.ui.log(`error: ${messageOf(error)}`, { to: 'debug' })
}

const eventsPath = (s: Session): string =>
  `${config.dataDir}/raw/events-${s.id}-${s.chunk}.jsonl`

const limitsNow = async ($: EngineInterface): Promise<RateLimit[]> =>
  attempt(async () => [...(await $.session.usage()).rateLimits], [])

const boot = async ($: EngineInterface): Promise<Session> => {
  if (config.dataDir.startsWith('~')) {
    const home =
      (await attempt(() => $.env.get('USERPROFILE'), undefined)) ??
      (await attempt(() => $.env.get('HOME'), undefined))
    const under = `${home?.replace(/[\\/]+$/, '')}${config.dataDir.slice(1)}`
    config = {
      ...config,
      dataDir:
        home === undefined
          ? '.cache-keeper'
          : home.includes('\\')
            ? under.replaceAll('/', '\\')
            : under,
    }
  }
  const id = await attempt(() => $.session.id(), 'unknown')
  const version = await attempt(
    async () => (await $.session.version()).version,
    'unknown',
  )
  const settings = await attempt(
    async () => (await $.settings.read()) as unknown as Record<string, unknown>,
    {},
  )
  const force5m = await attempt(() => $.env.get('FORCE_PROMPT_CACHING_5M'), undefined)
  const s: Session = {
    id,
    version,
    model: await attempt(() => $.session.model(), 'unknown'),
    effort: '',
    requested: requestedTtl({
      force5m,
      envTtl: await attempt(() => $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'), undefined),
      settingTtl: settings.promptCacheTtl,
    }),
    subagent: requestedSubagentTtl({
      force5m,
      envTtl: await attempt(
        () => $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'),
        undefined,
      ),
      settingTtl: settings.subagentPromptCacheTtl,
      enable1h: await attempt(() => $.env.get('ENABLE_PROMPT_CACHING_1H'), undefined),
    }),
    agents: new Map(),
    agentHits: 0,
    agentMisses: 0,
    agentFailures: 0,
    agentStopNote: null,
    quiet: new Map(),
    observed: null,
    keeper: initialKeeperState(carriedEnabled ?? config.enabled),
    baseline: null,
    transcriptPath: null,
    rows: [],
    chunk: 0,
    keeperHits: 0,
    keeperMisses: 0,
    run: null,
    pending: null,
    tags: new Map(),
    stopNote: null,
    isEnabledDecided: false,
    lastStatus: undefined,
    heartbeatAt: 0,
    lastRealAt: null,
    bridge: initialBridge(),
    forkRetryAt: 0,
    backgroundPending: 0,
    backgroundSeenAt: null,
    isAnchor: false,
    isAnchorExpiryNoted: false,
  }
  carriedEnabled = undefined

  const saved = await attempt(() => $.store.get(`s:${id}`), undefined)
  if (isRecord(saved)) {
    // The default decides until someone has: a session saved before a change
    // of default follows the new one.
    s.isEnabledDecided = saved.isEnabledDecided === true
    if (s.isEnabledDecided) {
      s.keeper.enabled = booleanOf(saved.enabled, s.keeper.enabled)
    }
    s.keeper.lastActivityAt =
      typeof saved.lastActivityAt === 'number' ? saved.lastActivityAt : null
    s.keeper.cachedPrefixTokens = numberOf(saved.cachedPrefixTokens, 0)
    s.lastRealAt = typeof saved.lastRealAt === 'number' ? saved.lastRealAt : null
    s.isAnchor = saved.isAnchor === true
    s.backgroundPending = numberOf(saved.backgroundPending, 0)
    s.backgroundSeenAt =
      typeof saved.backgroundSeenAt === 'number' ? saved.backgroundSeenAt : null
    if (isRecord(saved.bridge)) {
      const b = saved.bridge
      s.bridge = {
        phase: b.phase === 'wrapped' ? 'wrapped' : 'idle',
        window: typeof b.window === 'string' ? b.window : null,
        resetAtMs: typeof b.resetAtMs === 'number' ? b.resetAtMs : null,
        wrapAt: typeof b.wrapAt === 'number' ? b.wrapAt : null,
        isTakenOver: b.isTakenOver === true,
        wrappedAtPercent:
          typeof b.wrappedAtPercent === 'number' ? b.wrappedAtPercent : null,
        weeklyWindow: typeof b.weeklyWindow === 'string' ? b.weeklyWindow : null,
      }
    }
    s.keeper.consecutiveFailures = numberOf(saved.consecutiveFailures, 0)
    s.keeper.idleKeepalives = numberOf(saved.idleKeepalives, 0)
    s.keeper.pausedReason =
      typeof saved.pausedReason === 'string' ? saved.pausedReason : null
    s.observed =
      saved.observed === '5m' || saved.observed === '1h' || saved.observed === 'mixed'
        ? saved.observed
        : null
    s.baseline = isRecord(saved.baseline)
      ? {
          model: stringOf(saved.baseline.model, ''),
          effort: stringOf(saved.baseline.effort, ''),
        }
      : null
    s.transcriptPath =
      typeof saved.transcriptPath === 'string' ? saved.transcriptPath : null
    s.chunk = numberOf(saved.chunk, 0)
    s.keeperHits = numberOf(saved.keeperHits, 0)
    s.keeperMisses = numberOf(saved.keeperMisses, 0)
    s.model = stringOf(saved.model, s.model)
    s.effort = stringOf(saved.effort, '')
    s.stopNote = typeof saved.stopNote === 'string' ? saved.stopNote : null
    s.agentHits = numberOf(saved.agentHits, 0)
    s.agentMisses = numberOf(saved.agentMisses, 0)
    s.agentStopNote =
      typeof saved.agentStopNote === 'string' ? saved.agentStopNote : null
    for (const one of Array.isArray(saved.agents) ? saved.agents : []) {
      if (!isRecord(one) || typeof one.id !== 'string') continue
      // A reload forgets what was in flight: the loop's next event says.
      s.agents.set(one.id, {
        lastActivityAt: numberOf(one.lastActivityAt, 0),
        prefixTokens: numberOf(one.prefixTokens, 0),
        model: stringOf(one.model, ''),
        keepalives: numberOf(one.keepalives, 0),
        isRunning: false,
        pingAt: null,
        isPingAnswered: false,
        isPingMissed: false,
      })
    }
    if (isRecord(saved.run)) {
      // The step a reload interrupted is asked again; the run says so.
      const run = saved.run as unknown as Run
      s.run = {
        ...run,
        isInFlight: false,
        warnings: run.isInFlight
          ? [...run.warnings, 'the mod reloaded mid-step']
          : run.warnings,
      }
    }
    s.rows = parseJsonl<EventRow>(await attempt(() => $.fs.read(eventsPath(s)), ''))
  }

  const now = await attempt(() => $.clock.now(), 0)
  for (const key of await attempt(() => $.store.keys(), [])) {
    if (!key.startsWith('s:') && !key.startsWith('hb:')) continue
    if (key === `s:${id}`) continue
    const value = await attempt(() => $.store.get(key), undefined)
    const at = isRecord(value) ? numberOf(value.at, 0) : 0
    if (now - at > STALE_MS) await attempt(() => $.store.delete(key), undefined)
  }

  return s
}

const ensure = ($: EngineInterface): Promise<Session> => (booting ??= boot($))

const save = async ($: EngineInterface, s: Session): Promise<void> => {
  await attempt(
    async () =>
      $.store.set(`s:${s.id}`, {
        at: await $.clock.now(),
        enabled: s.keeper.enabled,
        isEnabledDecided: s.isEnabledDecided,
        lastActivityAt: s.keeper.lastActivityAt,
        lastRealAt: s.lastRealAt,
        isAnchor: s.isAnchor,
        backgroundPending: s.backgroundPending,
        backgroundSeenAt: s.backgroundSeenAt,
        bridge: s.bridge,
        cachedPrefixTokens: s.keeper.cachedPrefixTokens,
        consecutiveFailures: s.keeper.consecutiveFailures,
        idleKeepalives: s.keeper.idleKeepalives,
        pausedReason: s.keeper.pausedReason,
        observed: s.observed,
        baseline: s.baseline,
        transcriptPath: s.transcriptPath,
        chunk: s.chunk,
        keeperHits: s.keeperHits,
        keeperMisses: s.keeperMisses,
        model: s.model,
        effort: s.effort,
        stopNote: s.stopNote,
        agentHits: s.agentHits,
        agentMisses: s.agentMisses,
        agentStopNote: s.agentStopNote,
        agents: [...s.agents].map(([id, agent]) => ({ id, ...agent })),
        run: s.run,
      }),
    undefined,
  )
}

const flush = async ($: EngineInterface, s: Session): Promise<void> => {
  if (s.rows.length === 0) return
  await $.fs.write(
    eventsPath(s),
    `${s.rows.map(row => JSON.stringify(row)).join('\n')}\n`,
  )
  if (s.rows.length >= CHUNK_ROWS) {
    s.chunk += 1
    s.rows = []
  }
}

const syncKeeper = (s: Session): void => {
  s.keeper.ttl = effectiveTtl(s.requested.ttl, s.observed)
  s.keeper.isRunActive = s.run !== null
  if (config.maxIdleKeepalives > 0) {
    s.keeper.idleKeepaliveBudget = config.maxIdleKeepalives
  } else {
    s.keeper.idleKeepaliveBudget =
      s.keeper.ttl === null
        ? null
        : (breakEvenKeepalives(s.model, s.keeper.ttl) ?? null)
  }
}

const contaminate = (run: Run, cause: string): void => {
  if (!run.contamination.includes(cause)) run.contamination.push(cause)
}

const rowOf = (
  s: Session,
  fields: Pick<EventRow, 'kind' | 'timestamp' | 'source'> & Partial<EventRow>,
  usage: Usage,
  tag: Tag | undefined,
): EventRow => {
  const isSubagent = fields.source === 'subagent'
  const split: CacheSplit | null =
    usage.cache_creation_input_tokens === 0
      ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }
      : null
  const model = fields.model ?? s.model
  const cost = apiEquivalentCost(
    model,
    usage,
    split,
    isSubagent ? s.subagent.ttl : effectiveTtl(s.requested.ttl, s.observed),
  )

  return {
    experiment_id: tag?.experimentId ?? '',
    replicate: tag?.replicate ?? null,
    session_id: s.id,
    model,
    effort: s.effort,
    claude_code_version: s.version,
    ttl_requested: s.requested.ttl ?? 'automatic',
    ttl_observed: isSubagent ? '' : (s.observed ?? ''),
    ...usage,
    ephemeral_5m_input_tokens: split?.ephemeral_5m_input_tokens ?? null,
    ephemeral_1h_input_tokens: split?.ephemeral_1h_input_tokens ?? null,
    cache_miss_reason: '',
    context_tokens: null,
    context_window: null,
    rate_limits_before: [],
    rate_limits_after: [],
    api_equivalent_usd: fields.kind === 'meter' ? null : cost.usd,
    cost_basis: fields.kind === 'meter' ? '' : cost.basis,
    contaminated: false,
    notes: tag?.note ?? '',
    result: '',
    turn_id: '',
    step_index: null,
    agent_id: '',
    duration_ms: null,
    ...fields,
  }
}

const readTranscript = async (
  $: EngineInterface,
  path: string,
): Promise<string | null> => {
  try {
    return await $.fs.read(path)
  } catch {
    // over the read limit, or not written yet: the script reads its tail
  }
  const ran = await attempt(
    () =>
      $.process.run([
        'node',
        `${$.plugin.root}/scripts/analyze-transcript.ts`,
        path,
        '--tail',
        '600',
      ]),
    undefined,
  )

  return ran !== undefined && ran.exitCode === 0 ? ran.stdout : null
}

// Fills in what only the transcript has: each cache write's 5m/1h split and
// the API's cache-miss reason, matched to the rows recorded live.
const reconcile = async ($: EngineInterface, s: Session): Promise<void> => {
  if (s.transcriptPath === null) return
  const open = s.rows.filter(
    row =>
      row.kind === 'step' &&
      row.source !== 'subagent' &&
      row.ephemeral_5m_input_tokens === null,
  )
  if (open.length === 0) return
  const jsonl = await readTranscript($, s.transcriptPath)
  if (jsonl === null) return
  const parsed = parseTranscript(jsonl)
  const matches = matchSplits(
    open.map(row => ({
      timestamp: row.timestamp,
      isSubagent: false,
      usage: usageOf(row),
    })),
    parsed.requests,
  )
  for (const [index, row] of open.entries()) {
    const match = matches[index]
    if (match === null || match === undefined) continue
    row.ephemeral_5m_input_tokens = match.split.ephemeral_5m_input_tokens
    row.ephemeral_1h_input_tokens = match.split.ephemeral_1h_input_tokens
    row.ttl_observed = observedTtl(match.split) ?? row.ttl_observed
    row.cache_miss_reason = match.cacheMissReason ?? ''
    const cost = apiEquivalentCost(row.model, usageOf(row), match.split, null)
    row.api_equivalent_usd = cost.usd
    row.cost_basis = cost.basis
    if (!match.isSplitConsistent) {
      row.notes = `${row.notes} SPLIT_INCONSISTENT`.trim()
    }
  }
  const lastWrite = parsed.requests
    .filter(request => !request.isSidechain)
    .findLast(request => observedTtl(request.split) !== null)
  if (lastWrite !== undefined) s.observed = observedTtl(lastWrite.split)
  await flush($, s)
}

const stopKeeper = ($: EngineInterface, s: Session, reason: string): void => {
  s.keeper.enabled = false
  s.isEnabledDecided = true
  s.stopNote = reason
  s.bridge.phase = 'idle'
  $.ui.toast(`cache-keeper stopped: ${reason}`)
  $.ui.log(`keeper stopped: ${reason}`)
}

// One cache-sharing fork over the session's own transcript: the keepalive,
// a manual probe, or an experiment's keeper step.
const probe = async (
  $: EngineInterface,
  s: Session,
  tag: Tag | undefined,
  note: string,
): Promise<EventRow> => {
  s.keeper.isProbing = true
  try {
    const before = await limitsNow($)
    const startedAt = await $.clock.now()
    const reply = await $.model.fork({ prompt: config.probePrompt })
    const endedAt = await $.clock.now()
    const after = await attempt(() => $.session.usage(), undefined)
    const usage: Usage = 'usage' in reply ? { ...reply.usage } : ZERO_USAGE
    const result = classifyUsage(usage)
    const failure = reply.isAnswered
      ? ''
      : reply.reason === 'api-error'
        ? `api-error ${reply.status ?? ''} ${reply.error}`.trim()
        : reply.reason
    const refreshed =
      usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    if (result === 'hit' || result === 'partial_hit') {
      s.keeper.lastActivityAt = startedAt
      s.keeper.cachedPrefixTokens = Math.max(s.keeper.cachedPrefixTokens, refreshed)
      s.keeper.consecutiveFailures = 0
      s.keeper.idleKeepalives += 1
      s.keeperHits += 1
      s.isAnchorExpiryNoted = false
    } else if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
      // A resumed or just-started process has no request of its own to fork yet: wait, never count it as a failure.
      s.forkRetryAt = endedAt + 30_000
    } else {
      s.keeper.consecutiveFailures += 1
      s.keeperMisses += 1
      if (usage.cache_creation_input_tokens > 0) {
        // The miss rewrote the prefix, so the entry is fresh from here.
        s.keeper.lastActivityAt = startedAt
        s.keeper.cachedPrefixTokens = refreshed
        s.keeper.idleKeepalives += 1
      }
    }
    const row = rowOf(
      s,
      {
        kind: 'keeper',
        timestamp: iso(startedAt),
        source: 'keeper',
        result,
        notes: [note, failure].filter(Boolean).join(': '),
        rate_limits_before: before,
        rate_limits_after: after === undefined ? [] : [...after.rateLimits],
        context_tokens: after?.context.tokens ?? null,
        context_window: after?.context.window ?? null,
        duration_ms: endedAt - startedAt,
      },
      usage,
      tag,
    )
    s.rows.push(row)
    await flush($, s)
    await rememberMeter($, endedAt, after?.rateLimits ?? [])
    await save($, s)

    return row
  } finally {
    s.keeper.isProbing = false
  }
}

// A subagent's request, as its turn.step showed it: the cache it left behind is
// the one a later SendMessage to it reads. Answers the row's note.
const agentStepped = (
  s: Session,
  id: string,
  startedAt: number,
  model: string,
  usage: Usage,
): string => {
  const agent: AgentTrack = s.agents.get(id) ?? {
    lastActivityAt: startedAt,
    prefixTokens: 0,
    model,
    keepalives: 0,
    isRunning: true,
    pingAt: null,
    isPingAnswered: false,
    isPingMissed: false,
  }
  agent.lastActivityAt = startedAt
  agent.prefixTokens =
    usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  agent.model = model
  agent.isRunning = true
  s.agents.set(id, agent)
  if (agent.pingAt === null) {
    // A real run: its idle stretch starts over.
    agent.keepalives = 0
    return ''
  }
  if (!agent.isPingAnswered) {
    agent.isPingAnswered = true
    if (classifyUsage(usage) === 'miss') {
      agent.isPingMissed = true
      s.agentMisses += 1
      s.agentFailures += 1
    } else {
      s.agentHits += 1
      s.agentFailures = 0
    }
  }

  return 'subagent keepalive'
}

const agentFinished = ($: EngineInterface, s: Session, id: string): void => {
  const agent = s.agents.get(id)
  if (agent === undefined) return
  agent.isRunning = false
  if (agent.pingAt === null) return
  agent.pingAt = null
  agent.isPingAnswered = false
  if (!agent.isPingMissed) return
  // The keepalive rewrote the entry instead of reading it: the TTL assumed for
  // this subagent is wrong, and another keepalive would cost the same again.
  s.agents.delete(id)
  if (s.agentFailures >= config.maxConsecutiveProbeFailures) {
    s.agentStopNote = `${s.agentFailures} consecutive subagent keepalives missed`
    $.ui.toast(`cache-keeper stopped keeping subagents: ${s.agentStopNote}`)
    $.ui.log(`subagent keeper stopped: ${s.agentStopNote}`)
  }
}

// Whether the session saved a subagent under this id. The engine lists the
// subagents it ran in the background; one that ran in the foreground is on no
// list, and neither are the engine's own forks, which save nothing here.
const isSavedSubagent = async (
  $: EngineInterface,
  s: Session,
  id: string,
): Promise<boolean> => {
  if (s.transcriptPath === null) return false
  const path = `${s.transcriptPath.replace(/.jsonl$/, '')}/subagents/agent-${id}.meta.json`
  const meta = await attempt(
    async () => JSON.parse(await $.fs.read(path)) as unknown,
    undefined,
  )

  return isRecord(meta) && typeof meta.agentType === 'string'
}

// Resumes one finished subagent with the keepalive message: one the engine
// lists as completed, or one it does not list whose transcript the session
// saved. A running one waits; a failed or killed one is not resumed.
const pingAgent = async (
  $: EngineInterface,
  s: Session,
  id: string,
  now: number,
): Promise<string> => {
  const agent = s.agents.get(id)
  if (agent === undefined) return 'not tracked'
  const listed = await attempt(() => $.agent.list(), [])
  const status = listed.find(one => one.id === id)?.status
  const isResumable =
    status === 'completed' ||
    (status === undefined && (await isSavedSubagent($, s, id)))
  if (!isResumable) {
    if (status !== 'running') s.agents.delete(id)
    return status ?? 'not a subagent of this session'
  }
  agent.pingAt = now
  agent.isPingAnswered = false
  agent.isPingMissed = false
  agent.keepalives += 1
  s.quiet.set(id, now)
  const sent = await attempt(
    () => $.session.send({ to: { agentId: id }, text: AGENT_PING }),
    undefined,
  )
  if (sent === undefined || !sent.isDelivered) {
    s.agents.delete(id)
    s.quiet.delete(id)
    const why = sent?.reason ?? 'the send failed'
    $.ui.log(`subagent ${id} keepalive not delivered: ${why}`)
    return `not delivered (${why})`
  }
  await save($, s)

  return 'sent'
}

const keepAgents = async (
  $: EngineInterface,
  s: Session,
  now: number,
): Promise<void> => {
  for (const [id, at] of s.quiet) {
    if (now - at > QUIET_MS) s.quiet.delete(id)
  }
  let due: string | undefined
  for (const [id, agent] of s.agents) {
    if (agent.pingAt !== null) {
      // Delivered and never run: nothing will clear it.
      if (!agent.isRunning && now - agent.pingAt > PING_TIMEOUT_MS) s.agents.delete(id)
      continue
    }
    const decision = decideAgent(
      agent,
      now,
      s.subagent.ttl,
      config,
      config.subagentKeepalives,
    )
    if (decision === 'forget') s.agents.delete(id)
    else if (decision === 'fire') due ??= id
  }
  if (due === undefined || !s.keeper.enabled || s.agentStopNote !== null) return
  const limits = await limitsNow($)
  if (limits.some(limit => isOverStopLine(limit, config))) return
  await pingAgent($, s, due, now)
}

const agentsText = (s: Session, now: number): string => {
  const stopped = s.agentStopNote === null ? '' : ` (stopped: ${s.agentStopNote})`
  const head = `subagents: TTL ${s.subagent.ttl} (${s.subagent.reason}) · keepalives per subagent ${config.subagentKeepalives}${stopped} · tracked ${s.agents.size} · hits ${s.agentHits} · misses ${s.agentMisses}`
  const rows = [...s.agents].map(([id, agent]) => {
    const state = agent.isRunning
      ? 'running'
      : `idle ${minutes(now - agent.lastActivityAt)}`
    const flight = agent.pingAt === null ? '' : ' · keepalive in flight'

    return `  ${id} · ${agent.model} · prefix ${agent.prefixTokens} · ${state} · keepalives ${agent.keepalives}${flight}`
  })

  return [head, ...rows].join('\n')
}

const otherSessionsSince = async (
  $: EngineInterface,
  s: Session,
  since: number,
): Promise<string[]> => {
  const others: string[] = []
  for (const key of await attempt(() => $.store.keys(), [])) {
    if (!key.startsWith('hb:') || key === `hb:${s.id}`) continue
    const value = await attempt(() => $.store.get(key), undefined)
    if (isRecord(value) && numberOf(value.at, 0) >= since) {
      others.push(key.slice(3, 11))
    }
  }

  return others
}

const finishRun = async (
  $: EngineInterface,
  s: Session,
  run: Run,
): Promise<void> => {
  await reconcile($, s)
  const now = await $.clock.now()
  const mine = s.rows.filter(
    row =>
      row.experiment_id === run.experimentId && row.replicate === run.replicate,
  )
  const build = mine.find(row => row.notes.startsWith('build'))
  const observed = build === undefined ? null : observedTtl(splitOf(build))
  if (isTtlMismatch(s.requested.ttl, observed)) {
    run.warnings.push('TTL_CONFIG_MISMATCH')
  }
  if (build !== undefined && build.ephemeral_5m_input_tokens === null) {
    run.warnings.push('TTL_UNVERIFIED: no transcript split for the build request')
  }
  if (
    build !== undefined &&
    build.cache_creation_input_tokens + build.cache_read_input_tokens <
      run.fixtureTokens / 2
  ) {
    run.warnings.push('FIXTURE_SMALLER_THAN_ASKED')
  }
  for (const other of await otherSessionsSince($, s, run.requestedAt)) {
    contaminate(run, `session ${other} made requests meanwhile`)
  }
  const isContaminated = run.contamination.length > 0
  if (isContaminated) {
    for (const row of mine) row.contaminated = true
  }
  const ttl = s.requested.ttl ?? 'automatic'
  const record: RunRecord = {
    experiment_id: run.experimentId,
    plan: run.plan,
    replicate: run.replicate,
    ttl_requested: ttl,
    ttl_reason: s.requested.reason,
    ttl_observed: observed ?? '',
    session_id: s.id,
    model: s.model,
    effort: s.effort,
    claude_code_version: s.version,
    started_at: iso(run.startedAt ?? run.requestedAt),
    ended_at: iso(now),
    meter_start: run.meterStart,
    meter_end: await limitsNow($),
    contaminated: isContaminated,
    contamination: run.contamination,
    warnings: run.warnings,
    transcript_path: s.transcriptPath,
    fixture_tokens: run.fixtureTokens,
    steps: run.steps,
  }
  const path = `${config.dataDir}/raw/run-${run.experimentId}-${ttl}-r${run.replicate}-${s.id.slice(0, 8)}.json`
  await $.fs.write(path, `${JSON.stringify(record, null, 2)}\n`)
  s.run = null
  await flush($, s)
  await save($, s)
  const verdict = isContaminated ? 'contaminated' : 'clean'
  $.ui.toast(`cache-keeper: ${run.experimentId} r${run.replicate} finished (${verdict})`)
  $.ui.log(
    `${run.experimentId} r${run.replicate} finished (${verdict}); wrote ${path}. /cache-keeper report builds the report.`,
  )
}

const abortRun = async (
  $: EngineInterface,
  s: Session,
  why: string,
): Promise<void> => {
  const run = s.run
  if (run === null) return
  s.run = null
  s.pending = null
  await save($, s)
  $.ui.toast(`cache-keeper: ${run.experimentId} aborted (${why})`)
  $.ui.log(`${run.experimentId} r${run.replicate} aborted: ${why}`)
}

const advanceRun = async (
  $: EngineInterface,
  s: Session,
  run: Run,
  now: number,
): Promise<void> => {
  const plan = planNamed(run.plan)
  if (plan === undefined) {
    await abortRun($, s, 'unknown plan')
    return
  }
  if (run.isInFlight) {
    if (s.pending !== null && now - s.pending.since > 120_000) {
      await abortRun($, s, 'the step never started a turn')
    }
    return
  }
  if (s.keeper.isTurnRunning || s.keeper.isProbing) return
  const step = plan.steps[run.next]
  if (step === undefined) {
    await finishRun($, s, run)
    return
  }
  if (step.kind !== 'build') {
    if (run.startedAt === null) return
    if (now < run.startedAt + step.atSec * 1000) return
  }
  const tag: Tag = {
    experimentId: run.experimentId,
    replicate: run.replicate,
    note: step.kind,
    stepIndex: run.next,
  }
  run.isInFlight = true
  if (step.kind === 'keeper') {
    const row = await probe($, s, tag, 'keeper')
    run.steps.push({
      kind: 'keeper',
      plannedSec: step.atSec,
      actualSec: (Date.parse(row.timestamp) - (run.startedAt ?? now)) / 1000,
      result: row.result,
      cacheRead: row.cache_read_input_tokens,
      cacheCreation: row.cache_creation_input_tokens,
    })
    run.next += 1
    run.isInFlight = false
    await save($, s)
    return
  }
  const isBuild = step.kind === 'build'
  s.pending = {
    ...tag,
    marker: marker(step.kind, run.nonce, isBuild ? 0 : run.next),
    since: now,
  }
  await save($, s)
  const entered = await attempt(
    () =>
      $.prompt.submit({
        text: isBuild
          ? buildPrompt(run.nonce, run.fixtureTokens, config.probePrompt)
          : probePromptFor(run.nonce, run.next, config.probePrompt),
        asUser: true,
      }),
    undefined,
  )
  if (entered === undefined || 'drop' in entered) {
    await abortRun($, s, 'the prompt was not accepted')
  }
}

const stepDone = async (
  $: EngineInterface,
  s: Session,
  run: Run,
  tag: Tag,
  turnId: string,
  reason: string,
): Promise<void> => {
  const plan = planNamed(run.plan)
  const rows = s.rows.filter(row => row.turn_id === turnId)
  const first = rows[0]
  const last = rows.at(-1)
  if (first === undefined || last === undefined) {
    await abortRun($, s, `the ${tag.note} turn got no response (${reason})`)
    return
  }
  if (reason !== 'answer') {
    run.warnings.push(`step ${tag.stepIndex} (${tag.note}) ended: ${reason}`)
  }
  if (rows.length > 1) {
    run.warnings.push(`step ${tag.stepIndex} (${tag.note}) took ${rows.length} requests`)
  }
  const at = Date.parse(first.timestamp)
  if (tag.note === 'build') run.startedAt = at
  run.steps.push({
    kind: tag.note,
    plannedSec: plan?.steps[tag.stepIndex]?.atSec ?? 0,
    actualSec: (at - (run.startedAt ?? at)) / 1000,
    result: last.result,
    cacheRead: last.cache_read_input_tokens,
    cacheCreation: last.cache_creation_input_tokens,
  })
  run.next = tag.stepIndex + 1
  run.isInFlight = false
}

const runStatus = (s: Session, run: Run, now: number): string => {
  const plan = planNamed(run.plan)
  const step = plan?.steps[run.next]
  const total = plan?.steps.length ?? 0
  if (step === undefined) return `${run.experimentId} r${run.replicate} · finishing`
  const wait =
    run.startedAt === null
      ? ''
      : ` · next ${step.kind} in ${minutes(
          Math.ceil((run.startedAt + step.atSec * 1000 - now) / 15_000) * 15_000,
        )}`

  return `${run.experimentId} r${run.replicate} · step ${run.next + 1}/${total}${wait}`
}

const showStatus = ($: EngineInterface, s: Session, now: number): void => {
  if (!config.showStatus) return
  syncKeeper(s)
  let text: string
  if (s.run !== null) {
    text = runStatus(s, s.run, now)
  } else {
    const decision = decide(s.keeper, now, config, [])
    const coarse: Decision =
      decision.action === 'wait' && decision.dueInMs !== undefined
        ? { ...decision, dueInMs: Math.ceil(decision.dueInMs / 15_000) * 15_000 }
        : decision
    text = describeKeeper(s.keeper, coarse)
  }
  if (text === s.lastStatus) return
  s.lastStatus = text
  $.ui.status(text)
}

// The weekly handoff, once per tick: with the weekly window nearly spent, the
// main session is asked once to leave a document a new conversation can pick
// up after the reset. It is not told to stop, and nothing resumes it.
const handoffStep = async (
  $: EngineInterface,
  s: Session,
  now: number,
): Promise<void> => {
  if (config.weeklyHandoffAtPercent <= 0 || s.lastRealAt === null) return
  const limits = await limitsNow($)
  const ask = shouldHandoff({
    isRunActive: s.run !== null,
    bridge: s.bridge,
    limits,
    now,
    lastRealAt: s.lastRealAt,
    ttl: effectiveTtl(s.requested.ttl, s.observed),
    atPercent: config.weeklyHandoffAtPercent,
    isBackgroundBusy: isBackgroundBusy(s.backgroundPending, s.backgroundSeenAt, now),
  })
  const limit = sevenDay(limits)
  const reset = resetMs(limit)
  if (!ask || limit === undefined || reset === null) return
  // Marked first: a failed send must not repeat every five seconds.
  s.bridge.weeklyWindow = windowKey(reset)
  await save($, s)
  const sent = await attempt(
    () => $.prompt.submit({ text: handoffText(limit.percentUsed, reset, now) }),
    undefined,
  )
  $.ui.toast(
    sent === undefined || 'drop' in sent
      ? 'cache-keeper: the weekly handoff message was not accepted'
      : `cache-keeper: weekly quota at ${limit.percentUsed}%, handoff document requested`,
  )
}

// The quota bridge, once per tick: wrap up near the end of the 5-hour window,
// resume once it has reset. Only the main thread is ever messaged.
const bridgeStep = async (
  $: EngineInterface,
  s: Session,
  now: number,
): Promise<void> => {
  const b = s.bridge
  if (b.phase === 'wrapped') {
    if (!s.keeper.enabled) {
      b.phase = 'idle'
      await save($, s)

      return
    }
    const verdict = resumeVerdict(b, now, await limitsNow($), config.bridgeAtPercent)
    if (verdict === 'wait') return
    b.phase = 'idle'
    await save($, s)
    if (verdict === 'resume') {
      const sent = await attempt(
        () => $.prompt.submit({ text: resumeText() }),
        undefined,
      )
      if (sent === undefined || 'drop' in sent) {
        $.ui.toast('cache-keeper: the resume message was not accepted')
      } else {
        $.ui.toast('cache-keeper: quota reset, session resumed')
      }
    }

    return
  }
  if (!s.keeper.enabled || !config.bridgeEnabled) return
  s.keeper.ttl = effectiveTtl(s.requested.ttl, s.observed)
  const limits = await limitsNow($)
  const wrap = shouldWrap({
    isEnabled: s.keeper.enabled,
    isBridgeOn: config.bridgeEnabled,
    isRunActive: s.run !== null,
    bridge: b,
    limits,
    now,
    lastRealAt: s.lastRealAt,
    ttl: s.keeper.ttl,
    atPercent: config.bridgeAtPercent,
    isBackgroundBusy: isBackgroundBusy(s.backgroundPending, s.backgroundSeenAt, now),
  })
  if (!wrap || s.keeper.cachedPrefixTokens < config.minCacheReadTokens) return
  const limit = fiveHour(limits)
  const reset = resetMs(limit)
  if (limit === undefined || reset === null) return
  // Marked first: a failed send must not repeat every five seconds.
  s.bridge = {
    phase: 'wrapped',
    window: limit.resetsAt ?? null,
    resetAtMs: reset,
    wrapAt: now,
    isTakenOver: false,
    wrappedAtPercent: limit.percentUsed,
    weeklyWindow: b.weeklyWindow,
  }
  await save($, s)
  const sent = await attempt(
    () => $.prompt.submit({ text: wrapText(limit.percentUsed, reset, now) }),
    undefined,
  )
  if (sent === undefined || 'drop' in sent) {
    s.bridge.phase = 'idle'
    await save($, s)
    $.ui.toast('cache-keeper: the wrap-up message was not accepted')
  } else {
    $.ui.toast(
      `cache-keeper: 5h quota at ${limit.percentUsed}%, wrap-up sent, keeping the cache warm until the reset`,
    )
  }
}

const barText = (s: Session, now: number): string => {
  const anchor = s.isAnchor ? ' · 锚点' : ''
  if (!s.keeper.enabled) {
    return `缓存保活：关${anchor}${s.stopNote === null ? '' : `（${s.stopNote}）`}`
  }
  syncKeeper(s)
  const bridge =
    s.bridge.phase === 'wrapped' ? ` · ${describeBridge(s.bridge, now)}` : ''
  const view = unboundedView(s.keeper, config, {
    isUnboundedBudget: s.isAnchor,
    isPastStopLine: s.isAnchor,
  })
  const decision = decide(view.keeper, now, view.config, [])
  const coarse: Decision =
    decision.action === 'wait' && decision.dueInMs !== undefined
      ? { ...decision, dueInMs: Math.ceil(decision.dueInMs / 15_000) * 15_000 }
      : decision

  return `缓存保活：开${anchor} · ${describeKeeper(s.keeper, coarse)}${bridge}`
}

const refreshBar = async ($: EngineInterface, s: Session): Promise<void> => {
  const text = barText(s, await $.clock.now())
  if ((await read($, barAtom)) !== text) await update($, barAtom, () => text)
  const cache = cacheStateOf(s.keeper, s.bridge.phase)
  if (JSON.stringify(await read($, cacheAtom)) !== JSON.stringify(cache)) {
    await update($, cacheAtom, () => cache)
  }
}

const setEnabled = async ($: EngineInterface, isOn: boolean): Promise<void> => {
  const s = await ensure($)
  s.keeper.enabled = isOn
  s.isEnabledDecided = true
  s.stopNote = null
  if (isOn) s.keeper.consecutiveFailures = 0
  else s.bridge.phase = 'idle'
  await save($, s)
  await refreshBar($, s)
}

const setAnchor = async ($: EngineInterface, isOn: boolean): Promise<void> => {
  const s = await ensure($)
  s.isAnchor = isOn
  s.isAnchorExpiryNoted = false
  if (isOn && !s.keeper.enabled) await setEnabled($, true)
  await save($, s)
  await refreshBar($, s)
}

const tick = async ($: EngineInterface): Promise<void> => {
  if (isTicking) return
  isTicking = true
  try {
    const s = await ensure($)
    const now = await $.clock.now()
    syncKeeper(s)
    if (s.run !== null) {
      await advanceRun($, s, s.run, now)
    } else {
      await handoffStep($, s, now)
      await bridgeStep($, s, now)
      const bridged = s.bridge.phase === 'wrapped'
      // Waiting on background work counts as working: its notice wakes the
      // session, and a warm cache makes that resume cheap, so pings are not
      // capped by the idle budget while it is out.
      const isWaitingOnWork = isBackgroundBusy(s.backgroundPending, s.backgroundSeenAt, now)
      // Bridged: pings run until the reset, past the idle cap and past the usual percent stop line.
      // An anchor is held the same way: that is its whole purpose.
      const { keeper, config: cfg } = unboundedView(s.keeper, config, {
        isUnboundedBudget: bridged || isWaitingOnWork || s.isAnchor,
        isPastStopLine: bridged || s.isAnchor,
      })
      let decision = decide(keeper, now, cfg, [])
      if (
        s.isAnchor &&
        !s.isAnchorExpiryNoted &&
        decision.action === 'wait' &&
        decision.reason === 'expired'
      ) {
        s.isAnchorExpiryNoted = true
        $.ui.toast(
          'cache-keeper: anchor cache expired, send any message here to re-arm it',
        )
      }
      if (
        decision.action === 'fire' &&
        bridged &&
        s.keeper.lastActivityAt !== null &&
        s.keeper.ttl !== null &&
        !needsPing(s.bridge, s.keeper.lastActivityAt, s.keeper.ttl)
      ) {
        decision = { action: 'wait', reason: 'not-due' }
      }
      if (decision.action === 'fire' && now < s.forkRetryAt) {
        decision = { action: 'wait', reason: 'no-fork-yet' }
      }
      if (decision.action === 'fire') {
        decision = decide(keeper, now, cfg, await limitsNow($))
      }
      if (decision.action === 'fire') {
        const usage = await attempt(() => $.session.usage(), undefined)
        if (hasShrunk(usage?.context.tokens, s.keeper.cachedPrefixTokens)) {
          s.keeper.pausedReason = 'compacted'
          await save($, s)
          decision = { action: 'wait', reason: 'paused' }
        }
      }
      if (decision.action === 'stop') {
        stopKeeper($, s, decision.reason)
        await save($, s)
      } else if (decision.action === 'fire') {
        await probe($, s, undefined, 'keepalive')
      }
      await keepAgents($, s, await $.clock.now())
    }
    showStatus($, s, await $.clock.now())
    await refreshBar($, s)
  } catch (error) {
    debug($, error)
  } finally {
    isTicking = false
  }
}

const statusText = async ($: EngineInterface, s: Session): Promise<string> => {
  const now = await $.clock.now()
  syncKeeper(s)
  const usage = await attempt(() => $.session.usage(), undefined)
  const view = unboundedView(s.keeper, config, {
    isUnboundedBudget: s.isAnchor,
    isPastStopLine: s.isAnchor,
  })
  const decision = decide(view.keeper, now, view.config, usage?.rateLimits ?? [])
  const idle =
    s.keeper.lastActivityAt === null
      ? 'no request seen yet'
      : `idle ${minutes(now - s.keeper.lastActivityAt)}`
  const budget =
    view.keeper.idleKeepaliveBudget === null
      ? 'unbounded'
      : `${view.keeper.idleKeepaliveBudget}${config.maxIdleKeepalives > 0 ? '' : ' (API break-even)'}`
  const meter =
    usage === undefined || usage.rateLimits.length === 0
      ? 'no reading (not a subscription, or no response yet)'
      : usage.rateLimits
          .map(limit => `${limit.kind} ${limit.percentUsed}%`)
          .join(' · ')
  const lines = [
    `keeper ${s.keeper.enabled ? 'on' : 'off'}${s.stopNote === null ? '' : ` (stopped: ${s.stopNote})`} · ${describeKeeper(s.keeper, decision)}`,
    `anchor ${s.isAnchor ? 'on (keepalives unbounded; expiry still ends them)' : 'off'}`,
    `Claude Code ${s.version} · model ${s.model} · effort ${s.effort || 'unknown'}`,
    `TTL requested: ${s.requested.ttl ?? 'automatic'} (${s.requested.reason}) · observed in transcript: ${s.observed ?? 'not yet'} · scheduling by: ${s.keeper.ttl ?? 'unknown'}`,
    `cached prefix: ${s.keeper.cachedPrefixTokens} tokens (minimum ${config.minCacheReadTokens}) · ${idle}`,
    `keepalives this idle stretch: ${s.keeper.idleKeepalives} of ${budget} · hits ${s.keeperHits} · misses ${s.keeperMisses}`,
    agentsText(s, now).split('\n')[0] ?? '',
    `meter: ${meter}`,
    describeBridge(s.bridge, now),
    `background: ${s.backgroundPending} in flight${s.backgroundSeenAt === null ? '' : `, last seen ${minutes(now - s.backgroundSeenAt)} ago`}`,
    `transcript: ${s.transcriptPath ?? 'not seen yet (known after the first turn ends)'}`,
    `data: ${config.dataDir}`,
  ]
  if (isTtlMismatch(s.requested.ttl, s.observed)) {
    lines.push('TTL_CONFIG_MISMATCH: the transcript shows a different TTL than requested')
  }
  if (s.run !== null) lines.push(`experiment: ${runStatus(s, s.run, now)}`)

  return lines.join('\n')
}

const preflight = async ($: EngineInterface, s: Session): Promise<string> => {
  const now = await $.clock.now()
  const usage = await attempt(() => $.session.usage(), undefined)
  const others = await otherSessionsSince($, s, now - 600_000)
  const held = usage?.context.tokens ?? 0
  const node = await attempt(() => $.process.run(['node', '--version']), undefined)
  const mark = (isOk: boolean): string => (isOk ? 'ok  ' : 'WARN')
  const hasMeter = usage !== undefined && usage.rateLimits.length > 0

  return [
    `${mark(isAtLeast(s.version, MIN_VERSION))} Claude Code ${s.version} (TTL variables need ${MIN_VERSION.join('.')}+)`,
    `${mark(s.requested.ttl !== null)} TTL requested: ${s.requested.ttl ?? 'automatic'} (${s.requested.reason})${s.requested.ttl === null ? ' - start the session with CLAUDE_CODE_PROMPT_CACHE_TTL=5m or 1h for an A/B cell' : ''}`,
    `${mark(true)} model ${s.model} · effort ${s.effort || 'known after the first request'}`,
    `${mark(hasMeter)} usage meter: ${hasMeter ? usage.rateLimits.map(limit => `${limit.kind} ${limit.percentUsed}%`).join(' · ') : 'no reading yet (a subscription reports one after its first response)'}`,
    `${mark(held === 0)} fresh session: ${held} tokens of context so far`,
    `${mark(others.length === 0)} other Claude Code sessions with this mod active in the last 10 minutes: ${others.length === 0 ? 'none' : others.join(', ')} (claude.ai web and mobile use cannot be seen from here)`,
    `${mark(s.run === null)} experiment in progress: ${s.run === null ? 'none' : s.run.experimentId}`,
    `${mark(node?.exitCode === 0)} node for the large-transcript fallback: ${node?.exitCode === 0 ? node.stdout.trim() : 'not found'}`,
    `${mark(true)} transcript: ${s.transcriptPath ?? 'known after the first turn ends'}`,
  ].join('\n')
}

// A fresh session has no meter reading until its first response, and the meter
// is the account's, not the session's: the reading the last session with this
// mod left behind is this run's start, while it is at most two minutes old.
const meterBaseline = async ($: EngineInterface): Promise<RateLimit[]> => {
  const known = await limitsNow($)
  if (known.length > 0) return known
  const left = await attempt(() => $.store.get(METER_KEY), undefined)
  if (!isRecord(left) || !Array.isArray(left.limits)) return []
  const age = (await $.clock.now()) - numberOf(left.at, 0)

  return age <= METER_CARRY_MS ? (left.limits as RateLimit[]) : []
}

const rememberMeter = async (
  $: EngineInterface,
  at: number,
  limits: readonly RateLimit[],
): Promise<void> => {
  if (limits.length === 0) return
  await attempt(() => $.store.set(METER_KEY, { at, limits: [...limits] }), undefined)
}

const planList = (): string =>
  [
    'Usage: /cache-keeper experiment <preflight|abort|plan> [tokens=60000] [force]',
    ...PLANS.map(
      plan =>
        `  ${plan.name.padEnd(15)} ${plan.id.padEnd(16)} ${minutes(planDurationSec(plan) * 1000)} min${plan.requiresTtl === null ? '' : ` · needs TTL ${plan.requiresTtl}`} · ${plan.title}`,
    ),
  ].join('\n')

const startRun = async (
  $: EngineInterface,
  s: Session,
  plan: Plan,
  words: readonly string[],
): Promise<string> => {
  const isForced = words.includes('force')
  const asked = words.find(word => word.startsWith('tokens='))
  const fixtureTokens = Math.min(
    400_000,
    Math.max(2_000, numberOf(Number(asked?.slice(7)), DEFAULT_FIXTURE_TOKENS)),
  )
  if (s.run !== null) {
    return `${s.run.experimentId} is running; /cache-keeper experiment abort ends it.`
  }
  if (plan.requiresTtl !== null && s.requested.ttl !== plan.requiresTtl && !isForced) {
    return `${plan.id} needs a session started with CLAUDE_CODE_PROMPT_CACHE_TTL=${plan.requiresTtl} (this one: ${s.requested.ttl ?? 'automatic'}). Add "force" to run anyway.`
  }
  // Fresh until the model has answered once: the context window has no fill.
  // A count of prompts would not do, since the command that starts a run may be one.
  const held = await attempt(
    async () => (await $.session.usage()).context.tokens ?? 0,
    0,
  )
  if (held > 0 && !isForced) {
    return `Each cell needs a fresh session and this one already holds ${held} tokens of context. Start a new session, or add "force" (the run is then not comparable).`
  }
  const meterStart = await meterBaseline($)
  const now = await $.clock.now()
  const ttl = s.requested.ttl ?? 'automatic'
  const counter = `rep:${plan.id}:${ttl}`
  const replicate = numberOf(await attempt(() => $.store.get(counter), 0), 0) + 1
  await attempt(() => $.store.set(counter, replicate), undefined)
  s.run = {
    plan: plan.name,
    experimentId: plan.id,
    replicate,
    nonce: `${s.id.slice(0, 8)}-${now.toString(36)}`,
    requestedAt: now,
    startedAt: null,
    next: 0,
    isInFlight: false,
    meterStart,
    contamination: held > 0 ? ['not a fresh session'] : [],
    warnings: meterStart.length === 0 ? ['METER_START_MISSING'] : [],
    steps: [],
    fixtureTokens,
  }
  await save($, s)

  return [
    `${plan.id} r${replicate} · TTL ${ttl} · about ${minutes(planDurationSec(plan) * 1000)} min · ${plan.steps.length} steps · filler ${fixtureTokens} tokens`,
    plan.title,
    'Starting within a few seconds. Until it finishes, leave this session alone and use the account nowhere else: any other request moves the usage meter and the run is then marked contaminated.',
  ].join('\n')
}

const writeReport = async ($: EngineInterface, s: Session): Promise<string> => {
  await reconcile($, s)
  await flush($, s)
  const raw = `${config.dataDir}/raw`
  const entries = await attempt(() => $.fs.list(raw), [])
  const events: EventRow[] = []
  const runs: RunRecord[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (/^events-.+\.jsonl$/.test(entry.name)) {
      events.push(
        ...parseJsonl<EventRow>(await attempt(() => $.fs.read(`${raw}/${entry.name}`), '')),
      )
    } else if (/^run-.+\.json$/.test(entry.name)) {
      const run = await attempt(
        async () => JSON.parse(await $.fs.read(`${raw}/${entry.name}`)) as RunRecord,
        undefined,
      )
      if (run !== undefined) runs.push(run)
    }
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const summary = summarize(events, runs, iso(await $.clock.now()))
  const written: string[] = []
  if (config.writeCsv) {
    await $.fs.write(`${config.dataDir}/cache-events.csv`, toCsv(events))
    written.push('cache-events.csv')
  }
  if (config.writeJson) {
    await $.fs.write(
      `${config.dataDir}/experiment-summary.json`,
      `${JSON.stringify(summary, null, 2)}\n`,
    )
    written.push('experiment-summary.json')
  }
  await $.fs.write(`${config.dataDir}/cache-report.md`, renderReport(summary))
  written.push('cache-report.md')

  return [
    `Wrote ${written.join(', ')} to ${config.dataDir} (${events.length} events, ${runs.length} runs).`,
    `Conclusion type ${summary.conclusion.category}: ${summary.conclusion.text}`,
  ].join('\n')
}

const runCommand = async ($: EngineInterface, args: string): Promise<string> => {
  const s = await ensure($)
  const [sub = 'status', ...words] = args.trim().split(/\s+/).filter(Boolean)
  if (sub === 'start') {
    s.keeper.enabled = true
    s.isEnabledDecided = true
    s.keeper.consecutiveFailures = 0
    s.stopNote = null
    await save($, s)
    return statusText($, s)
  }
  if (sub === 'stop') {
    s.keeper.enabled = false
    s.isEnabledDecided = true
    s.stopNote = null
    s.bridge.phase = 'idle'
    await save($, s)
    return statusText($, s)
  }
  if (sub === 'status') return statusText($, s)
  if (sub === 'anchor') {
    if (words[0] === 'on' || words[0] === 'off') await setAnchor($, words[0] === 'on')
    else if (words[0] !== undefined) return 'Usage: /cache-keeper anchor [on|off]'

    return `anchor ${s.isAnchor ? 'on' : 'off'} · keeper ${s.keeper.enabled ? 'on' : 'off'}`
  }
  if (sub === 'probe') {
    if (s.run !== null) return 'An experiment is running; it places its own probes.'
    const row = await probe($, s, undefined, 'manual probe')
    const moved = row.rate_limits_after
      .map(after => {
        const before = row.rate_limits_before.find(one => one.kind === after.kind)
        return `${after.kind} ${before?.percentUsed ?? '?'}% -> ${after.percentUsed}%`
      })
      .join(' · ')
    return [
      `probe: ${row.result}${row.notes === 'manual probe' ? '' : ` (${row.notes})`}`,
      `cache read ${row.cache_read_input_tokens} · cache write ${row.cache_creation_input_tokens} · input ${row.input_tokens} · output ${row.output_tokens}`,
      `API-equivalent ${row.api_equivalent_usd === null ? 'unpriced' : `$${row.api_equivalent_usd.toFixed(4)}`} (${row.cost_basis}) · meter ${moved || 'no reading'}`,
    ].join('\n')
  }
  if (sub === 'experiment') {
    const [name, ...rest] = words
    if (name === 'preflight') return preflight($, s)
    if (name === 'abort') {
      if (s.run === null) return 'No experiment is running.'
      await abortRun($, s, 'asked to')
      return 'Experiment aborted; its rows stay in the event log.'
    }
    const plan = name === undefined ? undefined : planNamed(name)
    return plan === undefined ? planList() : startRun($, s, plan, rest)
  }
  if (sub === 'report') return writeReport($, s)
  if (sub === 'agents') {
    const now = await $.clock.now()
    if (words[0] !== 'ping') return agentsText(s, now)
    // Every tracked subagent now, whatever its size or schedule.
    const sent: string[] = []
    for (const id of [...s.agents.keys()]) {
      sent.push(`  ${id}: ${await pingAgent($, s, id, now)}`)
    }

    return sent.length === 0 ? 'No subagent is tracked.' : sent.join('\n')
  }

  return 'Usage: /cache-keeper start | stop | status | anchor [on|off] | probe | agents [ping] | experiment <name> | report'
}

export const register: Register = (on, options) => {
  config = readConfig(options)
  booting = undefined
  carriedEnabled = undefined
  timer = undefined
  isTicking = false

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const text = await read($, barAtom)
    if (text === '') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>{text} </Text>
        <Button key="keeper-on" label="开启保活" onPress={() => setEnabled($, true)} />
        <Text> </Text>
        <Button key="keeper-off" label="关闭保活" onPress={() => setEnabled($, false)} />
        <Text> </Text>
        <Button key="anchor-on" label="设为锚点" onPress={() => setAnchor($, true)} />
        <Text> </Text>
        <Button key="anchor-off" label="取消锚点" onPress={() => setAnchor($, false)} />
      </Box>
    )
  })

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Prompt-cache keeper: start, stop, status, anchor, probe, agents, experiment, report',
        argumentHint: 'start|stop|status|anchor [on|off]|probe|agents [ping]|experiment <name>|report',
      })
      const s = await ensure($)
      timer?.cancel()
      timer = $.clock.every(TICK_MS, () => void tick($))
      showStatus($, s, await $.clock.now())
    } catch (error) {
      debug($, error)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    try {
      return { text: await runCommand($, e.args) }
    } catch (error) {
      return { text: `cache-keeper: ${messageOf(error)}` }
    }
  })

  // A pinged subagent's notice of finishing would start a turn of the main
  // model to read "OK": it stops here.
  on('prompt.submit', async ($, e, next) => {
    try {
      if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
        const s = await ensure($)
        s.lastRealAt = await $.clock.now()
        s.keeper.idleKeepalives = 0
        // Only the person typing is a takeover: a plugin's own message (the wrap-up itself, a finished background job) is not.
        if (s.bridge.phase === 'wrapped' && e.origin.kind === 'composer') s.bridge.isTakenOver = true
        await save($, s)
      }
      if (e.origin.kind === 'task-notification' && booting !== undefined) {
        const s = await booting
        for (const id of s.quiet.keys()) {
          if (!e.text.includes(id)) continue
          s.quiet.delete(id)

          return { drop: `cache-keeper kept subagent ${id.slice(0, 8)} warm` }
        }
      }
      // A finished background task answers its notice: one less still out.
      if (e.origin.kind === 'task-notification') {
        const s = await ensure($)
        if (s.backgroundPending > 0) {
          s.backgroundPending -= 1
          await save($, s)
        }
      }
    } catch (error) {
      debug($, error)
    }

    return next(e)
  })

  // A background Bash or Agent call of the main thread leaves the thread quiet
  // while its work runs, so no message marks the session as worked in. Counted
  // here until its task-notification comes back (see prompt.submit).
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    try {
      const isBackground = (e as { run_in_background?: unknown }).run_in_background === true
      if (e.agentId === undefined && isBackground && (e.tool === 'Bash' || e.tool === 'Agent')) {
        const s = await ensure($)
        s.backgroundPending += 1
        s.backgroundSeenAt = await $.clock.now()
        await save($, s)
      }
    } catch (error) {
      debug($, error)
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    try {
      const s = await ensure($)
      s.keeper.isTurnRunning = true
      const pending = s.pending
      if (pending !== null) {
        const now = await $.clock.now()
        if (e.text.includes(pending.marker) || now - pending.since < 3_000) {
          s.tags.set(e.turnId, pending)
          s.pending = null
        }
      }
    } catch (error) {
      debug($, error)
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let seen: { s: Session; startedAt: number; before: RateLimit[] } | undefined
    try {
      const s = await ensure($)
      seen = { s, startedAt: await $.clock.now(), before: await limitsNow($) }
    } catch (error) {
      debug($, error)
    }
    const result = yield* next(e)
    if (seen === undefined || result.usage === null) return result
    try {
      const { s, startedAt, before } = seen
      const { model, ...usage } = result.usage
      const endedAt = await $.clock.now()
      const after = await attempt(() => $.session.usage(), undefined)
      const isMain = e.agentId === undefined
      const tag = isMain ? s.tags.get(e.turnId) : undefined
      const effort = e.effort === undefined ? '' : String(e.effort)
      let note = ''
      if (isMain) {
        const isChanged =
          s.baseline !== null &&
          (s.baseline.model !== e.model || s.baseline.effort !== effort)
        if (isChanged) {
          s.keeper.pausedReason = 'model or effort changed'
          if (s.run !== null) contaminate(s.run, 'model or effort changed')
        } else if (
          s.keeper.pausedReason !== null &&
          usage.cache_read_input_tokens > 0 &&
          classifyUsage(usage) !== 'miss'
        ) {
          s.keeper.pausedReason = null
        }
        s.baseline = { model: e.model, effort }
        s.model = model
        s.effort = effort
        s.keeper.lastActivityAt = startedAt
        s.lastRealAt = startedAt
        s.keeper.cachedPrefixTokens =
          usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        s.keeper.idleKeepalives = 0
        s.keeper.consecutiveFailures = 0
        s.isAnchorExpiryNoted = false
        if (s.run !== null && tag === undefined) {
          contaminate(s.run, 'a turn outside the experiment ran')
        }
      } else {
        if (s.run !== null) contaminate(s.run, 'a subagent ran')
        note = agentStepped(s, e.agentId ?? '', startedAt, model, usage)
      }
      s.rows.push(
        rowOf(
          s,
          {
            kind: 'step',
            timestamp: iso(startedAt),
            source: !isMain ? 'subagent' : tag === undefined ? 'user' : 'benchmark',
            model,
            effort,
            result: classifyUsage(usage),
            turn_id: e.turnId,
            step_index: e.index,
            agent_id: e.agentId ?? '',
            rate_limits_before: before,
            rate_limits_after: after === undefined ? [] : [...after.rateLimits],
            context_tokens: after?.context.tokens ?? null,
            context_window: after?.context.window ?? null,
            duration_ms: endedAt - startedAt,
            ...(note === '' ? {} : { notes: note }),
          },
          usage,
          tag,
        ),
      )
      await flush($, s)
      await rememberMeter($, endedAt, after?.rateLimits ?? [])
      if (endedAt - s.heartbeatAt > 20_000) {
        s.heartbeatAt = endedAt
        await attempt(() => $.store.set(`hb:${s.id}`, { at: endedAt }), undefined)
      }
      await save($, s)
    } catch (error) {
      debug($, error)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      try {
        const s = await ensure($)
        agentFinished($, s, e.agentId)
        await save($, s)
      } catch (error) {
        debug($, error)
      }

      return result
    }
    try {
      const s = await ensure($)
      s.keeper.isTurnRunning = false
      await reconcile($, s)
      const tag = s.tags.get(e.turnId)
      if (tag !== undefined) {
        s.tags.delete(e.turnId)
        if (s.run !== null) await stepDone($, s, s.run, tag, e.turnId, e.reason)
      }
      await save($, s)
    } catch (error) {
      debug($, error)
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    try {
      if (e.changed.includes('rateLimits')) {
        const s = await ensure($)
        s.rows.push(
          rowOf(
            s,
            {
              kind: 'meter',
              timestamp: iso(await $.clock.now()),
              source: 'meter',
              rate_limits_after: [...e.rateLimits],
              context_tokens: e.context.tokens ?? null,
              context_window: e.context.window,
            },
            ZERO_USAGE,
            undefined,
          ),
        )
        await flush($, s)
      }
    } catch (error) {
      debug($, error)
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    try {
      const isMain = e.agentId === undefined && e.trigger !== 'precompute'
      if (isMain && !('skip' in result)) {
        const s = await ensure($)
        s.keeper.pausedReason = 'compacted'
        if (s.run !== null) contaminate(s.run, 'the conversation was compacted')
        await save($, s)
      }
    } catch (error) {
      debug($, error)
    }

    return result
  })

  // A compaction another mod answered never reaches the hook above when that
  // mod sits over this one: the boundary row the engine then stores does.
  on('session.append', { door: 'compaction' }, async ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        const s = await ensure($)
        if (s.keeper.pausedReason === null) {
          s.keeper.pausedReason = 'compacted'
          await save($, s)
        }
      }
    } catch (error) {
      debug($, error)
    }

    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    try {
      const s = await ensure($)
      if (s.transcriptPath !== e.transcript_path) {
        s.transcriptPath = e.transcript_path
        await save($, s)
      }
      // The session's own list of background work still out: it corrects the
      // count from launches and notices, and covers Bash calls that moved to the
      // background on their own.
      const now = await $.clock.now()
      const inFlight = countInFlight(Array.isArray(e.background_tasks) ? e.background_tasks : [])
      if (inFlight > 0 || s.backgroundPending > 0) {
        s.backgroundPending = inFlight
        if (inFlight > 0) s.backgroundSeenAt = now
        await save($, s)
      }
    } catch (error) {
      debug($, error)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      if (booting !== undefined) {
        const s = await booting
        await flush($, s)
        await save($, s)
        if (e.reason === 'clear') {
          // The process goes on under a new session id with no cache prefix:
          // the keeper stays on and waits for a new baseline.
          carriedEnabled = s.keeper.enabled
          booting = undefined
        }
      }
    } catch (error) {
      debug($, error)
    }

    return next(e)
  })
}
