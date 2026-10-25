// GPT（ChatGPT/Codex 订阅）额度：scripts/gpt-quota.mjs 的输出和面板上的显示。

export type QuotaWindow = { label: string; used: number; resetAt?: number }
export type GptQuota =
  | { ok: true; source: 'live' | 'cached'; at: number; plan: string; limitReached: boolean; windows: QuotaWindow[] }
  | { ok: false; error: string }

export const normalizeQuota = (raw: unknown): GptQuota => {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (o.ok !== true) return { ok: false, error: typeof o.error === 'string' ? o.error : '额度脚本没有输出' }
  const windows = (Array.isArray(o.windows) ? o.windows : [])
    .map(w => (typeof w === 'object' && w !== null ? (w as Record<string, unknown>) : {}))
    .filter(w => typeof w.label === 'string' && typeof w.used === 'number')
    .map(w => ({
      label: w.label as string,
      used: Math.max(0, Math.min(100, w.used as number)),
      ...(typeof w.resetAt === 'number' ? { resetAt: w.resetAt } : {}),
    }))
  if (windows.length === 0) return { ok: false, error: '额度里没有窗口数据' }

  return {
    ok: true,
    source: o.source === 'cached' ? 'cached' : 'live',
    at: typeof o.at === 'number' ? o.at : Date.now(),
    plan: typeof o.plan === 'string' ? o.plan : '',
    limitReached: o.limitReached === true,
    windows,
  }
}

/** 进度条拆成已用和剩余两段，好分别上色。 */
export const barOf = (used: number, width = 12): [string, string] => {
  const u = Math.max(0, Math.min(100, used))
  // 用了一点就至少亮一格，免得 1% 看着像没用。
  const n = u > 0 ? Math.max(1, Math.round((u / 100) * width)) : 0

  return ['━'.repeat(n), '─'.repeat(width - n)]
}

export const usedColor = (used: number): string => (used >= 80 ? 'error' : used >= 50 ? 'warning' : 'success')

export const resetIn = (resetAt: number | undefined, now: number): string => {
  if (resetAt === undefined) return ''
  const m = Math.max(0, Math.round((resetAt - now) / 60_000))
  if (m >= 1440) return `${Math.floor(m / 1440)} 天 ${Math.floor((m % 1440) / 60)} 时后重置`
  if (m >= 60) return `${Math.floor(m / 60)} 时 ${m % 60} 分后重置`

  return `${m} 分后重置`
}
