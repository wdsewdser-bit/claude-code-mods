// 启动器：runner 要脱离插件的进程树，杀掉启动器（热重载时插件的子进程会被整棵杀掉）后 runner 照跑、照样写出结果。
// 用 DELEGATE_RUNNER_SCRIPT 换成假 runner，不起真模型。
//
//   node --test tests/launch.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const launcher = path.join(here, '../scripts/launch.mjs')

const FAKE = `
import fs from 'node:fs'
const a = f => process.argv[process.argv.indexOf(f) + 1]
const raw = JSON.parse(fs.readFileSync(a('--input'), 'utf8'))
fs.rmSync(a('--input'))
fs.writeFileSync(a('--reply') + '.pid', String(process.pid))
setTimeout(() => {
  fs.writeFileSync(a('--reply'), JSON.stringify({ ok: true, text: 'FAKE ' + raw.job.jobId + ' ' + (raw.env.FAKE_MARK ?? '') }))
  process.exit(0)
}, Number(process.env.FAKE_MS ?? 200))
`

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-launch-'))
  const fake = path.join(dir, 'fake-runner.mjs')
  fs.writeFileSync(fake, FAKE)
  return { dir, fake, jobs: path.join(dir, 'jobs') }
}

const start = (t, id, ms) => {
  const child = spawn(process.execPath, [launcher], {
    env: { ...process.env, DELEGATE_JOBS_DIR: t.jobs, DELEGATE_RUNNER_SCRIPT: t.fake, FAKE_MS: String(ms), FAKE_MARK: 'host-env' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', d => (out += d))
  child.stdin.end(JSON.stringify({ jobId: id, cwd: t.dir }))
  return { child, done: new Promise(resolve => child.on('exit', () => resolve(out))) }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('the launcher relays the runner reply and passes the host environment', async () => {
  const t = setup()
  const { done } = start(t, 'j-relay', 200)
  const out = await done
  assert.equal(JSON.parse(out.trim()).text, 'FAKE j-relay host-env')
  assert.equal(fs.existsSync(path.join(t.jobs, 'j-relay', 'input.json')), false)
  assert.equal(fs.existsSync(path.join(t.jobs, 'j-relay', 'reply.json')), false)
})

test('killing the launcher and its whole tree leaves the runner running to the end', { skip: process.platform !== 'win32' }, async () => {
  const t = setup()
  const { child } = start(t, 'j-detached', 3000)
  const pidFile = path.join(t.jobs, 'j-detached', 'reply.json.pid')
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(100)
  assert.ok(fs.existsSync(pidFile), 'runner started')
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  await sleep(4500)
  const reply = path.join(t.jobs, 'j-detached', 'reply.json')
  assert.ok(fs.existsSync(reply), 'runner wrote its reply after the launcher tree was killed')
  assert.match(fs.readFileSync(reply, 'utf8'), /FAKE j-detached/)
})
