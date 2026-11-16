// node --test delegate/tests/run-agy.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFileOf, agentKindOf, argsOf, createTranslator, promptOf, recoveredTurn, retrySuffix, nextRetryState } from '../scripts/run-agy.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

test('each mode runs its own agent with permissions auto-approved; resume passes the conversation', () => {
  const work = argsOf({ mode: 'work', model: 'gemini-4-hydrogen-medium' }, 'do it', null)
  assert.deepEqual(work, ['--print=do it', '--output-format', 'stream-json', '--agent', 'cc-delegate-work', '--dangerously-skip-permissions', '--model', 'gemini-4-hydrogen-medium'])
  const read = argsOf({ mode: 'read' }, 'look', 'abc')
  assert.ok(read.includes('cc-delegate-read') && !read.includes('--mode'))
  assert.deepEqual(read.slice(-2), ['--conversation', 'abc'])
})

test('agent files drop agy defaults and route work through ptc run_code', () => {
  const read = agentFileOf('read')
  assert.match(read, /excludeDefaultComponents: true/)
  assert.match(read, /TASK_TERMINAL/)
  assert.match(read, /call_mcp_tool/)
  assert.match(read, /POLICY_DENIED/)
  // 白名单和 mcpServers 都不能写（前者报 not found，后者让 agent 加载失败）
  assert.doesNotMatch(read, /^tools:|^mcpServers:/m)
  assert.doesNotMatch(read, /@@SDK@@/)
  assert.match(agentFileOf('work'), /cc-delegate-work/)
  // 派出去的活是一次性的：不教 lib.def 登记，只说可调用全局库
  for (const k of ['read', 'work']) {
    assert.doesNotMatch(agentFileOf(k), /lib\.def/)
    assert.match(agentFileOf(k), /lib\.help\(\) 列出全局库现有函数/)
  }
})

test('the first prompt names the working directory; follow-ups are bare', () => {
  assert.equal(promptOf({ task: 'T', cwd: 'C:/x' }, true), '工作目录：C:/x\n\nT')
  assert.equal(promptOf({ mode: 'work', task: 'T' }, false), 'T')
})

test('thinking from the transcript is put before the text of that step', () => {
  const tr = createTranslator('m', step => (step === 3 ? 'plan it' : ''))
  const su = s => ({ event: 'step_update', step_update: s })
  tr.on(su({ step_type: 'agent_response', state: 'ACTIVE', step_index: 3, text_delta: 'ok' }))
  const [ev] = tr.on(su({ step_type: 'agent_response', state: 'DONE', step_index: 3, usage: {} }))
  assert.deepEqual(ev.message.content, [{ type: 'thinking', thinking: 'plan it' }, { type: 'text', text: 'ok' }])
})

test('agy events become assistant lines with tool_use, text and usage', () => {
  const tr = createTranslator('m')
  const su = s => ({ event: 'step_update', step_update: s })
  assert.deepEqual(tr.on(su({ step_type: 'agent_response', state: 'ACTIVE', text_delta: 'he' })), [])
  tr.on(su({ step_type: 'agent_response', state: 'ACTIVE', text_delta: 'llo' }))
  const [done] = tr.on(su({ step_type: 'agent_response', state: 'DONE', usage: { input_tokens: 10, cache_read_tokens: 5, output_tokens: 3, thinking_tokens: 2 } }))
  assert.equal(done.type, 'assistant')
  assert.deepEqual(done.message.content, [{ type: 'text', text: 'hello' }])
  assert.deepEqual(done.message.usage, { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 5 })
  const [tool] = tr.on(su({ step_type: 'tool', state: 'ACTIVE', tool_name: 'write_file', tool_info: { parameters: { Path: 'x' } } }))
  assert.deepEqual(tool.message.content, [{ type: 'tool_use', name: 'write_file', input: { Path: 'x' } }])
  assert.deepEqual(tr.on(su({ step_type: 'tool', state: 'DONE', tool_name: 'write_file' })), [])
  const [ptc] = tr.on(su({ step_type: 'tool', state: 'ACTIVE', tool_name: 'call_mcp_tool', tool_info: { parameters: { ServerName: 'ptc', ToolName: 'run_code', Arguments: { code: 'return 1' } } } }))
  assert.deepEqual(ptc.message.content, [{ type: 'tool_use', name: 'run_code', input: { code: 'return 1' } }])
  assert.deepEqual(tr.usage, { input: 10, cacheRead: 5, cacheWrite: 0, output: 5 })
  assert.equal(tr.turns, 1)
  assert.equal(tr.context, 15)
})

