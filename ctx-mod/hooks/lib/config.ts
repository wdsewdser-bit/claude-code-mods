// The thresholds a person may set from the plugin's configuration, each overridable
// by an environment variable. Everything here fails back to DEFAULTS: a hook that
// threw would take the engine's own path down with it.

import { DEFAULTS } from './types.ts'
import type { Config } from './types.ts'

/** The environment variables that override the manifest's values. */
export const ENV = {
  enabled: 'CTX_MOD',
  compactWindow: 'CTX_MOD_COMPACT_WINDOW',
  boundaryTokens: 'CTX_MOD_BOUNDARY_TOKENS',
  softTokens: 'CTX_MOD_SOFT_TOKENS',
  urgentTokens: 'CTX_MOD_URGENT_TOKENS',
  cooldownRequests: 'CTX_MOD_COOLDOWN_REQUESTS',
  maxSwitchesPerHour: 'CTX_MOD_MAX_SWITCHES_PER_HOUR',
  coldMinTokens: 'CTX_MOD_COLD_MIN_TOKENS',
  gateMinTokens: 'CTX_MOD_GATE_MIN_TOKENS',
} as const

/** The fields the manifest exposes, in the order the status line lists them. */
export const TUNABLE = [
  'compactWindow',
  'boundaryTokens',
  'softTokens',
  'urgentTokens',
  'cooldownRequests',
  'maxSwitchesPerHour',
  'coldMinTokens',
  'gateMinTokens',
] as const

export type Tunable = (typeof TUNABLE)[number]

type Raw = Readonly<Record<string, unknown>>

/** A finite number from the options or the environment; none when it is not one. */
const numberOf = (value: unknown): number | undefined => {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value.trim())
        : NaN

  return Number.isFinite(n) ? n : undefined
}

/** A context fill: a finite positive number of tokens. */
const tokensOf = (value: unknown): number | undefined => {
  const n = numberOf(value)

  return n !== undefined && n > 0 ? n : undefined
}

/** A count: a finite number, zero allowed. */
const countOf = (value: unknown): number | undefined => {
  const n = numberOf(value)

  return n !== undefined && n >= 0 ? n : undefined
}

const PARSERS: Readonly<Record<Tunable, (value: unknown) => number | undefined>> = {
  compactWindow: tokensOf,
  boundaryTokens: tokensOf,
  softTokens: tokensOf,
  urgentTokens: tokensOf,
  cooldownRequests: countOf,
  maxSwitchesPerHour: countOf,
  coldMinTokens: tokensOf,
  gateMinTokens: tokensOf,
}

/** One field: the environment first, then the option, then the default; a bad value is the default. */
const fieldOf = (field: Tunable, options: Raw, env: Readonly<Record<string, string | undefined>>): number => {
  const fromEnv = env[ENV[field]]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return PARSERS[field](fromEnv) ?? DEFAULTS[field]
  const fromOptions = options[field]

  return fromOptions === undefined ? DEFAULTS[field] : PARSERS[field](fromOptions) ?? DEFAULTS[field]
}

/**
 * What this session runs with: DEFAULTS with the tunable fields as configured. The
 * three fills must climb, or the whole group falls back (a lower fill later than a
 * higher one would make the earlier reminder unreachable).
 */
export const readConfig = (
  options: Raw | undefined,
  env: Readonly<Record<string, string | undefined>> = {},
  warn: (text: string) => void = () => {},
): Config => {
  const held = options ?? {}
  const tuned = {} as Record<Tunable, number>
  for (const field of TUNABLE) tuned[field] = fieldOf(field, held, env)
  if (!(tuned.boundaryTokens <= tuned.softTokens && tuned.softTokens <= tuned.urgentTokens)) {
    warn(
      `三级阈值必须满足 boundaryTokens <= softTokens <= urgentTokens，当前是 ${tuned.boundaryTokens}/${tuned.softTokens}/${tuned.urgentTokens}；三档整组回退默认 ${DEFAULTS.boundaryTokens}/${DEFAULTS.softTokens}/${DEFAULTS.urgentTokens}。`,
    )
    tuned.boundaryTokens = DEFAULTS.boundaryTokens
    tuned.softTokens = DEFAULTS.softTokens
    tuned.urgentTokens = DEFAULTS.urgentTokens
  }

  return { ...DEFAULTS, ...tuned }
}

/** The environment's own switch: true for `1`, false for `0`, undefined when it leaves the choice to the option. */
export const switchOf = (env: Readonly<Record<string, string | undefined>>): boolean | undefined => {
  const flag = env[ENV.enabled]?.trim()

  return flag === '1' ? true : flag === '0' ? false : undefined
}

/** Whether the mod acts: the environment's switch wins over the manifest's `enabled`. */
export const enabledOf = (options: Raw | undefined, env: Readonly<Record<string, string | undefined>> = {}): boolean => {
  const flag = switchOf(env)
  if (flag !== undefined) return flag

  return options?.['enabled'] === true
}

/** The tunable fields that differ from DEFAULTS, as one configuration line; '' when none do. */
export const changedText = (config: Config): string => {
  const changed = TUNABLE.filter(field => config[field] !== DEFAULTS[field]).map(
    field => `${field}=${config[field]}（默认 ${DEFAULTS[field]}）`,
  )

  return changed.length === 0 ? '' : `\n配置：${changed.join('、')}`
}
