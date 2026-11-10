// The pure part of effort-auto: the levels, the configuration, the two texts
// the model reads, and the state one turn of the main conversation follows.
// No engine calls here.

export type Level = 'low' | 'medium' | 'high' | 'xhigh'

/** What the effort tool may ask for: `low` is the resting level, never requested. */
export type Raise = 'medium' | 'high' | 'xhigh'

export const RAISES: readonly Raise[] = ['medium', 'high', 'xhigh']

export const isRaise = (value: unknown): value is Raise =>
  typeof value === 'string' && (RAISES as readonly string[]).includes(value)

const ORDER: readonly Level[] = ['low', 'medium', 'high', 'xhigh']

/** Higher is more thinking. */
export const rank = (level: Level): number => ORDER.indexOf(level)

/** Where every turn rests: a new user message resets to it. */
export const RESTING: Level = 'low'

/** Each turn's first request: the one that reads the user's new message. */
export const FIRST: Level = 'medium'

export type Config = {
  /** Off changes no request, injects nothing and registers no tool. */
  enabled: boolean
  /** How many raise calls one turn accepts; the ones past it are ignored. */
  maxRaises: number
  /** How many requests one raise to high or above may last at most. */
  maxHighSteps: number
  /** The JSONL file; empty means the plugin's own data directory. */
  logPath: string
}

export const DEFAULTS: Config = {
  enabled: false,
  maxRaises: 4,
  maxHighSteps: 5,
  logPath: '',
}

/** The environment variables that override the manifest's values. */
export const ENV = {
  enabled: 'EFFORT_AUTO',
  maxRaises: 'EFFORT_AUTO_MAX_RAISES',
  maxHighSteps: 'EFFORT_AUTO_MAX_HIGH_STEPS',
  logPath: 'EFFORT_AUTO_LOG',
} as const

/** How many requests a raise lasts when the model names no `steps`. */
export const DEFAULT_STEPS = 3

type Raw = Readonly<Record<string, unknown>>

const textOf = (raw: Raw, key: string): string => {
  const value = raw[key]

  return typeof value === 'string' ? value.trim() : ''
}

const flagOf = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined
  const flag = value.trim().toLowerCase()
  if (flag === '') return undefined
  if (flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on') return true
  if (flag === '0' || flag === 'false' || flag === 'no' || flag === 'off') return false

  return undefined
}

const intOf = (value: unknown, least: number): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(least, Math.floor(value))
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value.trim())

  return Number.isFinite(parsed) ? Math.max(least, Math.floor(parsed)) : undefined
}

/**
 * The manifest's values, with the environment on top (as ctx-mod reads
 * CTX_MOD). A value that names no number is ignored rather than fatal.
 */