test('flush emits un-DONE text as an assistant event without changing turns or usage', () => {
  const tr = createTranslator('m')
  const su = s => ({ event: 'step_update', step_update: s })
  assert.deepEqual(tr.on(su({ step_type: 'agent_response', state: 'ACTIVE', text_delta: 'par' })), [])
  assert.deepEqual(tr.on(su({ step_type: 'agent_response', state: 'ACTIVE', text_delta: 'tial' })), [])
  const flushed = tr.flush()
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].type, 'assistant')
  assert.deepEqual(flushed[0].message.content, [{ type: 'text', text: 'partial' }])
  assert.equal(flushed[0].message.usage, undefined)
  assert.deepEqual(tr.flush(), [])
  assert.equal(tr.turns, 0)
  assert.deepEqual(tr.usage, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
})

test('ptc:false picks the native agent, which never mentions run_code', () => {
  assert.equal(agentKindOf({ mode: 'work', ptc: false }), 'native')
  assert.equal(agentKindOf({ mode: 'work' }), 'work')
  assert.equal(agentKindOf({ mode: 'read' }), 'read')
  assert.ok(argsOf({ mode: 'work', ptc: false }, 'p', null).includes('cc-delegate-native-work'))
  const file = agentFileOf('native')
  assert.match(file, /^name: cc-delegate-native-work$/m)
  assert.doesNotMatch(file, /run_code|ptc|mcpServers/)
})

