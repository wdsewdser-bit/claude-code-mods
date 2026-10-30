// 缓存保活的纯逻辑：设置、重放体的改写、判定、用量/费用、日志统计。
// 没有网络也没有子进程，脚本（keepalive.mjs / keepalive-proxy.mjs）和测试都从这里取，
// 规则只写一份，转发和守护不会各算各的。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 中转站的提示缓存几分钟到几十分钟就失效：默认每 8 分钟续一次，3 小时后收手。
export const DEFAULT_SETTINGS = { enabled: true, intervalMinutes: 15, minTokens: 60000, maxHours: 3 }
// 连续这么多次重放的缓存命中率都不到一半，就认为这条会话回不来了，删掉文件停止保活。
export const MAX_LOW_HITS = 2
export const MIN_HIT_RATE = 0.5
// 面板算账用的单价（美元/百万 token）：缓存读 $0.02、输入 $0.4、输出 $2。
export const PRICE_PER_MILLION = { cacheRead: 0.02, input: 0.4, output: 2 }

const isRecord = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = v => Number.isFinite(Number(v))
const positive = v => Number.isFinite(Number(v)) && Number(v) > 0

/** ~/.claude/delegate/keepalive；DELEGATE_KEEPALIVE_DIR 给测试和换目录用。 */
export const keepaliveRootOf = (env = process.env, home = os.homedir()) => {
  const dir = typeof env?.DELEGATE_KEEPALIVE_DIR === 'string' ? env.DELEGATE_KEEPALIVE_DIR.trim() : ''

  return dir !== '' ? dir : path.join(home, '.claude', 'delegate', 'keepalive')
}

/** 作业 id 进文件名：只留下安全字符，避免 ../ 之类。 */
export const jobIdOf = v => String(v ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)

export const sessionPathOf = (root, jobId) => path.join(root, `${jobIdOf(jobId)}.json`)
export const settingsPathOf = root => path.join(root, 'config.json')
export const logPathOf = root => path.join(root, 'log.jsonl')
export const pidPathOf = root => path.join(root, 'daemon.pid')

const numOr = (v, fallback, min) => {
  const n = Number(v)

  return Number.isFinite(n) && n >= min ? n : fallback
}

/** 缺省、垃圾、越界都退回默认值；只有明确写 false 才关掉。 */
export const normalizeSettings = raw => {
  const o = isRecord(raw) ? raw : {}

  return {
    enabled: o.enabled !== false,
    intervalMinutes: numOr(o.intervalMinutes, DEFAULT_SETTINGS.intervalMinutes, 1),
    minTokens: numOr(o.minTokens, DEFAULT_SETTINGS.minTokens, 0),
    maxHours: numOr(o.maxHours, DEFAULT_SETTINGS.maxHours, 0.01),
  }
}

export const readSettings = root => {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsPathOf(root), 'utf8')))
  } catch {
    return normalizeSettings(undefined)
  }
}

export const writeSettings = (root, patch) => {
  const next = normalizeSettings({ ...readSettings(root), ...(isRecord(patch) ? patch : {}) })
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(settingsPathOf(root), JSON.stringify(next, null, 2) + '\n')

  return next
}

// ── 一次真实请求 → 一个会话文件 ────────────────────────────────────────────
// 只放请求体、时间和从响应里读到的用量：没有 headers、没有 key、没有 token。
export const sessionRecordOf = ({ jobId, body, now = Date.now() }) => ({
  jobId: jobIdOf(jobId),
  model: typeof body?.model === 'string' ? body.model : '',
  at: now,
  lastRequestAt: now,
  lowHits: 0,
  usage: null,
  body,
})

/**
 * 重放体：相对原请求只改两处 —— stream=false、max_tokens 尽量小。
 * thinking（含 budget_tokens）、output_config、metadata、system、tools、messages、model 全部原样保留：
 * 动思考设置可能让上游换一个缓存键，重放就不命中了。
 */
export const replayBodyOf = (body, maxTokens = 1) => {
  if (!isRecord(body)) return body
  const out = structuredClone(body)
  out.stream = false
  out.max_tokens = maxTokens

  return out
}

