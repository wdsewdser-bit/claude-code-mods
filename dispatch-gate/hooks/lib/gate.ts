/**
 * The decisions of dispatch-gate, with no engine imports: the unit tests and the
 * offline replay drive this file directly.
 *
 * Counting is per request, not per tool call: one model request (one batch of
 * tool calls, however many) is one unit, because the cost of a request is the
 * whole prefix it carries.
 *
 * Two directions, both soft:
 *  - the main session doing too much itself: consecutive execution requests earn
 *    one reminder (L1) and, later, one refusal (L2) per streak;
 *  - the main session dispatching Claude subagents too fast: more than
 *    `agentPerHour` in a rolling hour earns one refusal per hour window.
 * A dispatch of either kind clears the self-work streak. Refusals never repeat
 * inside their own stretch: the model's retry always runs.
 */

export type Mode = 'off' | 'remind' | 'soft'

export type Config = {
  /** `off`: nothing; `remind`: only the L1 reminder; `soft`: L1 and both refusals. */
  mode: Mode
  /** Consecutive execution requests that earn the reminder, once per streak. */
  remindAt: number
  /** Consecutive execution requests that earn the refusal, once per streak. */
  denyAt: number
  /** Claude subagent dispatches allowed in one rolling hour. */
  agentPerHour: number
  /** Read-only acceptance requests after a dispatch that are free. */
  grace: number
}

export const DEFAULTS: Config = { mode: 'soft', remindAt: 4, denyAt: 8, agentPerHour: 3, grace: 3 }

/** The rolling window of the Claude-subagent limit. */
export const AGENT_WINDOW_MS = 3_600_000

/** One tool use of a request: the tool's name and the arguments it was given. */
export type Use = { tool: string; input: Readonly<Record<string, unknown>> }

/** A request's class; the highest present wins: dispatch > exec > book > other. */
export type Kind = 'dispatch' | 'exec' | 'book' | 'other'

/** Work the main session does itself. */
const EXEC = new Set([
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'PowerShell',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'BashOutput',
  'mcp__ptc-run__run_code',
])

/** Reading the work back after a dispatch: free while the acceptance grace lasts. */
const READ_ONLY = new Set(['Read', 'Grep', 'Glob'])

/** The tools that start or resume a Claude subagent. */
const CLAUDE_AGENT = new Set(['Agent', 'Task'])

/** Dispatching to DeepSeek: never limited, and it clears the self-work count. */
const DELEGATE = new Set(['mcp__delegate__delegate_flash', 'mcp__delegate__delegate_pro'])

/** The host's own bookkeeping: neither counted nor cleared. */
const BOOK = new Set([
  'mcp__ccd_turn__update_plan',
  'mcp__ccd_turn__wrap_up',
  'mcp__ctx-mod__context',
  'mcp__ctx-mod__history',
  'mcp__ctx-mod__ledger_append',
  'mcp__ctx-mod__ledger_read',
])

/** The tools whose input may be a main-session-only operation. */
const PROBE = new Set(['Bash', 'PowerShell', 'mcp__ptc-run__run_code'])

/**
 * A command that only the main session can run: a Claude probe, an interactive
 * debugger, or a browser. It is never counted and never refused.
 */
const MAIN_ONLY: readonly RegExp[] = [
  /\bclaude\b[^\n]*?(?:\s-p\b|\s--print\b|--version\b|--doctor\b)/,
  /--inspect(?:-brk)?\b/,
  /\bdebugpy\b/,
  /\bgdb\b/,
  /\blldb\b/,
  /\s-it\b/,
  /--interactive\b/,
  /\b(?:chrome|msedge|playwright)\b/,
]

export const isExecTool = (tool: string): boolean => EXEC.has(tool)
export const isClaudeAgent = (tool: string): boolean => CLAUDE_AGENT.has(tool)
export const isDelegate = (tool: string): boolean => DELEGATE.has(tool)
export const isBookTool = (tool: string): boolean => BOOK.has(tool)
export const isDispatchTool = (tool: string): boolean =>
  isClaudeAgent(tool) || isDelegate(tool) || tool === 'SendMessage'

