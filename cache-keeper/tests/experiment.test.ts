import { describe, expect, test } from 'claude-code/testing'

import { buildFiller, PLANS } from '../hooks/lib/experiment.ts'
import { meterDelta, summarize, toCsv } from '../hooks/lib/report.ts'
import type { EventRow, RunRecord } from '../hooks/lib/report.ts'
import { boot, command, events, fileAt, turn, usage, world } from './world.ts'
import type { World } from './world.ts'

const FIVE = { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }
const LONG = { timeoutMs: 20_000 }

const runFile = (w: World, name: string): RunRecord =>
  JSON.parse(fileAt(w, `.cache-keeper/raw/${name}`) ?? 'null') as RunRecord

describe('experiment runner', () => {
  test('B-renew: build, two keepalives, a probe, then a clean run record', LONG, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    expect(await command($, 'experiment renew')).toContain('B-renew r1 · TTL 5m')

    await w.clock.advance(5_000)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('[cache-keeper:build:')
    expect(w.submitted[0]?.length).toBeGreaterThan(200_000)
    w.stepUsage = usage(0, 70_000)
    await turn($, 't1', w.submitted[0] ?? '')

    await w.clock.advance(235_000)
    expect(w.forks).toHaveLength(0)
    await w.clock.advance(5_000)
    expect(w.forks).toHaveLength(1)
    await w.clock.advance(240_000)
    expect(w.forks).toHaveLength(2)
    await w.clock.advance(235_000)
    expect(w.submitted).toHaveLength(1)
    await w.clock.advance(5_000)
    expect(w.submitted[1]).toContain('[cache-keeper:probe:')
    w.stepUsage = usage(70_000, 40)
    await turn($, 't2', w.submitted[1] ?? '')
    await w.clock.advance(5_000)

    const run = runFile(w, 'run-B-renew-5m-r1-aaaaaaaa.json')
    expect(run).toMatchObject({
      experiment_id: 'B-renew',
      replicate: 1,
      ttl_requested: '5m',
      ttl_reason: 'env',
      contaminated: false,
      claude_code_version: '2.1.288',
    })
    expect(run.steps.map(step => [step.kind, step.actualSec, step.result])).toEqual([
      ['build', 0, 'miss'],
      ['keeper', 240, 'hit'],
      ['keeper', 480, 'hit'],
      ['probe', 720, 'hit'],
    ])
    expect(run.meter_start).toHaveLength(1)
    expect(run.meter_end).toHaveLength(1)
    expect(run.warnings).toContain('TTL_UNVERIFIED: no transcript split for the build request')

    const tagged = events(w).filter(row => row.experiment_id === 'B-renew')
    expect(tagged.map(row => row.source)).toEqual(['benchmark', 'keeper', 'keeper', 'benchmark'])
    expect(tagged.every(row => row.replicate === 1 && row.contaminated === false)).toBe(true)
    expect(w.toasts.at(-1)).toContain('B-renew r1 finished (clean)')
  })

  test('a fresh session starts from the meter reading the last session left', LONG, async ($, on) => {
    const reading = [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-06T05:00:00Z' }]
    const w = world(on, FIVE)
    w.limits = []
    w.store.set('meter:last', { at: w.clock.now() - 30_000, limits: reading })
    await boot($)
    await command($, 'experiment ttl')
    await w.clock.advance(5_000)
    w.limits = [{ ...reading[0], kind: 'five_hour', percentUsed: 42 }]
    w.stepUsage = usage(0, 70_000)
    await turn($, 't1', w.submitted[0] ?? '')
    await w.clock.advance(90_000)
    w.stepUsage = usage(70_000, 40)
    await turn($, 't2', w.submitted[1] ?? '')
    await w.clock.advance(5_000)

    const run = runFile(w, 'run-A-ttl-5m-r1-aaaaaaaa.json')
    expect(run.meter_start).toEqual(reading)
    expect(run.meter_end[0]?.percentUsed).toBe(42)
    expect(run.warnings).not.toContain('METER_START_MISSING')
    expect(w.store.get('meter:last')).toMatchObject({ limits: [{ percentUsed: 42 }] })
  })

  test('a reading too old to trust is no start at all', LONG, async ($, on) => {
    const w = world(on, FIVE)
    w.limits = []
    w.store.set('meter:last', {
      at: w.clock.now() - 300_000,
      limits: [{ kind: 'five_hour', percentUsed: 40 }],
    })
    await boot($)
    await command($, 'experiment ttl')
    await w.clock.advance(5_000)
    w.stepUsage = usage(0, 70_000)
    await turn($, 't1', w.submitted[0] ?? '')
    await w.clock.advance(90_000)
    await turn($, 't2', w.submitted[1] ?? '')
    await w.clock.advance(5_000)
    expect(runFile(w, 'run-A-ttl-5m-r1-aaaaaaaa.json').warnings).toContain('METER_START_MISSING')
  })

  test('refuses a plan the session TTL cannot run, and a used session', LONG, async ($, on) => {
    const w = world(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
    await boot($)
    expect(await command($, 'experiment renew')).toContain('needs a session started with')
    w.contextTokens = 48_000
    expect(await command($, 'experiment ttl')).toContain('needs a fresh session')
    await w.clock.advance(10_000)
    expect(w.submitted).toHaveLength(0)
  })

  test('marks a run contaminated by a subagent and by another session', LONG, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await command($, 'experiment ttl')
    await w.clock.advance(5_000)
    w.stepUsage = usage(0, 70_000)
    await turn($, 't1', w.submitted[0] ?? '')
    await turn($, 'sub1', '', 'agent-7')
    w.store.set('hb:bbbbbbbb-2222', { at: w.clock.now() })
    await w.clock.advance(90_000)
    w.stepUsage = usage(70_000, 40)
    await turn($, 't2', w.submitted[1] ?? '')
    await w.clock.advance(5_000)

    const run = runFile(w, 'run-A-ttl-5m-r1-aaaaaaaa.json')
    expect(run.contaminated).toBe(true)
    expect(run.contamination).toEqual([
      'a subagent ran',
      'session bbbbbbbb made requests meanwhile',
    ])
    const tagged = events(w).filter(row => row.experiment_id === 'A-ttl')
    expect(tagged.every(row => row.contaminated === true)).toBe(true)
    expect(events(w).find(row => row.source === 'subagent')).toMatchObject({ agent_id: 'agent-7' })
  })

  test('report writes the csv, the summary and the markdown apart', LONG, async ($, on) => {
    const w = world(on, FIVE)
    await boot($)
    await command($, 'experiment ttl')
    await w.clock.advance(5_000)
    w.stepUsage = usage(0, 70_000)
    await turn($, 't1', w.submitted[0] ?? '')
    await w.clock.advance(90_000)
    w.stepUsage = usage(70_000, 40)
    await turn($, 't2', w.submitted[1] ?? '')
    await w.clock.advance(5_000)

    const text = await command($, 'report')
    expect(text).toContain('Conclusion type 5')
    expect(fileAt(w, '.cache-keeper/cache-events.csv')).toStartWith(
      'timestamp,experiment_id,replicate,session_id,source,model,effort,claude_code_version,ttl_requested,ttl_observed,input_tokens',
    )
    const summary = JSON.parse(fileAt(w, '.cache-keeper/experiment-summary.json') ?? '{}')
    expect(summary.cells[0]).toMatchObject({ experiment: 'A-ttl', ttl: '5m', n: 1 })
    const report = fileAt(w, '.cache-keeper/cache-report.md') ?? ''
    expect(report).toContain('API 等价 USD / run')
    expect(report).toContain('套餐 meter')
  })

  test('preflight costs nothing and names what is missing', LONG, async ($, on) => {
    const w = world(on)
    await boot($)
    const text = await command($, 'experiment preflight')
    expect(text).toContain('ok   Claude Code 2.1.288')
    expect(text).toContain('WARN TTL requested: automatic')
    expect(w.forks).toHaveLength(0)
    expect(w.submitted).toHaveLength(0)
  })
})

