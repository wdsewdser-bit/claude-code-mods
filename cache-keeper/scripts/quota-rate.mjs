#!/usr/bin/env node
// 5 小时额度换算：每涨 1% 花了多少加权成本，推算一个窗口能装多少 Opus。
//
// 额度进度来自 cache-keeper 记下的 rate_limits（~/.claude/cache-keeper/raw），
// 用量来自 ~/.claude/projects 的会话记录（主线程 + 子代理）和保活 fork 的记录。
// 加权（Opus 输入 token = 1）：输入 1，输出 5，缓存读 0.1，缓存写 2；
// Sonnet 按 Opus 的一半；Haiku 和外部模型不占 Opus 额度，只列出不计入。
//
// 用法：node quota-rate.mjs [--window <resetsAt ISO>] [--step 5] [--data <cache-keeper 数据目录>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const STEP = Math.max(1, Number(flag('step', 5)))
const dataDir = flag('data', path.join(os.homedir(), '.claude', 'cache-keeper'))
const WINDOW_MS = 5 * 3_600_000

const W = { input: 1, output: 5, read: 0.1, write: 2 }
const weightOf = model => {
  if (/opus/i.test(model)) return 1
  if (/sonnet/i.test(model)) return 0.5
  return 0
}
const classOf = model => (/opus/i.test(model) ? 'opus' : /sonnet/i.test(model) ? 'sonnet' : /haiku/i.test(model) ? 'haiku' : 'other')

const walk = (dir, ext, out = []) => {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, ext, out)
    else if (e.name.endsWith(ext)) out.push(p)
  }
  return out
}
const lines = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)

// ---- 额度时间线 ----
const points = []
const windows = new Set()
for (const f of walk(path.join(dataDir, 'raw'), '.jsonl')) {
  for (const line of lines(f)) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    const t = Date.parse(o.timestamp)
    if (!Number.isFinite(t)) continue
    const add = (limits, at) => {
      for (const l of limits ?? []) {
        if (l.kind !== 'five_hour' || !l.resetsAt) continue
        windows.add(l.resetsAt)
        points.push({ t: at, p: l.percentUsed, reset: l.resetsAt })
      }
    }
    add(o.rate_limits_before, t)
    add(o.rate_limits_after, t + (Number(o.duration_ms) || 0))
  }
}
if (points.length === 0) {
  console.error('没找到额度记录：先让 cache-keeper 跑一阵。')
  process.exit(1)
}
const resetsAt = flag('window', [...windows].sort().at(-1))
const resetMs = Date.parse(resetsAt)
const startMs = resetMs - WINDOW_MS

const raw = points.filter(x => x.reset === resetsAt).sort((a, b) => a.t - b.t)
const line = [{ t: startMs, p: 0 }]
for (const x of raw) {
  if (x.p > line.at(-1).p) line.push({ t: x.t, p: x.p })
}
if (line.length < 2) {
  console.error('这个窗口里还没有额度上涨的记录。')
  process.exit(1)
}

// ---- 用量 ----
const seen = new Set()
const usage = [] // { t, cls, units, tokens }
const take = (t, model, u) => {
  if (t < startMs || t > resetMs) return
  const cls = classOf(model)
  const input = u.input_tokens ?? 0
  const output = u.output_tokens ?? 0
  const read = u.cache_read_input_tokens ?? 0
  const write = u.cache_creation_input_tokens ?? 0
  usage.push({
    t,
    cls,
    tokens: input + output + read + write,
    units: weightOf(model) * (W.input * input + W.output * output + W.read * read + W.write * write),
  })
}
for (const f of walk(path.join(os.homedir(), '.claude', 'projects'), '.jsonl')) {
  if (fs.statSync(f).mtimeMs < startMs) continue
  for (const l of lines(f)) {
    if (!l.includes('"usage"')) continue
    let o
    try { o = JSON.parse(l) } catch { continue }
    const m = o.message
    if (!m?.usage || !o.timestamp) continue
    const key = `${m.id ?? ''}|${o.requestId ?? ''}|${m.usage.output_tokens ?? ''}`
    if (m.id) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    take(Date.parse(o.timestamp), m.model ?? 'unknown', m.usage)
  }
}
// 保活 fork 不进会话记录，从 cache-keeper 自己的记录里补。
for (const f of walk(path.join(dataDir, 'raw'), '.jsonl')) {
  for (const l of lines(f)) {
    let o
    try { o = JSON.parse(l) } catch { continue }
    if (o.source !== 'keeper') continue
    take(Date.parse(o.timestamp), o.model ?? 'unknown', o)
  }
}
usage.sort((a, b) => a.t - b.t)

