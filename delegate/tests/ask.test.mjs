// 后台作业请示主会话：runner 侧的端到端验证。真 claude 起不来（要 CLI 和活模型），所以用 DELEGATE_CHILD_CMD
// 换成一个假子进程，它按 stream-json 说话：先发一条以【请示】开头的 result，此后每收到一条用户消息再请示一次，
// 第三次输出最终结果。cpaEnv 也换成假的（DELEGATE_CPA_ENSURE + DELEGATE_CPA_PYTHON）。
//
//   node --test tests/ask.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const runner = path.join(here, '../scripts/run-delegate.mjs')

// 假子进程：argv 和收到的每条用户消息都记进 FAKE_LOG。
const FAKE_CHILD = `
import fs from 'node:fs'
const log = process.env.FAKE_LOG
const note = (name, extra) => { try { fs.appendFileSync(log, JSON.stringify({ name, ...extra }) + '\\n') } catch {} }
const emit = result => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session', num_turns: 1, result }) + '\\n')
note('argv', { argv: process.argv.slice(2) })
const ask = process.env.FAKE_ASK === '1'
setTimeout(() => emit(ask ? '\\n  【请示】现状：A 和 B 都能做。\\n可选：A / B。倾向 A。' : 'plain done'), 50)
let users = 0
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (line.trim() === '') continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type !== 'user') continue
    users += 1
    note('user', { text: o.message?.content })
    if (!ask) continue
    if (users === 2) emit('【请示】第二次：还要继续吗？')
    else if (users === 3) emit('FINAL: 按回复做完了')
  }
})
process.stdin.on('end', () => process.exit(0))
`

// 假 ensure_cpa.py：只打印 runner 要的那两个变量。
const FAKE_ENSURE = "process.stdout.write('ANTHROPIC_BASE_URL=http://127.0.0.1:9\\nANTHROPIC_AUTH_TOKEN=fake-token-000000\\n')"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const setup = (fileName) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-ask-'))
  const child = path.join(dir, fileName)
  const ensure = path.join(dir, 'fake-ensure.mjs')
  fs.writeFileSync(child, FAKE_CHILD)
  fs.writeFileSync(ensure, FAKE_ENSURE)
  const jobs = path.join(dir, 'jobs')
  fs.mkdirSync(jobs, { recursive: true })
  const log = path.join(dir, 'child.log')
  fs.writeFileSync(log, '')
  return { dir, child, ensure, jobs, log }
}

const statusOf = (jobs, jobId) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(jobs, jobId, 'status.json'), 'utf8'))
  } catch {
    return undefined
  }
}

const resultOf = (jobs, jobId) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(jobs, jobId, 'result.json'), 'utf8'))
  } catch {
    return undefined
  }
}

const logOf = (log) =>
  fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))

const waitFor = async (read, what, ms = 20_000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() >= end) throw new Error(`等不到：${what}`)
    await sleep(50)
  }
}

