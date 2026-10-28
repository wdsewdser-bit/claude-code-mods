// One delegated job through local CPA; stdin job, sanitized JSON result.
// A job that carries jobId (the plugin's own calls do) also gets a directory of
// its own under ~/.claude/delegate/jobs/<jobId>/: status.json (pid, childPid,
// sessionId, phase, turns, lastTool, lastText) rewritten as the stream comes in,
// events.jsonl (the raw stream, rotated by size), result.json at the end. Two
// files go the other way: cancel stops the child tree, inbox/*.json are messages
// queued into the child's stdin while it runs (stream: true).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRootsEnv, readRootsOf, readRootsPromptArg } from './read-roots.mjs'
import { createOutputTracker } from './stream-usage.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = os.homedir()
const READ_TOOLS = 'Read,Grep,Glob,WebFetch'
const WORK_TOOLS = 'Read,Grep,Glob,WebFetch,Edit,Write,Bash'
const PTC_TOOL = 'mcp__ptc-run__run_code'
const PTC_SERVER = 'mcp__ptc-run'
// ptc-only: the whole system prompt is replaced by DSH's PTC-only prompt (plus our SDK declarations) from this file.
const PTC_ONLY_PROMPT = process.env.DELEGATE_PTC_PROMPT || path.join(here, 'ptc-only-system.md') // env override: A/B tests only
// read + ptc: 'only': the same presentation with only read/glob/grep/ref declared; ptc-run runs read-only (PTC_RUN_READONLY=1).
const PTC_RO_PROMPT = process.env.DELEGATE_PTC_RO_PROMPT || path.join(here, 'ptc-readonly-system.md')
// Settings for ptc-only: no output style, no language line, and the plugins whose MCP instructions would show up
// anyway are switched off (ptc-run must stay: run_code is a plugin tool, and --bare would drop it).
const PTC_ONLY_SETTINGS = JSON.stringify({
  outputStyle: 'default',
  language: '',
  enabledPlugins: { 'ctx-mod@skills-dir': false, 'delegate@skills-dir': false },
})
const BLOCKED_MCP = ['mcp__ctx-mod', 'mcp__delegate']
const CLEAN_SETTINGS = JSON.stringify({
  outputStyle: 'default',
  language: '',
  enabledPlugins: Object.fromEntries(
    ['away-autopilot', 'cache-keeper', 'ctx-mod', 'delegate', 'dispatch-gate', 'ptc-run', 'read-dedup', 'synced'].map(n => [`${n}@skills-dir`, false])
      .concat(['typescript-lsp', 'pyright-lsp', 'rust-analyzer-lsp', 'jdtls-lsp'].map(n => [`${n}@claude-plugins-official`, false])),
  ),
})

// Where a tracked job keeps its status/events/result and takes cancel and inbox files.
const JOBS_ROOT = process.env.DELEGATE_JOBS_DIR || path.join(home, '.claude', 'delegate', 'jobs')
const MAX_EVENT_BYTES = 512 * 1024 // events.jsonl rotates at this size, one older file kept
const STATUS_EVERY_MS = 400 // a status write is at most this often (a result forces one)
const HEARTBEAT_MS = 5000 // so a long tool call still looks alive
const POLL_MS = 500 // cancel file and inbox
const SEND_GRACE_MS = Math.max(Number(process.env.DELEGATE_SEND_GRACE_MS) || 2000, 200) // a result waits this long for a queued message before stdin closes
const OUT_KEEP = 2_000_000 // the tail of stdout kept for the error message
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const finish = (value, code = 0) => {
  process.stdout.write(JSON.stringify(value) + '\n')
  process.exit(code)
}

