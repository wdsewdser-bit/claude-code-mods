#!/usr/bin/env node
// 后台/前台作业的启动器：插件用 $.process.spawn 起的是它，不是 runner。
// $.process.spawn 的子进程跟插件模块同生共死（热重载、宿主退出都会杀掉它），所以真正干活的 runner
// 经一个立即退出的中转进程以 detached 方式启动，脱离插件的进程树。启动器自己只负责等 runner 写出 --reply 文件，再把那一行原样打到 stdout。
// 启动器被杀了也没关系：runner 照跑，结束时写的 result.json 由插件的定时巡检收尾、补发通知。
import { spawn } from 'node:child_process'
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

// 中转进程：以 detached 起 runner、把 pid 写进文件后立刻退出。runner 的父进程随即消失，
// 按进程树结束启动器（taskkill /T、宿主卸载插件时清理子进程）就够不着它。
// 不用 WMI（Win32_Process.Create）：Claude 桌面版是 MSIX 包，包外起的进程看到的是另一份 AppData，
// 找不到包内装的 agy 等工具；中转进程仍在包的上下文里，文件视图和宿主一致。
const BOUNCE = [
  'const cp = require("child_process"), fs = require("fs")',
  'const [runner, pidFile, cwd, ...rest] = process.argv.slice(1)',
  'const c = cp.spawn(process.execPath, [runner, ...rest], { cwd, detached: true, stdio: "ignore", windowsHide: true })',
  'c.unref()',
  'fs.writeFileSync(pidFile, String(c.pid))',
  'process.exit(0)',
].join('\n')

const startDetached = (runner, args, cwd, pidFile) =>
  new Promise(resolve => {
    fs.rmSync(pidFile, { force: true })
    const b = spawn(process.execPath, ['-e', BOUNCE, runner, pidFile, cwd, ...args], { cwd, detached: true, stdio: 'ignore', windowsHide: true })
    b.on('error', () => resolve(undefined))
    b.on('exit', () => {
      try {
        const pid = Number(fs.readFileSync(pidFile, 'utf8'))
        fs.rmSync(pidFile, { force: true })
        resolve(Number.isInteger(pid) && pid > 0 ? pid : undefined)
      } catch {
        resolve(undefined)
      }
    })
  })

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}


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
  // 宿主给的环境变量一并交过去：runner 照常继承，这里显式交一份，换启动方式也不丢。
  fs.writeFileSync(input, JSON.stringify({ job, env: process.env }))
  const cwd = typeof job.cwd === 'string' && fs.existsSync(job.cwd) ? job.cwd : process.cwd()
  const pid = await startDetached(runner, ['--input', input, '--reply', reply], cwd, path.join(dir, 'runner.pid'))
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
