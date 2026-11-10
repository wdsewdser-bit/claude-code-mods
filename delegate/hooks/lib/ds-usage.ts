// DS（delegate_flash / delegate_pro）每日 token 用量：按本地日期分桶，以作业为单位记“该作业到目前为止的总量”。
// 日账本 = 当天各作业总量之和：同一作业反复更新只替换自己那一条，不会重复加；resume 续用同一 agent 产生的新作业
// 是新的一条。跨零点的作业记在开始那天（job.at 的本地日期），所以分桶只看作业开始时间。
//
// 总量 = 输入 + 缓存读 + 缓存写 + 输出，四项都保留；供应商没给 usage 时整条记为 missing（未知），不记 0 当成真的。

export type UsageParts = { input: number; cacheRead: number; cacheWrite: number; output: number }
export type UsageEntry = UsageParts & { jobId: string; date: string; at: number; missing?: true }
export type UsageLedger = Record<string, UsageEntry>
export type UsageSummary = { parts: UsageParts; total: number; jobs: number; missing: number }

/** 只保留最近多少天（含今天）。 */
export const USAGE_DAYS = 30

const zero = (): UsageParts => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)

export const totalOf = (p: UsageParts): number => p.input + p.cacheRead + p.cacheWrite + p.output

/** runner 报来的四项；缺字段按 0，四项全是 0 就是没有可用数据（不能当成真的用了 0）。 */
export const partsOf = (raw: unknown): UsageParts | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const parts = { input: int(o.input), cacheRead: int(o.cacheRead), cacheWrite: int(o.cacheWrite), output: int(o.output) }

  return totalOf(parts) > 0 ? parts : undefined
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 本地日期 YYYY-MM-DD（不是 UTC：账本按用户当地的“今天”算）。 */
export const localDate = (ms: number): string => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 保留最近 days 天（含 today）时最早的那一天；日期字符串按字典序比较。 */
export const cutoffDate = (today: string, days: number = USAGE_DAYS): string => {
  const [y, m, d] = today.split('-').map(Number)
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  date.setDate(date.getDate() - (Math.max(1, Math.round(days)) - 1))

  return localDate(date.getTime())
}

export const pruneLedger = (ledger: UsageLedger, today: string, days: number = USAGE_DAYS): UsageLedger => {
  const cutoff = cutoffDate(today, days)

  return Object.fromEntries(Object.entries(ledger).filter(([, entry]) => entry.date >= cutoff))
}

export const upsertEntry = (ledger: UsageLedger, entry: UsageEntry): UsageLedger => ({
  ...ledger,
  [entry.jobId]: entry,
})

/** 一条作业记录：有 usage 就按四项存，没有就只留 missing（未知）。 */
export const entryOf = (jobId: string, at: number, parts: UsageParts | undefined): UsageEntry =>
  parts === undefined
    ? { ...zero(), jobId, date: localDate(at), at, missing: true }
    : { ...parts, jobId, date: localDate(at), at }

/** 某个本地日期的汇总：总量、作业数、其中没有用量数据的作业数。 */
export const summaryOf = (ledger: UsageLedger, date: string): UsageSummary => {
  const parts = zero()
  let jobs = 0
  let missing = 0
  for (const entry of Object.values(ledger)) {
    if (entry.date !== date) continue
    jobs += 1
    if (entry.missing === true) {
      missing += 1
      continue
    }
    parts.input += entry.input
    parts.cacheRead += entry.cacheRead
    parts.cacheWrite += entry.cacheWrite
    parts.output += entry.output
  }

  return { parts, total: totalOf(parts), jobs, missing }
}

/** store 里读回来的一条（旧版本或半写坏的数据就当没有）。 */
export const normalizeEntry = (raw: unknown, jobId?: string): UsageEntry | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const id = typeof o.jobId === 'string' && o.jobId !== '' ? o.jobId : jobId
  const date = typeof o.date === 'string' ? o.date : ''
  if (id === undefined || id === '' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0
  const parts = { input: int(o.input), cacheRead: int(o.cacheRead), cacheWrite: int(o.cacheWrite), output: int(o.output) }

  return o.missing === true ? { ...zero(), jobId: id, date, at, missing: true } : { ...parts, jobId: id, date, at }
}

const UNITS: Record<string, number> = { '': 1, k: 1e3, 千: 1e3, m: 1e6, 万: 1e4, b: 1e9, 亿: 1e8 }

/** 每日上限的写法：800000000 / 8亿 / 800M / 0.8B / 80万；空串或 0 = 不设上限。 */
export const parseTokenLimit = (text: string): { limit: number } | { error: string } => {
  const raw = String(text ?? '').trim().toLowerCase().replace(/[,，_\s]/g, '')
  if (raw === '') return { limit: 0 }
  const m = /^(\d+(?:\.\d+)?)(k|m|b|千|万|亿)?$/.exec(raw)
  if (m === null) return { error: '每日上限要写成 800000000、8亿、800M 或 0.8B（0 表示不设上限）' }
  const limit = Math.round(Number(m[1]) * UNITS[m[2] ?? ''])
  if (!Number.isSafeInteger(limit) || limit < 0) return { error: '每日上限太大了' }

  return { limit }
}

const one = (n: number): string => String(Math.round(n * 10) / 10).replace(/\.0$/, '')

/** 1.2亿 / 8000万 / 12.3万 / 9500：给人看的大数。 */
export const formatTokens = (n: number): string => {
  const v = Math.max(0, Math.round(n))
  if (v < 10_000) return String(v)
  if (v < 100_000_000) return `${one(v / 10_000)}万`

  return `${one(v / 100_000_000)}亿`
}

/** 已用百分比（四舍五入）；没设上限时为 0。 */
export const percentOf = (total: number, limit: number): number => (limit <= 0 ? 0 : Math.round((total / limit) * 100))

/** 面板/按钮栏/列表的一行；今日 0 用量且没设上限时返回空串（什么都不显示）。 */
export const usageLabel = (total: number, limit: number, missing = 0): string => {
  if (total <= 0 && limit <= 0) return ''
  const head = limit > 0 ? `DS 今日 ${formatTokens(total)}/${formatTokens(limit)} ${percentOf(total, limit)}%` : `DS 今日 ${formatTokens(total)}`

  return missing > 0 ? `${head}（${missing} 个作业无用量数据）` : head
}

/** 派发返回末尾的提醒：没设上限、或没用够 80% 时什么都不附；到 100% 换成更强的一行，但不拦派发。 */
export const usageWarning = (total: number, limit: number): string => {
  if (limit <= 0 || total < limit * 0.8) return ''
  const head = `DS 今日已用 ${formatTokens(total)} / ${formatTokens(limit)}（${percentOf(total, limit)}%）`
  if (total >= limit) {
    return `${head}，已超出每日上限；上限是估算值，仍可继续派发，需要的话在 /delegate 里调高上限或加号。`
  }

  return `${head}，接近每日上限；需要的话在 /delegate 里调高上限或加号。`
}