// 任务自己的结论写在最终文本里：TASK_TERMINAL: completed|blocked|failed。取最后一次出现，允许前后有 markdown 的
// ** 或反引号；没找到就是 null（不是空串）。ok 只代表 CLI 没报错，两者不要混。
// （同一份逻辑的纯函数版在 hooks/lib/terminal.ts，那里给测试 import；这里是 runner 自己的内联副本。）
const TERMINAL_RE = /TASK_TERMINAL:\s*[*`_]*\s*(completed|blocked|failed)/gi
const terminalOf = text => {
  if (typeof text !== 'string') return null
  let found = null
  for (const m of text.matchAll(TERMINAL_RE)) found = m[1].toLowerCase()
  return found
}

// 每条 assistant 消息里实际作答的模型，按首次出现顺序去重（一次运行可能换过模型）。
const addModel = (models, o) => {
  const model = typeof o?.message?.model === 'string' ? o.message.model.trim() : ''
  if (model !== '' && !models.includes(model)) models.push(model)
  return models
}

const readStdin = () =>
  new Promise(resolve => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', d => (s += d))
    process.stdin.on('end', () => resolve(s))
  })

const killTree = child => {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { child.kill('SIGKILL') } catch {}
  }
}

// A job the plugin tracks: status.json / events.jsonl / result.json out, cancel and inbox in.
// Every write is best effort: losing a status line must never fail the job itself.
const createControl = (jobId, job) => {
  const dir = path.join(JOBS_ROOT, jobId)
  const files = {
    status: path.join(dir, 'status.json'),
    events: path.join(dir, 'events.jsonl'),
    rotated: path.join(dir, 'events.1.jsonl'),
    result: path.join(dir, 'result.json'),
    inbox: path.join(dir, 'inbox'),
    cancel: path.join(dir, 'cancel'),
  }
  try { fs.mkdirSync(files.inbox, { recursive: true }) } catch {}
  let bytes = 0
  try { bytes = fs.statSync(files.events).size } catch {}
  const state = {
    jobId,
    pid: process.pid,
    childPid: null,
    sessionId:
      typeof job.sessionId === 'string' && job.sessionId !== ''
        ? job.sessionId
        : job.resume
          ? String(job.resume)
          : null,
    phase: 'starting',
    stream: job.stream === true,
    tier: typeof job.tier === 'string' ? job.tier : null,
    model: typeof job.model === 'string' ? job.model : null,
    cwd: typeof job.cwd === 'string' && job.cwd !== '' ? job.cwd : process.cwd(),
    startedAt: Date.now(),
    updatedAt: 0,
    turns: 0,
    lastTool: null,
    lastText: '',
    // 运行中数出来的输出 token 总数：每条 assistant 行的 usage.output_tokens 是 0，
    // 只有 stream_event 的 message_delta 和最后的 result 行带着真数（见 stream-usage.mjs）。
    outputTokens: 0,
    // 最近一次请求的真实输入（来自 message_delta；assistant 行里的是 CPA 的预估，偏大）。
    contextTokens: 0,
  }
  let lastWrite = 0
  const write = force => {
    const now = Date.now()
    if (!force && now - lastWrite < STATUS_EVERY_MS) return
    lastWrite = now
    state.updatedAt = now
    try { fs.writeFileSync(files.status, JSON.stringify(state)) } catch {}
  }
  const append = line => {
    try {
      if (bytes > MAX_EVENT_BYTES) {
        fs.renameSync(files.events, files.rotated)
        bytes = 0
      }
      fs.appendFileSync(files.events, line + '\n')
      bytes += Buffer.byteLength(line) + 1
    } catch {}
  }
  // 运行中的输出：stream_event 只用来数 token，不进 events.jsonl（逐 token 的增量会把有用事件挤掉）。
  const output = createOutputTracker()
  const track = event => {
    const total = output.onEvent(event)
    if (total !== state.outputTokens || output.context !== state.contextTokens) {
      state.outputTokens = total
      state.contextTokens = output.context
      write(false) // 和 assistant/user 行同一个节流频率
    }
  }
  const onEvent = (line, o) => {
    if (o.type === 'stream_event') {
      track(o.event)

      return
    }
    // 每个思考 token 一行的进度事件对面板没用，只会把文件撑大、提前轮转。
    if (!(o.type === 'system' && o.subtype === 'thinking_tokens')) append(line)
    if (typeof o.session_id === 'string' && o.session_id !== '') state.sessionId = o.session_id
    if (o.type === 'assistant') {
      state.turns += 1
      const blocks = Array.isArray(o.message?.content) ? o.message.content : []
      const tool = blocks.find(c => c && c.type === 'tool_use')
      if (tool) state.lastTool = String(tool.name ?? '')
      const text = blocks.filter(c => c && c.type === 'text').map(c => c.text).join('').trim()
      if (text) state.lastText = text.slice(0, 600)
      state.phase = 'working'
      write(false)
    } else if (o.type === 'user') {
      state.phase = 'working'
      write(false)
    } else if (o.type === 'result') {
      state.phase = 'finishing'
      // result.usage.output_tokens 是整次运行的真实总数，覆盖运行中数出来的值。
      const total = output.final(o.usage)
      if (total > state.outputTokens) state.outputTokens = total
      write(true)
    }
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
      } catch {
        continue // half written: read it again on the next poll
      }
      try { fs.unlinkSync(file) } catch {}
      if (text.trim() !== '') out.push(text)
    }
    return out
  }
  const isCancelled = () => {
    try { return fs.existsSync(files.cancel) } catch { return false }
  }
  const finishJob = value => {
    const endedAt = Date.now()
    try {
      fs.writeFileSync(files.result, JSON.stringify({ ...value, jobId, endedAt }))
    } catch {}
    state.phase = value.error === 'cancelled' ? 'cancelled' : value.ok ? 'done' : 'failed'
    state.endedAt = endedAt
    if (typeof value.sessionId === 'string' && value.sessionId !== '') state.sessionId = value.sessionId
    if (typeof value.turns === 'number') state.turns = value.turns
    if (typeof value.text === 'string' && value.text !== '') state.lastText = value.text.slice(0, 600)
    const used = Number(value.usage?.output_tokens)
    if (Number.isFinite(used) && used > state.outputTokens) state.outputTokens = used
    write(true)
  }
  const heartbeat = setInterval(() => write(true), HEARTBEAT_MS)
  heartbeat.unref?.()
  write(true)

  return {
    files,
    state,
    write,
    append,
    onEvent,
    drain,
    isCancelled,
    finish: finishJob,
    stop: () => clearInterval(heartbeat),
  }
}


// delegate_gpt: GPT through the local CPA (CLIProxyAPI) proxy, which answers Anthropic /v1/messages itself,
// so there is no a2o in that path. ensure_cpa.py starts CPA when the port is closed and prints the two
// variables Claude Code needs; that key stays in this process (stdin and the child's env, never disk).
const CPA_ENSURE =
  process.env.DELEGATE_CPA_ENSURE || path.join(home, 'tools', 'cliproxyapi', 'ensure_cpa.py')
const CPA_PYTHON = process.env.DELEGATE_CPA_PYTHON || 'python'

const cpaEnv = () => {
  let run
  try {
    run = spawnSync(CPA_PYTHON, [CPA_ENSURE, '--print-env'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 90_000,
    })
  } catch (e) {
    return { error: `CPA 启动失败：${e?.message ?? e}` }
  }
  if (run.error) return { error: `CPA 启动失败（${CPA_PYTHON}）：${run.error.message}` }
  const err = String(run.stderr ?? '').replace(/\s+/g, ' ').trim().slice(-300)
  if (run.status !== 0) {
    return {
      error: `CPA 未就绪（ensure_cpa.py 退出 ${run.status}${err === '' ? '' : `：${err}`}）。日志在 ${path.join(path.dirname(CPA_ENSURE), 'cpa.log')}`,
    }
  }
  const env = {}
  for (const line of String(run.stdout ?? '').split('\n')) {
    const m = /^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2].trim()
  }
  if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) {
    return { error: 'ensure_cpa.py 没有输出 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN' }
  }

  return { env }
}

// A key must never reach a log line or an error message.
const redact = (text, secrets) => {
  let s = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) s = s.split(secret).join('***')
  }

  return s
}

const findClaude = () => {
  if (process.env.DELEGATE_CLAUDE) return process.env.DELEGATE_CLAUDE
  const local = process.env.LOCALAPPDATA
  if (local) {
    const packages = path.join(local, 'Packages')
    const found = []
    try {
      for (const pkg of fs.readdirSync(packages)) {
        if (!pkg.startsWith('Claude_')) continue
        const base = path.join(packages, pkg, 'LocalCache', 'Roaming', 'Claude', 'claude-code')
        if (!fs.existsSync(base)) continue
        for (const ver of fs.readdirSync(base)) {
          for (const hash of fs.readdirSync(path.join(base, ver))) {
            const exe = path.join(base, ver, hash, 'claude.exe')
            if (fs.existsSync(exe)) found.push({ ver, exe })
          }
        }
      }
    } catch {}
    found.sort((a, b) => a.ver.localeCompare(b.ver, undefined, { numeric: true }))
    if (found.length > 0) return found.at(-1).exe
  }
  return 'claude'
}

const main = async () => {
  let job
  try {
    job = JSON.parse(await readStdin())
  } catch {
    return finish({ ok: false, error: 'the job on stdin is not JSON' }, 2)
  }
  // A tracked job records itself before anything can fail, so a restart still sees it.
  const control = job.jobId ? createControl(String(job.jobId), job) : null
  // Persist the terminal state before exiting.
  const done = (value, code = 0) => {
    try { control?.finish(value) } catch {}
    try { control?.stop() } catch {}
    finish(value, code)
  }
  // gpt: CPA supplies the url and the key, so the job carries only the model and the task.
  const gpt = job.gpt === true
  const { model, task } = job
  if (!task || !model) {
    return done(
      {
        ok: false,
        error: 'model and task are required',
      },
      2,
    )
  }
  // A bad cwd makes spawn fail with nothing readable; say what is wrong before anything starts.
  if (job.cwd) {
    let cwdStat
    try { cwdStat = fs.statSync(job.cwd) } catch { cwdStat = undefined }
    if (!cwdStat) return done({ ok: false, error: `cwd 不存在：${job.cwd}` }, 2)
    if (!cwdStat.isDirectory()) return done({ ok: false, error: `cwd 不是目录：${job.cwd}` }, 2)
  }
  // work defaults to ptc-only (run_code + the DSH-style prompt); ptc: true keeps the built-ins beside run_code, false drops it.
  if (job.ptc === undefined) job.ptc = 'only' // read defaults to the read-only ptc too; ptc: false gives read the built-ins back
  const started = Date.now()
  const ensured = cpaEnv()
  if (ensured.error !== undefined) return done({ ok: false, error: ensured.error })
  const cpa = ensured.env
  const cliEffort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(job.effort) ? ['--effort', job.effort] : []
  const routedModel = !gpt && job.effort === 'off' ? model + '(none)' : model
  {
    const env = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (!/^(CLAUDE|ANTHROPIC)/i.test(k)) env[k] = v
    }
    {
      // CPA routes by the model in the request, so the real GPT id has to travel in every model variable;
      // Claude Code warns [claude-code:unrecognized_model] on stderr and runs anyway.
      Object.assign(env, {
        ANTHROPIC_BASE_URL: cpa.ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: cpa.ANTHROPIC_AUTH_TOKEN,
        ANTHROPIC_MODEL: routedModel,
        ANTHROPIC_SMALL_FAST_MODEL: routedModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: routedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: routedModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: routedModel,
        CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '3',
        ENABLE_TOOL_SEARCH: 'false',
        CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      })
      // Claude Code caps output at 32000 by default; DS max-effort thinking alone can use all of it.
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = gpt ? '128000' : '358000'
      // CPA 的模型 CC 都不认识，窗口按 200K 处理（约 169K 就自动压缩）；DS 和 GPT 统一放到 400K。
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '400000'
    }
    // read + ptc: 'only' (the default; ptc: false gives the built-in Read/Grep/Glob/WebFetch): run_code is the only
    // tool, like work's ptc-only, but ptc-run runs it read-only (Node permission model: no writes, no child processes).
    const roOnly = job.mode !== 'work' && job.ptc === 'only'
    if (job.clean === true) env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
    if (job.ptc === 'only') {
      env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1' // no CLAUDE.md in the request
      env.PTC_RUN_SDK_IN_PROMPT = '1' // ptc-run: short run_code description + DSH-shaped tools.*
      if (roOnly) env.PTC_RUN_READONLY = '1' // ptc-run: read-only sandbox (broker + restricted runner)
    }
    // read + ptc:'only' with readPaths: extra directories ptc-run's read-only broker may read and search, besides the
    // cwd (PTC_RUN_READ_ROOTS, PATH-style separated). Read only: writes and child processes stay blocked, and ptc-run
    // drops any entry that is missing or not absolute, so a stale directory never fails the run.
    const readRoots = readRootsOf(job, roOnly)
    const readRootsValue = readRootsEnv(readRoots, path.delimiter)
    if (readRootsValue !== '') env.PTC_RUN_READ_ROOTS = readRootsValue
    else delete env.PTC_RUN_READ_ROOTS
    // ptc: 'only' leaves run_code as the sole tool (like DSH's PTC-only presentation), so no
    // built-in tool descriptions are sent at all. --tools "" would also drop plugin tools, so name it.
    const only = job.ptc === 'only'
    // read's ptc-only keeps WebFetch beside run_code: the read-only sandbox has no network tool of its own to offer.
    const tools = only ? (roOnly ? `${PTC_TOOL},WebFetch` : PTC_TOOL) : job.mode === 'work' ? WORK_TOOLS : READ_TOOLS
    // Plugin tools ($.tool.register) are not MCP config, so --strict-mcp-config does not remove them;
    // each plugin is shut out by name. work may keep ptc-run's run_code (it can already write and run
    // commands, like Bash); read gets it only as ptc: 'only', where ptc-run confines it (PTC_RUN_READONLY), since the
    // unconfined run_code would undo --restricted.
    const ptc = (job.mode === 'work' && job.ptc !== false) || roOnly
    const blocked = ptc ? BLOCKED_MCP : [...BLOCKED_MCP, PTC_SERVER]
    // stream: the task rides in as the first user message and stdin stays open, so a message can be
    // queued mid-run (the CLI runs it after the current turn) and the child exits when stdin closes.
    const stream = job.stream === true
    // A new task gets the id the plugin generated, so a restart can still name the agent; a resume keeps its own.
    const sessionArg = job.resume
      ? ['--resume', String(job.resume)]
      : typeof job.sessionId === 'string' && UUID_RE.test(job.sessionId)
        ? ['--session-id', job.sessionId]
        : []
    const args = [
      ...sessionArg,
      ...cliEffort,
      '-p',
      ...(stream ? ['--input-format', 'stream-json'] : [task]),
      '--output-format',
      'stream-json',
      '--verbose',
      // 半成品事件（stream_event）里才有运行中的用量：assistant 行的 usage.output_tokens 恒为 0。
      '--include-partial-messages',
      // GPT 的推理摘要要请求里带 thinking.display=summarized，CPA 才向上游要 reasoning.summary；不带时思考块只有加密签名、没有文字。
      ...(gpt ? ['--thinking-display', 'summarized'] : []),
      '--allowedTools',
      only ? tools : ptc ? `${tools},${PTC_TOOL}` : tools,
      '--tools',
      tools,
      ...(only ? ['--system-prompt-file', roOnly ? PTC_RO_PROMPT : PTC_ONLY_PROMPT, '--settings', PTC_ONLY_SETTINGS, '--exclude-dynamic-system-prompt-sections'] : []),
      // The read-only prompt is shared, so the extra readable directories go in as an appended line (one arg, no shell).
      ...readRootsPromptArg(readRoots),
      // clean: 原生 CC 对照用，保留内置工具，关掉全部插件、输出风格和 CLAUDE.md（A/B 测试专用）。
      ...(job.clean === true && !only ? ['--settings', CLEAN_SETTINGS] : []),
      '--strict-mcp-config',
      '--disallowedTools',
      blocked.join(','),
      // --restricted strips code-running tools, run_code included, so read + ptc: 'only' goes without it; there
      // ptc-run's read-only sandbox confines reads to the cwd (Node permission model) and refuses all writes/commands.
      ...(job.mode === 'work' || roOnly ? [] : ['--restricted']),
      '--max-turns',
      String(Math.max(Number(job.maxTurns) || 1000, 1)),
    ]
    // No practical turn/time cap: 2 h only catches a hung child process
    const timeoutMs = Number(job.timeoutMs) || 7_200_000
    const child = spawn(findClaude(), args, {
      cwd: job.cwd || process.cwd(),
      env,
      stdio: [stream ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (control) {
      control.state.childPid = child.pid ?? null
      control.write(true)
    }
    let out = ''
    let err = ''
    let buf = ''
    let parsed
    let sid = control?.state.sessionId ?? null
    let lastText = ''
    let turnCount = 0
    const models = []
    let cancelled = false
    let pendingClose = false
    let lastResultAt = 0
    let stdinClosed = false
    const closeStdin = () => {
      if (stdinClosed) return
      stdinClosed = true
      try { child.stdin.end() } catch {}
    }
    const writeUser = text => {
      if (!stream || stdinClosed) return false
      try {
        child.stdin.write(
          JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }) + '\n',
        )
        return true
      } catch {
        return false
      }
    }
    const handleLine = line => {
      if (line.trim() === '') return
      let o
      try {
        o = JSON.parse(line)
      } catch {
        try { control?.append(line) } catch {}
        return
      }
      if (control) control.onEvent(line, o)
      // stream-json: keep the session id and the last assistant text, so a run cut short still reports what it did.
      if (typeof o.session_id === 'string' && o.session_id !== '') sid = o.session_id
      if (o.type === 'assistant') {
        turnCount += 1
        addModel(models, o)
        const text = (o.message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('')
        if (text) lastText = text
      }
      if (o.type === 'result') {
        parsed = o
        lastResultAt = Date.now()
        if (stream) pendingClose = true
      }
    }
    child.stdout.on('data', d => {
      const text = String(d)
      out = out.length > OUT_KEEP ? out.slice(-OUT_KEEP) + text : out + text
      buf += text
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        handleLine(line)
      }
    })
    child.stderr.on('data', d => (err += d))
    if (stream) writeUser(task)
    // DELEGATE_STREAM_LOG=<file> keeps the raw stream-json of one run (debugging: which model answered, why it stopped).
    if (process.env.DELEGATE_STREAM_LOG) {
      child.on('close', () => {
        try { fs.writeFileSync(process.env.DELEGATE_STREAM_LOG, out) } catch {}
      })
    }
    // The control loop: inbox messages into the child, the cancel file out to the child tree, and stdin
    // closed once a result has waited SEND_GRACE_MS with nothing queued.
    const poll = setInterval(() => {
      if (control) {
        const messages = control.drain()
        for (const text of messages) {
          if (writeUser(text)) {
            pendingClose = false
            try { control.append(JSON.stringify({ type: 'sent', at: Date.now(), text: text.slice(0, 500) })) } catch {}
          } else {
            try { control.append(JSON.stringify({ type: 'dropped', at: Date.now(), reason: 'job is not in stream mode' })) } catch {}
          }
        }
        if (messages.length > 0) control.write(true)
        if (!cancelled && control.isCancelled()) {
          cancelled = true
          control.state.phase = 'cancelling'
          control.write(true)
          killTree(child)
        }
      }
      if (stream && pendingClose && Date.now() - lastResultAt >= SEND_GRACE_MS) {
        pendingClose = false
        closeStdin()
      }
    }, POLL_MS)
    poll.unref?.()
    const timer = setTimeout(() => killTree(child), timeoutMs)
    const code = await new Promise(resolve => child.on('close', resolve))
    clearTimeout(timer)
    clearInterval(poll)
    if (buf.trim() !== '') handleLine(buf)
    const ms = Date.now() - started
    if (cancelled) {
      return done({
        ok: false,
        error: 'cancelled',
        text: lastText,
        models: models.length > 0 ? models : null,
        terminal: terminalOf(lastText),
        sessionId: sid ?? control?.state.sessionId ?? null,
        turns: turnCount,
        ms,
      })
    }
    if (parsed && typeof parsed.result === 'string') {
      return done({
        ok: parsed.is_error !== true,
        text: parsed.result,
        models: models.length > 0 ? models : null,
        terminal: terminalOf(parsed.result),
        sessionId: parsed.session_id ?? sid ?? null,
        turns: parsed.num_turns ?? null,
        ms,
        usage: parsed.usage ?? null,
      })
    }
    const tail = redact((err || out).replace(/\s+/g, ' ').trim().slice(-600), [
      cpa.ANTHROPIC_AUTH_TOKEN,
    ])
    const cut = code === null || Date.now() - started >= timeoutMs
    if (cut && sid) {
      const said = lastText ? '\n它最后说的：' + lastText : ''
      return done({
        ok: false,
        error: '超时（' + Math.round(ms / 1000) + ' 秒）被中止，但代理已经做了 ' + turnCount + ' 轮，改动的文件可能已经写好，先去核对；要它接着做就用 resume 续用，不要新建。' + said,
        text: lastText,
        models: models.length > 0 ? models : null,
        terminal: terminalOf(lastText),
        sessionId: sid,
        turns: turnCount,
        ms,
      })
    }
    return done({
      ok: false,
      error: code === null || Date.now() - started >= timeoutMs ? `timed out after ${Math.round(ms / 1000)} s` : `claude exited ${code}: ${tail}`,
      models: models.length > 0 ? models : null,
      terminal: terminalOf(lastText),
    })
  }
}

main().catch(e => finish({ ok: false, error: String(e?.message ?? e) }, 1))