describe('plans and filler', () => {
  test('every plan builds first and the filler differs per run', () => {
    for (const plan of PLANS) expect(plan.steps[0]).toEqual({ atSec: 0, kind: 'build' })
    const one = buildFiller('run-a', 400)
    expect(one).toBe(buildFiller('run-a', 400))
    expect(one.split(/\s+/)).toHaveLength(400)
    expect(one.slice(0, 80)).not.toBe(buildFiller('run-b', 400).slice(0, 80))
  })
})

const event = (run: RunRecord, read: number, write5m: number, write1h: number, usd: number): EventRow => ({
  kind: 'step',
  timestamp: run.started_at,
  experiment_id: run.experiment_id,
  replicate: run.replicate,
  session_id: run.session_id,
  source: 'benchmark',
  model: 'claude-opus-5-5',
  effort: 'medium',
  claude_code_version: '2.1.288',
  ttl_requested: run.ttl_requested,
  ttl_observed: run.ttl_observed,
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write5m + write1h,
  ephemeral_5m_input_tokens: write5m,
  ephemeral_1h_input_tokens: write1h,
  cache_miss_reason: '',
  context_tokens: null,
  context_window: null,
  rate_limits_before: [],
  rate_limits_after: [],
  api_equivalent_usd: usd,
  cost_basis: 'split',
  contaminated: false,
  notes: 'probe',
  result: 'hit',
  turn_id: 't',
  step_index: 0,
  agent_id: '',
  duration_ms: 1,
})