/** Whether this tool use is a main-session-only operation, from its command or code. */
export const isMainOnly = (use: Use): boolean => {
  if (!PROBE.has(use.tool)) return false
  const command = use.input['command']
  const code = use.input['code']
  const text = typeof command === 'string' ? command : typeof code === 'string' ? code : ''
  if (text === '') return false

  return MAIN_ONLY.some(pattern => pattern.test(text))
}

/** Whether this tool use is work the main session does itself. */
export const isExec = (use: Use): boolean => EXEC.has(use.tool) && !isMainOnly(use)

/** The class of one request, from the tool uses the model answered with. */
export const classify = (uses: readonly Use[]): Kind => {
  if (uses.some(use => isDispatchTool(use.tool))) return 'dispatch'
  if (uses.some(use => isExec(use))) return 'exec'
  if (uses.some(use => isBookTool(use.tool))) return 'book'

  return 'other'
}

/** The tool uses of a `turn.step` result, however the engine spells them. */
export const usesOf = (result: unknown): Use[] => {
  const held = (result as { toolUses?: unknown } | null | undefined)?.toolUses
  if (!Array.isArray(held)) return []
  const uses: Use[] = []
  for (const item of held) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const name = typeof row['tool'] === 'string' ? row['tool'] : typeof row['name'] === 'string' ? row['name'] : undefined
    if (name === undefined) continue
    const input = row['input']
    uses.push({
      tool: name,
      input: input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {},
    })
  }

  return uses
}

export type State = {
  /** Consecutive execution requests the main session did itself. */
  streak: number
  /** Read-only acceptance requests left free after the last dispatch. */
  grace: number
  /** The reminder was given in this streak. */
  reminded: boolean
  /** The refusal was given in this streak. */
  denied: boolean
  /** The next execution tool call is refused. */
  armed: boolean
  /** When each Claude subagent was dispatched, in ms. */
  agentCalls: number[]
  /** When this hour window gave its one refusal; null when it has not. */
  agentDeniedAt: number | null
  /** The last request counted, so the same step seen twice counts once. */
  lastStep: string | null
}

export const createState = (): State => ({
  streak: 0,
  grace: 0,
  reminded: false,
  denied: false,
  armed: false,
  agentCalls: [],
  agentDeniedAt: null,
  lastStep: null,
})

/** A dispatch, or a person's own message: the streak starts over, with fresh grace. */
export const resetStreak = (state: State, config: Config): void => {
  state.streak = 0
  state.reminded = false
  state.denied = false
  state.armed = false
  state.grace = Math.max(0, Math.floor(config.grace))
}

export type Outcome = {
  kind: Kind
  /** The L1 reminder is owed for this request. */
  remind: boolean
}

/**
 * One main-session request, after its answer is known. `stepKey` (turn and
 * index) keeps a replayed or retried step from counting twice.
 */
export const observeRequest = (
  state: State,
  config: Config,
  uses: readonly Use[],
  stepKey?: string,
): Outcome => {
  if (stepKey !== undefined) {
    if (state.lastStep === stepKey) return { kind: 'other', remind: false }
    state.lastStep = stepKey
  }
  const kind = classify(uses)
  if (kind === 'dispatch') {
    resetStreak(state, config)

    return { kind, remind: false }
  }
  // Bookkeeping and everything else: neither counted nor cleared, so a plan
  // update in the middle of a long stretch does not buy the model a fresh one.
  if (kind !== 'exec') return { kind, remind: false }

  // Acceptance: after a dispatch, reading the result back is free for a few requests.
  if (state.grace > 0 && uses.every(use => !isExec(use) || READ_ONLY.has(use.tool))) {
    state.grace -= 1

    return { kind, remind: false }
  }
  state.grace = 0
  state.streak += 1

  let remind = false
  if (config.mode !== 'off' && state.streak >= config.remindAt && !state.reminded) {
    state.reminded = true
    remind = true
  }
  if (config.mode === 'soft' && state.streak >= config.denyAt && !state.denied) {
    state.denied = true
    state.armed = true
  }

  return { kind, remind }
}

export type Verdict = { deny?: string }

/**
 * One main-session tool call, before it runs. A refusal is returned instead of
 * the call's result; it is given at most once per streak and once per hour
 * window, so the model's retry always runs.
 */
