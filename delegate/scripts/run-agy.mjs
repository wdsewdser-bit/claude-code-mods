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
import { hardRules, reportRules } from './ptc-rules.mjs'
import { fileURLToPath } from 'node:url'

// 由 launch.mjs 脱离插件进程树启动时：任务在 --input 文件里（附带宿主的环境变量），最终结果另写一份到 --reply 文件。
// 这样插件热重载、宿主退出都杀不到 runner。直接用 stdin 启动的老方式照旧可用。
const argAfter = flag => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}
const REPLY_FILE = argAfter('--reply')
let INPUT_JOB
{
  const inputFile = argAfter('--input')
  if (inputFile !== undefined) {
    try {
      const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'))
      for (const [k, v] of Object.entries(raw.env ?? {})) if (typeof v === 'string') process.env[k] = v
      INPUT_JOB = JSON.stringify(raw.job ?? {})
    } catch {}
    try { fs.rmSync(inputFile, { force: true }) } catch {}
  }
}
const writeReply = value => {
  if (REPLY_FILE === undefined) return
  try {
    fs.writeFileSync(REPLY_FILE + '.tmp', JSON.stringify(value))
    fs.renameSync(REPLY_FILE + '.tmp', REPLY_FILE)
  } catch {}
}

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
  writeReply(value)
  process.stdout.write(JSON.stringify(value) + '\n')
  process.exit(code)
}

