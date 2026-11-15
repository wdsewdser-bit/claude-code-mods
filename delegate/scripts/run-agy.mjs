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

const here = path.dirname(fileURLToPath(import.meta.url))

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

// ── 自定义 agent：excludeDefaultComponents 去掉 agy 默认的提示词段落和内置工具（浏览器、联网搜索、子代理、
// 技能、插件……），系统提示只剩下面这段。干活只用一个工具：ptc-run 的 run_code（和 DS 通道同一个沙箱），
// 由 ptc-run/mcp/server.mjs 以 MCP 服务器提供，agy 里经通用的 call_mcp_tool（server "ptc"）调用。
// 服务器要先全局注册一次：agy mcp add ptc node <仓库>/ptc-run/mcp/server.mjs（ensurePtcServer 会做）。
// 服务器只在带 PTC_MCP_CWD 的进程里暴露工具，所以人自己开的 agy / IDE 会话看不到它。
// 只读：PTC_RUN_READONLY=1 让 run_code 走 ptc-run 的只读 broker（写文件、跑命令直接 POLICY_DENIED），是硬隔离。
// agent 不写 tools 白名单：写了 call_mcp_tool 会报 not found；不写时只剩 call_mcp_tool / list_resources /
// read_resource / manage_task。frontmatter 里也不能写 mcpServers（agent 会加载失败）。
const AGENTS_DIR = process.env.DELEGATE_AGY_AGENTS_DIR || path.join(home, '.gemini', 'config', 'agents')
const PTC_SERVER = path.resolve(here, '..', '..', 'ptc-run', 'mcp', 'server.mjs')

// run_code 的 SDK 说明：和主会话 run_code 的工具说明同一份（ptc-run/src/register.tpl.ts 的 DESC_PARTS）。
const sdkText = () => {
  try {
    const tpl = fs.readFileSync(path.resolve(here, '..', '..', 'ptc-run', 'src', 'register.tpl.ts'), 'utf8')
    const m = /const DESC_PARTS = \[([\s\S]*?)\]\n/.exec(tpl)
    if (m) return (0, eval)('[' + m[1] + ']').join(' ')
  } catch {}
  return 'tools.* 都是同步的（不要 .then）：tools.read/write/edit/replace/glob/grep/peek/batch/bash/sh/parallel，ref.*，lib.*；tools.help() 列出主题。'
}

const COMMON_RULES = [
  '你是主会话派出的执行代理，在 Windows 上工作。按任务说明做，不扩大范围，不再派给别人。',
  '',
  '## 唯一的工具：run_code',
  '用 call_mcp_tool 调用，ServerName 填 "ptc"，ToolName 填 "run_code"，Arguments 是 {"code": "<异步函数体>"}，可选 timeoutMs、root、maxChars。',
  '程序里只有 console.log 的输出和 return 的值会回来。相对路径以任务给的工作目录为准。',
  '把能预见的多步操作写进一个程序一次做完（定位→读片段→改→验证），只打印需要的摘录，不要一次只做一步。',
  '',
  '## SDK',
  '@@SDK@@',
  '',
  '## 规则',
  '- 先 grep/glob 定位，再按行号范围读需要的片段，不整读大文件。',
  '- 不提交、不推送、不加依赖、不为让测试通过而削弱测试；不做任务没要求的重构和格式化。',
  '- 遇到这些情况先停下，在报告里写清现状和可选做法，用 TASK_TERMINAL: blocked 结束：改动会超出任务给的范围或路径；有几种做法会实质改变结果而任务没指定；任务前提不成立；要做难以撤销的操作（删除、覆盖、发布）。',
  '- 做完给最终报告（中文，简洁）：结论、改了哪些文件（绝对路径）、怎么验证的（命令和真实输出）、还有什么没验证。只报真实结果，没跑过的检查写明没跑。',
  '- 报告最后单独一行：TASK_TERMINAL: completed（目标完成且必要验证做过）、TASK_TERMINAL: blocked（缺信息或权限）或 TASK_TERMINAL: failed（尝试后失败）。',
]
const AGENTS = {
  work: {
    name: 'cc-delegate-work',
    body: [...COMMON_RULES, '- 你可以改文件、跑命令（tools.bash / tools.sh 跑的是 cmd/PowerShell 环境下的命令）；改完要读文件或跑命令核实结果。'],
  },
  read: {
    name: 'cc-delegate-read',
    body: [...COMMON_RULES, '- 这是只读任务：run_code 是只读沙箱，只能 read/glob/grep/peek 和 ref.*，写文件和跑命令会返回 POLICY_DENIED；不要尝试改动，需要改的写进报告。'],
  },
}