/** 上游嫌 max_tokens 小于思考预算时，能通过的最小值（budget_tokens + 1）；没有预算就是 null。 */
export const minMaxTokensOf = body => {
  const budget = Number(body?.thinking?.budget_tokens)
  if (!Number.isFinite(budget) || budget <= 0) return null

  return Math.ceil(budget) + 1
}

/** 400 是不是"max_tokens 小于 thinking.budget_tokens"这一类：是就说明该换大一点的 max_tokens 重试。 */
export const maxTokensTooSmall = (status, text) => {
  if (Number(status) !== 400) return false

  return /max_tokens/i.test(String(text ?? '')) && /budget_tokens|thinking|greater than/i.test(String(text ?? ''))
}

/** 从 SSE / JSON 响应里认出用量：message_start 带输入和缓存，message_delta 带输出。 */
const USAGE_KEYS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']

export const usageFromEvent = payload => {
  if (!isRecord(payload)) return undefined
  const u = payload.type === 'message_start' ? payload.message?.usage : payload.usage
  if (!isRecord(u)) return undefined
  const out = {}
  for (const key of USAGE_KEYS) if (finite(u[key])) out[key] = Number(u[key])

  return Object.keys(out).length > 0 ? out : undefined
}

/** 输入/缓存取先看到的正数（message_start），输出取最后一次（message_delta 是累计值）。 */
export const mergeUsage = (prev, next) => {
  const out = { ...(isRecord(prev) ? prev : {}) }
  if (!isRecord(next)) return out
  for (const key of USAGE_KEYS) {
    if (!finite(next[key])) continue
    const value = Number(next[key])
    if (key === 'output_tokens') out[key] = value
    else if (value > 0) out[key] = value
  }

  return out
}

/** 这次请求真实的输入规模：优先用响应里的 usage，没有才按 body 估。 */
export const tokensOf = session => {
  const usage = isRecord(session?.usage) ? session.usage : {}
  const used = Number(usage.input_tokens || 0) + Number(usage.cache_read_input_tokens || 0)
  if (used > 0) return used

  return tokensOfBody(session?.body)
}

/** 粗估：system + tools + messages 的 JSON 长度 / 4。 */
export const tokensOfBody = body => {
  if (!isRecord(body)) return 0
  let chars = 0
  for (const key of ['system', 'tools', 'messages']) {
    const part = body[key]
    if (part === undefined || part === null) continue
    try {
      chars += JSON.stringify(part).length
    } catch {
      // 循环引用之类：估不出来就当 0，不能因此让作业或守护崩掉
    }
  }

  return Math.ceil(chars / 4)
}

/** 缓存命中率：缓存读 / 全部输入。没有输入数字时是 null（不算命中，也不算没命中）。 */
export const hitRate = usage => {
  if (!isRecord(usage)) return null
  const read = Number(usage.cache_read_input_tokens || 0)
  const input = Number(usage.input_tokens || 0)
  const total = read + input

  return total > 0 ? read / total : null
}

/** 一次重放（或一次真实请求）花了多少钱，按面板的单价。 */
export const costOf = usage => {
  const u = isRecord(usage) ? usage : {}
  const read = Number(u.cache_read_input_tokens || 0)
  const input = Number(u.input_tokens || 0)
  const output = Number(u.output_tokens || 0)

  return (read * PRICE_PER_MILLION.cacheRead + input * PRICE_PER_MILLION.input + output * PRICE_PER_MILLION.output) / 1_000_000
}

/**
 * 要不要重放：
 *   drop：超过 maxHours，或连续 MAX_LOW_HITS 次命中率不到一半 —— 删文件
 *   skip：作业仍在运行（最后一次真实请求距今 < intervalMinutes），或会话太小（< minTokens）
 *   replay：可以续一次
 * force（--once）：跳过"仍在运行"的判断，其余条件照旧。
 */