// 断流判定：夹具是 agy 真实会话 e528d7dd 第 74–88 步（第 76 步是断流的 ERROR_MESSAGE，之后 agy 自己接着跑完）。
const fixtureSteps = fs.readFileSync(new URL('./fixtures/agy-interrupt-e528d7dd.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l))
const STREAM_ERR = 'The stream was interrupted. Please continue the task you were working on.'
const FAILED = { status: 'ERROR', error: STREAM_ERR }

test('断流后恢复并完成：判为恢复，计 1 次断流', () => {
  assert.deepEqual(recoveredTurn(fixtureSteps, 0, FAILED), { interrupts: 1 })
})

test('续跑时带着历史断流错误：只看续跑起点之后，历史错误不计入本轮', () => {
  const resumed = [...fixtureSteps, { step_index: 89, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: '续跑的最终报告' }]
  assert.deepEqual(recoveredTurn(resumed, 89, FAILED), { interrupts: 0 })
})

test('真失败：断流后没有任何回复，最后一步是错误，不判恢复', () => {
  assert.equal(recoveredTurn(fixtureSteps.slice(0, 3), 0, FAILED), null)
})

test('报错文本与 agy 记录的错误步骤不相等（结构化比对失败）：不判恢复，退化成失败', () => {
  assert.equal(recoveredTurn(fixtureSteps, 0, { status: 'ERROR', error: 'quota exceeded' }), null)
})

test('成功的结果不做判定', () => {
  assert.equal(recoveredTurn(fixtureSteps, 0, { status: 'SUCCESS', error: STREAM_ERR }), null)
})

test('失败时的说明带上本轮断流次数和最后一次错误，历史错误不计入', () => {
  assert.equal(retrySuffix(fixtureSteps, 0), `（本轮断流 1 次，最后一次：${STREAM_ERR}）`)
  assert.equal(retrySuffix(fixtureSteps, 89), '')
})

test('实时重试状态：错误步骤记为重试中，之后的回复或工具调用清掉“重试中”，次数保留', () => {
  let st = null
  st = nextRetryState(st, { step_type: 'error_message' })
  assert.deepEqual(st, { count: 1, retrying: true })
  st = nextRetryState(st, { step_type: 'agent_response' })
  assert.deepEqual(st, { count: 1, retrying: false })
  st = nextRetryState(st, { step_type: 'error_message' })
  assert.deepEqual(st, { count: 2, retrying: true })
  st = nextRetryState(st, { step_type: 'tool' })
  assert.deepEqual(st, { count: 2, retrying: false })
  assert.equal(nextRetryState(null, { step_type: 'user_input' }), null)
})

test('最后一步是只发工具调用的中间回复（没有正文）：不判恢复', () => {
  const midTool = [...fixtureSteps.slice(0, 3), { step_index: 77, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: '' }]
  assert.equal(recoveredTurn(midTool, 0, FAILED), null)
})

test('被取消的作业即使历史里有断流记录，也不判成恢复', () => {
  assert.equal(recoveredTurn(fixtureSteps, 0, FAILED, true), null)
})


// 提示词里的 run_code 示例在 ptc MCP 服务器里真跑：read 模式的走只读沙箱，work 模式的走可写沙箱。
const callPtc = (cwd, code, readonly) => new Promise((resolve, reject) => {
  const server = path.resolve(import.meta.dirname, '..', '..', 'ptc-run', 'mcp', 'server.mjs')
  const env = { ...process.env, PTC_MCP_CWD: cwd, PTC_MCP_SCOPE: 'agy-ex-test' }
  if (readonly) env.PTC_RUN_READONLY = '1'; else delete env.PTC_RUN_READONLY
  const child = spawn(process.execPath, [server], { cwd, env, windowsHide: true })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.on('error', reject)
  child.on('close', () => {
    const msg = out.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(m => m.id === 1)
    resolve(msg?.result)
  })
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_code', arguments: { description: '示例', code } } }) + '\n')
})
test('the ptc MCP server describes run_code without lib.def', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-desc-'))
  try {
    const server = path.resolve(import.meta.dirname, '..', '..', 'ptc-run', 'mcp', 'server.mjs')
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [server], { cwd: dir, env: { ...process.env, PTC_MCP_CWD: dir }, windowsHide: true })
      let s = ''
      child.stdout.on('data', d => { s += d })
      child.on('error', reject)
      child.on('close', () => resolve(s))
      child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n')
    })
    const desc = JSON.parse(out.split('\n').find(Boolean)).result.tools[0].description
    assert.doesNotMatch(desc, /lib\.def/)
    assert.match(desc, /lib\.help\(\) 列出全局库现有函数/)
    assert.match(desc, /tools\.grep/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

const codeBlocks = text => [...text.matchAll(/```js\n([\s\S]*?)```/g)].map(m => m[1])

test('the run_code examples in the agent prompts run in the ptc sandbox', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ex-'))
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'config.mjs'), 'export function parseConfig () {\n  return { timeout: 30 }\n}\n// TODO: env\n')
  fs.writeFileSync(path.join(dir, 'src', 'app.mjs'), "import { parseConfig } from './config.mjs'\nexport async function main () { return parseConfig() }\n")
  fs.writeFileSync(path.join(dir, 'src', 'config.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert'\nimport { parseConfig } from './config.mjs'\ntest('t', () => assert.ok(parseConfig().timeout > 0))\n")
  try {
    for (const [kind, readonly] of [['read', true], ['work', false]]) {
      const blocks = codeBlocks(agentFileOf(kind))
      assert.equal(blocks.length, kind === 'read' ? 2 : 3, kind)
      for (const code of blocks) {
        const r = await callPtc(dir, code, readonly)
        // 只读沙箱读不到会话库时会多一行 [lib] 提示（程序照常运行），与示例无关
        const text = (r?.content?.map(c => c.text).join('') ?? '').split('\n').filter(l => !l.startsWith('[lib]')).join('\n')
        assert.ok(r && !r.isError, `${kind} 示例失败：${code.split('\n')[0]}\n${text}`)
        assert.doesNotMatch(text, /Error|POLICY_DENIED|失败/, text)
        if (code.includes('示例 1')) assert.match(text, /文件 3 个[\s\S]*config\.mjs:1 export function parseConfig[\s\S]*TODO: src\/config\.mjs=1/)
        if (code.includes('示例 2')) assert.match(text, /app\.mjs:1> import \{ parseConfig \}/)
        if (code.includes('示例 3')) assert.match(text, /改 1 处；测试 通过；残留 0/)
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
