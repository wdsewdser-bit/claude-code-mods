#!/usr/bin/env node
// 缓存保活守护：作业结束后进程就没了，转发写下的最后一次 /v1/messages 请求体还留在
// ~/.claude/delegate/keepalive/<jobId>.json。这个守护每隔几分钟把它原样重放一次
// （只改 stream=false、max_tokens 尽量小），让中转站的提示缓存不冷掉。
//
//   node scripts/keepalive.mjs               常驻（单实例，pid 文件；没有待保活会话就自己退出）
//   node scripts/keepalive.mjs --once        立即扫一遍、能续的都续一次（忽略"作业仍在运行"）
//   node scripts/keepalive.mjs --status      给面板的一行 JSON：会话数 / 今日重放次数 / 花费
//   node scripts/keepalive.mjs --set-enabled on|off
//
// 日志写在 keepalive/log.jsonl：每次重放的 status、input_tokens、cache_read_input_tokens、
// output_tokens 和花费，没有 key、没有 headers。
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  afterReplay,
  appendLog,
  decide,
  keepaliveRootOf,
  listSessionFiles,
  logEntryOf,
  maxTokensTooSmall,
  minMaxTokensOf,
  pidPathOf,
  readLogText,
  readSessionFile,
  readSettings,
  replayBodyOf,
  summarizeLog,
  usageFromEvent,
  writeSession,
  writeSettings,
} from './keepalive-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = keepaliveRootOf()
const TICK_MS = 60_000
const CPA_ENSURE =
  process.env.DELEGATE_CPA_ENSURE || path.join(os.homedir(), 'tools', 'cliproxyapi', 'ensure_cpa.py')
const CPA_PYTHON = process.env.DELEGATE_CPA_PYTHON || 'python'

const say = value => process.stdout.write(JSON.stringify(value) + '\n')

/** 和 run-delegate 的 cpaEnv 一条路：ensure_cpa.py --print-env 给出 url 和 key。key 只留在内存里。 */
const cpaEnv = () => {
  let run
  try {
    run = spawnSync(CPA_PYTHON, [CPA_ENSURE, '--print-env'], { encoding: 'utf8', windowsHide: true, timeout: 90_000 })
  } catch (e) {
    return { error: `CPA 启动失败：${e?.message ?? e}` }
  }
  if (run.error) return { error: `CPA 启动失败（${CPA_PYTHON}）：${run.error.message}` }
  if (run.status !== 0) {
    const err = String(run.stderr ?? '').replace(/\s+/g, ' ').trim().slice(-200)

    return { error: `CPA 未就绪（ensure_cpa.py 退出 ${run.status}${err === '' ? '' : `：${err}`}）` }
  }
  const env = {}
  for (const line of String(run.stdout ?? '').split('\n')) {
    const m = /^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2].trim()
  }
  if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) return { error: 'ensure_cpa.py 没有输出 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN' }

  return { url: env.ANTHROPIC_BASE_URL, key: env.ANTHROPIC_AUTH_TOKEN }
}

const messagesUrl = baseUrl => {
  const base = new URL(baseUrl)
  const basePath = base.pathname.replace(/\/+$/, '')

  return { base, path: `${basePath}/v1/messages` }
}

/** 一次不带流的 POST /v1/messages。返回原文，key 不进任何日志。 */
const postMessages = (baseUrl, key, body) =>
  new Promise((resolve, reject) => {
    let target
    try {
      target = messagesUrl(baseUrl)
    } catch {
      reject(new Error('CPA 地址不合法'))

      return
    }
    const mod = target.base.protocol === 'https:' ? https : http
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = mod.request(
      {
        protocol: target.base.protocol,
        hostname: target.base.hostname,
        port: target.base.port || undefined,
        method: 'POST',
        path: target.path,
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          'anthropic-version': '2023-06-01',
          'x-api-key': key,
          authorization: `Bearer ${key}`,
        },
      },
      res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          if (text.length < 200_000) text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.setTimeout(180_000, () => req.destroy(new Error('重放超时')))
    req.end(payload)
  })

