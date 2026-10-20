import type { RateLimit } from './keeper.ts'

export type EventRow = {
  kind: 'step' | 'keeper' | 'meter' | 'shadow' | 'recovery'
  timestamp: string
  experiment_id: string
  replicate: number | null
  session_id: string
  source: 'user' | 'benchmark' | 'keeper' | 'subagent' | 'meter' | 'shadow' | 'recovery'
  model: string
  effort: string
  claude_code_version: string
  ttl_requested: string
  ttl_observed: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  ephemeral_5m_input_tokens: number | null
  ephemeral_1h_input_tokens: number | null
  cache_miss_reason: string
  context_tokens: number | null
  context_window: number | null
  rate_limits_before: RateLimit[]
  rate_limits_after: RateLimit[]
  api_equivalent_usd: number | null
  cost_basis: string
  contaminated: boolean
  notes: string
  result: string
  turn_id: string
  step_index: number | null
  agent_id: string
  duration_ms: number | null
  /** Shadow mode only: this row records a keepalive that was not sent. */
  shadow_would_have?: boolean
  /** Shadow mode only: the prefix a would-have keepalive would have read. */
  shadow_prefix_tokens?: number
  /** Shadow mode only: seconds from the previous real request to this one. */
  shadow_recovery_sec?: number | null
  /** Shadow mode only: the 1-based would-have keepalive in its idle stretch. */
  shadow_keepalive_index?: number
  /** Shadow mode only: the TTL the decision was made against. */
  shadow_ttl?: string
  /** Shadow mode only: when the last would-have keepalive was due, in ms. */
  shadow_last_would_have_at?: number | null
}

export type RunStep = {
  kind: string
  plannedSec: number
  actualSec: number | null
  result: string
  cacheRead: number
  cacheCreation: number
}

export type RunRecord = {
  experiment_id: string
  plan: string
  replicate: number
  ttl_requested: string
  ttl_reason: string
  ttl_observed: string
  session_id: string
  model: string
  effort: string
  claude_code_version: string
  started_at: string
  ended_at: string
  meter_start: RateLimit[]
  meter_end: RateLimit[]
  contaminated: boolean
  contamination: string[]
  warnings: string[]
  transcript_path: string | null
  fixture_tokens: number
  steps: RunStep[]
}

const CSV_COLUMNS = [
  'timestamp',
  'experiment_id',
  'replicate',
  'session_id',
  'source',
  'model',
  'effort',
  'claude_code_version',
  'ttl_requested',
  'ttl_observed',
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'ephemeral_5m_input_tokens',
  'ephemeral_1h_input_tokens',
  'cache_miss_reason',
  'context_tokens',
  'context_window',
  'rate_limits_before_json',
  'rate_limits_after_json',
  'api_equivalent_usd',
  'contaminated',
  'notes',
  'result',
  'cost_basis',
  'shadow_would_have',
  'shadow_prefix_tokens',
  'shadow_recovery_sec',
  'shadow_keepalive_index',
  'shadow_ttl',
  'shadow_last_would_have_at',
] as const

const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  const cell = String(value)

  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
}

export const toCsv = (rows: readonly EventRow[]): string => {
  const lines = rows.map(row => {
    const flat: Record<string, unknown> = {
      ...row,
      rate_limits_before_json: JSON.stringify(row.rate_limits_before),
      rate_limits_after_json: JSON.stringify(row.rate_limits_after),
    }

    return CSV_COLUMNS.map(column => csvCell(flat[column])).join(',')
  })

  return `${[CSV_COLUMNS.join(','), ...lines].join('\n')}\n`
}

export const parseJsonl = <T>(jsonl: string): T[] => {
  const rows: T[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line) as T)
    } catch {
      // a row cut short by a crash mid-write
    }
  }

  return rows
}

/**
 * How far each window moved between two meter readings. A window that reset
 * in between has no difference worth reading: null.
 */
