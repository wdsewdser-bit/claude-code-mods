// The engine wiring of effort-auto: one tool the model calls to raise its own
// thinking effort for a few requests — its description is the whole rule set —
// and one hook that puts the level on each model request of the main session.
// Everything that decides anything lives in `lib/effort.ts`.

import type { EngineInterface, Register, TurnStepResult } from 'claude-code'

import {
  DEFAULT_STEPS,
  DEFAULTS,
  ENV,
  ERROR_REMINDER,
  configOf,
  decide,
  failureOf,
  fresh,
  isRaise,
  noteFailure,
  noteSuccess,
  raise,
  rulesOf,
} from './lib/effort.ts'
import type { Config, Level, Source, TurnState } from './lib/effort.ts'

const TOOL_NAME = 'effort'
const TOOL_FULL = 'mcp__effort-auto__effort'
const OWN_PREFIX = 'mcp__effort-auto__'

/** The single tool: its description carries the whole rule set, every request. */
const toolOf = (config: Config) => ({
  name: TOOL_NAME,
  description: rulesOf(config),
  inputSchema: {
    type: 'object',
    properties: {
      level: {
        type: 'string',
        enum: ['medium', 'high', 'xhigh'],
        description: '目标档位。low 是常驻档，不需要用工具声明。',
      },
      steps: {
        type: 'integer',
        minimum: 1,
        description: `升档持续多少个请求，默认 ${DEFAULT_STEPS}；high 及以上一次最多 ${config.maxHighSteps} 步。`,
      },
      reason: {
        type: 'string',
        description: '一句话说明为什么需要升档（可选，写进日志）。',
      },
    },
    required: ['level'],
  },
  isDeferred: false as const,
})

/** The tool arguments ride on `e` beside the engine's envelope keys. */
const ENVELOPE = ['tool', 'tool_use_id', 'consent', 'agentId', 'agent', 'requestMeta'] as const

const argsOf = (e: unknown): Readonly<Record<string, unknown>> => {
  const args: Record<string, unknown> = { ...(e as Record<string, unknown>) }
  for (const key of ENVELOPE) delete args[key]

  return args
}

const messageOf = (problem: unknown): string =>
  problem instanceof Error ? problem.message : String(problem)

const attempt = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await run()
  } catch {
    return fallback
  }
}

const logError = ($: EngineInterface, where: string, problem: unknown): void => {
  try {
    $.ui.log(`effort-auto: ${where}: ${messageOf(problem)}`, { to: 'debug' })
  } catch {
    // A log that fails must not become the failure.
  }
}

const stepsOf = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return undefined

  return Math.floor(value)
}

const reasonOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const reason = value.trim()

  return reason === '' ? undefined : reason
}

let config: Config = { ...DEFAULTS }
let enabled = false
let mainTurnId: string | undefined
// The session's own effort; anything but low means effort-auto stands aside.
let baseEffort: string | undefined
let sessionId = ''
let logPath = ''

const states = new Map<string, TurnState>()

// The log is one JSONL file, appended to by rewriting it: `$.fs` has no append.
let logRows: string[] = []
let logLoaded = false
let logQueue: Promise<void> = Promise.resolve()

const stateOf = (turnId: string): TurnState => {
  const held = states.get(turnId)
  if (held !== undefined) return held
  const restart: TurnState = { ...fresh(), source: 'default' }
  states.set(turnId, restart)

  return restart
}

const appendRow = async ($: EngineInterface, row: Record<string, unknown>): Promise<void> => {
  if (logPath === '') return
  logQueue = logQueue
    .then(async () => {
      if (!logLoaded) {
        logLoaded = true
        const existing: unknown = await attempt(async () => await $.fs.read(logPath), '')
        if (typeof existing === 'string' && existing !== '') {
          logRows = existing.endsWith('\n') ? existing.slice(0, -1).split('\n') : existing.split('\n')
        }
      }
      logRows.push(JSON.stringify(row))
      await $.fs.write(logPath, `${logRows.join('\n')}\n`)
    })
    .catch(error => logError($, 'log', error))
  await logQueue
}

const thinkingOf = (usage: unknown): number | null => {
  const record = usage as Record<string, unknown> | null
  if (record === null) return null
  for (const key of ['thinking_tokens', 'thinkingTokens', 'reasoning_tokens']) {
    const value = record[key]
    if (typeof value === 'number') return value
  }

  return null
}

type StepFacts = {
  effort: Level
  source: Source
  raises: number
  reason?: string
  reminder: boolean
}

/** One line per request: the level it used, why, and what the request cost. */
const note = async (
  $: EngineInterface,
  e: { turnId: string; index: number; model: string },
  facts: StepFacts,
  result: TurnStepResult,
): Promise<void> => {
  try {
    const usage = result.usage
    await appendRow($, {
      at: new Date().toISOString(),
      sessionId,
      turnId: e.turnId,
      step: e.index,
      effort: facts.effort,
      source: facts.source,
      raises: facts.raises,
      ...(facts.reason === undefined ? {} : { reason: facts.reason }),
      reminder: facts.reminder,
      usage:
        usage === null
          ? null
          : {
              output: usage.output_tokens,
              thinking_tokens: thinkingOf(usage),
            },
    })
  } catch (error) {
    logError($, 'note', error)
  }
}

/** Attaches the reminder to a tool result the model reads on its next request. */
const withReminder = <T>(result: T, text: string): T => {
  const answer = result as Record<string, unknown> | null
  if (answer === null || answer.deny !== undefined) return result
  const context = Array.isArray(answer.context) ? (answer.context as unknown[]) : []

  return { ...answer, context: [...context, text] } as T
}