export const judge = (
  state: State,
  config: Config,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  now: number,
): Verdict => {
  if (config.mode === 'off') return {}

  // DeepSeek: unlimited, and it clears the self-work count.
  if (isDelegate(tool)) {
    resetStreak(state, config)

    return {}
  }

  // Claude subagents: counted in their own rolling window, and they also clear
  // the self-work count, since dispatching is exactly what this mod wants.
  if (isClaudeAgent(tool)) {
    if (config.mode !== 'soft') {
      resetStreak(state, config)

      return {}
    }
    const refusal = judgeAgentWindow(state, config, now)
    if (refusal !== undefined) return { deny: refusal }
    resetStreak(state, config)

    return {}
  }

  if (tool === 'SendMessage') {
    resetStreak(state, config)

    return {}
  }

  if (config.mode === 'soft' && state.armed && isExec({ tool, input })) {
    state.armed = false

    return { deny: denyText(state.streak) }
  }

  return {}
}

/** The Claude-subagent limit: one refusal per rolling hour window. */
const judgeAgentWindow = (state: State, config: Config, now: number): string | undefined => {
  state.agentCalls = state.agentCalls.filter(at => now - at < AGENT_WINDOW_MS)
  if (state.agentDeniedAt !== null && now - state.agentDeniedAt >= AGENT_WINDOW_MS) state.agentDeniedAt = null

  if (state.agentCalls.length >= Math.max(0, Math.floor(config.agentPerHour)) && state.agentDeniedAt === null) {
    state.agentDeniedAt = now

    return agentDenyText(state.agentCalls.length)
  }
  state.agentCalls.push(now)

  return undefined
}

/** L1: the reminder injected once per streak, after the batch that earned it. */
export const remindText = (streak: number): string =>
  `dispatch-gate：主会话已连续 ${streak} 个执行请求，没有派发。接下来把剩下的工作按文件集合打包，交给 mcp__delegate__delegate_pro（mode=work），写清要改的文件、验收标准和不要碰的文件；主会话只做派发和验收。探针、浏览器、交互式调试这类只能自己做的，继续即可。`

/** L2: the one refusal per streak, given at the tool call that would keep going. */
export const denyText = (streak: number): string =>
  `dispatch-gate：这一段已连续 ${streak} 个执行请求，先停一下。把接下来的工作按文件集合合并成 1–2 个工作包，用 mcp__delegate__delegate_pro（mode=work）派出去，写清要改的文件、验收标准、不要碰的文件。确实只能主会话做的，重新调用同一个工具即可放行；本段不会再拦。`

/** The refusal of a Claude subagent dispatched past the hourly limit. */
export const agentDenyText = (count: number): string =>
  `dispatch-gate：最近 60 分钟已经派了 ${count} 个 Claude 子代理。先按文件集合合并分包：改同一批文件、或验收标准相同的合成一个。确实不能合并的，重新调用 Agent，并在 prompt 开头写明为什么不能合并、拆成几包、每包改哪些文件。重试会放行，这一小时内不再拦。`

export const modeOf = (value: unknown, fallback: Mode = DEFAULTS.mode): Mode => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''

  return text === 'off' || text === 'remind' || text === 'soft' ? text : fallback
}

const numberOf = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN

  return Number.isFinite(n) ? n : fallback
}

/** The plugin's options, as the engine hands them over. */
export const readConfig = (options: Readonly<Record<string, unknown>> | undefined): Config => {
  const held = options ?? {}

  return {
    mode: modeOf(held['mode']),
    remindAt: Math.max(1, Math.floor(numberOf(held['remindAt'], DEFAULTS.remindAt))),
    denyAt: Math.max(1, Math.floor(numberOf(held['denyAt'], DEFAULTS.denyAt))),
    agentPerHour: Math.max(0, Math.floor(numberOf(held['agentPerHour'], DEFAULTS.agentPerHour))),
    grace: Math.max(0, Math.floor(numberOf(held['grace'], DEFAULTS.grace))),
  }
}

/**
 * The environment's own switch, read once per session: `DISPATCH_GATE=0` turns
 * the mod off, `DISPATCH_GATE_MODE=off|remind|soft` overrides the option.
 */
export const withEnv = (config: Config, gate: string | undefined, mode: string | undefined): Config => {
  if (gate === '0') return { ...config, mode: 'off' }
  if (typeof mode === 'string' && mode.trim() !== '') return { ...config, mode: modeOf(mode, config.mode) }

  return config
}
