// 缓存保活：重放体的改写、保活条件、日志里不许出现 key。纯逻辑 + 一个本地转发的小闭环。
//
//   node --test tests/keepalive.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  afterReplay,
  appendLog,
  costOf,
  decide,
  hitRate,
  logEntryOf,
  logPathOf,
  maxTokensTooSmall,
  mergeUsage,
  minMaxTokensOf,
  normalizeSettings,
  replayBodyOf,
  sessionPathOf,
  summarizeLog,
  tokensOf,
} from '../scripts/keepalive-lib.mjs'
import { startKeepaliveProxy } from '../scripts/keepalive-proxy.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-ka-'))
const MIN = 60_000
const now = 1_700_000_000_000

// 一条真实请求的样子：system / tools / messages / model / thinking / output_config 都在。
const originalBody = () => ({
  model: 'mypool-resp/gpt-6.1-sol',
  max_tokens: 128000,
  stream: true,
  system: [{ type: 'text', text: 'you are a delegate', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'run_code', description: 'run js', input_schema: { type: 'object', properties: {} } }],
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    { role: 'user', content: 'now do the thing' },
  ],
  thinking: { type: 'enabled', budget_tokens: 32000, display: 'summarized' },
  output_config: { effort: 'high' },
  metadata: { user_id: 'abc' },
})

test('重放体只改 stream 和 max_tokens：thinking、output_config、metadata 原样保留', () => {
  const body = originalBody()
  const replay = replayBodyOf(body)
  assert.equal(replay.stream, false)
  assert.equal(replay.max_tokens, 1)
  // 动思考设置会让上游换缓存键：一个字都不能变
  assert.deepEqual(replay.thinking, body.thinking)
  assert.deepEqual(replay.output_config, body.output_config)
  assert.deepEqual(replay.metadata, body.metadata)
  assert.deepEqual(replay.system, body.system)
  assert.deepEqual(replay.tools, body.tools)
  assert.deepEqual(replay.messages, body.messages)
  assert.equal(replay.model, body.model)
  // 只多出/改动这两个键，其余键集合完全一致
  assert.deepEqual(Object.keys(replay).sort(), Object.keys(body).sort())
  // 原请求不被就地改动
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 128000)
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 32000, display: 'summarized' })
})

test('上游嫌 max_tokens 小时，换成 budget_tokens+1；没有思考预算就没有备选值', () => {
  const body = originalBody()
  assert.equal(minMaxTokensOf(body), 32001)
  assert.equal(minMaxTokensOf({ max_tokens: 10 }), null)
  assert.equal(minMaxTokensOf({ thinking: { type: 'disabled' } }), null)
  assert.equal(replayBodyOf(body, 32001).max_tokens, 32001)
  assert.deepEqual(replayBodyOf(body, 32001).thinking, body.thinking)
  assert.equal(maxTokensTooSmall(400, '{"error":"max_tokens must be greater than thinking.budget_tokens"}'), true)
  assert.equal(maxTokensTooSmall(500, 'max_tokens budget_tokens'), false)
})

test('保活条件：运行中跳过、太小跳过、超时删除、连续低命中删除、否则重放', () => {
  const settings = normalizeSettings({ intervalMinutes: 8, minTokens: 60000, maxHours: 3 })
  const big = { body: originalBody(), lastRequestAt: now - 20 * MIN, usage: { input_tokens: 2000, cache_read_input_tokens: 148000 } }
  assert.equal(tokensOf(big), 150000)
  assert.deepEqual(decide(big, settings, now), { action: 'replay', reason: 'ok' })

  // 作业还在跑（最后真实请求距今不到 intervalMinutes）
  assert.equal(decide({ ...big, lastRequestAt: now - 3 * MIN }, settings, now).reason, 'running')
  // --once 时不再等，但其余条件照旧
  assert.equal(decide({ ...big, lastRequestAt: now - MIN }, settings, now, { force: true }).action, 'replay')
  // 小于 minTokens：按 body 估也一样跳过
  const small = { body: { messages: [{ role: 'user', content: 'ok' }] }, lastRequestAt: now - 20 * MIN, usage: { input_tokens: 10 } }
  assert.equal(decide(small, settings, now).reason, 'small')
  // 超过 maxHours
  assert.equal(decide({ ...big, lastRequestAt: now - 4 * 60 * MIN }, settings, now).reason, 'expired')
  // 连续两次命中率不到一半
  assert.equal(decide({ ...big, lowHits: 2 }, settings, now).reason, 'low-hit')
  assert.equal(decide({ ...big, lowHits: 1 }, settings, now).action, 'replay')
  // 关掉开关就什么都不做
  assert.equal(decide(big, { ...settings, enabled: false }, now).action, 'skip')
})