export const agentFileOf = kind => {
  const a = AGENTS[kind]
  return [
    '---',
    `name: ${a.name}`,
    `description: claude-code delegate 的${kind === 'work' ? '执行' : '只读'}代理（由 delegate 插件自动生成，改动会被覆盖）`,
    'mainAgent: true',
    'excludeDefaultComponents: true',
    '---',
    ...a.body.map(l => (l === '@@SDK@@' ? sdkText() : l)),
    '',
  ].join('\n')
}

// ptc 服务器全局注册一次（~/.gemini/config/mcp_config.json，IDE 和 CLI 共用）；已注册且路径相同就不动。
const ensurePtcServer = () => {
  const file = path.join(home, '.gemini', 'config', 'mcp_config.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8') || '{}') } catch {}
  const have = cfg?.mcpServers?.ptc
  const want = PTC_SERVER.replace(/\\/g, '/')
  if (have && Array.isArray(have.args) && String(have.args[0]).replace(/\\/g, '/') === want && have.disabled !== true) return
  const run = spawnSync(agyExe(), ['mcp', 'add', 'ptc', 'node', want], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  if (run.status !== 0) throw new Error(`agy mcp add 失败：${String(run.stderr || run.stdout).trim().slice(-200)}`)
}

const ensureAgent = kind => {
  const file = path.join(AGENTS_DIR, AGENTS[kind].name, 'agent.md')
  const want = agentFileOf(kind)
  let have = ''
  try { have = fs.readFileSync(file, 'utf8') } catch {}
  if (have === want) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, want)
}

export const promptOf = (job, first) => {
  const task = String(job.task ?? '')
  if (!first) return task
  const cwd = typeof job.cwd === 'string' && job.cwd !== '' ? job.cwd : process.cwd()
  return `工作目录：${cwd}\n\n${task}`
}

