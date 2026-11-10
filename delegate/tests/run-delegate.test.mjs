// The runner's readPaths hand-off, checked where a real child cannot be started from a test (spawning claude needs a
// real CLI and a live model): the source must wire readPaths into PTC_RUN_READ_ROOTS and into the appended prompt,
// and only for read + ptc:'only'. The env variable's real effect is covered by ptc-run's tests/e2e-hook.mjs.
//
//   node --test tests/run-delegate.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRootsEnv, readRootsOf, readRootsPromptArg } from '../scripts/read-roots.mjs'
import { createOutputTracker } from '../scripts/stream-usage.mjs'
import { createErrorNote } from '../scripts/error-note.mjs'

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

// 状态/日志写入失败的诊断：写一行、限流、目录不在时静默（绝不能把作业弄挂）。
test('noteError appends one line with the where and the message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-note-'))
  try {
    const file = path.join(dir, 'errors.log')
    const note = createErrorNote(file)
    assert.equal(note('status', new Error('EBUSY: resource busy or locked')), 1)
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z status: EBUSY: resource busy or locked$/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('noteError throttles one where after the limit and only counts the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-note-'))
  try {
    const file = path.join(dir, 'errors.log')
    const note = createErrorNote(file, { limit: 3 })
    for (let i = 0; i < 8; i += 1) note('status', new Error('EPERM: operation not permitted'))
    assert.equal(note.countOf('status'), 8)
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 4) // 3 条错误 + 1 条限流说明
    assert.match(lines[3], /status: 同类错误已达 3 次，之后只计数（累计 4 次）$/)
    // 别的 where 不受影响
    assert.equal(note('events', new Error('ENOSPC')), 1)
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 5)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('noteError stays silent when the log directory is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-note-'))
  try {
    const note = createErrorNote(path.join(dir, 'missing', 'errors.log'))
    assert.doesNotThrow(() => note('status', new Error('x')))
    assert.equal(note.countOf('status'), 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// DS 每日用量需要整次运行的输入分项：每次请求的 input + 缓存读 + 缓存写都算，同一条消息不重复加。
test('parts sum every message input and cache read/write, and final output covers the run', () => {
  const t = createOutputTracker()
  t.onEvent({ type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 50, output_tokens: 0 } } })
  t.onEvent({ type: 'message_delta', usage: { input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 50, output_tokens: 10 } })
  t.onEvent({ type: 'message_delta', usage: { input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 50, output_tokens: 20 } })
  t.onEvent({ type: 'message_start', message: { usage: { input_tokens: 150, cache_read_input_tokens: 9500, cache_creation_input_tokens: 0, output_tokens: 0 } } })
  t.onEvent({ type: 'message_delta', usage: { input_tokens: 150, cache_read_input_tokens: 9500, cache_creation_input_tokens: 0, output_tokens: 5 } })
  assert.deepEqual(t.parts, { input: 250, cacheRead: 18_500, cacheWrite: 50, output: 25 })
  assert.equal(t.final({ input_tokens: 999, cache_read_input_tokens: 999, output_tokens: 40 }), 40)
  // result 行的输入只代表最后一次请求，不能覆盖流里累加出来的分项。
  assert.deepEqual(t.parts, { input: 250, cacheRead: 18_500, cacheWrite: 50, output: 40 })
})

test('the real message_delta input replaces the larger message_start estimate', () => {
  const t = createOutputTracker()
  t.onEvent({ type: 'message_start', message: { usage: { input_tokens: 1400, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 0 } } })
  t.onEvent({ type: 'message_delta', usage: { input_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 2 } })
  assert.deepEqual(t.parts, { input: 1000, cacheRead: 1000, cacheWrite: 0, output: 2 })
})

test('parts fall back to the result usage when the stream reported no input at all', () => {
  const t = createOutputTracker()
  t.onEvent({ type: 'message_delta', usage: { output_tokens: 10 } })
  assert.deepEqual(t.parts, { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 })
  t.final({ input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 12 })
  assert.deepEqual(t.parts, { input: 7, cacheRead: 3, cacheWrite: 0, output: 12 })
})

test('garbage events never throw and never invent output', () => {
  const t = createOutputTracker()
  assert.equal(t.onEvent(undefined), 0)
  assert.equal(t.onEvent({}), 0)
  assert.equal(t.onEvent({ type: 'message_delta', usage: { output_tokens: 'x' } }), 0)
  assert.equal(t.onEvent({ type: 'message_delta', usage: { output_tokens: -3 } }), 0)
})