test('命中率决定连续失败计数，命中一次就清零', () => {
  const base = { lowHits: 0, lastRequestAt: now }
  const miss = afterReplay(base, { input_tokens: 150000, cache_read_input_tokens: 1000, output_tokens: 1 }, now)
  assert.equal(miss.lowHits, 1)
  const missAgain = afterReplay(miss, { input_tokens: 150000, cache_read_input_tokens: 1000, output_tokens: 1 }, now)
  assert.equal(missAgain.lowHits, 2)
  const hit = afterReplay(missAgain, { input_tokens: 2000, cache_read_input_tokens: 148000, output_tokens: 1 }, now)
  assert.equal(hit.lowHits, 0)
  assert.equal(hitRate({ input_tokens: 2000, cache_read_input_tokens: 148000 }), 0.9866666666666667)
  assert.equal(hitRate({}), null)
  // 没有数字（例如 400）不改变计数
  assert.equal(afterReplay(base, undefined, now).lowHits, 0)
})

test('费用按缓存读 $0.02/百万、输入 $0.4/百万、输出 $2/百万', () => {
  const usd = costOf({ input_tokens: 2000, cache_read_input_tokens: 148000, output_tokens: 1 })
  assert.ok(Math.abs(usd - (148000 * 0.02 + 2000 * 0.4 + 1 * 2) / 1_000_000) < 1e-12)
  const sum = summarizeLog(
    [logEntryOf({ jobId: 'j1', model: 'm', status: 200, usage: { cache_read_input_tokens: 148000 }, now }), logEntryOf({ jobId: 'j1', model: 'm', status: 200, usage: { input_tokens: 1000 }, now: now - 2880 * MIN })].map(e => JSON.stringify(e)).join('\n'),
    now,
  )
  assert.equal(sum.replays, 2)
  assert.equal(sum.replaysToday, 1)
  assert.ok(sum.costToday > 0 && sum.costToday < sum.cost)
})

test('日志里没有 key，也没有 headers', () => {
  const root = tmp()
  const secret = 'sk-ant-SECRET-do-not-log-0123456789'
  const entry = logEntryOf({ jobId: 'fg-1', model: 'mypool-resp/gpt-6.1-sol', status: 200, usage: { input_tokens: 5, cache_read_input_tokens: 60000, output_tokens: 1 }, now })
  appendLog(root, entry)
  const text = fs.readFileSync(logPathOf(root), 'utf8')
  assert.doesNotMatch(text, /SECRET/)
  assert.doesNotMatch(text, /authorization|x-api-key|"headers"|sk-/i)
  const parsed = JSON.parse(text.trim())
  assert.equal(parsed.cache_read_input_tokens, 60000)
  assert.equal(parsed.output_tokens, 1)
  void secret
})

test('用量合并：输入取先看到的正数，输出取最后一次', () => {
  const merged = mergeUsage({ input_tokens: 150000, cache_read_input_tokens: 0 }, { input_tokens: 0, cache_read_input_tokens: 149000, output_tokens: 1 })
  assert.equal(merged.input_tokens, 150000)
  assert.equal(merged.cache_read_input_tokens, 149000)
  assert.equal(merged.output_tokens, 1)
})

test('转发：流式原样传回，请求体存成 <jobId>.json，用量跟着记，文件里没有 key', async () => {
  const root = tmp()
  const secret = 'sk-live-SECRET-abcdefghijklmnop'
  const upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      assert.equal(req.url, '/v1/messages')
      assert.equal(JSON.parse(body).model, 'mypool-resp/gpt-6.1-sol')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 2000, cache_read_input_tokens: 148000, output_tokens: 0 } } }) + '\n\n')
      res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }) + '\n\n')
      res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 3 } }) + '\n\n')
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    })
  })
  await new Promise(done => upstream.listen(0, '127.0.0.1', done))
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port
  const proxy = await startKeepaliveProxy({ target: baseUrl, jobId: 'ka-smoke-1', root })
  try {
    const reply = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxy.port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret, 'x-api-key': secret } },
        res => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', c => (text += c))
          res.on('end', () => resolve({ status: res.statusCode, text }))
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify(originalBody()))
    })
    assert.equal(reply.status, 200)
    assert.match(reply.text, /content_block_delta/)
    assert.match(reply.text, /message_stop/)
    // 用量在响应结束后才写回，给它一点时间
    const file = sessionPathOf(root, 'ka-smoke-1')
    let saved
    for (let i = 0; i < 100; i += 1) {
      saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined
      if (saved !== undefined && saved.usage !== undefined && saved.usage !== null) break
      await new Promise(done => setTimeout(done, 20))
    }
    assert.ok(saved !== undefined, 'session file should exist')
    assert.deepEqual(saved.body, originalBody())
    assert.equal(saved.jobId, 'ka-smoke-1')
    assert.ok(saved.lastRequestAt > 0)
    assert.equal(saved.usage.cache_read_input_tokens, 148000)
    assert.equal(saved.usage.input_tokens, 2000)
    assert.equal(saved.usage.output_tokens, 3)
    // 只有请求体、时间和用量：没有 headers、没有 key
    assert.deepEqual(Object.keys(saved).sort(), ['at', 'body', 'jobId', 'lastRequestAt', 'lowHits', 'model', 'usage', 'usageAt'])
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /SECRET|authorization|x-api-key|"headers"/i)
  } finally {
    await proxy.close()
    await new Promise(done => upstream.close(done))
  }
})