export const meterDelta = (
  before: readonly RateLimit[],
  after: readonly RateLimit[],
): Record<string, number | null> => {
  const delta: Record<string, number | null> = {}
  for (const end of after) {
    const start = before.find(limit => limit.kind === end.kind)
    if (start === undefined) continue
    delta[end.kind] =
      start.resetsAt === end.resetsAt
        ? Math.round((end.percentUsed - start.percentUsed) * 10) / 10
        : null
  }

  return delta
}

type Spread = {
  mean: number | null
  min: number | null
  max: number | null
  n: number
  sum: number
  /** Sample variance; 0 for fewer than two values. */
  variance: number
}

const spread = (values: readonly number[]): Spread => {
  if (values.length === 0) {
    return { mean: null, min: null, max: null, n: 0, sum: 0, variance: 0 }
  }
  const sum = values.reduce((total, value) => total + value, 0)
  const mean = sum / values.length
  const squares = values.reduce((total, value) => total + (value - mean) ** 2, 0)

  return {
    mean,
    min: Math.min(...values),
    max: Math.max(...values),
    n: values.length,
    sum,
    variance: values.length > 1 ? squares / (values.length - 1) : 0,
  }
}

export type RunSummary = {
  replicate: number
  session_id: string
  apiEquivalentUsd: number
  rateLimitDelta: Record<string, number | null>
  finalStep: string
  ttlObserved: string
  status: 'clean' | 'contaminated' | 'ttl-mismatch'
}

export type CellSummary = {
  experiment: string
  ttl: string
  /** Clean runs: the only ones the totals and the comparisons count. */
  n: number
  excludedRuns: number
  totals: {
    cacheRead: number
    cacheWrite5m: number
    cacheWrite1h: number
    cacheWriteUnsplit: number
    input: number
    output: number
    apiEquivalentUsd: number
  }
  apiEquivalentUsdPerRun: Spread
  rateLimitDelta: Record<string, Spread>
  cacheHitRate: number | null
  runs: RunSummary[]
  warnings: string[]
}

const cellTtl = (run: RunRecord): string =>
  run.ttl_requested === '5m' || run.ttl_requested === '1h'
    ? run.ttl_requested
    : run.ttl_observed || 'automatic'

const statusOf = (run: RunRecord): RunSummary['status'] => {
  if (run.warnings.includes('TTL_CONFIG_MISMATCH')) return 'ttl-mismatch'

  return run.contaminated ? 'contaminated' : 'clean'
}

const summarizeCell = (
  experiment: string,
  ttl: string,
  runs: readonly RunRecord[],
  events: readonly EventRow[],
): CellSummary => {
  const totals = {
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteUnsplit: 0,
    input: 0,
    output: 0,
    apiEquivalentUsd: 0,
  }
  const warnings = new Set<string>()
  const summaries: RunSummary[] = []
  const deltas: Record<string, number[]> = {}
  const costs: number[] = []
  for (const run of runs) {
    const status = statusOf(run)
    const rows = events.filter(
      row =>
        row.kind !== 'meter' &&
        row.session_id === run.session_id &&
        row.experiment_id === run.experiment_id &&
        row.replicate === run.replicate,
    )
    const usd = rows.reduce((sum, row) => sum + (row.api_equivalent_usd ?? 0), 0)
    const delta = meterDelta(run.meter_start, run.meter_end)
    summaries.push({
      replicate: run.replicate,
      session_id: run.session_id,
      apiEquivalentUsd: usd,
      rateLimitDelta: delta,
      finalStep: run.steps.at(-1)?.result ?? '',
      ttlObserved: run.ttl_observed,
      status,
    })
    for (const warning of run.warnings) warnings.add(warning)
    if (status !== 'clean') {
      for (const cause of run.contamination) warnings.add(`contaminated: ${cause}`)
      continue
    }
    costs.push(usd)
    for (const [kind, moved] of Object.entries(delta)) {
      if (moved === null) warnings.add(`METER_WINDOW_RESET: ${kind}`)
      else (deltas[kind] ??= []).push(moved)
    }
    for (const row of rows) {
      totals.cacheRead += row.cache_read_input_tokens
      totals.input += row.input_tokens
      totals.output += row.output_tokens
      totals.apiEquivalentUsd += row.api_equivalent_usd ?? 0
      if (row.api_equivalent_usd === null) warnings.add('UNPRICED_MODEL')
      if (row.ephemeral_5m_input_tokens === null) {
        totals.cacheWriteUnsplit += row.cache_creation_input_tokens
        if (row.cache_creation_input_tokens > 0) {
          warnings.add('UNSPLIT_CACHE_WRITES: priced at the assumed TTL')
        }
      } else {
        totals.cacheWrite5m += row.ephemeral_5m_input_tokens
        totals.cacheWrite1h += row.ephemeral_1h_input_tokens ?? 0
      }
    }
  }
  const prompt =
    totals.cacheRead +
    totals.cacheWrite5m +
    totals.cacheWrite1h +
    totals.cacheWriteUnsplit +
    totals.input

  return {
    experiment,
    ttl,
    n: costs.length,
    excludedRuns: runs.length - costs.length,
    totals,
    apiEquivalentUsdPerRun: spread(costs),
    rateLimitDelta: Object.fromEntries(
      Object.entries(deltas).map(([kind, values]) => [kind, spread(values)]),
    ),
    cacheHitRate: prompt === 0 ? null : totals.cacheRead / prompt,
    runs: summaries,
    warnings: [...warnings].sort(),
  }
}