export const argsOf = (job, prompt, conversation) => {
  const kind = job.mode === 'work' ? 'work' : 'read'
  // 只读靠 agent 的工具白名单（没有写文件和命令工具），所以两种模式都自动批准：
  // print 模式下被拒的权限请求会让这一轮直接结束、报告为空。
  const args = [`--print=${prompt}`, '--output-format', 'stream-json', '--agent', AGENTS[kind].name, '--dangerously-skip-permissions']
  if (typeof job.model === 'string' && job.model !== '') args.push('--model', job.model)
  if (conversation) args.push('--conversation', conversation)
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
          // ptc 的 run_code 经 call_mcp_tool（事件里也可能叫 mcp_ptc_run_code）调用：面板上显示成 run_code 和它的参数。
          const raw = String(s.tool_name ?? info.name ?? 'tool')
          const params = info.parameters ?? {}
          const ptc = raw === 'mcp_ptc_run_code' || (raw === 'call_mcp_tool' && params.ServerName === 'ptc')
          out.push(assistant([{ type: 'tool_use', name: ptc ? 'run_code' : raw, input: ptc ? (params.Arguments ?? params) : params }]))
        }
      }
      return out
    },
    flush() {
      if (text.trim() === '') { text = ''; return [] }
      const ev = assistant([{ type: 'text', text }])
      text = ''
      return [ev]
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
      // ptc 服务器从 agy 继承环境：PTC_MCP_CWD 让它暴露 run_code 并以此为工作目录，只读模式加 PTC_RUN_READONLY。
      const env = { ...process.env, PTC_MCP_CWD: cwd, PTC_MCP_SCOPE: `agy-${job.jobId ?? 'job'}`, PTC_RUN_READONLY: job.mode === 'work' ? '0' : '1' }
      child = spawn(exe, argsOf(job, prompt, conversation), { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
    const emit = ev => {
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
    const onLine = line => {
      if (line.trim() === '') return
      let o
      try { o = JSON.parse(line) } catch { return }
      if (o.event === 'init' && typeof o.conversation_id === 'string') {
        convId = o.conversation_id
        if (control) { control.state.sessionId = convId; control.write(true) }
      }
      if (o.event === 'result') { result = o.result ?? {}; return }
      for (const ev of tr.on(o)) emit(ev)
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
      const tail = tr.text
      for (const ev of tr.flush()) emit(ev)
      resolve({ code, result, convId, stderr, cancelled, timedOut, tail })
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
  try { ensureAgent(job.mode === 'work' ? 'work' : 'read'); ensurePtcServer() } catch (e) {
    return finish({ ok: false, error: `准备 agy 自定义 agent / ptc 服务器失败：${e?.message ?? e}` }, 1)
  }
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
  let turnText = ''
  for (;;) {
    const r = await runTurn(job, prompt, conversation, control, tr, deadline)
    if (r.error) return done({ ok: false, error: r.error, sessionId: conversation }, 1)
    conversation = r.convId ?? conversation
    const res = r.result
    // agy 有时在回复前带一段空的结构化输出 "{}"，去掉。
    turnText = (typeof res?.response === 'string' ? res.response : (r.tail ?? tr.text)).replace(/^\s*\{\}\s*/, '')
    const fallbackText = turnText || lastText
    if (r.cancelled || control?.isCancelled()) {
      return done({ ok: false, error: 'cancelled', text: fallbackText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(fallbackText) })
    }
    if (r.timedOut || Date.now() > deadline) {
      return done({ ok: false, error: '超过 2 小时，已停止', text: fallbackText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(fallbackText) }, 1)
    }
    if (!res || res.status !== 'SUCCESS') {
      const why = res?.error ?? res?.status ?? `agy 退出 ${r.code}，没有 result 事件`
      const err = String(r.stderr ?? '').replace(/\s+/g, ' ').trim().slice(-400)
      return done({ ok: false, error: `${typeof why === 'string' ? why : JSON.stringify(why)}${err ? `：${err}` : ''}`, text: fallbackText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(fallbackText) }, 1)
    }
    if (turnText.trim() === '') {
      return done({ ok: false, error: 'agy 这一轮结束了但没有给出最终回复（可能是工具被拒或中途停下）；用 delegate_status 看事件，或 resume 让它补报告', sessionId: conversation, turns: tr.turns }, 1)
    }
    lastText = turnText
    control?.append({ type: 'result', is_error: false, result: turnText, num_turns: tr.turns, usage: { output_tokens: tr.usage.output } })
    if (control?.isCancelled()) {
      return done({ ok: false, error: 'cancelled', text: turnText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(turnText) })
    }
    if (Date.now() > deadline) {
      return done({ ok: false, error: '超过 2 小时，已停止', text: turnText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(turnText) }, 1)
    }
    // delegate_send 留下的话：作为同一会话的下一轮接着跑。
    const queued = control?.drain() ?? []
    if (queued.length === 0) break
    for (const q of queued) control?.append({ type: 'sent', text: q })
    prompt = queued.join('\n\n')
  }
  return done({ ok: true, text: turnText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(turnText) })
}

// 经链接路径运行时 argv[1] 和模块路径写法不同：两边都取 realpath 再比（测试 import 时不跑 main）。
const real = p => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main().catch(e => finish({ ok: false, error: String(e?.message ?? e) }, 1))
}
