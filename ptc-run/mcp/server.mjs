// ptc-run as a stdio MCP server, for hosts that are not Claude Code (delegate_agy hands it to the Antigravity CLI).
// Zero dependencies: newline-delimited JSON-RPC 2.0, the MCP subset a tools-only server needs
// (initialize, tools/list, tools/call, ping). Each run_code call runs the same sandbox the plugin runs:
// `node -e BOOT` with the payload line and src/runner.js on stdin, or the read-only broker when PTC_RUN_READONLY=1.
//
// Environment (set by whoever launches the host, inherited by this server):
//   PTC_MCP_CWD        working directory for programs (default: this process's cwd)
//   PTC_RUN_READONLY   1 = read-only broker (no write/edit/bash), as delegate's read mode
//   PTC_RUN_READ_ROOTS extra readable absolute directories (path-separator list), read-only mode only
//   PTC_MCP_SCOPE      scope / session id for refs, kv and the session lib (default: 'mcp')
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const RUNNER = fs.readFileSync(path.join(root, 'src', 'runner.js'), 'utf8')
const BROKER = fs.readFileSync(path.join(root, 'src', 'broker.js'), 'utf8')
// Same bootstrap as hooks/register.ts: the first stdin line is the payload, the rest is evaluated.
const BOOT = 'const s=require("fs").readFileSync(0,"utf8"),k=s.indexOf("\\n");globalThis.__PTC_IN=s.slice(0,k);(0,eval)(s.slice(k+1))'
const RG = path.join(root, 'bin', 'rg.exe')

const env = process.env
const ro = env.PTC_RUN_READONLY === '1'
const cwd = env.PTC_MCP_CWD && fs.existsSync(env.PTC_MCP_CWD) ? env.PTC_MCP_CWD : process.cwd()
const scope = (env.PTC_MCP_SCOPE || 'mcp').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'mcp'
const readRoots = ro ? (env.PTC_RUN_READ_ROOTS || '').split(path.delimiter).map(s => s.trim()).filter(Boolean) : []

// 工具说明和主会话的 run_code 同一份：从 src/register.tpl.ts 的 DESC_PARTS 取（build.cjs 也是这样读的）。
const descParts = () => {
  try {
    const tpl = fs.readFileSync(path.join(root, 'src', 'register.tpl.ts'), 'utf8')
    const m = /const DESC_PARTS = \[([\s\S]*?)\]\n/.exec(tpl)
    if (m) return (0, eval)('[' + m[1] + ']').join(' ')
  } catch {}
  return 'Run a JavaScript async-function body in a sandbox: tools.* are synchronous (no .then); only console.log output and the return value come back. tools.help() lists the SDK topics.'
}
const DESC = ro
  ? 'READ-ONLY sandbox: tools.read/glob/grep/peek and ref.* work; tools.write/edit/replace/batch/bash/sh throw POLICY_DENIED. ' + descParts()
  : descParts()

const TOOL = {
  name: 'run_code',
  description: DESC,
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Body of an async function; use return and console.log.' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000, description: 'whole-program timeout, default 300000' },
      root: { type: 'string', description: 'optional existing absolute directory used as the base for relative paths, glob/grep and bash' },
      maxChars: { type: 'integer', minimum: 1000, maximum: 50000, description: 'output cap in chars (default 50000)' },
    },
    required: ['code'],
  },
}

const runCode = input =>
  new Promise(resolve => {
    const timeoutMs = Math.min(Math.max(Math.trunc(Number(input.timeoutMs) || 300000), 1000), 600000)
    const maxChars = Math.min(Math.max(Math.trunc(Number(input.maxChars) || 50000), 1000), 50000)
    const logName = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    const payload = {
      cwd,
      code: String(input.code ?? ''),
      ...(fs.existsSync(RG) ? { rg: RG } : {}),
      scope,
      sessionId: scope,
      dsh: false, // 标准同步 SDK；dsh 是配 DS 专用提示词的异步写法
      root: typeof input.root === 'string' && input.root !== '' ? input.root : undefined,
      roRoots: [],
      readRoots,
      logName,
      dedup: false,
      dedupTag: 'mcp',
      dedupReset: true,
      maxChars,
    }
    const stdin = ro
      ? JSON.stringify({ ...payload, timeoutMs, boot: BOOT, runner: RUNNER }) + '\n' + BROKER
      : JSON.stringify(payload) + '\n' + RUNNER
    let out = ''
    let err = ''
    let done = false
    const child = spawn(process.execPath, ['-e', BOOT], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const finish = (text, isError) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ content: [{ type: 'text', text }], isError })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish(`[RESULT_UNKNOWN] 程序在 ${timeoutMs / 1000} 秒超时被终止。已打印的输出：\n${out.slice(-4000) || '（无输出）'}`, true)
    }, timeoutMs + 2000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err = (err + d).slice(-4000) })
    child.on('error', e => finish(`run_code 启动失败：${e?.message ?? e}`, true))
    child.on('close', code => finish(out + (err ? '\n[stderr] ' + err.slice(0, 2000) : ''), code !== 0))
    child.stdin.end(stdin)
  })

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

const handle = async msg => {
  const { id, method, params } = msg
  if (id === undefined || id === null) return // notifications (initialized, cancelled): nothing to answer
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'ptc-run', version: '0.2.0' },
    })
  }
  if (method === 'ping') return reply(id, {})
  // 只给 delegate 启动的会话（带 PTC_MCP_CWD）：全局注册后，人自己开的 agy 会话里看不到这个工具。
  if (method === 'tools/list') return reply(id, { tools: env.PTC_MCP_CWD ? [TOOL] : [] })
  if (method === 'tools/call') {
    if (params?.name !== 'run_code') return fail(id, -32602, `unknown tool ${params?.name}`)
    return reply(id, await runCode(params.arguments ?? {}))
  }
  return fail(id, -32601, `method not found: ${method}`)
}

let buf = ''
let pending = 0
let ended = false
const maybeExit = () => { if (ended && pending === 0) process.exit(0) }
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line === '') continue
    let msg
    try { msg = JSON.parse(line) } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue }
    pending += 1
    handle(msg)
      .catch(e => fail(msg.id, -32603, String(e?.message ?? e)))
      .finally(() => { pending -= 1; maybeExit() })
  }
})
// 输入关了也要等还在跑的 run_code 回完再走。
process.stdin.on('end', () => { ended = true; maybeExit() })