// `$.env.get` takes a literal name, so every variable is read by its own line.
const envOf = async ($: EngineInterface): Promise<Record<string, string | undefined>> => {
  const env: Record<string, string | undefined> = {}
  env[ENV.enabled] = await attempt(async () => await $.env.get('EFFORT_AUTO'), undefined)
  env[ENV.maxRaises] = await attempt(async () => await $.env.get('EFFORT_AUTO_MAX_RAISES'), undefined)
  env[ENV.maxHighSteps] = await attempt(async () => await $.env.get('EFFORT_AUTO_MAX_HIGH_STEPS'), undefined)
  env[ENV.logPath] = await attempt(async () => await $.env.get('EFFORT_AUTO_LOG'), undefined)

  return env
}

const homeOf = async ($: EngineInterface): Promise<string> => {
  const profile = await attempt(async () => await $.env.get('USERPROFILE'), undefined)
  const raw =
    typeof profile === 'string' && profile !== ''
      ? profile
      : await attempt(async () => await $.env.get('HOME'), undefined)

  return typeof raw === 'string' ? raw.replace(/[\\/]+$/, '') : ''
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // A fresh session reads its configuration and starts with no state of its own.
    states.clear()
    mainTurnId = undefined
    baseEffort = undefined
    logRows = []
    logLoaded = false
    logQueue = Promise.resolve()
    try {
      config = configOf(options as unknown as Record<string, unknown>, await envOf($))
      enabled = config.enabled
      if (enabled) {
        sessionId = await attempt(async () => await $.session.id(), '')
        const home = await homeOf($)
        const dir = home === '' ? '.claude/effort-auto' : `${home}/.claude/effort-auto`
        logPath =
          config.logPath !== ''
            ? config.logPath
            : `${dir}/steps-${sessionId === '' ? 'session' : sessionId}.jsonl`
        await $.tool.register(toolOf(config))
      }
    } catch (error) {
      logError($, 'session.start', error)
    }

    return next(e)
  })

  // A new user message: back to low, with the turn's counts cleared.
  on('turn.start', async ($, e, next) => {
    if (!enabled) return next(e)
    states.set(e.turnId, fresh())
    if (states.size > 64) {
      const oldest = states.keys().next()
      if (!oldest.done && oldest.value !== e.turnId) states.delete(oldest.value)
    }

    return next(e)
  })

  // The model's own tool: it raises the requests that follow this one.
  on('tool.call', { tool: TOOL_FULL as never }, async ($, e) => {
    if (!enabled) return { result: 'effort-auto 未启用。', isError: true as const }
    const call = e as unknown as Record<string, unknown>
    if (call.agentId !== undefined) {
      return { result: 'effort 只作用于主会话：子代理不升档。', isError: true as const }
    }
    if (baseEffort !== undefined && baseEffort !== 'low') {
      return { result: `当前基础档位是 ${baseEffort}，自适应思考只在 low 时生效，不需要升档。` }
    }
    const input = argsOf(e)
    if (!isRaise(input.level)) {
      return { result: 'level 必须是 medium、high 或 xhigh 之一；low 是常驻档，不需要声明。', isError: true as const }
    }
    if (mainTurnId === undefined) {
      return { result: '当前没有进行中的回合，无法升档。', isError: true as const }
    }
    const turnId = mainTurnId
    const outcome = raise(
      stateOf(turnId),
      { level: input.level, steps: stepsOf(input.steps), reason: reasonOf(input.reason) },
      config,
    )
    states.set(turnId, outcome.state)
    if (!outcome.ok) {
      return {
        result: `本轮已升档 ${config.maxRaises} 次，达到上限，本次忽略，仍按当前档位继续。把剩下的判断做完，下一步直接执行。`,
      }
    }
    const held = outcome.held ? `（high 及以上一次最多 ${config.maxHighSteps} 步）` : ''

    return { result: `已升到 ${outcome.level}，作用于接下来 ${outcome.steps} 个请求，之后自动回到 low${held}。` }
  })

  // Every other tool's outcome: only a run of failures matters, and only for
  // the main conversation — a subagent's tools are not counted or annotated.
  on('tool.call', async ($, e, next) => {
    if (!enabled) return next(e)
    const result = await next(e)
    try {
      if (e.agentId !== undefined) return result
      if (String(e.tool).startsWith(OWN_PREFIX)) return result
      const turnId = mainTurnId
      if (turnId === undefined) return result
      if (baseEffort !== 'low') return result
      const state = stateOf(turnId)
      if (!failureOf(String(e.tool), result)) {
        states.set(turnId, noteSuccess(state))

        return result
      }
      const failed = noteFailure(state)
      states.set(turnId, failed.state)

      return failed.remind ? withReminder(result, ERROR_REMINDER) : result
    } catch (error) {
      logError($, 'tool.call', error)

      return result
    }
  })

  // One model request of the main conversation: the raise in force, else low.
  on('turn.step', async function* ($, e, next) {
    if (!enabled) return yield* next(e)
    // A subagent's loop is left exactly as it came.
    if (e.agentId !== undefined) return yield* next(e)
    mainTurnId = e.turnId
    // A model without effort takes no change at all.
    if (e.effort === undefined) return yield* next(e)
    baseEffort = String(e.effort)
    // Only a session resting on low is adapted; medium and above run as set.
    if (e.effort !== 'low') return yield* next(e)

    const state = stateOf(e.turnId)
    const decision = decide(state)
    states.set(e.turnId, decision.state)
    const result = yield* next({ ...e, effort: decision.effort })
    await note(
      $,
      e,
      {
        effort: decision.effort,
        source: decision.source,
        raises: decision.state.raises,
        ...(state.override?.reason === undefined ? {} : { reason: state.override.reason }),
        reminder: state.remind,
      },
      result,
    )

    return result
  })
}