export type ApiVerdict = 'a' | 'b' | 'tie' | 'insufficient'

export type MeterVerdict =
  | 'a'
  | 'b'
  | 'unclear'
  | 'insufficient-replicates'
  | 'insufficient-resolution'

export type Comparison = {
  id: string
  title: string
  a: { label: string; experiment: string; ttl: string }
  b: { label: string; experiment: string; ttl: string }
  api: { verdict: ApiVerdict; a: Spread; b: Spread }
  meter: {
    verdict: MeterVerdict
    byKind: Record<string, { a: Spread; b: Spread }>
  }
}

const COMPARISONS = [
  {
    id: 'W',
    title: '只写缓存（建缓存 + 1 次 probe）：5m 写入 vs 1h 写入',
    a: { label: '5m', experiment: 'A-ttl', ttl: '5m' },
    b: { label: '1h', experiment: 'A-ttl', ttl: '1h' },
  },
  {
    id: 'C1',
    title: '高频 active coding（约 3 分钟一次请求）：5m vs 1h',
    a: { label: '5m', experiment: 'C1-active', ttl: '5m' },
    b: { label: '1h', experiment: 'C1-active', ttl: '1h' },
  },
  {
    id: 'C2',
    title: '间歇 coding（约 10 分钟一次请求）：5m vs 1h',
    a: { label: '5m', experiment: 'C2-intermittent', ttl: '5m' },
    b: { label: '1h', experiment: 'C2-intermittent', ttl: '1h' },
  },
  {
    id: 'D-keeper',
    title: 'idle 18 分钟：5m + keeper vs 5m 无 keeper',
    a: { label: '5m+keeper', experiment: 'D2-keeper', ttl: '5m' },
    b: { label: '5m 无 keeper', experiment: 'D1-idle', ttl: '5m' },
  },
  {
    id: 'D-1h',
    title: 'idle 18 分钟：5m + keeper vs 1h 无 keeper',
    a: { label: '5m+keeper', experiment: 'D2-keeper', ttl: '5m' },
    b: { label: '1h 无 keeper', experiment: 'D1-idle', ttl: '1h' },
  },
] as const

/** The replicates a meter verdict needs on each side. */
export const MIN_REPLICATES = 3
/** The percentage points a cell's runs must move a window by, in all, for its meter to say anything. */
export const MIN_METER_POINTS = 2
// The meter reports whole points, so one run's delta is off by up to a point
// either way. Runs that all read the same are not that exact: their variance
// is held to at least what rounding alone gives a difference of two readings.
const ROUNDING_VARIANCE = 0.25
/** How many standard errors apart two cells' mean deltas must be to call one cheaper. */
const MIN_SEPARATION = 2.5

const EMPTY: Spread = { mean: null, min: null, max: null, n: 0, sum: 0, variance: 0 }

