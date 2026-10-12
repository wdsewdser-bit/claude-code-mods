import type { RateLimit } from './keeper.ts'
import { TTL_MS } from './keeper.ts'
import type { Ttl } from './pricing.ts'

/**
 * The quota bridge: when the 5-hour window nears its end, the main session is
 * told to wrap up, its cache is kept warm until the window resets, and it is
 * told to carry on afterwards. Pure decisions live here; register.tsx acts.
 */
export type BridgePhase = 'idle' | 'wrapped'

export type Bridge = {
  phase: BridgePhase
  /** The window (its resetsAt) the bridge last wrapped for: one wrap per window. */
  window: string | null
  resetAtMs: number | null
  wrapAt: number | null
  /** The person typed after the wrap-up: no automatic resume. */
  isTakenOver: boolean
  /** Percent when the wrap-up was sent. */
  wrappedAtPercent: number | null
  /** The weekly window (windowKey of its reset) the handoff notice was sent for. */
  weeklyWindow: string | null
}

export const initialBridge = (): Bridge => ({
  phase: 'idle',
  window: null,
  resetAtMs: null,
  wrapAt: null,
  isTakenOver: false,
  wrappedAtPercent: null,
  weeklyWindow: null,
})

/** Only a session worked in this recently counts as being worked: older ones are never woken. */
export const ACTIVE_MS = 600_000

/**
 * Background work out for longer than this since the last sign of it (a launch,
 * or a Stop hook's list that still named it) is taken as lost: a task whose
 * notice never came back must not keep an idle session "worked in" forever.
 */
export const BACKGROUND_MAX_MS = 24 * 3_600_000

/**
 * How many background tasks the Stop hook's list still names as in flight. That
 * list is the session's own: it includes tasks a Bash call moved to the
 * background by itself, which no tool input shows.
 */
export const countInFlight = (tasks: readonly unknown[]): number => tasks.length

/**
 * Whether background work this session started is still out: some task has not
 * sent its task-notification back, and it was last seen recently enough to
 * trust. While it is out the session is waiting on that work, not idle, even
 * though no message has come from the main thread for a while.
 */
export const isBackgroundBusy = (
  pending: number,
  seenAt: number | null,
  now: number,
): boolean => pending > 0 && seenAt !== null && now - seenAt < BACKGROUND_MAX_MS

/** Wait this long after resetsAt before resuming, for the meter to move. */
export const RESUME_DELAY_MS = 20_000
/** If the meter still reads high this long after the reset, resume anyway. */
export const RESUME_GRACE_MS = 300_000
/** A cache this close to expiring at resume time still wants its last keepalive. */
export const RESUME_SAFETY_MS = 90_000

export const fiveHour = (limits: readonly RateLimit[]): RateLimit | undefined =>
  limits.find(limit => limit.kind === 'five_hour')

export const resetMs = (limit: RateLimit | undefined): number | null => {
  if (limit?.resetsAt === undefined) return null
  const at = Date.parse(limit.resetsAt)

  return Number.isFinite(at) ? at : null
}

export const sevenDay = (limits: readonly RateLimit[]): RateLimit | undefined =>
  limits.find(limit => limit.kind === 'seven_day')

/** One window, by its reset to the minute: a reading's milliseconds may wander. */
export const windowKey = (resetAtMs: number): string =>
  String(Math.round(resetAtMs / 60_000))

export type HandoffInput = {
  isRunActive: boolean
  bridge: Bridge
  limits: readonly RateLimit[]
  now: number
  /** The last user or assistant message of the main thread, in ms. */
  lastRealAt: number | null
  ttl: Ttl | null
  /** Weekly percent that asks for the handoff; 0 never asks. */
  atPercent: number
  /** Background work this session started is still out (see isBackgroundBusy). */
  isBackgroundBusy: boolean
}

/**
 * Whether the session is being worked in: background work is out, or the main
 * thread spoke within the active window (never longer than the cache TTL).
 */
const isWorkedIn = (
  lastRealAt: number,
  ttl: Ttl | null,
  now: number,
  isBackgroundBusy: boolean,
): boolean =>
  isBackgroundBusy || now - lastRealAt < Math.min(ACTIVE_MS, TTL_MS[ttl ?? '1h'])

/**
 * Whether to ask for a handoff document now: the weekly window is nearly
 * spent, so the work will be picked up after its reset, days away, by a new
 * conversation rather than by this one's long-expired cache. Once per weekly
 * window, and only for a session being worked in, by the wrap-up's rule.
 */
export const shouldHandoff = (input: HandoffInput): boolean => {
  if (input.atPercent <= 0 || input.isRunActive) return false
  const limit = sevenDay(input.limits)
  const reset = resetMs(limit)
  if (limit === undefined || reset === null || reset <= input.now) return false
  if (limit.percentUsed < input.atPercent) return false
  if (windowKey(reset) === input.bridge.weeklyWindow) return false
  if (input.lastRealAt === null) return false

  return isWorkedIn(input.lastRealAt, input.ttl, input.now, input.isBackgroundBusy)
}

