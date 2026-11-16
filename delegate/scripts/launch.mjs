#!/usr/bin/env node
// 后台/前台作业的启动器：插件用 $.process.spawn 起的是它，不是 runner。
// $.process.spawn 的子进程跟插件模块同生共死（热重载、宿主退出都会杀掉它），所以真正干活的 runner
// 由这里交给 WMI（Win32_Process.Create）启动，挂在 WmiPrvSE 下、脱离插件的进程树和作业对象；
// WMI 不可用时退回 detached spawn。启动器自己只负责等 runner 写出 --reply 文件，再把那一行原样打到 stdout。
// 启动器被杀了也没关系：runner 照跑，结束时写的 result.json 由插件的定时巡检收尾、补发通知。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const JOBS_ROOT = process.env.DELEGATE_JOBS_DIR || path.join(os.homedir(), '.claude', 'delegate', 'jobs')
const out = value => {
  process.stdout.write(JSON.stringify(value) + '\n')
}

const readStdin = () =>
  new Promise((resolve, reject) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', d => (s += d))
    process.stdin.on('end', () => resolve(s))
    process.stdin.on('error', reject)
  })

/** 交给 WMI 起进程：返回 pid，失败返回 undefined。 */
const wmiStart = (commandLine, cwd) => {
  if (process.platform !== 'win32') return undefined
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:DLG_CMD; CurrentDirectory = $env:DLG_CWD }',
    'if ($r.ReturnValue -ne 0) { exit 3 }',
    'Write-Output $r.ProcessId',
  ].join('; ')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    env: { ...process.env, DLG_CMD: commandLine, DLG_CWD: cwd },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  })
  const pid = Number(String(r.stdout ?? '').trim().split(/\s+/).pop())
  return r.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : undefined
}

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const quote = s => '"' + String(s).replace(/"/g, '\\"') + '"'

const main = async () => {
  let job
  try {
    job = JSON.parse(await readStdin())
  } catch {
    return out({ ok: false, error: 'the job on stdin is not JSON' })
  }
  // DELEGATE_RUNNER_SCRIPT 只给测试用：换成一个假 runner。
  const runner = process.env.DELEGATE_RUNNER_SCRIPT || path.join(here, job.agy === true ? 'run-agy.mjs' : 'run-delegate.mjs')
  const id = typeof job.jobId === 'string' && job.jobId !== '' ? job.jobId : 'adhoc-' + Date.now()
  const dir = path.join(JOBS_ROOT, id)
  fs.mkdirSync(dir, { recursive: true })
  const input = path.join(dir, 'input.json')
  const reply = path.join(dir, 'reply.json')
  fs.rmSync(reply, { force: true })
  // 宿主给的环境变量一并交过去：WMI 起的进程拿到的是用户默认环境，没有宿主注入的那些。
  fs.writeFileSync(input, JSON.stringify({ job, env: process.env }))
  const cwd = typeof job.cwd === 'string' && fs.existsSync(job.cwd) ? job.cwd : process.cwd()
  let pid = wmiStart([quote(process.execPath), quote(runner), '--input', quote(input), '--reply', quote(reply)].join(' '), cwd)
  if (pid === undefined) {
    const child = spawn(process.execPath, [runner, '--input', input, '--reply', reply], { cwd, detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    pid = child.pid
  }
  if (pid === undefined) return out({ ok: false, error: 'could not start the runner' })
  // 等结果：reply.json 出现就转交；runner 没了还没有结果，稍等一下再判失败（最后一次写盘可能还在路上）。
  let goneAt = 0
  for (;;) {
    if (fs.existsSync(reply)) {
      const text = fs.readFileSync(reply, 'utf8')
      fs.rmSync(reply, { force: true })
      process.stdout.write(text.trim() + '\n')
      return
    }
    if (!alive(pid)) {
      if (goneAt === 0) goneAt = Date.now()
      else if (Date.now() - goneAt > 3_000) {
        fs.rmSync(input, { force: true })
        return out({ ok: false, error: 'runner exited without a result (pid ' + pid + ')' })
      }
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

main().catch(error => out({ ok: false, error: String(error?.message ?? error) }))
