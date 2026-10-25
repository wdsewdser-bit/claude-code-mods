// 查 ChatGPT/Codex 订阅额度：经 CPA 管理接口代理 wham/usage；失败时退回 CPA 记下的最近响应头。
// 管理 key：环境变量 CPA_MANAGEMENT_KEY，或 ~/.claude/delegate/cpa-mgmt.key。输出一行 JSON。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const BASE = process.env.CPA_BASE ?? 'http://127.0.0.1:8317'
const out = v => process.stdout.write(JSON.stringify(v) + '\n')

const keyOf = () => {
  if (process.env.CPA_MANAGEMENT_KEY) return process.env.CPA_MANAGEMENT_KEY.trim()
  try {
    return readFileSync(`${homedir()}/.claude/delegate/cpa-mgmt.key`, 'utf8').trim()
  } catch {
    return ''
  }
}

const labelOf = secs => (secs === 18000 ? '5 小时' : secs === 604800 ? '本周' : secs >= 86400 ? `${Math.round(secs / 86400)} 天` : `${Math.round(secs / 3600)} 小时`)

const fromWindow = (w, prefix = '') => {
  if (!w || typeof w.used_percent !== 'number') return undefined
  const resetAt = typeof w.reset_at === 'number' ? w.reset_at * 1000 : typeof w.reset_after_seconds === 'number' ? Date.now() + w.reset_after_seconds * 1000 : undefined
  return { label: prefix + labelOf(w.limit_window_seconds), used: w.used_percent, resetAt }
}

const fromUsage = b => {
  const windows = []
  const add = (rl, prefix) => {
    for (const w of [rl?.primary_window, rl?.secondary_window]) {
      const x = fromWindow(w, prefix)
      if (x) windows.push(x)
    }
  }
  add(b.rate_limit, '')
  for (const extra of b.additional_rate_limits ?? []) add(extra.rate_limit, `${extra.limit_name ?? extra.metered_feature ?? '附加'} `)
  return { plan: b.plan_type ?? '', limitReached: b.rate_limit?.limit_reached === true, windows }
}

const fromSignals = s => {
  const windows = []
  for (const side of ['Primary', 'Secondary']) {
    const used = Number(s[`X-Codex-${side}-Used-Percent`])
    const mins = Number(s[`X-Codex-${side}-Window-Minutes`])
    if (!Number.isFinite(used) || !Number.isFinite(mins)) continue
    const at = Number(s[`X-Codex-${side}-Reset-At`])
    windows.push({ label: labelOf(mins * 60), used, resetAt: Number.isFinite(at) ? at * 1000 : undefined })
  }
  return { plan: s['X-Codex-Plan-Type'] ?? '', limitReached: false, windows }
}

const main = async () => {
  const key = keyOf()
  if (key === '') return out({ ok: false, error: '没有 CPA 管理 key（~/.claude/delegate/cpa-mgmt.key）' })
  const auth = { Authorization: `Bearer ${key}` }
  const res = await fetch(`${BASE}/v0/management/auth-files`, { headers: auth, signal: AbortSignal.timeout(8000) })
  if (!res.ok) return out({ ok: false, error: `CPA auth-files 返回 ${res.status}` })
  const files = ((await res.json()).files ?? []).filter(f => f.provider === 'codex' && !f.disabled)
  const f = files.find(x => x.status === 'active' || x.status === 'ready') ?? files[0]
  if (!f) return out({ ok: false, error: 'CPA 里没有 Codex 凭据' })
  try {
    const call = await fetch(`${BASE}/v0/management/api-call`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        auth_index: f.auth_index,
        method: 'GET',
        url: 'https://chatgpt.com/backend-api/wham/usage',
        header: {
          Authorization: 'Bearer $TOKEN$',
          Accept: 'application/json',
          'User-Agent': 'codex_cli_rs/0.76.0',
          ...(f.id_token?.chatgpt_account_id ? { 'Chatgpt-Account-Id': f.id_token.chatgpt_account_id } : {}),
        },
      }),
    })
    const d = await call.json()
    if (d.status_code === 200) {
      const q = fromUsage(JSON.parse(d.body))
      if (q.windows.length > 0) return out({ ok: true, source: 'live', at: Date.now(), ...q })
    }
  } catch {}
  const s = f.quota?.signals
  if (s) {
    const q = fromSignals(s)
    if (q.windows.length > 0) return out({ ok: true, source: 'cached', at: Date.parse(f.quota.observed_at) || Date.now(), ...q })
  }
  out({ ok: false, error: '查不到额度（wham/usage 失败，CPA 也没记下响应头）' })
}

main().catch(e => out({ ok: false, error: `CPA 连不上：${e?.cause?.code ?? e?.message ?? e}` }))
