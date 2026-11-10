import type { Register } from 'claude-code'

const MARKER = '[待确认]'

/** The bounds of the manifest's userConfig: a value outside them falls back to the default. */
const MIN_IDLE_MINUTES = 0.5
const MAX_IDLE_MINUTES = 240
const MAX_AUTO_NUDGES = 50

/** The plugin's options, as the manifest's userConfig declares them. */
export type Config = {
  /** Minutes of silence from the user before one nudge; decimals allowed. */
  idleMinutes: number
  /** Nudges one away stretch may give itself; 0 turns automatic progress off. */
  maxAutoNudges: number
  /** false: no pause tool, no system prompt section, no timer. */
  enabled: boolean
}

export const DEFAULTS: Config = {
  idleMinutes: 5,
  maxAutoNudges: 8,
  enabled: true,
}

const numberOf = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN

  return Number.isFinite(n) ? n : fallback
}

const within = (value: number, min: number, max: number): boolean =>
  Number.isFinite(value) && value >= min && value <= max

/**
 * The plugin's options, as the engine hands them over. Anything unreadable or
 * out of range falls back to the default: the hook must never fail here.
 */
export const readConfig = (options?: Readonly<Record<string, unknown>> | null): Config => {
  try {
    const held = options ?? {}
    const idle = numberOf(held['idleMinutes'], DEFAULTS.idleMinutes)
    const cap = numberOf(held['maxAutoNudges'], DEFAULTS.maxAutoNudges)
    const enabled = typeof held['enabled'] === 'boolean' ? held['enabled'] : DEFAULTS.enabled

    return {
      idleMinutes: within(idle, MIN_IDLE_MINUTES, MAX_IDLE_MINUTES) ? idle : DEFAULTS.idleMinutes,
      maxAutoNudges: within(cap, 0, MAX_AUTO_NUDGES) ? Math.floor(cap) : DEFAULTS.maxAutoNudges,
      enabled,
    }
  } catch {
    return DEFAULTS
  }
}

/** `5` -> `5 分钟`; `0.5` -> `0.5 分钟`: a whole minute without a decimal, anything else with one. */
export const minutesLabel = (minutes: number): string =>
  Number.isInteger(minutes) ? `${minutes} 分钟` : `${minutes.toFixed(1)} 分钟`

export const nudgeText = (idleMinutes: number): string => `[away-autopilot] 用户 ${minutesLabel(idleMinutes)}未回复，可能没空。请自行决定下一步：
- 可以直接做：只读操作、无副作用的操作、可回滚的本地改动、确认收益明显大于副作用的操作。
- 需要重启 Claude Code 才能验证的改动：用 \`claude -p\`（mod 加 \`--plugin-dir <目录>\`）起新进程直接测试，不要等用户重启。
- 不要做：git commit/push、发送消息、删除数据、改生产或共享配置、花钱，这些留给用户回来确认。
- 做完后汇报你替用户做了哪个选择、为什么、怎么回滚。
- 如果剩下的都必须用户确认、或继续推进不值得，调用 mcp__away-autopilot__pause 停下等待。`

export const sectionText = (idleMinutes: number): string => `# 离开模式（away-autopilot）
当你停下来等用户确认（选 A/B、是否继续、是否执行某操作）时，在回复末尾单独写一行 ${MARKER}。
用户 ${minutesLabel(idleMinutes)}没回复时会收到 [away-autopilot] 提示，届时按提示自行决定；判断应该停下等用户时，调用 mcp__away-autopilot__pause。`

export const statusText = (idleMinutes: number): string =>
  `离开模式：${minutesLabel(idleMinutes)}无回复将自动推进`

/** The texts at the default idle time: 0.1.0's exact wording. */
export const NUDGE = nudgeText(DEFAULTS.idleMinutes)
export const SECTION = sectionText(DEFAULTS.idleMinutes)

// 这几种来源不是用户本人；其余（终端、桌面端、远程）都算用户回来了
// Every origin that is not the user answering: other sessions, hand-offs, relays, triggers, observers.
const NON_USER_ORIGINS = new Set([
  'plugin',
  'task-notification',
  'scheduled-trigger',
  'peer',
  'peer-send-message',
  'projects-relay',
  'coordinator',
  'channel',
  'observer',
  'observer-activity',
  'unclassified',
])

/** ctx-mod re-submits a message it held for a cold cache as the user's own: that is the user answering. */
const isUserOrigin = (origin: { kind: string; name?: unknown; asUser?: unknown }): boolean =>
  !NON_USER_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.name === 'ctx-mod' && origin.asUser === true)

export const register: Register = (on, options) => {
  const config = readConfig(options as unknown as Readonly<Record<string, unknown>>)
  // enabled=false: no pause tool, no system prompt section, no timer.
  if (!config.enabled) return

  const idleMs = Math.round(config.idleMinutes * 60_000)
  const hardCap = config.maxAutoNudges
  const nudge = nudgeText(config.idleMinutes)
  const section = sectionText(config.idleMinutes)

  let timer: { cancel: () => void } | undefined
  let autoCount = 0
  let paused = false
  // 桌面端用 wrap_up 的 ask 向用户提问，且之后不再写文字，所以不会有 MARKER
  let askedThisTurn = false

  // 取消待触发的提示，返回状态栏应显示的文字
  const clear = () => {
    timer?.cancel()
    timer = undefined
    return paused ? '离开模式：已暂停' : undefined
  }

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'pause',
      description: '在离开模式下停止自动推进，直到用户本人回复。剩余步骤都需要用户确认、或继续推进不值得时调用。',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: '为什么停下，一句话' } },
        required: ['reason'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__away-autopilot__pause' }, $ => {
    paused = true
    void $.ui.status(clear())
    return { result: 'paused', text: '已暂停自动推进，等待用户回复。' }
  })

  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, ($, e, next) => {
    const ask = (e.input as { ask?: unknown }).ask
    if (typeof ask === 'string' && ask.trim()) askedThisTurn = true
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, { id: 'away-autopilot', text: section, scope: 'session' as const }] }
  })

  on('prompt.submit', ($, e, next) => {
    if (isUserOrigin(e.origin as { kind: string; name?: unknown; asUser?: unknown })) {
      autoCount = 0
      paused = false
    }
    void $.ui.status(clear())
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const waiting = askedThisTurn || e.answer.includes(MARKER)
    askedThisTurn = false
    if (e.reason === 'answer' && !paused && waiting && autoCount < hardCap) {
      timer?.cancel()
      timer = $.clock.after(idleMs, () => {
        timer = undefined
        autoCount++
        void $.ui.status(undefined)
        void $.prompt.submit({ text: nudge })
      })
      void $.ui.status(statusText(config.idleMinutes))
    }
    return next(e)
  })
}