/** 还留着的会话文件数：守护据此决定还要不要继续跑。 */
const liveSessions = () => listSessionFiles(root).filter(f => readSessionFile(f) !== undefined).length

const usageOfText = text => {
  try {
    return usageFromEvent(JSON.parse(text))
  } catch {
    return undefined
  }
}

/**
 * 重放一次：先试 max_tokens=1；上游因 thinking.budget_tokens 嫌它太小（400）时，
 * 换成能通过的最小值再来一次，其余字段两次完全相同。
 */
const replayOne = async (cpa, session, now) => {
  let attempt = await postMessages(cpa.url, cpa.key, replayBodyOf(session.body, 1))
  let maxTokens = 1
  if (maxTokensTooSmall(attempt.status, attempt.text)) {
    const bigger = minMaxTokensOf(session.body)
    if (bigger !== null) {
      maxTokens = bigger
      attempt = await postMessages(cpa.url, cpa.key, replayBodyOf(session.body, bigger))
    }
  }

  return {
    status: attempt.status,
    maxTokens,
    usage: usageOfText(attempt.text),
    error: attempt.status >= 300 ? attempt.text.slice(0, 200) : undefined,
  }
}

/** 扫一遍：该删的删，该续的续一次。pending = 还留着、以后还可能续的会话数。 */
const scan = async ({ force = false, quiet = false } = {}) => {
  const settings = readSettings(root)
  const now = Date.now()
  const files = listSessionFiles(root)
  const out = { ok: true, enabled: settings.enabled, scanned: files.length, replayed: 0, dropped: 0, pending: 0, results: [] }
  if (!settings.enabled) return out
  const due = []
  for (const file of files) {
    const session = readSessionFile(file)
    if (session === undefined) {
      try {
        fs.unlinkSync(file)
      } catch {}
      out.dropped += 1
      continue
    }
    const d = decide(session, settings, now, { force })
    if (d.action === 'drop') {
      try {
        fs.unlinkSync(file)
      } catch {}
      out.dropped += 1
      if (!quiet) appendLog(root, { at: now, jobId: session.jobId, model: session.model, ok: false, status: 0, drop: d.reason, input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, hitRate: null, usd: 0 })
    } else if (d.action === 'skip') {
      out.pending += 1
    } else {
      due.push({ file, session })
    }
  }
  if (due.length === 0) return out
  const cpa = cpaEnv()
  if (cpa.error !== undefined) {
    out.error = cpa.error
    out.pending = liveSessions()

    return out
  }
  for (const { file, session } of due) {
    let result
    try {
      result = await replayOne(cpa, session, now)
    } catch (e) {
      result = { status: 0, usage: undefined, error: String(e?.message ?? e).slice(0, 200) }
    }
    const entry = logEntryOf({ jobId: session.jobId, model: session.model, status: result.status, usage: result.usage, now })
    if (result.error !== undefined) entry.error = result.error
    appendLog(root, entry)
    out.replayed += 1
    out.results.push({
      jobId: session.jobId,
      status: result.status,
      maxTokens: result.maxTokens ?? 1,
      input_tokens: entry.input_tokens,
      cache_read_input_tokens: entry.cache_read_input_tokens,
      output_tokens: entry.output_tokens,
      hitRate: entry.hitRate,
      usd: entry.usd,
      ...(result.error === undefined ? {} : { error: result.error }),
    })
    const next = afterReplay(session, result.usage, now)
    const drop = decide(next, settings, Date.now(), { force: false })
    if (drop.action === 'drop') {
      try {
        fs.unlinkSync(file)
      } catch {}
      out.dropped += 1
    } else {
      writeSession(root, next)
      if (drop.action === 'skip') out.pending += 1
    }
  }

  // 剩下的文件（含刚续过的）都要继续盯着，直到超时被删。
  out.pending = liveSessions()

  return out
}

// ── 单实例：pid 文件 ─────────────────────────────────────────────────────
const alive = pid => {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)

    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