export type WrapInput = {
  isEnabled: boolean
  isBridgeOn: boolean
  isRunActive: boolean
  bridge: Bridge
  limits: readonly RateLimit[]
  now: number
  /** The last user or assistant message of the main thread, in ms. */
  lastRealAt: number | null
  ttl: Ttl | null
  atPercent: number
  /** Background work this session started is still out (see isBackgroundBusy). */
  isBackgroundBusy: boolean
}

/**
 * Whether to send the wrap-up now: the window is at the threshold, resets in
 * the future, this session was worked in within ACTIVE_MS or still has background
 * work out (an idle session is never woken), and the window was not wrapped for already.
 */
export const shouldWrap = (input: WrapInput): boolean => {
  if (!input.isEnabled || !input.isBridgeOn || input.isRunActive) return false
  if (input.bridge.phase !== 'idle') return false
  const limit = fiveHour(input.limits)
  const reset = resetMs(limit)
  if (limit === undefined || reset === null || reset <= input.now) return false
  if (limit.percentUsed < input.atPercent) return false
  if (limit.resetsAt === input.bridge.window) return false
  if (input.lastRealAt === null) return false

  return isWorkedIn(input.lastRealAt, input.ttl, input.now, input.isBackgroundBusy)
}

/**
 * Whether a keepalive would still be needed before the resume message: the
 * resume is itself a request, so a cache that outlives it needs no more pings.
 */
export const needsPing = (
  bridge: Bridge,
  lastActivityAt: number,
  ttl: Ttl,
): boolean => {
  if (bridge.resetAtMs === null) return true

  return (
    bridge.resetAtMs + RESUME_DELAY_MS - lastActivityAt >=
    TTL_MS[ttl] - RESUME_SAFETY_MS
  )
}

export type ResumeVerdict = 'wait' | 'resume' | 'skip'

/** What to do about the resume message at `now`. */
export const resumeVerdict = (
  bridge: Bridge,
  now: number,
  limits: readonly RateLimit[],
  atPercent: number,
): ResumeVerdict => {
  if (bridge.phase !== 'wrapped' || bridge.resetAtMs === null) return 'wait'
  if (now < bridge.resetAtMs + RESUME_DELAY_MS) return 'wait'
  if (bridge.isTakenOver) return 'skip'
  const limit = fiveHour(limits)
  const isStillHigh = limit !== undefined && limit.percentUsed >= atPercent
  if (isStillHigh && now < bridge.resetAtMs + RESUME_GRACE_MS) return 'wait'

  return 'resume'
}

export const clockOf = (ms: number): string => {
  const at = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')

  return `${two(at.getHours())}:${two(at.getMinutes())}`
}

export const spanOf = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)

  return hours === 0 ? `${minutes} 分钟` : `${hours} 小时 ${minutes % 60} 分钟`
}

export const wrapText = (percent: number, resetAtMs: number, now: number): string =>
  `【cache-keeper 自动通知】5 小时额度已用 ${percent}%，约 ${spanOf(resetAtMs - now)}后（${clockOf(resetAtMs)}）重置。请只快速完成当前这一步并收尾（保存进度、写好交接说明），不要开始新任务、不要再派子代理，然后停下等待。额度重置后会自动通知你继续。`

const dayOf = (ms: number): string => {
  const at = new Date(ms)

  return `${at.getMonth() + 1} 月 ${at.getDate()} 日 ${clockOf(ms)}`
}

export const handoffText = (percent: number, resetAtMs: number, now: number): string =>
  `【cache-keeper 自动通知】周额度已用 ${percent}%，约 ${spanOf(resetAtMs - now)}后（${dayOf(resetAtMs)}）重置。请现在写一份交接检查点：更新已有的台账或交接文档，没有就在工作目录新建 HANDOFF.md，写清目标与授权范围、已完成并验证的结果、进行中的步骤和当前状态、下一步、关键文件位置和要跑的命令，让一个没有本对话上下文的新会话能直接接手。写完把文件路径告诉用户，然后继续手头的工作，之后每完成一个阶段就更新它。额度重置后由新对话按这份文档接手，不续用本对话。`

export const resumeText = (): string =>
  '【cache-keeper 自动通知】5 小时额度已重置。请接着刚才收尾的地方继续之前的工作。'

export const describeBridge = (bridge: Bridge, now: number): string =>
  bridge.phase === 'wrapped' && bridge.resetAtMs !== null
    ? `bridge: waiting for reset in ${spanOf(bridge.resetAtMs - now)} (${clockOf(bridge.resetAtMs)})${bridge.isTakenOver ? ' · you took over: no auto-resume' : ''}`
    : 'bridge: idle'