// 起 runner（后台），返回收尾的 promise 和往 inbox 送消息的入口。
const start = (env, job, jobsDir) => {
  const child = spawn(process.execPath, [runner], {
    env: {
      ...process.env,
      DELEGATE_CPA_PYTHON: process.execPath,
      DELEGATE_ASK_WAIT_MS: '',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  const closed = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })))
  child.stdin.end(JSON.stringify(job) + '\n')
  const send = async (jobId, text) => {
    const dir = path.join(jobsDir, jobId, 'inbox')
    await waitFor(() => fs.existsSync(dir), 'inbox 目录')
    fs.writeFileSync(
      path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`),
      JSON.stringify({ text, at: Date.now() }),
    )
  }
  return { closed, send }
}

const replyOf = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1))

test('请示 → 回复 → 再请示 → 回复：phase 变 asking，回复送进子进程，最终结果取最后一次', { timeout: 60_000 }, async () => {
  const s = setup('fake-child-ask.mjs')
  const jobId = 't-ask-reply'
  // readPaths 让 runner 先有一条 --append-system-prompt：请示那段必须并进去，不能出现第二个同名参数。
  const job = { model: 'm', task: 'TASK ONE', jobId, stream: true, askWaitMs: 60_000, cwd: s.dir, readPaths: [s.dir] }
  const run = start(
    {
      DELEGATE_JOBS_DIR: s.jobs,
      DELEGATE_CHILD_CMD: process.execPath,
      DELEGATE_CHILD_ARGS: JSON.stringify([s.child]),
      DELEGATE_CPA_ENSURE: s.ensure,
      DELEGATE_SEND_GRACE_MS: '300',
      FAKE_ASK: '1',
      FAKE_LOG: s.log,
    },
    job,
    s.jobs,
  )

  const first = await waitFor(
    () => {
      const st = statusOf(s.jobs, jobId)
      return st?.phase === 'asking' && st.ask?.seq === 1 ? st : undefined
    },
    '第一次请示写进 status.json',
  )
  assert.equal(first.askWaitMs, 60_000)
  assert.ok(first.ask.text.startsWith('【请示】'), first.ask.text)
  assert.match(first.ask.text, /现状/)

  await run.send(jobId, '就按 A 做')
  const second = await waitFor(
    () => {
      const st = statusOf(s.jobs, jobId)
      return st?.phase === 'asking' && st.ask?.seq === 2 ? st : undefined
    },
    '第二次请示',
  )
  assert.match(second.ask.text, /第二次/)
  const users = logOf(s.log).filter((e) => e.name === 'user').map((e) => e.text)
  assert.deepEqual(users.slice(0, 2), ['TASK ONE', '就按 A 做'])

  await run.send(jobId, '按 A 继续，别再问了')
  const { code, stdout } = await run.closed
  assert.equal(code, 0)
  const reply = replyOf(stdout)
  assert.equal(reply.ok, true)
  assert.equal(reply.text, 'FINAL: 按回复做完了')
  assert.equal(reply.askTimeout, undefined)

  const argv = logOf(s.log).find((e) => e.name === 'argv').argv
  const at = argv.filter((a) => a === '--append-system-prompt')
  assert.equal(at.length, 1)
  const appended = argv[argv.indexOf('--append-system-prompt') + 1]
  assert.match(appended, /Extra readable directories/)
  assert.match(appended, /【请示】/)
})

test('请示没人回复：等到 askWaitMs 后照常结束，结果是请示内容，事件里有 ask_timeout', { timeout: 60_000 }, async () => {
  const s = setup('fake-child-timeout.mjs')
  const jobId = 't-ask-timeout'
  const job = { model: 'm', task: 'TASK ONE', jobId, stream: true, askWaitMs: 1_500, cwd: s.dir }
  const run = start(
    {
      DELEGATE_JOBS_DIR: s.jobs,
      DELEGATE_CHILD_CMD: process.execPath,
      DELEGATE_CHILD_ARGS: JSON.stringify([s.child]),
      DELEGATE_CPA_ENSURE: s.ensure,
      DELEGATE_SEND_GRACE_MS: '300',
      FAKE_ASK: '1',
      FAKE_LOG: s.log,
    },
    job,
    s.jobs,
  )

  await waitFor(() => (statusOf(s.jobs, jobId)?.phase === 'asking' ? true : undefined), '请示写进 status.json')
  const { code, stdout } = await run.closed
  assert.equal(code, 0)
  const reply = replyOf(stdout)
  assert.equal(reply.ok, true)
  assert.ok(reply.text.trimStart().startsWith('【请示】'), reply.text)
  assert.equal(reply.askTimeout, true)

  const events = fs
    .readFileSync(path.join(s.jobs, jobId, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
  assert.ok(events.some((e) => e.type === 'ask_timeout'))
  assert.equal(resultOf(s.jobs, jobId).askTimeout, true)
  assert.equal(statusOf(s.jobs, jobId).phase, 'done')
})

test('没有 askWaitMs（前台作业）：命令行里没有请示那段，也不等回复', { timeout: 60_000 }, async () => {
  const s = setup('fake-child-plain.mjs')
  const jobId = 't-plain'
  const job = { model: 'm', task: 'TASK ONE', jobId, stream: true, cwd: s.dir }
  const run = start(
    {
      DELEGATE_JOBS_DIR: s.jobs,
      DELEGATE_CHILD_CMD: process.execPath,
      DELEGATE_CHILD_ARGS: JSON.stringify([s.child]),
      DELEGATE_CPA_ENSURE: s.ensure,
      DELEGATE_SEND_GRACE_MS: '300',
      FAKE_LOG: s.log,
    },
    job,
    s.jobs,
  )
  const { code, stdout } = await run.closed
  assert.equal(code, 0)
  const reply = replyOf(stdout)
  assert.equal(reply.ok, true)
  assert.equal(reply.text, 'plain done')
  assert.equal(reply.askTimeout, undefined)
  const argv = logOf(s.log).find((e) => e.name === 'argv').argv
  assert.equal(argv.includes('--append-system-prompt'), false)
  const st = statusOf(s.jobs, jobId)
  assert.equal(st.ask, null)
  assert.equal(st.askWaitMs, 0)
})