const record = (
  experiment: string,
  ttl: string,
  replicate: number,
  moved: number,
  extra: Partial<RunRecord> = {},
): RunRecord => ({
  experiment_id: experiment,
  plan: 'x',
  replicate,
  ttl_requested: ttl,
  ttl_reason: 'env',
  ttl_observed: ttl,
  session_id: `${experiment}-${ttl}-${replicate}`,
  model: 'claude-opus-5-5',
  effort: 'medium',
  claude_code_version: '2.1.288',
  started_at: '2026-10-06T00:00:00.000Z',
  ended_at: '2026-10-06T00:40:00.000Z',
  meter_start: [{ kind: 'five_hour', percentUsed: 10, resetsAt: 'r' }],
  meter_end: [{ kind: 'five_hour', percentUsed: 10 + moved, resetsAt: 'r' }],
  contaminated: false,
  contamination: [],
  warnings: [],
  transcript_path: null,
  fixture_tokens: 60_000,
  steps: [{ kind: 'probe', plannedSec: 0, actualSec: 0, result: 'hit', cacheRead: 1, cacheCreation: 0 }],
  ...extra,
})

describe('summarize', () => {
  test('a window that reset gives no delta', () => {
    expect(
      meterDelta(
        [{ kind: 'five_hour', percentUsed: 80, resetsAt: 'a' }, { kind: 'seven_day', percentUsed: 5.5 }],
        [{ kind: 'five_hour', percentUsed: 2, resetsAt: 'b' }, { kind: 'seven_day', percentUsed: 7 }],
      ),
    ).toEqual({ five_hour: null, seven_day: 1.5 })
  })

  test('keeps API cost and meter apart, and excludes dirty runs', () => {
    const runs = [
      ...[1, 2, 3].map(n => record('C1-active', '5m', n, 3)),
      ...[1, 2, 3].map(n => record('C1-active', '1h', n, 5)),
      record('C1-active', '5m', 4, 40, { contaminated: true, contamination: ['a subagent ran'] }),
      record('C1-active', '1h', 4, 0, { warnings: ['TTL_CONFIG_MISMATCH'], ttl_observed: '5m' }),
    ]
    const rows = runs.map(run =>
      run.ttl_requested === '5m' ? event(run, 600_000, 60_000, 0, 0.42) : event(run, 600_000, 0, 60_000, 0.6),
    )
    const summary = summarize(rows, runs, '2026-10-06T01:00:00.000Z')
    const fiveMinutes = summary.cells.find(cell => cell.ttl === '5m')
    expect(fiveMinutes).toMatchObject({
      experiment: 'C1-active',
      n: 3,
      excludedRuns: 1,
      totals: { cacheRead: 1_800_000, cacheWrite5m: 180_000, cacheWrite1h: 0 },
    })
    expect(fiveMinutes?.rateLimitDelta.five_hour).toMatchObject({ mean: 3, n: 3 })
    expect(fiveMinutes?.warnings).toContain('contaminated: a subagent ran')

    const active = summary.comparisons.find(one => one.id === 'C1')
    expect(active?.api.verdict).toBe('a')
    expect(active?.meter.verdict).toBe('a')
    expect(summary.conclusion.category).toBe(1)
    expect(toCsv(rows).split('\n')).toHaveLength(rows.length + 2)
  })

  test('says the meter cannot tell when it barely moved or runs are few', () => {
    const few = [record('C1-active', '5m', 1, 3), record('C1-active', '1h', 1, 5)]
    const fewSummary = summarize(few.map(run => event(run, 1, 0, 0, 0.1)), few, 'now')
    const active = (summary: ReturnType<typeof summarize>) =>
      summary.comparisons.find(one => one.id === 'C1')?.meter.verdict
    expect(active(fewSummary)).toBe('insufficient-replicates')
    expect(fewSummary.conclusion.category).toBe(5)

    const flat = [
      ...[1, 2, 3].map(n => record('C1-active', '5m', n, 0)),
      ...[0, 1, 0].map((moved, index) => record('C1-active', '1h', index + 1, moved)),
    ]
    const flatSummary = summarize(flat.map(run => event(run, 1, 0, 0, 0.1)), flat, 'now')
    expect(active(flatSummary)).toBe('insufficient-resolution')
    expect(flatSummary.conclusion.category).toBe(5)
    expect(summarize([], [], 'now').conclusion.category).toBe(5)
  })

  test('many small runs add up: whole-point rounding is allowed for, not trusted', () => {
    const writes = (ttl: string, moved: readonly number[]) =>
      moved.map((points, index) => record('A-ttl', ttl, index + 1, points))
    const verdict = (five: readonly number[], hour: readonly number[]) => {
      const runs = [...writes('5m', five), ...writes('1h', hour)]

      return summarize(runs.map(run => event(run, 1, 0, 0, 0.1)), runs, 'now').comparisons.find(
        one => one.id === 'W',
      )?.meter.verdict
    }
    expect(verdict([1, 0, 1, 1, 0, 1], [1, 2, 1, 2, 2, 1])).toBe('a')
    expect(verdict([1, 0, 1, 1, 0, 1], [1, 1, 0, 1, 1, 1])).toBe('unclear')
    expect(verdict([0, 0, 0], [0, 1, 0])).toBe('insufficient-resolution')
  })
})
