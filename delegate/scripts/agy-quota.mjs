// 查 Antigravity 订阅额度：官方 agy CLI 的 /usage 命令（print 模式直接返回，不调模型、不耗 token）。
// 输出一行 JSON，形状和 gpt-quota.mjs 相同（normalizeQuota 能直接读）：windows 里 used 是已用百分比。
import { spawnSync } from 'node:child_process'
import { agyExe } from './run-agy.mjs'

const out = v => process.stdout.write(JSON.stringify(v) + '\n')

// 组名和窗口名尽量缩短，按钮栏和面板都窄。
const groupLabel = name =>
  /^Gemini Models$/i.test(name) ? 'Gemini' : /Claude and GPT/i.test(name) ? 'Claude/GPT' : name.replace(/^Gemini 4 /, '')
const windowLabel = w => (w === 'weekly' ? '本周' : w === '5h' || w === 'five_hour' ? '5 小时' : w)

export const windowsOf = data => {
  const windows = []
  for (const g of Array.isArray(data?.groups) ? data.groups : []) {
    for (const b of Array.isArray(g?.buckets) ? g.buckets : []) {
      if (typeof b?.remaining_fraction !== 'number') continue
      const win = typeof b.window === 'string' ? b.window : /5-?hour|five/i.test(String(b.name)) ? '5h' : 'weekly'
      const resetAt = Date.parse(b.reset_time)
      windows.push({
        label: `${groupLabel(String(g.name ?? ''))} ${windowLabel(win)}`,
        used: Math.round((1 - b.remaining_fraction) * 1000) / 10,
        ...(Number.isFinite(resetAt) ? { resetAt } : {}),
      })
    }
  }
  return windows
}

const main = () => {
  const exe = agyExe()
  const run = spawnSync(exe, ['--print=/usage', '--output-format', 'json'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (run.error) return out({ ok: false, error: `agy 启动失败：${run.error.message}` })
  let parsed
  try {
    parsed = JSON.parse(String(run.stdout).trim().split('\n').at(-1) ?? '')
  } catch {
    return out({ ok: false, error: `agy /usage 没有返回 JSON（退出 ${run.status}）：${String(run.stderr).trim().slice(-120)}` })
  }
  const windows = windowsOf(parsed?.command?.data)
  if (windows.length === 0) return out({ ok: false, error: String(parsed?.response ?? 'agy /usage 没有额度数据').slice(0, 120) })
  out({ ok: true, source: 'live', at: Date.now(), plan: '', limitReached: windows.some(w => w.used >= 100), windows })
}

if (process.argv[1] && /agy-quota\.mjs$/.test(process.argv[1])) main()