const readStdin = () =>
  new Promise((resolve, reject) => {
    if (INPUT_JOB !== undefined) return resolve(INPUT_JOB)
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
// 派出去的活是一次性的：去掉 lib.def 登记示例，只留一句可调用全局库（全局库对每个会话都加载，会话库按作业各自独立）。
export const forDelegate = s => s.replace(/\n\/\/[^\n]*\nlib\.def\([^\n]*\nconsole\.log\(lib\.[^\n]*/, '') + ' lib.help() 列出全局库现有函数，可直接 lib.xxx() 调用。'
const sdkText = () => {
  try {
    const tpl = fs.readFileSync(path.resolve(here, '..', '..', 'ptc-run', 'src', 'register.tpl.ts'), 'utf8')
    const m = /const DESC_PARTS = \[([\s\S]*?)\]\r?\n/.exec(tpl)
    if (m) return forDelegate((0, eval)('[' + m[1] + ']').join(' '))
  } catch {}
  return 'tools.* 都是同步的（不要 .then）：tools.read/write/edit/replace/glob/grep/peek/batch/bash/sh/parallel，ref.*，lib.*；tools.help() 列出主题。'
}

// run_code 示例：read 模式只给只读的，work 模式再加一个"改+验证"。示例在 delegate/tests/run-agy.test.mjs 里真跑一遍。
const EX_SURVEY = [
  '// 示例 1：首次摸项目，独立的查询放进同一个程序',
  'const files = tools.glob({ pattern: "**/*.mjs", path: "src" })',
  'const fns = tools.grep({ pattern: "export (async )?function \\\\w+", path: "src" })',
  'const todo = tools.grep({ pattern: "TODO|FIXME", path: "src", outputMode: "count" })',
  'console.log(`文件 ${files.total} 个`)',
  'for (const h of fns.items) console.log(`${h.file}:${h.line} ${h.text.trim()}`)',
  'console.log("TODO:", todo.items.map(i => `${i.file}=${i.count}`).join(" "))',
]
const EX_LOCATE = [
  '// 示例 2：找出一个名字的全部位置，每处带上下文，只打印摘录',
  'const hits = tools.grep({ pattern: "\\\\bparseConfig\\\\b", path: "src", before: 2, after: 2 })',
  'for (const h of hits.items) console.log(`${h.file}:${h.line}${h.context ? " " : ">"} ${h.text}`)',
  'const sizes = files => files.map(f => [f, tools.read({ path: f }).split("\\n").length]).sort((a, b) => b[1] - a[1])',
  'console.log(sizes(tools.glob({ pattern: "*.mjs", path: "src" }).items).slice(0, 3))',
]
const EX_CHANGE = [
  '// 示例 3：一个阶段的全部改动 + 验证，只打印结论',
  'const e = tools.edit({ path: "src/config.mjs", old: "timeout: 30", new: "timeout: 60" })',
  'const t = tools.sh("node --test", { tail: 20 })',
  'const left = tools.grep({ pattern: "timeout: 30", path: "src" })',
  'console.log(`改 ${e.replaced} 处；测试 ${t.code === 0 ? "通过" : "失败"}；残留 ${left.total}`)',
  'if (t.code !== 0) console.log(t.text)',
]
const block = lines => ['```js', ...lines, '```']
const EX_NOTES = '- tools.* 同步返回，不要 await/.then；read 返回字符串，numbered:true 时每行带 "N: " 前缀，正则别用 ^ 锚定行首。'
export const EXAMPLES = { read: [EX_SURVEY, EX_LOCATE], work: [EX_SURVEY, EX_LOCATE, EX_CHANGE] }
const examplesOf = kind => ['', '## run_code 示例', EX_NOTES, ...EXAMPLES[kind].flatMap(block)]

const COMMON_RULES = [
  '你是主会话派出的执行代理，在 Windows 上工作。按任务说明做，不扩大范围，不再派给别人。',
  '',
  '## 唯一的工具：run_code',
  '用 call_mcp_tool 调用，ServerName 填 "ptc"，ToolName 填 "run_code"，Arguments 是 {"description": "<一句中文，说明这个程序要做什么>", "code": "<异步函数体>"}，可选 timeoutMs、root、maxChars。description 必填，用户靠它看你在做什么。',
  '程序里只有 console.log 的输出和 return 的值会回来。相对路径以任务给的工作目录为准。',
  '',
  ...hardRules('sync'),
  '',
  '## SDK',
  '@@SDK@@',
  '',
  ...reportRules,
]
// 不带 ptc 的 native agent 的规则：用 agy 自带工具干活，不提 run_code。
const NATIVE_RULES = [
  '你是主会话派出的执行代理，在 Windows 上工作。按任务说明做，不扩大范围，不再派给别人。',
  '',
  '## 工具',
  '用 agy 自带的文件读写、搜索和命令工具干活（工具名以你当前可用的为准，不要猜）。',
  '',
  ...COMMON_RULES.slice(COMMON_RULES.indexOf('## 规则')),
]
const AGENTS = {
  work: {
    name: 'cc-delegate-work',
    body: [...COMMON_RULES, '- 你可以改文件、跑命令（tools.bash / tools.sh 跑的是 cmd/PowerShell 环境下的命令）；改完要读文件或跑命令核实结果。', ...examplesOf('work')],
  },
  read: {
    name: 'cc-delegate-read',
    body: [...COMMON_RULES, '- 这是只读任务：run_code 是只读沙箱，只能 read/glob/grep/peek 和 ref.*，写文件和跑命令会返回 POLICY_DENIED；不要尝试改动，需要改的写进报告。', ...examplesOf('read')],
  },
  // 不带 ptc 的对照组：不写 run_code 相关提示，启动时也不设 PTC_* 环境变量，所以 ptc 服务器不会暴露工具。
  native: {
    name: 'cc-delegate-native-work',
    body: [...NATIVE_RULES, '- 你可以改文件、跑命令（用 run_command）；改完要读文件或跑命令核实结果。'],
  },
}

export const agentFileOf = kind => {
  const a = AGENTS[kind]
  return [
    '---',
    `name: ${a.name}`,
    `description: claude-code delegate 的${kind === 'read' ? '只读' : '执行'}代理（由 delegate 插件自动生成，改动会被覆盖）`,
    'mainAgent: true',
    ...(kind === 'native' ? ['tools: [read_file, write_file, edit_file, run_command]'] : ['excludeDefaultComponents: true']),
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

// ptc:false 选不带 ptc 的 native agent（对照组）；否则按模式选 work / read。
export const agentKindOf = job => (job.ptc === false ? 'native' : job.mode === 'work' ? 'work' : 'read')

export const argsOf = (job, prompt, conversation) => {
  const kind = agentKindOf(job)
  // 只读靠 agent 的工具白名单（没有写文件和命令工具），所以两种模式都自动批准：
  // print 模式下被拒的权限请求会让这一轮直接结束、报告为空。
  const args = [`--print=${prompt}`, '--output-format', 'stream-json', '--agent', AGENTS[kind].name, '--dangerously-skip-permissions']
  if (typeof job.model === 'string' && job.model !== '') args.push('--model', job.model)
  if (conversation) args.push('--conversation', conversation)
  return args
}

// agy event → the Claude-stream-shaped lines liveEvents/usageOf already read.
// thinkingOf(stepIndex)：stream-json 里没有思考文本（只有 thinking_tokens），由调用方从 agy 的会话转写里取。
export const createTranslator = (model, thinkingOf = () => '') => {
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
            let thought = ''
            try { thought = String(thinkingOf(s.step_index) ?? '').trim() } catch {}
            const blocks = [...(thought === '' ? [] : [{ type: 'thinking', thinking: thought }]), ...(text.trim() === '' ? [] : [{ type: 'text', text }])]
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
      const env = { ...process.env }
      if (job.ptc === false) {
        delete env.PTC_MCP_CWD
        delete env.PTC_MCP_SCOPE
        delete env.PTC_RUN_READONLY
      } else {
        Object.assign(env, { PTC_MCP_CWD: cwd, PTC_MCP_SCOPE: `agy-${job.jobId ?? 'job'}`, PTC_RUN_READONLY: job.mode === 'work' ? '0' : '1' })
      }
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
      if (process.env.DELEGATE_AGY_RAW_LOG) { try { fs.appendFileSync(process.env.DELEGATE_AGY_RAW_LOG, line + '\n') } catch {} }
      let o
      try { o = JSON.parse(line) } catch { return }
      if (o.event === 'step_update' && control) {
        const next = nextRetryState(control.state.retry, o.step_update)
        if (next !== control.state.retry) { control.state.retry = next; control.write(true) }
      }
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

// agy 把每一步写进 brain/<会话>/.system_generated/logs/transcript_full.jsonl，step_index 从 0 连续编号。
export const stepsOf = conv => {
  if (!conv) return []
  const file = path.join(home, '.gemini', 'antigravity-cli', 'brain', String(conv), '.system_generated', 'logs', 'transcript_full.jsonl')
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

// 判定：agy 的 result 报了非成功，但它其实已经自己恢复并跑完这一轮。全部条件都要满足：
// 1) 本轮（step_index >= startStep，即续跑起点之后）的最后一步是模型的回复，不是错误步骤；
// 2) agy 在它自己的会话记录里留有错误步骤（ERROR_MESSAGE），且其 error 字段与 result 报的 error 完全相等（结构化的相等，不是猜文案）。
// 1)、2) 任一不满足 → null，按失败处理。agy 改文案时两边一起变，相等不成立就退化成报失败，不会误报成功。
// 返回 { interrupts }：本轮（续跑起点之后）的断流次数；续跑时历史里的旧错误不计入本轮。
const isErrStep = st => /ERROR/.test(String(st?.type ?? ''))
export const recoveredTurn = (steps, startStep, res, cancelled = false) => {
  if (cancelled) return null
  if (!res || res.status === 'SUCCESS' || typeof res.error !== 'string') return null
  const since = steps.filter(st => st.step_index >= startStep)
  const last = since[since.length - 1]
  if (!last || isErrStep(last) || last.type !== 'PLANNER_RESPONSE' || last.source !== 'MODEL') return null
  // 中间回复只发工具调用、没有正文；有正文才是这一轮的最终回复。
  if (typeof last.content !== 'string' || last.content.trim() === '') return null
  if (!steps.some(st => isErrStep(st) && st.error === res.error)) return null
  return { interrupts: since.filter(isErrStep).length }
}

// 失败时在报错后面附上本轮断流次数和最后一次真实错误（只统计续跑起点之后）。
export const retrySuffix = (steps, startStep) => {
  const errs = steps.filter(st => st.step_index >= startStep && isErrStep(st))
  if (errs.length === 0) return ''
  const last = errs[errs.length - 1]
  return `（本轮断流 ${errs.length} 次，最后一次：${String(last.error ?? last.content ?? '')}）`
}

// 实时的重试状态（给 delegate_status 看）：遇到错误步骤记为“断流、自动重试中”，之后出现 agy 的新回复或工具调用就清掉“重试中”。
export const nextRetryState = (prev, s) => {
  const type = String(s?.step_type ?? '')
  if (/ERROR/i.test(type)) return { count: (prev?.count ?? 0) + 1, retrying: true }
  if (prev?.retrying && (type === 'agent_response' || type === 'tool')) return { count: prev.count, retrying: false }
  return prev ?? null
}

const main = async () => {
  let job
  try { job = JSON.parse(await readStdin()) } catch { return finish({ ok: false, error: 'the job on stdin is not JSON' }, 2) }
  const started = Date.now()
  const control = job.jobId ? createControl(String(job.jobId), job) : null
  const model = typeof job.model === 'string' ? job.model : ''
  // agy 把每步的思考写在 ~/.gemini/antigravity-cli/brain/<会话>/.system_generated/logs/transcript_full.jsonl：
  // 按 step_index 取。文件只增不改，读过的部分记住偏移量，不重复解析。
  const thoughts = new Map()
  let tPath = ''
  let tOffset = 0
  const thinkingOf = step => {
    const conv = control?.state.sessionId ?? job.resume
    if (!conv) return ''
    const file = path.join(home, '.gemini', 'antigravity-cli', 'brain', String(conv), '.system_generated', 'logs', 'transcript_full.jsonl')
    if (file !== tPath) { tPath = file; tOffset = 0 }
    try {
      const buf = fs.readFileSync(file)
      if (buf.length > tOffset) {
        const chunk = buf.subarray(tOffset).toString('utf8')
        const cut = chunk.lastIndexOf('\n')
        if (cut >= 0) {
          for (const line of chunk.slice(0, cut).split('\n')) {
            try { const o = JSON.parse(line); if (typeof o.thinking === 'string' && o.thinking.trim() !== '') thoughts.set(o.step_index, o.thinking) } catch {}
          }
          tOffset += Buffer.byteLength(chunk.slice(0, cut + 1))
        }
      }
    } catch {}
    return thoughts.get(step) ?? ''
  }
  const tr = createTranslator(model, thinkingOf)
  const deadline = started + TIME_LIMIT_MS
  try { ensureAgent(agentKindOf(job)); if (job.ptc !== false) ensurePtcServer() } catch (e) {
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
  const notes = []
  for (;;) {
    const startStep = stepsOf(conversation).length
    const r = await runTurn(job, prompt, conversation, control, tr, deadline)
    if (r.error) return done({ ok: false, error: r.error, sessionId: conversation }, 1)
    conversation = r.convId ?? conversation
    const res = r.result
    const recovered = res && res.status !== 'SUCCESS' ? recoveredTurn(stepsOf(conversation), startStep, res, Boolean(r.cancelled || r.timedOut || control?.isCancelled())) : null
    if (recovered) notes.push(`本轮中途断流 ${recovered.interrupts} 次，agy 已自动恢复并跑完（agy 报的错误：${res.error}）`)
    // agy 有时在回复前带一段空的结构化输出 "{}"，去掉。
    turnText = (typeof res?.response === 'string' ? res.response : (r.tail ?? tr.text)).replace(/^\s*\{\}\s*/, '')
    const fallbackText = turnText || lastText
    if (r.cancelled || control?.isCancelled()) {
      return done({ ok: false, error: 'cancelled', text: fallbackText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(fallbackText) })
    }
    if (r.timedOut || Date.now() > deadline) {
      return done({ ok: false, error: '超过 2 小时，已停止', text: fallbackText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(fallbackText) }, 1)
    }
    if ((!res || res.status !== 'SUCCESS') && !recovered) {
      const why = res?.error ?? res?.status ?? `agy 退出 ${r.code}，没有 result 事件`
      let err = String(r.stderr ?? '').replace(/\s+/g, ' ').trim().slice(-400)
      // 找不到 agy.exe 时 agyExe 退回裸名 'agy'，报错只剩一句 ENOENT：点明查的路径和常见原因。
      if (/ENOENT/.test(err) && agyExe() === 'agy') err += `（没找到 ${path.join(process.env.LOCALAPPDATA ?? '%LOCALAPPDATA%', 'agy', 'bin', 'agy.exe')}：runner 若在 Claude 应用包外启动就看不到包内的 AppData）`
      return done({ ok: false, error: `${typeof why === 'string' ? why : JSON.stringify(why)}${err ? `：${err}` : ''}${retrySuffix(stepsOf(conversation), startStep)}`, text: fallbackText, sessionId: conversation, turns: tr.turns, terminal: terminalOf(fallbackText) }, 1)
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
  const note = notes.map(n => `> ${n}`).join('\n')
  const text = note ? `${note}\n\n${turnText}` : turnText
  return done({ ok: true, text, sessionId: conversation, turns: tr.turns, terminal: terminalOf(turnText), ...(notes.length ? { recovered: notes } : {}) })
}

// 经链接路径运行时 argv[1] 和模块路径写法不同：两边都取 realpath 再比（测试 import 时不跑 main）。
const real = p => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main().catch(e => finish({ ok: false, error: String(e?.message ?? e) }, 1))
}