const lockOwner = () => {
  try {
    const pid = Number(fs.readFileSync(pidPathOf(root), 'utf8').trim())

    return alive(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

const acquireLock = () => {
  const file = pidPathOf(root)
  fs.mkdirSync(root, { recursive: true })
  for (let i = 0; i < 2; i += 1) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)

      return true
    } catch (e) {
      if (e?.code !== 'EEXIST') return false
      const owner = lockOwner()
      if (owner !== undefined && owner !== process.pid) return false
      try {
        fs.unlinkSync(file)
      } catch {}
    }
  }

  return false
}

const releaseLock = () => {
  try {
    const pid = Number(fs.readFileSync(pidPathOf(root), 'utf8').trim())
    if (pid === process.pid) fs.unlinkSync(pidPathOf(root))
  } catch {}
}

/** 由 run-delegate 在作业结束时调用：有会话要保活且没有守护在跑，就 detached 起一个。 */
export const spawnDaemon = (dir = root) => {
  try {
    if (listSessionFiles(dir).length === 0) return false
    try {
      const pid = Number(fs.readFileSync(pidPathOf(dir), 'utf8').trim())
      if (alive(pid)) return false
    } catch {}
    const child = spawn(process.execPath, [path.join(here, 'keepalive.mjs')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, DELEGATE_KEEPALIVE_DIR: dir },
    })
    child.unref()

    return true
  } catch {
    return false
  }
}

const statusOf = () => {
  const settings = readSettings(root)
  const sessions = listSessionFiles(root).filter(f => readSessionFile(f) !== undefined).length
  const sum = summarizeLog(readLogText(root))
  const now = Date.now()

  return {
    ok: true,
    enabled: settings.enabled,
    intervalMinutes: settings.intervalMinutes,
    minTokens: settings.minTokens,
    maxHours: settings.maxHours,
    sessions,
    running: lockOwner() !== undefined,
    replaysToday: sum.replaysToday,
    costToday: Number(sum.costToday.toFixed(6)),
    replays: sum.replays,
    cost: Number(sum.cost.toFixed(6)),
    at: now,
  }
}

const daemonLoop = async () => {
  if (!acquireLock()) return { ok: false, error: 'another keepalive daemon is already running' }
  const bye = () => {
    releaseLock()
    process.exit(0)
  }
  process.on('exit', releaseLock)
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
  let lastError
  for (;;) {
    let result
    try {
      result = await scan({ force: false })
      lastError = undefined
    } catch (e) {
      result = { ok: false, error: String(e?.message ?? e), pending: 0 }
      lastError = result.error
    }
    // 没有待保活会话就收工：下一次作业结束时会再被拉起来。
    if ((result.pending ?? 0) === 0) {
      releaseLock()

      return { ok: result.ok !== false, stopped: true, ...(lastError === undefined ? {} : { error: lastError }) }
    }
    await new Promise(done => setTimeout(done, TICK_MS))
  }
}

const main = async () => {
  const args = process.argv.slice(2)
  if (args.includes('--status')) {
    say(statusOf())

    return 0
  }
  const at = args.indexOf('--set-enabled')
  if (at >= 0) {
    const on = String(args[at + 1] ?? '').trim().toLowerCase()
    const settings = writeSettings(root, { enabled: on === 'on' || on === 'true' || on === '1' })
    say({ ok: true, enabled: settings.enabled })

    return 0
  }
  if (args.includes('--once')) {
    const result = await scan({ force: true })
    say(result)

    return result.ok === false ? 1 : 0
  }
  const result = await daemonLoop()
  if (result?.ok === false && result.error !== undefined) {
    say(result)

    return 1
  }

  return 0
}

const invokedDirectly = () => {
  try {
    return process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.join(here, 'keepalive.mjs')
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  main()
    .then(code => process.exit(code ?? 0))
    .catch(e => {
      say({ ok: false, error: String(e?.message ?? e) })
      process.exit(1)
    })
}

export { scan, statusOf }
