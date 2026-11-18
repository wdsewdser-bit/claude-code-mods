// Offline replay of the decision-API idea on a real ctx-mod session directory.
// For every window switch W-1 -> W: the candidates are the tasks open at the end of W-1, the label is whether
// window W appended to that task, the input is the last three person requests up to the end of W-1.
// The decision scores are compared with the recency baseline (newest ledger entry first).
// Usage: node decision-replay.mjs <session dir> [...more dirs]   (keys: GEMINI_API_KEY* user variables)
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions'
const CRITERIA = ['Irrelevant to the current task', 'Potentially useful supporting context', 'Directly necessary for the current task']

const keys = (() => {
  const names = Array.from({ length: 32 }, (_, i) => (i === 0 ? 'GEMINI_API_KEY' : `GEMINI_API_KEY_${i + 1}`))
  const found = names.map(n => process.env[n]).filter(Boolean)
  if (found.length > 0 || process.platform !== 'win32') return found
  const script = `$a=@();foreach($n in @(${names.map(n => `'${n}'`).join(',')})){$v=[Environment]::GetEnvironmentVariable($n,'User');if($v){$a+=,$v}};[Console]::Write((ConvertTo-Json -InputObject @($a) -Compress))`
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }) || '[]')
})()

const jsonl = file => fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : [] } catch { return [] } })

const score = async (input, candidates) => {
  const questions = {}
  for (const c of candidates) {
    questions[c.id] = { type: 'score', instructions: `A coding session is switching to a fresh context window. How much does the next window need this item to continue the user's current work? Item (task): ${c.text.slice(0, 600)}`, criteria: CRITERIA }
  }
  for (const key of keys) {
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gemini-decision-1', input, questions }), signal: AbortSignal.timeout(15000) })
    if (!res.ok) continue
    const answers = (await res.json()).answers ?? {}
    return Object.fromEntries(candidates.map(c => [c.id, (answers[c.id]?.score ?? NaN) / 2]))
  }
  throw new Error('no key worked')
}

/** Probability a random positive outranks a random negative; ties count half. */
const auc = (rows, by) => {
  const pos = rows.filter(r => r.label), neg = rows.filter(r => !r.label)
  let sum = 0
  for (const p of pos) for (const n of neg) sum += p[by] > n[by] ? 1 : p[by] === n[by] ? 0.5 : 0
  return sum / (pos.length * neg.length)
}
const hitAt = (rows, by, k) => [...rows].sort((a, b) => b[by] - a[by]).slice(0, k).filter(r => r.label).length / Math.min(k, rows.filter(r => r.label).length)

const RICH = process.env.RICH === '1'
const OUT = path.join(process.env.TEMP ?? '.', 'decision-replay-rows.jsonl')
let missing = 0
for (const dir of process.argv.slice(2)) {
  missing = 0
  const names = fs.readdirSync(dir)
  const entries = names.filter(n => /^(ledger|archive-\d+)\.jsonl$/.test(n)).flatMap(n => jsonl(path.join(dir, n))).sort((a, b) => a.seq - b.seq)
  const requests = names.filter(n => n.startsWith('history-w') && n.endsWith('.jsonl')).flatMap(n => jsonl(path.join(dir, n)))
    .filter(r => r.role === 'user' && r.isPerson === true && r.door === undefined).sort((a, b) => a.seq - b.seq)
  const lastWindow = Math.max(...entries.map(e => e.window))
  const results = []
  for (let w = 2; w <= lastWindow; w += 1) {
    const latest = new Map()
    // Snapshots and backfills are not work: they neither move a task's recency nor count as touching it.
    const real = e => !/^(保活快照|〔补记〕)/.test(String(e.text))
    const status = new Map(), lastReal = new Map(), nextStep = new Map()
    for (const e of entries) if (e.window <= w - 1) {
      status.set(e.task_id, e)
      if (real(e)) lastReal.set(e.task_id, e)
      if (typeof e.next_step === 'string' && e.next_step !== '') nextStep.set(e.task_id, e.next_step)
    }
    const open = [...status.values()].filter(e => e.status === 'in_progress' || e.status === 'blocked')
    const touched = new Set(entries.filter(e => e.window === w && real(e)).map(e => e.task_id))
    const rows = open.map((e, i) => {
      const r = lastReal.get(e.task_id) ?? e
      const rich = RICH ? `（${w - 1 - r.window} 个窗口没有实质更新）下一步：${String(nextStep.get(e.task_id) ?? '无').slice(0, 200)}。` : ''
      return { id: `task_${i}`, task: e.task_id, text: `${e.task_id}：${e.title}${rich}最新：${String(r.text).slice(0, 300)}`, recency: r.seq, label: touched.has(e.task_id) }
    })
    if (rows.length < 2 || !rows.some(r => r.label) || rows.every(r => r.label)) continue
    const input = requests.filter(r => r.window <= w - 1).slice(-3).map(r => String(r.text).slice(0, 2000)).join('\n---\n')
    try {
      const s = await score(input, rows)
      for (const r of rows) r.api = Number.isFinite(s[r.id]) ? s[r.id] : (missing++, -1)
      fs.appendFileSync(OUT, rows.map(r => JSON.stringify({ dir: path.basename(dir), rich: RICH, w, task: r.task, api: r.api, recency: r.recency, label: r.label })).join('\n') + '\n')
    } catch (error) {
      console.error(`w${w}: ${error.message}`)
      continue
    }
    // Override: recency's top two, then the API's best among the rest.
    const byRec = [...rows].sort((a, b) => b.recency - a.recency)
    const rest = byRec.slice(2).sort((a, b) => b.api - a.api)
    const mixTop = [...byRec.slice(0, 2), ...rest.slice(0, 1)]
    const k = Math.min(3, rows.filter(r => r.label).length)
    const hitMix = mixTop.filter(r => r.label).length / k
    const outside = byRec.slice(3).some(r => r.label)
    results.push({ hitMix, outside, w, n: rows.length, pos: rows.filter(r => r.label).length, aucApi: auc(rows, 'api'), aucRec: auc(rows, 'recency'), hitApi: hitAt(rows, 'api', 3), hitRec: hitAt(rows, 'recency', 3) })
  }
  const mean = (key, list = results) => (list.reduce((s, r) => s + r[key], 0) / list.length).toFixed(3)
  const hard = results.filter(r => r.outside)
  console.log(JSON.stringify({ rich: RICH, missing, top3Mix: mean('hitMix'), hardWindows: hard.length, hardTop3Rec: hard.length ? mean('hitRec', hard) : null, hardTop3Mix: hard.length ? mean('hitMix', hard) : null }))
  console.log(JSON.stringify({ dir: path.basename(dir), windows: results.length, avgOpen: mean('n'), avgTouched: mean('pos'), aucApi: mean('aucApi'), aucRecency: mean('aucRec'), top3Api: mean('hitApi'), top3Recency: mean('hitRec'), apiBetter: results.filter(r => r.aucApi > r.aucRec).length, recencyBetter: results.filter(r => r.aucApi < r.aucRec).length }))
}