export const configOf = (
  options: Raw | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Config => {
  const raw = options ?? {}

  return {
    enabled: flagOf(env[ENV.enabled]) ?? raw.enabled === true,
    maxRaises: intOf(env[ENV.maxRaises], 1) ?? intOf(raw.maxRaises, 1) ?? DEFAULTS.maxRaises,
    maxHighSteps: intOf(env[ENV.maxHighSteps], 1) ?? intOf(raw.maxHighSteps, 1) ?? DEFAULTS.maxHighSteps,
    logPath: (() => {
      const fromEnv = env[ENV.logPath]
      if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()

      return textOf(raw, 'logPath')
    })(),
  }
}

/**
 * The rules, verbatim: they are the effort tool's description, so they ride the
 * tool list on every main-session request — inside the cached prefix — and a
 * compaction or a new context window cannot drop them.
 */
export const rulesOf = (config: Pick<Config, 'maxRaises' | 'maxHighSteps'>): string => `【effort-auto：主会话专属思考档位】默认常驻 low；每轮第一个请求自动用 medium 读用户消息、判断范围。只在需要判断时用 effort 工具临时升档，判断做完立刻回到执行。
升到 medium：
- 收到用户新消息后，需要判断范围、拆包、选模型或选档位时。
- 验收子代理的结果、判断算不算完成或要不要打回时。
- 工具报错，或结果与预期不符、需要判断原因时。
- 向用户给出建议或结论之前（方案取舍、是否提交）。
升到 high：
- 根因不明，且已经试过一次没解决。
- 架构、数据库/迁移、并发、权限、正式版等改错代价高的决定。
- 用户要深入分析，或问题本身有争议、需要权衡。
降回 low：
- 判断已经做出、进入执行步骤（派活、记台账、读文件、跑命令、改已定内容）。
- 升档时声明的 steps 用完。
- 新一轮开始（自动）。
用法：effort { level: "medium" | "high" | "xhigh", steps: 3, reason: "一句话理由" }，可以和其他工具放在同一条消息里，从下一个请求起生效。
steps 默认 3；high 及以上一次最多 ${config.maxHighSteps} 步；每轮最多 ${config.maxRaises} 次升档，超过的会被忽略。`

/** The note the model reads after two tool calls failed in a row. */
export const ERROR_REMINDER = `连续两次工具报错。先判断是真问题还是误报：误报或已知可直接处理的情况不需要升档，直接继续；原因不明、方向可能错了或已试过一次没解决，才用 effort 升到 medium/high 并写明 steps。
常见误报：权限确认被拒；输出含 error 字样但退出码为 0；预期中的文件不存在；超时后重试成功；用户中断。`

/** What the model asked for with the effort tool. */
export type Override = {
  level: Raise
  /** Requests left to use it; the request that reads 0 leaves it behind. */
  remaining: number
  /** Why, for the log. */
  reason?: string
}

/** What decides one request's effort. */
export type Source = 'default' | 'tool' | 'expire' | 'reset' | 'cap'

/** One turn of the main conversation. */
export type TurnState = {
  /** The raise in force, if any. */
  override?: Override
  /** Raise calls accepted this turn. */
  raises: number
  /** Tool calls that failed since the last one that did not. */
  errors: number
  /** The next request carries the two-errors reminder. */
  remind: boolean
  /** What decides the next request's effort until something changes it. */
  source: Source
}

/** A turn's state as a new user message leaves it: resting at low. */
export const fresh = (): TurnState => ({ raises: 0, errors: 0, remind: false, source: 'reset' })

export type Decision = {
  effort: Level
  source: Source
  /** The turn's state after this request. */
  state: TurnState
}

/**
 * One request's effort: the raise in force, else the resting level. A raise
 * that this request empties leaves the next one on low, marked `expire`.
 */
export const decide = (state: TurnState): Decision => {
  const held = state.override
  if (held !== undefined) {
    const remaining = held.remaining - 1
    const expired = remaining <= 0

    return {
      effort: held.level,
      source: 'tool',
      state: {
        ...state,
        override: expired ? undefined : { ...held, remaining },
        source: expired ? 'expire' : 'tool',
        remind: false,
      },
    }
  }

  // A turn's first request reads the user's message: it gets medium to judge
  // scope before the turn settles back to low.
  const effort: Level = state.source === 'reset' ? FIRST : RESTING

  return { effort, source: state.source, state: { ...state, source: 'default', remind: false } }
}

export type RaiseOutcome =
  | { ok: true; level: Raise; steps: number; held: boolean; state: TurnState }
  | { ok: false; why: 'cap'; state: TurnState }

/**
 * A raise the model asked for: the steps it lasts, held at `maxHighSteps` for
 * high and above, and refused once the turn has used `maxRaises` of them.
 */
export const raise = (
  state: TurnState,
  request: { level: Raise; steps?: number; reason?: string },
  config: Pick<Config, 'maxRaises' | 'maxHighSteps'>,
): RaiseOutcome => {
  const limit = Math.max(1, Math.floor(config.maxRaises))
  if (state.raises >= limit) return { ok: false, why: 'cap', state: { ...state, source: 'cap' } }

  const asked =
    request.steps !== undefined && Number.isFinite(request.steps) && request.steps >= 1
      ? Math.floor(request.steps)
      : DEFAULT_STEPS
  const most = Math.max(1, Math.floor(config.maxHighSteps))
  const high = rank(request.level) >= rank('high')
  const steps = high ? Math.min(asked, most) : asked

  return {
    ok: true,
    level: request.level,
    steps,
    held: high && asked > most,
    state: {
      ...state,
      override: {
        level: request.level,
        remaining: steps,
        ...(request.reason === undefined || request.reason === '' ? {} : { reason: request.reason }),
      },
      raises: state.raises + 1,
      source: 'tool',
    },
  }
}

/** One failed tool call: the second in a row asks the next request for the reminder. */
export const noteFailure = (state: TurnState): { state: TurnState; remind: boolean } => {
  const errors = state.errors + 1
  const remind = errors === 2

  return { state: { ...state, errors, remind: state.remind || remind }, remind }
}

/** One tool call that did not fail: the run of failures ends. */
export const noteSuccess = (state: TurnState): TurnState =>
  state.errors === 0 ? state : { ...state, errors: 0 }

/** The exit code a Bash result carries, from its record or from its text. */
export const bashExitOf = (result: unknown): number | undefined => {
  const answer = result as { result?: unknown; text?: unknown } | null
  const record = answer?.result
  if (typeof record === 'object' && record !== null) {
    for (const key of ['exitCode', 'exit_code']) {
      const value = (record as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
  }
  const text = typeof answer?.text === 'string' ? answer.text : ''
  const match = /(?:Exit code|exit code|exited with code)[: ]+(-?\d+)/.exec(text)

  return match === null ? undefined : Number(match[1])
}

/**
 * Whether a tool result counts as a failure: the engine's `isError`, or a Bash
 * that exited non-zero. A refusal (`deny`) is not a failure of the tool.
 */
export const failureOf = (tool: string, result: unknown): boolean => {
  if ((result as { deny?: unknown } | null)?.deny !== undefined) return false
  if ((result as { isError?: unknown } | null)?.isError === true) return true
  if (tool !== 'Bash') return false
  const code = bashExitOf(result)

  return code !== undefined && code !== 0
}
