// The engine wiring of dispatch-gate. Every decision lives in `lib/gate.ts`;
// this file only observes the engine, hands it the request or the call, and
// answers. Nothing here can throw into the engine: a broken hook walks the
// engine's own path, so the gate fails open.

import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  DEFAULTS,
  createState,
  judge,
  observeRequest,
  readConfig,
  remindText,
  resetStreak,
  usesOf,
  withEnv,
} from './lib/gate.ts'
import type { Config, State } from './lib/gate.ts'

/** The options the engine handed over at load, before the environment's own switch. */
let base: Config = DEFAULTS
/** What this session runs with. */
let config: Config = DEFAULTS
/** The streak and the hour window of this session. */
let state: State = createState()
/** The L1 reminder earned by the last main request, waiting for its batch to end. */
let pendingRemind = false

const messageOf = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem))

const attempt = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await run()
  } catch {
    return fallback
  }
}

/** A log that fails must not become the failure. */
const debug = ($: EngineInterface, text: string): void => {
  try {
    $.ui.log(`dispatch-gate: ${text}`, { to: 'debug' })
  } catch {
    // best effort
  }
}

/** The session's own configuration: the options, then the environment's switch. */
const configure = async ($: EngineInterface): Promise<Config> => {
  const gate = await attempt(() => $.env.get('DISPATCH_GATE'), undefined)
  const mode = await attempt(() => $.env.get('DISPATCH_GATE_MODE'), undefined)

  return withEnv(base, gate, mode)
}

export const register: Register = (on, options) => {
  base = readConfig(options as unknown as Readonly<Record<string, unknown>>)

  on('session.start', async ($, e, next) => {
    state = createState()
    pendingRemind = false
    config = await configure($)
    debug($, `mode=${config.mode} remindAt=${config.remindAt} denyAt=${config.denyAt} agentPerHour=${config.agentPerHour} grace=${config.grace}`)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    state = createState()
    pendingRemind = false

    return next(e)
  }).catch(($, e, next) => next(e))

  // A person's own message starts a new request: whatever the model was doing
  // on its own is over, and the gate's count goes with it.
  on('prompt.submit', async ($, e, next) => {
    resetStreak(state, config)
    pendingRemind = false

    return next(e)
  }).catch(($, e, next) => next(e))

  // Counting happens at the request, not at the tool call: the model's answer
  // says what this request is for, and one request is one unit however many
  // tools it calls in parallel.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      if (e.agentId === undefined && config.mode !== 'off') {
        const outcome = observeRequest(state, config, usesOf(result), `${e.turnId}:${e.index}`)
        if (outcome.remind) {
          pendingRemind = true
          debug($, `remind at streak ${state.streak}`)
        }
      }
    } catch (error) {
      debug($, `turn.step: ${messageOf(error)}`)
    }

    return result
  })

  // L1: one reminder per streak, injected once for the whole batch. It cannot
  // refuse anything, which is why the refusal lives at the tool call.
  on('classic.PostToolBatch', async ($, e, next) => {
    const forMain = (e as { agent_id?: unknown }).agent_id === undefined
    const remind = pendingRemind && forMain
    if (remind) pendingRemind = false
    const result = await next(e)
    if (!remind) return result
    try {
      const held = (result ?? {}) as { hookSpecificOutput?: Record<string, unknown> }

      return {
        ...held,
        hookSpecificOutput: {
          ...(held.hookSpecificOutput ?? {}),
          hookEventName: 'PostToolBatch',
          additionalContext: remindText(state.streak),
        },
      }
    } catch (error) {
      debug($, `PostToolBatch: ${messageOf(error)}`)

      return result
    }
  }).catch(($, e, next) => next(e))

  // Both refusals live here: the one Claude subagent per hour window, and the
  // one execution call per streak. A subagent's own calls are never gated.
  on('tool.call', async ($, e, next) => {
    try {
      if (e.agentId !== undefined) return next(e)
      if (config.mode === 'off') return next(e)
      const tool = String(e.tool)
      const now = await attempt(() => $.clock.now(), Date.now())
      const verdict = judge(state, config, tool, e as unknown as Readonly<Record<string, unknown>>, now)
      if (verdict.deny !== undefined) {
        debug($, `deny ${tool} (streak ${state.streak}, agents ${state.agentCalls.length})`)

        return { deny: verdict.deny }
      }
    } catch (error) {
      debug($, `tool.call: ${messageOf(error)}`)
    }

    return next(e)
  }).catch(($, e, next) => next(e))
}