const between = (a, b, pick) =>
  usage.filter(x => x.t > a && x.t <= b).reduce((s, x) => s + pick(x), 0)
const fmt = n => (n >= 1e8 ? `${(n / 1e8).toFixed(2)} 亿` : `${(n / 1e6).toFixed(1)}M`)
const clock = ms => new Date(ms).toTimeString().slice(0, 5)

// ---- 分段：每涨 STEP 个百分点一段 ----
const segs = []
let from = line[0]
for (const pt of line.slice(1)) {
  if (pt.p - from.p >= STEP || pt === line.at(-1)) {
    if (pt.p > from.p) segs.push({ a: from, b: pt })
    from = pt
  }
}

const rate = (a, b) => {
  const pct = b.p - a.p
  const units = between(a.t, b.t, x => x.units)
  const opusRaw = between(a.t, b.t, x => (x.cls === 'opus' ? x.tokens : 0))
  return { pct, units, opusRaw, perPct: units / pct }
}

console.log(`窗口 ${clock(startMs)} → ${clock(resetMs)}，当前 ${line.at(-1).p}%（记录时间 ${clock(line.at(-1).t)}）`)
console.log('加权单位：Opus 输入 token = 1（输入 1 / 输出 5 / 缓存读 0.1 / 缓存写 2；Sonnet 减半）\n')
console.log('分段（每 ' + STEP + '% 左右）')
for (const s of segs) {
  const r = rate(s.a, s.b)
  console.log(
    `  ${clock(s.a.t)}–${clock(s.b.t)}  ${s.a.p}%→${s.b.p}%  加权 ${fmt(r.units)}  Opus 原始 ${fmt(r.opusRaw)}  每 1% ≈ ${fmt(r.perPct)}  窗口 ≈ ${fmt(r.perPct * 100)}`,
  )
}

const all = rate(line[0], line.at(-1))
console.log(`\n整个窗口至今：${all.pct}%  加权 ${fmt(all.units)}  每 1% ≈ ${fmt(all.perPct)}  → 满窗口 ≈ ${fmt(all.perPct * 100)} 加权 Opus 单位`)

const last = line.at(-1)
const back = [...line].reverse().find(x => last.p - x.p >= 10) ?? line[0]
const recent = rate(back, last)
console.log(`最近 ${recent.pct}%（${clock(back.t)}–${clock(last.t)}）：每 1% ≈ ${fmt(recent.perPct)} → 满窗口 ≈ ${fmt(recent.perPct * 100)}`)
console.log(`按最近用法，剩余 ${100 - last.p}% 还能装 ≈ ${fmt(recent.perPct * (100 - last.p))} 加权单位`)

// 外部模型和 Haiku 只列出，不计入。
const byCls = {}
for (const x of usage) byCls[x.cls] = (byCls[x.cls] ?? 0) + x.tokens
console.log('\n本窗口本机记录的原始 token：' + Object.entries(byCls).map(([k, v]) => `${k} ${fmt(v)}`).join('，'))
console.log('说明：只含本机的会话记录；别的设备或已删除的会话不在内，所以窗口估值会偏大一点。额度进度是取整的，短区间误差大，看「整个窗口至今」更稳。')

// 用你在应用里看到的「今日 Opus」读数校准：窗口开始前一个读数、现在一个读数（单位 M）。
// node quota-rate.mjs --app-base 407.1 --app-now 551.4 [--sonnet-base 161.2 --sonnet-now 171.8]
const appBase = Number(flag('app-base', NaN))
const appNow = Number(flag('app-now', NaN))
if (Number.isFinite(appBase) && Number.isFinite(appNow)) {
  const sonnet = (Number(flag('sonnet-now', 0)) - Number(flag('sonnet-base', 0))) / 2
  const tokens = (appNow - appBase + (Number.isFinite(sonnet) ? sonnet : 0)) * 1e6
  const perPct = tokens / line.at(-1).p
  console.log(`\n按应用读数校准：Opus 新增 ${(appNow - appBase).toFixed(1)}M${sonnet ? ` + Sonnet 折半 ${sonnet.toFixed(1)}M` : ''}，涨了 ${line.at(-1).p}%`)
  console.log(`  每 1% ≈ ${fmt(perPct)}  → 满窗口 ≈ ${fmt(perPct * 100)}（应用口径的原始 token，含缓存读写）`)
  const mine = usage.filter(x => x.cls === 'opus').reduce((s, x) => s + x.tokens, 0)
  console.log(`  本机记录只覆盖应用读数的 ${Math.round((mine / ((appNow - appBase) * 1e6)) * 100)}%，上面的加权数据因此偏小，以这一段为准。`)
}
