// ctx-mod decision shadow run: scores the handoff's candidates with the Gemini Decisions API and only logs the scores.
// Started detached when a handoff is built; it never changes the handoff. Input on stdin (JSON):
//   { dir, window, input, candidates: [{ id, kind, shown, text }] }
// Output: one line appended to <dir>/decision-shadow.jsonl with ids, kinds, scores and timing (never the texts or keys).
// Off by default: set CTX_MOD_DECISION_SHADOW=1 to run it.
// Keys: the same GEMINI_API_KEY, GEMINI_API_KEY_2 … user variables Harness reads (or its decision_api.api_key_env prefix).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions'
const MODEL = 'gemini-decision-1'
const TIMEOUT_MS = 6000
const CRITERIA = ['Irrelevant to the current task', 'Potentially useful supporting context', 'Directly necessary for the current task']

const readStdin = () => fs.readFileSync(0, 'utf8')

/** Harness's decision settings, when its config names a different key prefix or endpoint. */
const harnessSettings = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harness', 'config.json'), 'utf8'))
    const d = raw.decision_api ?? {}
    const endpoint = typeof d.endpoint === 'string' && /^https:\/\//.test(d.endpoint) ? d.endpoint : ENDPOINT
    const prefix = typeof d.api_key_env === 'string' && /^[A-Za-z0-9_]{1,128}$/.test(d.api_key_env) ? d.api_key_env : 'GEMINI_API_KEY'
    return { endpoint, prefix }
  } catch {
    return { endpoint: ENDPOINT, prefix: 'GEMINI_API_KEY' }
  }
}

const keysOf = prefix => {
  const names = Array.from({ length: 32 }, (_, i) => (i === 0 ? prefix : `${prefix}_${i + 1}`))
  const keys = names.map(name => process.env[name]).filter(value => typeof value === 'string' && value.trim() !== '')
  if (keys.length === 0 && process.platform === 'win32') {
    // User variables set after this process tree started are only in the registry.
    const script = `$a=@();foreach($n in @(${names.map(n => `'${n}'`).join(',')})){$v=[Environment]::GetEnvironmentVariable($n,'User');if(-not [string]::IsNullOrWhiteSpace($v)){$a+=,$v}};[Console]::Write((ConvertTo-Json -InputObject @($a) -Compress))`
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 8000, windowsHide: true })
      for (const key of JSON.parse(out || '[]')) if (typeof key === 'string' && key.trim() !== '') keys.push(key.trim())
    } catch {
      // No keys found: the run logs itself as unavailable.
    }
  }
  return [...new Set(keys)]
}

const log = (dir, row) => {
  try {
    fs.appendFileSync(path.join(dir, 'decision-shadow.jsonl'), JSON.stringify(row) + '\n')
  } catch {
    // Nowhere to report to: a shadow run must never disturb the session.
  }
}

const main = async () => {
  const job = JSON.parse(readStdin())
  const started = Date.now()
  const base = { ts: started, window: job.window, count: job.candidates.length }
  const kinds = Object.fromEntries(job.candidates.map(c => [c.id, c.kind]))
  const shown = Object.fromEntries(job.candidates.map(c => [c.id, c.shown === true]))
  if (job.candidates.length === 0) return
  const { endpoint, prefix } = harnessSettings()
  const keys = keysOf(prefix)
  if (keys.length === 0) return log(job.dir, { ...base, ok: false, reason: 'no key' })

  const questions = {}
  for (const c of job.candidates.slice(0, 200)) {
    questions[c.id] = {
      type: 'score',
      instructions: `A coding session is switching to a fresh context window. How much does the next window need this item to continue the user's current work? Item (${c.kind}): ${String(c.text).slice(0, 600)}`,
      criteria: CRITERIA,
    }
  }
  const body = JSON.stringify({ model: MODEL, input: String(job.input).slice(0, 60000), questions })
  let reason = 'all keys failed'
  for (const [index, key] of keys.entries()) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        reason = `http ${res.status}`
        if ([401, 403, 429].includes(res.status)) continue
        break
      }
      const answers = (await res.json()).answers ?? {}
      const scores = {}
      for (const id of Object.keys(questions)) {
        const raw = answers[id]?.score
        if (typeof raw === 'number' && Number.isFinite(raw)) scores[id] = Math.max(0, Math.min(1, raw / (CRITERIA.length - 1)))
      }
      return log(job.dir, { ...base, ok: true, ms: Date.now() - started, keyIndex: index, kinds, shown, scores })
    } catch (error) {
      reason = error?.name === 'TimeoutError' ? 'timeout' : 'network'
    }
  }
  log(job.dir, { ...base, ok: false, ms: Date.now() - started, reason })
}

main().catch(() => {})