const compare = (
  spec: (typeof COMPARISONS)[number],
  cells: readonly CellSummary[],
): Comparison => {
  const cellOf = (side: { experiment: string; ttl: string }) =>
    cells.find(
      cell => cell.experiment === side.experiment && cell.ttl === side.ttl,
    )
  const a = cellOf(spec.a)
  const b = cellOf(spec.b)
  const costA = a?.apiEquivalentUsdPerRun ?? EMPTY
  const costB = b?.apiEquivalentUsdPerRun ?? EMPTY
  let api: ApiVerdict = 'insufficient'
  if (costA.mean !== null && costB.mean !== null) {
    if (costA.mean < costB.mean * 0.97) api = 'a'
    else if (costB.mean < costA.mean * 0.97) api = 'b'
    else api = 'tie'
  }

  const kinds = new Set([
    ...Object.keys(a?.rateLimitDelta ?? {}),
    ...Object.keys(b?.rateLimitDelta ?? {}),
  ])
  const byKind: Comparison['meter']['byKind'] = {}
  const decided = new Set<'a' | 'b'>()
  let hasReplicates = false
  let hasResolution = false
  for (const kind of kinds) {
    const sideA = a?.rateLimitDelta[kind] ?? EMPTY
    const sideB = b?.rateLimitDelta[kind] ?? EMPTY
    byKind[kind] = { a: sideA, b: sideB }
    if (sideA.n < MIN_REPLICATES || sideB.n < MIN_REPLICATES) continue
    hasReplicates = true
    if (Math.max(sideA.sum, sideB.sum) < MIN_METER_POINTS) continue
    hasResolution = true
    const error = Math.sqrt(
      Math.max(sideA.variance, ROUNDING_VARIANCE) / sideA.n +
        Math.max(sideB.variance, ROUNDING_VARIANCE) / sideB.n,
    )
    const apart = ((sideB.mean ?? 0) - (sideA.mean ?? 0)) / error
    if (apart >= MIN_SEPARATION) decided.add('a')
    else if (apart <= -MIN_SEPARATION) decided.add('b')
  }
  let meter: MeterVerdict = 'unclear'
  if (!hasReplicates) meter = 'insufficient-replicates'
  else if (!hasResolution) meter = 'insufficient-resolution'
  else if (decided.size === 1) meter = [...decided][0] ?? 'unclear'

  return {
    id: spec.id,
    title: spec.title,
    a: spec.a,
    b: spec.b,
    api: { verdict: api, a: costA, b: costB },
    meter: { verdict: meter, byKind },
  }
}

export type Conclusion = { category: 1 | 2 | 3 | 4 | 5; text: string }

const conclude = (comparisons: readonly Comparison[]): Conclusion => {
  const rhythm = comparisons.filter(one => one.id === 'C1' || one.id === 'C2')
  if (rhythm.every(one => one.api.verdict === 'insufficient')) {
    return {
      category: 5,
      text: '数据不足，无法判断：C1/C2 还没有可比较的 5m 与 1h 干净 run。',
    }
  }
  const api = new Set(
    rhythm.map(one => one.api.verdict).filter(v => v === 'a' || v === 'b'),
  )
  const meter = new Set(
    rhythm.map(one => one.meter.verdict).filter(v => v === 'a' || v === 'b'),
  )
  const isMeterBlind = rhythm.every(one =>
    one.meter.verdict.startsWith('insufficient'),
  )
  if (isMeterBlind) {
    const writes = comparisons.find(one => one.id === 'W')?.meter.verdict
    const onWrites =
      writes === 'a'
        ? '只写缓存的对比（W）里，meter 显示 5m 写入比 1h 写入省。'
        : writes === 'b'
          ? '只写缓存的对比（W）里，meter 显示 1h 写入比 5m 写入省。'
          : writes === 'unclear'
            ? '只写缓存的对比（W）里，meter 没有显示出 5m 与 1h 写入的显著差异。'
            : ''

    return {
      category: 5,
      text: `C1/C2 上 Pro meter 的分辨率或重复次数不足，暂不能按工作节奏判断哪种 TTL 更省套餐额度；API 等价成本见下表，但不能替代 meter 结论。${onWrites}`,
    }
  }
  if (api.size > 1 || meter.size > 1) {
    return { category: 4, text: '结果随工作节奏而变化：见各对比的分项结论。' }
  }
  if (meter.has('b')) {
    return { category: 3, text: '1h 更便宜：Pro meter 在已判定的工作节奏下偏向 1h。' }
  }
  if (meter.has('a')) {
    return api.has('b')
      ? { category: 4, text: 'API 等价成本与 Pro meter 的结论相反：见各对比的分项结论。' }
      : { category: 1, text: '5m 在 API 等价成本和 Pro meter 两边都更便宜（限已判定的工作节奏）。' }
  }
  if (api.has('a')) {
    return { category: 2, text: '5m 只在 API 等价成本上更便宜，Pro meter 无显著优势。' }
  }

  return {
    category: api.has('b') ? 3 : 2,
    text: api.has('b')
      ? '1h 在 API 等价成本上更便宜；Pro meter 无显著差异。'
      : 'API 等价成本与 Pro meter 均无显著差异。',
  }
}

