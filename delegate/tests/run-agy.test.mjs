// node --test delegate/tests/run-agy.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFileOf, argsOf, createTranslator, promptOf } from '../scripts/run-agy.mjs'

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
})

test('the first prompt names the working directory; follow-ups are bare', () => {
  assert.equal(promptOf({ task: 'T', cwd: 'C:/x' }, true), '工作目录：C:/x\n\nT')
  assert.equal(promptOf({ mode: 'work', task: 'T' }, false), 'T')
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
