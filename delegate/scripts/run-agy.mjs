// delegate_agy: one delegated job through the official Antigravity CLI (agy.exe, AGY subscription).
// No proxy, no CPA, no token handling: agy uses its own cached sign-in. stdin: the job JSON;
// stdout: one JSON line with the same shape run-delegate.mjs gives (ok/text/sessionId/turns/ms/models/terminal).
// A job with jobId also gets ~/.claude/delegate/jobs/<jobId>/ like the other channels: status.json,
// events.jsonl (agy's events translated to the assistant/result lines the panel reads), result.json;
// the cancel file stops the child tree, inbox/*.json messages become follow-up turns of the same conversation.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const home = os.homedir()
const JOBS_ROOT = process.env.DELEGATE_JOBS_DIR || path.join(home, '.claude', 'delegate', 'jobs')
const MAX_EVENT_BYTES = 512 * 1024
const STATUS_EVERY_MS = 400
const HEARTBEAT_MS = 5000
const POLL_MS = 500
const TIME_LIMIT_MS = 2 * 60 * 60 * 1000
// Windows caps a command line at 32767 chars; a longer task goes through a file the agent reads first.
const ARG_MAX = 24_000
const TERMINAL_RE = /TASK_TERMINAL:\s*[*`_]*\s*(completed|blocked|failed)/gi

export const agyExe = () => {
  if (process.env.DELEGATE_AGY) return process.env.DELEGATE_AGY
  const local = process.env.LOCALAPPDATA
  const exe = local ? path.join(local, 'agy', 'bin', 'agy.exe') : ''
  return exe !== '' && fs.existsSync(exe) ? exe : 'agy'
}

const terminalOf = text => {
  if (typeof text !== 'string') return null
  let found = null
  for (const m of text.matchAll(TERMINAL_RE)) found = m[1].toLowerCase()
  return found
}

const finish = (value, code = 0) => {
  process.stdout.write(JSON.stringify(value) + '\n')
  process.exit(code)
}

const readStdin = () =>
  new Promise((resolve, reject) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', d => (s += d))
    process.stdin.on('end', () => resolve(s))
    process.stdin.on('error', reject)
  })

const READ_RULE =
  '【只读任务】这次只允许读取和分析：不要创建、修改、删除任何文件，不要运行会改动文件或系统状态的命令。'
const REPORT_RULE = [
  '做完后给出最终报告：做了什么、改了哪些文件（绝对路径）、怎么验证的、还有什么没验证。',
  '报告最后单独一行写 TASK_TERMINAL: completed（完成）、TASK_TERMINAL: blocked（缺信息或权限无法继续）或 TASK_TERMINAL: failed（尝试后失败）。',
].join('\n')

export const promptOf = (job, first) => {
  const task = String(job.task ?? '')
  if (!first) return task
  return [job.mode === 'work' ? '' : READ_RULE, task, REPORT_RULE].filter(Boolean).join('\n\n')
}

export const argsOf = (job, prompt, conversation) => {
  const args = [`--print=${prompt}`, '--output-format', 'stream-json']
  if (typeof job.model === 'string' && job.model !== '') args.push('--model', job.model)
  if (conversation) args.push('--conversation', conversation)
  if (job.mode === 'work') args.push('--dangerously-skip-permissions')
  else args.push('--mode', 'plan')
  return args
}

// agy event → the Claude-stream-shaped lines liveEvents/usageOf already read.
export const createTranslator = model => {
  let text = ''
  let msg = 0
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  let context = 0
  let turns = 0
  const assistant = (content, u) => ({
    type: 'assistant',
    message: { id: `agy-${++msg}`, model, role: 'assistant', content, ...(u ? { usage: u } : {}) },
  })
  return {
    usage,
    get context() { return context },
    get turns() { return turns },
    get text() { return text },
    on(o) {
      const out = []
      if (o?.event === 'step_update') {
        const s = o.step_update ?? {}
        if (s.step_type === 'agent_response') {
          if (typeof s.text_delta === 'string') text += s.text_delta
          if (s.state === 'DONE') {
            turns += 1
            const u = s.usage ?? {}
            const inp = Number(u.input_tokens) || 0
            const cr = Number(u.cache_read_tokens) || 0
            const op = (Number(u.output_tokens) || 0) + (Number(u.thinking_tokens) || 0)
            usage.input += inp
            usage.cacheRead += cr
            usage.output += op
            if (inp + cr > 0) context = inp + cr
            const blocks = text.trim() === '' ? [] : [{ type: 'text', text }]
            out.push(assistant(blocks, { input_tokens: inp, cache_read_input_tokens: cr, output_tokens: op }))
            text = ''
          }
        } else if (s.step_type === 'tool' && s.state === 'ACTIVE') {
          const info = s.tool_info ?? {}
          out.push(assistant([{ type: 'tool_use', name: String(s.tool_name ?? info.name ?? 'tool'), input: info.parameters ?? {} }]))
        }
      }
      return out
    },
  }
}

const createControl = (jobId, job) => {
  const dir = path.join(JOBS_ROOT, jobId)
  const files = {
    dir,
    status: path.join(dir, 'status.json'),
    events: path.join(dir, 'events.jsonl'),
    rotated: path.join(dir, 'events.1.jsonl'),
    result: path.join(dir, 'result.json'),
    inbox: path.join(dir, 'inbox'),
    cancel: path.join(dir, 'cancel'),
    errors: path.join(dir, 'errors.log'),
  }
  try { fs.mkdirSync(files.inbox, { recursive: true }) } catch {}
  let bytes = 0
  try { bytes = fs.statSync(files.events).size } catch {}
  const state = {
    jobId,
    pid: process.pid,
    childPid: null,
    sessionId: job.resume ? String(job.resume) : null,
    phase: 'starting',
    stream: job.stream === true,
    tier: 'agy',
    model: typeof job.model === 'string' ? job.model : null,
    cwd: typeof job.cwd === 'string' && job.cwd !== '' ? job.cwd : process.cwd(),
    startedAt: Date.now(),
    updatedAt: 0,
    turns: 0,
    lastTool: null,
    lastText: '',
    askWaitMs: 0,
    outputTokens: 0,
    contextTokens: 0,
    usage: null,
  }
  const noteError = (what, e) => {
    try { fs.appendFileSync(files.errors, `${new Date().toISOString()} ${what}: ${e?.message ?? e}\n`) } catch {}
  }
  let lastWrite = 0
  const write = force => {
    const now = Date.now()
    if (!force && now - lastWrite < STATUS_EVERY_MS) return
    lastWrite = now
    state.updatedAt = now
    try { fs.writeFileSync(files.status, JSON.stringify(state)) } catch (e) { noteError('status', e) }
  }
  const append = obj => {
    const line = JSON.stringify(obj)
    try {
      if (bytes > MAX_EVENT_BYTES) {
        fs.renameSync(files.events, files.rotated)
        bytes = 0
      }
      fs.appendFileSync(files.events, line + '\n')
      bytes += Buffer.byteLength(line) + 1
    } catch (e) { noteError('events', e) }
  }
  const drain = () => {
    let names = []
    try { names = fs.readdirSync(files.inbox).filter(n => n.endsWith('.json')).sort() } catch { return [] }
    const out = []
    for (const name of names) {
      const file = path.join(files.inbox, name)
      let text = ''
      try {
        const o = JSON.parse(fs.readFileSync(file, 'utf8'))
        text = typeof o?.text === 'string' ? o.text : typeof o?.message === 'string' ? o.message : ''
      } catch { continue }
      try { fs.unlinkSync(file) } catch {}
      if (text.trim() !== '') out.push(text)
    }
    return out
  }
  const isCancelled = () => { try { return fs.existsSync(files.cancel) } catch { return false } }
  const heartbeat = setInterval(() => write(true), HEARTBEAT_MS)
  heartbeat.unref?.()
  write(true)
  return {
    files, state, write, append, drain, isCancelled, noteError,
    finish(value) {
      const endedAt = Date.now()
      try { fs.writeFileSync(files.result, JSON.stringify({ ...value, jobId, endedAt })) } catch (e) { noteError('result', e) }
      state.phase = value.error === 'cancelled' ? 'cancelled' : value.ok ? 'done' : 'failed'
      state.endedAt = endedAt
      if (typeof value.sessionId === 'string' && value.sessionId !== '') state.sessionId = value.sessionId
      if (typeof value.turns === 'number') state.turns = value.turns
      if (typeof value.text === 'string' && value.text !== '') state.lastText = value.text.slice(0, 600)
      write(true)
      clearInterval(heartbeat)
    },
  }
}

const killTree = pid => {
  if (!pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    else process.kill(pid, 'SIGTERM')
  } catch {}
}

// One agy turn. Resolves with what the result event said (or why there was none).
const runTurn = (job, prompt, conversation, control, tr, deadline) =>
  new Promise(resolve => {
    const exe = agyExe()
    const cwd = typeof job.cwd === 'string' && job.cwd !== '' ? job.cwd : process.cwd()
    let child
    try {
      child = spawn(exe, argsOf(job, prompt, conversation), { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ error: `agy 启动失败（${exe}）：${e?.message ?? e}` })
      return
    }
    if (control) { control.state.childPid = child.pid ?? null; control.state.phase = 'working'; control.write(true) }
    let buf = ''
    let stderr = ''
    let result = null
    let convId = conversation || null
    let cancelled = false
    let timedOut = false
    const onLine = line => {
      if (line.trim() === '') return
      let o
      try { o = JSON.parse(line) } catch { return }
      if (o.event === 'init' && typeof o.conversation_id === 'string') {
        convId = o.conversation_id
        if (control) { control.state.sessionId = convId; control.write(true) }
      }
      if (o.event === 'result') { result = o.result ?? {}; return }
      for (const ev of tr.on(o)) {
        control?.append(ev)
        if (control) {
          const blocks = ev.message.content
          const tool = blocks.find(b => b.type === 'tool_use')
          if (tool) control.state.lastTool = tool.name
          const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('').trim()
          if (text) control.state.lastText = text.slice(0, 600)
          control.state.turns = tr.turns
          control.state.outputTokens = tr.usage.output
          control.state.contextTokens = tr.context
          control.state.usage = { ...tr.usage }
          control.write(false)
        }
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1) }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000) })
    const timer = setInterval(() => {
      if (!cancelled && control?.isCancelled()) { cancelled = true; killTree(child.pid) }
      if (!timedOut && Date.now() > deadline) { timedOut = true; killTree(child.pid) }
    }, POLL_MS)
    child.on('error', e => { stderr += `\n${e?.message ?? e}` })
    child.on('close', code => {
      clearInterval(timer)
      if (buf.trim() !== '') onLine(buf)
      resolve({ code, result, convId, stderr, cancelled, timedOut })
    })
  })

const main = async () => {
  let job
  try { job = JSON.parse(await readStdin()) } catch { return finish({ ok: false, error: 'the job on stdin is not JSON' }, 2) }
  const started = Date.now()
  const control = job.jobId ? createControl(String(job.jobId), job) : null
  const model = typeof job.model === 'string' ? job.model : ''
  const tr = createTranslator(model)
  const deadline = started + TIME_LIMIT_MS
  let conversation = job.resume ? String(job.resume) : null
  let prompt = promptOf(job, !conversation)
  if (prompt.length > ARG_MAX) {
    const file = path.join(control?.files.dir ?? os.tmpdir(), `task-${Date.now()}.md`)
    fs.writeFileSync(file, prompt)
    prompt = `任务说明较长，完整内容在这个文件里，先用读文件工具读完它，再严格按里面的要求执行：${file}`
  }
  const done = (value, code = 0) => {
    const out = { ...value, ms: Date.now() - started, models: model ? [model] : null, usageParts: { ...tr.usage } }
    control?.finish(out)
    finish(out, code)
  }
  let lastText = ''
  for (;;) {
    const r = await runTurn(job, prompt, conversation, control, tr, deadline)
    if (r.error) return done({ ok: false, error: r.error, sessionId: conversation }, 1)
    conversation = r.convId ?? conversation
    const res = r.result
    const text = typeof res?.response === 'string' ? res.response : tr.text
    if (text) lastText = text
    if (r.cancelled) return done({ ok: false, error: 'cancelled', text: lastText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(lastText) })
    if (r.timedOut) return done({ ok: false, error: '超过 2 小时，已停止', text: lastText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(lastText) }, 1)
    if (!res || res.status !== 'SUCCESS') {
      const why = res?.error ?? res?.status ?? `agy 退出 ${r.code}，没有 result 事件`
      const err = String(r.stderr ?? '').replace(/\s+/g, ' ').trim().slice(-400)
      return done({ ok: false, error: `${typeof why === 'string' ? why : JSON.stringify(why)}${err ? `：${err}` : ''}`, text: lastText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(lastText) }, 1)
    }
    control?.append({ type: 'result', is_error: false, result: lastText, num_turns: tr.turns, usage: { output_tokens: tr.usage.output } })
    // delegate_send 留下的话：作为同一会话的下一轮接着跑。
    const queued = control?.drain() ?? []
    if (queued.length === 0) break
    for (const q of queued) control?.append({ type: 'sent', text: q })
    prompt = queued.join('\n\n')
  }
  return done({ ok: true, text: lastText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(lastText) })
}

// 经链接路径运行时 argv[1] 和模块路径写法不同：两边都取 realpath 再比（测试 import 时不跑 main）。
const real = p => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main().catch(e => finish({ ok: false, error: String(e?.message ?? e) }, 1))
}