export const decide = (session, settings, now = Date.now(), options = {}) => {
  const s = normalizeSettings(settings)
  if (!s.enabled) return { action: 'skip', reason: 'disabled' }
  const last = Number(session?.lastRequestAt)
  if (!Number.isFinite(last) || last <= 0) return { action: 'drop', reason: 'no-request' } // 没有真实请求时间的文件是坏的，删掉免得守护一直等
  const age = now - last
  if (age > s.maxHours * 3_600_000) return { action: 'drop', reason: 'expired' }
  if (Number(session?.lowHits || 0) >= MAX_LOW_HITS) return { action: 'drop', reason: 'low-hit' }
  if (age < s.intervalMinutes * 60_000 && options?.force !== true) return { action: 'skip', reason: 'running' }
  if (tokensOf(session) < s.minTokens) return { action: 'skip', reason: 'small' }

  return { action: 'replay', reason: 'ok' }
}

/** 重放之后：命中率不到一半就累计一次，命中了就清零。 */
export const afterReplay = (session, usage, now = Date.now()) => {
  const rate = hitRate(usage)
  const lowHits = rate === null ? Number(session?.lowHits || 0) : rate < MIN_HIT_RATE ? Number(session?.lowHits || 0) + 1 : 0

  return { ...session, lastReplayAt: now, lowHits, replayUsage: isRecord(usage) ? usage : null }
}

/** 一条日志：有数字、有花费，没有 key / headers。 */
export const logEntryOf = ({ jobId, model, status, usage, now = Date.now() }) => {
  const u = isRecord(usage) ? usage : {}

  return {
    at: now,
    jobId: jobIdOf(jobId),
    model: typeof model === 'string' ? model : '',
    ok: status >= 200 && status < 300,
    status: Number(status) || 0,
    input_tokens: Number(u.input_tokens || 0),
    cache_read_input_tokens: Number(u.cache_read_input_tokens || 0),
    output_tokens: Number(u.output_tokens || 0),
    hitRate: hitRate(u),
    usd: Number(costOf(u).toFixed(6)),
  }
}

export const appendLog = (root, entry) => {
  try {
    fs.mkdirSync(root, { recursive: true })
    const file = logPathOf(root)
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) {
        fs.renameSync(file, path.join(root, 'log.1.jsonl'))
      }
    } catch {}
    fs.appendFileSync(file, JSON.stringify(entry) + '\n')
  } catch {}
}

/** 面板那一行用的统计：今日重放次数和花费（本地日界），以及总计。 */
export const summarizeLog = (text, now = Date.now()) => {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const dayStart = start.getTime()
  let replays = 0
  let cost = 0
  let replaysToday = 0
  let costToday = 0
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o?.ok !== true) continue
    const at = Number(o.at)
    if (!Number.isFinite(at)) continue
    const usd = Number.isFinite(Number(o.usd)) ? Number(o.usd) : 0
    replays += 1
    cost += usd
    if (at >= dayStart) {
      replaysToday += 1
      costToday += usd
    }
  }

  return { replays, cost, replaysToday, costToday }
}

export const readLogText = root => {
  try {
    return fs.readFileSync(logPathOf(root), 'utf8')
  } catch {
    return ''
  }
}

/** 会话文件（写成 <jobId>.json，先写临时文件再改名，守护读不到半截）。 */
export const writeSession = (root, record) => {
  try {
    fs.mkdirSync(root, { recursive: true })
    const file = sessionPathOf(root, record.jobId)
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(record))
    fs.renameSync(tmp, file)

    return file
  } catch {
    return undefined
  }
}

export const readSessionFile = file => {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isRecord(o) || !isRecord(o.body)) return undefined

    return o
  } catch {
    return undefined
  }
}

export const listSessionFiles = root => {
  try {
    return fs
      .readdirSync(root)
      .filter(n => n.endsWith('.json') && n !== 'config.json')
      .map(n => path.join(root, n))
  } catch {
    return []
  }
}

/** 转发结束时把用量补进会话文件；文件已经被删或换过就什么都不做。 */
export const mergeSessionUsage = (root, jobId, usage, now = Date.now()) => {
  const file = sessionPathOf(root, jobId)
  const session = readSessionFile(file)
  if (session === undefined) return undefined
  const next = { ...session, usage: mergeUsage(session.usage, usage), usageAt: now }

  return writeSession(root, next)
}
