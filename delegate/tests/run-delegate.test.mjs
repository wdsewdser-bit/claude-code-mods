// The runner's readPaths hand-off, checked where a real child cannot be started from a test (spawning claude needs a
// real CLI and a live model): the source must wire readPaths into PTC_RUN_READ_ROOTS and into the appended prompt,
// and only for read + ptc:'only'. The env variable's real effect is covered by ptc-run's tests/e2e-hook.mjs.
//
//   node --test tests/run-delegate.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRootsEnv, readRootsOf, readRootsPromptArg } from '../scripts/read-roots.mjs'
import { createOutputTracker } from '../scripts/stream-usage.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '../scripts/run-delegate.mjs'), 'utf8')

test('the runner derives the roots from the job and only for the read-only sandbox', () => {
  assert.match(src, /const roOnly = job\.mode !== 'work' && job\.ptc === 'only'/)
  assert.match(src, /const readRoots = readRootsOf\(job, roOnly\)/)
  assert.match(src, /if \(readRootsValue !== ''\) env\.PTC_RUN_READ_ROOTS = readRootsValue/)
  assert.match(src, /else delete env\.PTC_RUN_READ_ROOTS/)
  assert.match(src, /\.\.\.readRootsPromptArg\(readRoots\)/)
})

test('the env value is what the child gets: PATH-separated, nothing when there is nothing', () => {
  const job = { mode: 'read', ptc: 'only', readPaths: ['C:/ext/one', 'D:/ext/two'] }
  const roots = readRootsOf(job, true)
  assert.equal(readRootsEnv(roots, ';'), 'C:/ext/one;D:/ext/two')
  assert.equal(readRootsEnv(readRootsOf({ mode: 'work', readPaths: ['C:/x'] }, false), ';'), '')
  assert.deepEqual(readRootsPromptArg(roots).slice(0, 1), ['--append-system-prompt'])
})

test('the read-only prompt no longer claims the working directory is the only readable place', () => {
  const prompt = fs.readFileSync(path.join(here, '../scripts/ptc-readonly-system.md'), 'utf8')
  assert.doesNotMatch(prompt, /Only files under the working directory can be read or searched/)
  assert.match(prompt, /working directory plus the extra readable directories/)
})

// 输出用量：assistant 行的 usage.output_tokens 恒为 0，运行中的数只能从 stream_event 里数。
test('the runner asks for partial messages and keeps stream_event lines out of events.jsonl', () => {
  assert.match(src, /'--include-partial-messages'/)
  // stream_event 只用来数 token：onEvent 里先 return，不能落到 append(line)
  assert.match(src, /if \(o\.type === 'stream_event'\) \{[\s\S]{0,200}?return\n {2,4}\}/)
  assert.match(src, /outputTokens: 0/)
  assert.match(src, /const total = output\.final\(o\.usage\)/)
})

test('a message counts once: message_delta carries the running total, not a delta', () => {
  const t = createOutputTracker()
  assert.equal(t.onEvent({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } }), 0)
  assert.equal(t.onEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: '1' } }), 0)
  assert.equal(t.onEvent({ type: 'message_delta', usage: { output_tokens: 12 } }), 12)
  // 同一个数再来一次不会翻倍
  assert.equal(t.onEvent({ type: 'message_delta', usage: { output_tokens: 12 } }), 12)
  assert.equal(t.onEvent({ type: 'message_delta', usage: { output_tokens: 30 } }), 30)
  // 下一条消息从 0 起算，之前那条已经落袋
  assert.equal(t.onEvent({ type: 'message_start', message: { usage: { output_tokens: 0 } } }), 30)
  assert.equal(t.onEvent({ type: 'message_delta', usage: { output_tokens: 7 } }), 37)
  // 乱序/缺失的较小值不回退
  assert.equal(t.onEvent({ type: 'message_delta', usage: { output_tokens: 3 } }), 37)
})

test('the result line overrides what the stream counted, and never lowers it', () => {
  const t = createOutputTracker()
  t.onEvent({ type: 'message_start', message: { usage: { output_tokens: 0 } } })
  t.onEvent({ type: 'message_delta', usage: { output_tokens: 50 } })
  assert.equal(t.final({ output_tokens: 186_521 }), 186_521)
  assert.equal(t.total, 186_521)

  const u = createOutputTracker()
  u.onEvent({ type: 'message_delta', usage: { output_tokens: 80 } })
  // 网关没给数字时保留已经数到的值
  assert.equal(u.final({}), 80)
  assert.equal(u.final(undefined), 80)
  // 比数到的还小也不回退
  assert.equal(u.final({ output_tokens: 5 }), 80)
})

test('garbage events never throw and never invent output', () => {
  const t = createOutputTracker()
  assert.equal(t.onEvent(undefined), 0)
  assert.equal(t.onEvent({}), 0)
  assert.equal(t.onEvent({ type: 'message_delta', usage: { output_tokens: 'x' } }), 0)
  assert.equal(t.onEvent({ type: 'message_delta', usage: { output_tokens: -3 } }), 0)
})