export type ObservationRow = {
  session_id: string
  source: string
  ttl: string
  requests: number
  cacheRead: number
  cacheWrite: number
  input: number
  output: number
  apiEquivalentUsd: number
}

export type Summary = {
  generatedAt: string
  counts: { events: number; runs: number }
  cells: CellSummary[]
  comparisons: Comparison[]
  conclusion: Conclusion
  observation: ObservationRow[]
}

export const summarize = (
  events: readonly EventRow[],
  runs: readonly RunRecord[],
  generatedAt: string,
): Summary => {
  const groups = new Map<string, RunRecord[]>()
  for (const run of runs) {
    const key = `${run.experiment_id}\u0000${cellTtl(run)}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [run])
    else group.push(run)
  }
  const cells = [...groups.entries()]
    .map(([key, group]) => {
      const [experiment = '', ttl = ''] = key.split('\u0000')

      return summarizeCell(experiment, ttl, group, events)
    })
    .sort((x, y) => `${x.experiment}${x.ttl}`.localeCompare(`${y.experiment}${y.ttl}`))
  const comparisons = COMPARISONS.map(spec => compare(spec, cells))

  const observed = new Map<string, ObservationRow>()
  for (const row of events) {
    if (row.kind === 'meter' || row.kind === 'shadow' || row.kind === 'recovery') continue
    if (row.experiment_id !== '') continue
    const ttl = row.ttl_observed || row.ttl_requested
    const key = `${row.session_id}\u0000${row.source}\u0000${ttl}`
    const entry = observed.get(key) ?? {
      session_id: row.session_id,
      source: row.source,
      ttl,
      requests: 0,
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      apiEquivalentUsd: 0,
    }
    entry.requests += 1
    entry.cacheRead += row.cache_read_input_tokens
    entry.cacheWrite += row.cache_creation_input_tokens
    entry.input += row.input_tokens
    entry.output += row.output_tokens
    entry.apiEquivalentUsd += row.api_equivalent_usd ?? 0
    observed.set(key, entry)
  }

  return {
    generatedAt,
    counts: { events: events.length, runs: runs.length },
    cells,
    comparisons,
    conclusion: conclude(comparisons),
    observation: [...observed.values()],
  }
}

const usd = (value: number | null): string =>
  value === null ? '-' : `$${value.toFixed(4)}`

const points = (value: Spread): string =>
  value.mean === null
    ? '-'
    : `${value.mean.toFixed(1)} (${value.min}~${value.max}, n=${value.n})`

const API_WORDS: Record<ApiVerdict, string> = {
  a: 'A 更便宜',
  b: 'B 更便宜',
  tie: '差异小于 3%',
  insufficient: '数据不足',
}

const METER_WORDS: Record<MeterVerdict, string> = {
  a: 'A 更省',
  b: 'B 更省',
  unclear: '区间重叠，无显著差异',
  'insufficient-replicates': `每侧不足 ${MIN_REPLICATES} 次干净重复，无法判断`,
  'insufficient-resolution': `该组各 run 的 meter 累计变化不足 ${MIN_METER_POINTS} 个百分点，分辨率不足`,
}

const table = (head: readonly string[], rows: readonly (readonly string[])[]): string =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')

export const renderReport = (summary: Summary): string => {
  const parts: string[] = [
    '# cache-keeper 报告',
    '',
    `生成时间：${summary.generatedAt}；事件 ${summary.counts.events} 条，实验 run ${summary.counts.runs} 个。`,
    '',
    '## 结论',
    '',
    `**类型 ${summary.conclusion.category}：${summary.conclusion.text}**`,
    '',
    '两种成本分开报告：API 等价成本按官方 API 单价由日志算出；套餐额度只看 `$.session.usage().rateLimits` 的真实百分比增量，不由 API 价格推算。',
    '',
    '## 对比',
    '',
  ]
  for (const one of summary.comparisons) {
    parts.push(
      `### ${one.id}：${one.title}`,
      '',
      `A = ${one.a.label}（${one.a.experiment}），B = ${one.b.label}（${one.b.experiment}）`,
      '',
      table(
        ['成本口径', 'A', 'B', '判定'],
        [
          [
            'API 等价 USD / run',
            `${usd(one.api.a.mean)} (n=${one.api.a.n})`,
            `${usd(one.api.b.mean)} (n=${one.api.b.n})`,
            API_WORDS[one.api.verdict],
          ],
          ...Object.entries(one.meter.byKind).map(([kind, sides]) => [
            `套餐 meter ${kind} 增量（百分点）`,
            points(sides.a),
            points(sides.b),
            METER_WORDS[one.meter.verdict],
          ]),
          ...(Object.keys(one.meter.byKind).length === 0
            ? [['套餐 meter', '-', '-', METER_WORDS[one.meter.verdict]]]
            : []),
        ],
      ),
      '',
    )
  }

  parts.push('## 实验 cell', '')
  if (summary.cells.length === 0) parts.push('还没有完成的实验 run。', '')
  for (const cell of summary.cells) {
    parts.push(
      `### ${cell.experiment} · TTL ${cell.ttl}`,
      '',
      `干净 run ${cell.n} 个，排除 ${cell.excludedRuns} 个；cache 命中率 ${
        cell.cacheHitRate === null ? '-' : `${(cell.cacheHitRate * 100).toFixed(1)}%`
      }；API 等价合计 ${usd(cell.totals.apiEquivalentUsd)}。`,
      '',
      table(
        ['replicate', 'session', '状态', 'TTL 实测', '末步结果', 'API 等价 USD', 'meter 增量'],
        cell.runs.map(run => [
          String(run.replicate),
          run.session_id.slice(0, 8),
          run.status,
          run.ttlObserved || '-',
          run.finalStep || '-',
          usd(run.apiEquivalentUsd),
          Object.entries(run.rateLimitDelta)
            .map(([kind, moved]) => `${kind} ${moved ?? 'reset'}`)
            .join('; ') || '-',
        ]),
      ),
      '',
      table(
        ['cache read', '5m write', '1h write', '未拆分 write', 'input', 'output'],
        [
          [
            String(cell.totals.cacheRead),
            String(cell.totals.cacheWrite5m),
            String(cell.totals.cacheWrite1h),
            String(cell.totals.cacheWriteUnsplit),
            String(cell.totals.input),
            String(cell.totals.output),
          ],
        ],
      ),
      '',
    )
    if (cell.warnings.length > 0) {
      parts.push(...cell.warnings.map(warning => `- 警告：${warning}`), '')
    }
  }

  parts.push('## 日常观察（非实验请求）', '')
  parts.push(
    summary.observation.length === 0
      ? '无。'
      : table(
          ['session', '来源', 'TTL', '请求数', 'cache read', 'cache write', 'input', 'output', 'API 等价 USD'],
          summary.observation.map(row => [
            row.session_id.slice(0, 8),
            row.source,
            row.ttl,
            String(row.requests),
            String(row.cacheRead),
            String(row.cacheWrite),
            String(row.input),
            String(row.output),
            usd(row.apiEquivalentUsd),
          ]),
        ),
    '',
  )

  return parts.join('\n')
}
