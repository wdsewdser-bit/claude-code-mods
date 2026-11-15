// node --test delegate/tests/run-agy.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { argsOf, createTranslator, promptOf } from '../scripts/run-agy.mjs'

test('work mode skips permissions, read mode runs in plan mode, resume passes the conversation', () => {
  const work = argsOf({ mode: 'work', model: 'gemini-4-hydrogen-medium' }, 'do it', null)
  assert.deepEqual(work, ['--print=do it', '--output-format', 'stream-json', '--model', 'gemini-4-hydrogen-medium', '--dangerously-skip-permissions'])
  const read = argsOf({ mode: 'read' }, 'look', 'abc')
  assert.ok(read.includes('--conversation') && read.includes('abc'))
  assert.deepEqual(read.slice(-2), ['--mode', 'plan'])
})

test('the first prompt carries the read rule and the report rule; follow-ups are bare', () => {
  const first = promptOf({ mode: 'read', task: 'T' }, true)
  assert.match(first, /只读任务/)
  assert.match(first, /TASK_TERMINAL/)
  assert.doesNotMatch(promptOf({ mode: 'work', task: 'T' }, true), /只读任务/)
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
  assert.deepEqual(tr.usage, { input: 10, cacheRead: 5, cacheWrite: 0, output: 5 })
  assert.equal(tr.turns, 1)
  assert.equal(tr.context, 15)
})
