#!/usr/bin/env node
// Node 24+ (native TypeScript stripping). Runs the note-taker for one session
// directory, in the background: reads the person's own messages since the cursor,
// asks Haiku what they settled, and appends the answer to noted.jsonl. Nothing here
// is on the turn's path — a failure leaves the cursor where it was and says so in
// noter.log.
//
//   node scripts/noter.mjs <session dir> [--max-batches N]
//
// Test seam: CTX_MOD_NOTER_CMD holds a JSON argv prefix in place of `claude` (for
// example ["node","C:/tmp/fake.mjs"]), so no test ever calls the model for real.

import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

import { ENV } from '../hooks/lib/config.ts'
import {
  applyNoter,
  buildNoterBatch,
  cursorOf,
  estimateTokens,
  notedFromLines,
  NOTER_SYSTEM,
  parseNoterOutput,
} from '../hooks/lib/noter.ts'

const NOTED = 'noted.jsonl'
const CURSOR = 'noter-cursor.json'
const LOCK = 'noter.lock'
const LOG = 'noter.log'

/** A lock older than this belonged to a run that died; the next one takes it over. */
const LOCK_STALE_MS = 15 * 60 * 1000
/** Messages one call is given, in characters. */
const BATCH_CHARS = 40_000
/** How many calls one run makes unless told otherwise. */
const DEFAULT_MAX_BATCHES = 4
/** A run's own ceiling: a model call that hangs must not hold the lock for long. */
const TIMEOUT_MS = 9 * 60 * 1000
/** Above this many measured tokens a call is close enough to the 100k line to shrink the next one. */
const OVER_TOKENS = 90_000
/** At or under this many measured tokens the batches have room to grow again. */
const UNDER_TOKENS = 60_000
/** The budget multiplier is never taken below this: a call still has to carry something. */
const MIN_SCALE = 0.2
/** What a call over the line costs the next one, and what each cheap call gives back. */
const SCALE_DOWN = 0.7
const SCALE_UP = 1.1

/** The model that does the reading; overridable so a test never needs the real one. */
const MODEL = process.env['CTX_MOD_NOTER_MODEL'] ?? 'claude-haiku-5-5'

const messageOf = (problem) => (problem instanceof Error ? problem.message : String(problem))

/** The command prefix: the real CLI, or whatever a test put in CTX_MOD_NOTER_CMD. */
const commandOf = () => {
  const raw = process.env['CTX_MOD_NOTER_CMD']
  if (raw === undefined || raw.trim() === '') return ['claude']
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('CTX_MOD_NOTER_CMD 必须是 JSON 字符串数组')
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(part => typeof part !== 'string')) {
    throw new Error('CTX_MOD_NOTER_CMD 必须是 JSON 字符串数组')
  }

  return parsed
}

const readText = async (file) => {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

const exists = async (file) => {
  try {
    await fs.stat(file)

    return true
  } catch {
    return false
  }
}

const appendLog = async (dir, line) => {
  const text = `${new Date().toISOString()} ${line}\n`
  try {
    await fs.appendFile(path.join(dir, LOG), text, 'utf8')
  } catch {
    // A log that cannot be written must not become the failure.
  }
}

/** Every history row of the session, oldest first; a damaged line is skipped. */
const readRows = async (dir) => {
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    throw new Error(`读不到会话目录 ${dir}`)
  }
  const bySeq = new Map()
  for (const name of names.filter(entry => /^history-.*\.jsonl$/.test(entry)).sort()) {
    const text = await readText(path.join(dir, name))
    if (text === null) continue
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof row !== 'object' || row === null) continue
      const seq = row.seq
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) continue
      if (!bySeq.has(seq)) bySeq.set(seq, row)
    }
  }

  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

/** Takes the lock, or says that another run holds it. A lock past its life is taken over. */
const acquire = async (dir) => {
  const file = path.join(dir, LOCK)
  try {
    const stat = await fs.stat(file)
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false
    await fs.unlink(file).catch(() => undefined)
  } catch {
    // No lock: take one.
  }
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')

  return true
}

const release = async (dir) => {
  await fs.unlink(path.join(dir, LOCK)).catch(() => undefined)
}

const writeCursor = async (dir, cursorSeq, budgetScale) => {
  const file = path.join(dir, CURSOR)
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify({ cursorSeq, budgetScale }), 'utf8')
  await fs.rename(temp, file)
}

/**
 * The multiplier the last calls left in noter-cursor.json. A file that does not say, or
 * says something unusable, means one: the budget the estimates were made for.
 */
const scaleOf = text => {
  if (text === null) return 1
  try {
    const raw = JSON.parse(text)
    const scale = raw?.budgetScale

    return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? Math.min(1, Math.max(MIN_SCALE, scale)) : 1
  } catch {
    return 1
  }
}

/**
 * The executable a bare command name stands for on Windows: npm installs `claude` as
 * claude.cmd, which a spawn without a shell cannot start. Elsewhere the name is used
 * as it came.
 */
const resolveExecutable = name => {
  if (process.platform !== 'win32' || /[\\/]/.test(name) || /\.(exe|cmd|bat|com)$/i.test(name)) return name
  const dirs = (process.env.PATH ?? '').split(';').filter(Boolean)
  for (const ext of ['.exe', '.cmd', '.bat']) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }

  return name
}

/**
 * A command as it is started. A .cmd shim goes through cmd.exe with the whole line
 * handed over verbatim: npm installs `claude` as claude.cmd, which no shell-less
 * spawn can start, and an argument vector would be re-quoted a second time.
 */
const spawnPlan = argv => {
  const file = resolveExecutable(argv[0])
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) {
    return { file, args: argv.slice(1), windowsVerbatimArguments: false }
  }
  const line = [file, ...argv.slice(1)].map(part => `"${String(part).replace(/"/g, '""')}"`).join(' ')

  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  }
}

/** Runs one command to the end; the child's environment has this mod turned off. */
const runChild = (argv, input) =>
  new Promise((resolve, reject) => {
    let child
    try {
      const plan = spawnPlan(argv)
      child = spawn(plan.file, plan.args, {
        // No prompt cache: each call's input is new (the list and the messages both
        // change), so a cache write is paid for and never read. Measured 2026-11-13 on
        // a 39k-token batch: $0.0098 without the cache, $0.0134 with the write.
        env: { ...process.env, [ENV.enabled]: '0', DISABLE_PROMPT_CACHING: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      })
    } catch (problem) {
      reject(problem)

      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`模型命令超过 ${TIMEOUT_MS}ms 没有返回`))
    }, TIMEOUT_MS)
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', problem => {
      clearTimeout(timer)
      reject(problem)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })

/**
 * What one call measured, in the count the 100k line uses: every kind of input plus the
 * output. Absent usage is not zero — it is "not known", and nothing is decided on it.
 */
const measuredOf = usage => {
  if (typeof usage !== 'object' || usage === null) return undefined
  const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens, usage.output_tokens]
  const known = parts.filter(part => typeof part === 'number' && Number.isFinite(part))
  if (known.length === 0) return undefined

  return known.reduce((sum, part) => sum + part, 0)
}

/** The model's answer, with what the call cost: the envelope the CLI prints on --output-format json. */
const askModel = async (systemFile, input) => {
  const argv = [
    ...commandOf(),
    '-p',
    '--model',
    MODEL,
    // Required with NOTER_SYSTEM: at `low` the model answers the data instead of reading it.
    '--effort',
    'medium',
    '--system-prompt-file',
    systemFile,
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'json',
  ]
  const { code, stdout, stderr } = await runChild(argv, input)
  if (code !== 0) throw new Error(`模型命令退出码 ${code}：${stderr.trim().slice(-300)}`)
  let envelope
  try {
    envelope = JSON.parse(stdout)
  } catch {
    throw new Error(`模型命令的输出不是 JSON：${stdout.slice(0, 200)}`)
  }
  if (typeof envelope !== 'object' || envelope === null) throw new Error('模型命令的输出不是一个 JSON 对象')
  if (envelope.is_error === true) throw new Error(`模型报错：${String(envelope.result).slice(0, 300)}`)
  // One batch is one model request: no tools are offered, so nothing can start a second
  // turn. With the prompt cache off a second request would pay for the whole input
  // again, so more than one turn is a failure to be seen, not a cost to absorb.
  if (typeof envelope.num_turns === 'number' && envelope.num_turns > 1) {
    throw new Error(`模型用了 ${envelope.num_turns} 轮，预期只有 1 轮`)
  }

  return {
    text: typeof envelope.result === 'string' ? envelope.result : '',
    cost: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : undefined,
    durationMs: typeof envelope.duration_ms === 'number' ? envelope.duration_ms : undefined,
    measured: measuredOf(envelope.usage),
  }
}

/** One run: a batch at a time, the cursor moving only once its answer is on disk. */
const run = async (dir, maxBatches) => {
  const rows = await readRows(dir)
  const cursorText = await readText(path.join(dir, CURSOR))
  let cursor = cursorOf(cursorText)
  // What earlier runs learned about the estimates: a call over the line leaves a smaller
  // multiplier behind, and each cheap call gives some of it back.
  let scale = scaleOf(cursorText)
  let noted = notedFromLines((await readText(path.join(dir, NOTED))) ?? '')
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-mod-noter-'))
  try {
    const systemFile = path.join(scratch, 'system.txt')
    await fs.writeFile(systemFile, NOTER_SYSTEM, 'utf8')
    for (let index = 0; index < maxBatches; index += 1) {
      const batch = buildNoterBatch(rows, cursor, BATCH_CHARS, noted, scale)
      if (batch.batchRows.length === 0) {
        // Nothing said, but injected rows may have been passed over: move the cursor anyway.
        if (batch.nextCursor !== cursor) {
          cursor = batch.nextCursor
          await writeCursor(dir, cursor, scale)
        }
        break
      }
      const inputFile = path.join(scratch, `in-${index}.txt`)
      await fs.writeFile(inputFile, batch.input, 'utf8')
      const input = await fs.readFile(inputFile, 'utf8')
      const started = Date.now()
      const estimated = estimateTokens(NOTER_SYSTEM + batch.input)
      const answer = await askModel(systemFile, input)
      const measured = answer.measured
      // The measurement is acted on before the answer is: the call is paid for whether or
      // not its answer is taken, and the next batch must not repeat the overspend.
      let warning = ''
      if (measured !== undefined && measured > OVER_TOKENS) {
        warning = ' 警告：接近 10 万上限'
        scale = Math.max(MIN_SCALE, scale * SCALE_DOWN)
      } else if (measured !== undefined && measured <= UNDER_TOKENS && scale < 1) {
        scale = Math.min(1, scale * SCALE_UP)
      }
      await writeCursor(dir, cursor, scale)
      const parsed = parseNoterOutput(answer.text, batch.batchRows, noted, batch.listedSeq)
      const lines = [
        ...parsed.add.map(decision => JSON.stringify(decision)),
        ...parsed.revoke.map(item => JSON.stringify({ revoke: item })),
      ]
      if (lines.length > 0) await fs.appendFile(path.join(dir, NOTED), `${lines.join('\n')}\n`, 'utf8')
      noted = applyNoter(noted, parsed)
      cursor = batch.nextCursor
      await writeCursor(dir, cursor, scale)
      const from = batch.batchRows[0]?.seq ?? 0
      const to = batch.batchRows[batch.batchRows.length - 1]?.seq ?? 0
      const cost = answer.cost === undefined ? '?' : `$${answer.cost.toFixed(4)}`
      const tokens = measured === undefined ? '?' : String(measured)
      await appendLog(
        dir,
        `批次 #${from}..#${to}（${batch.batchRows.length} 条）新增 ${parsed.add.length} 撤销 ${parsed.revoke.length} 丢弃 ${parsed.rejected.length} 耗时 ${Date.now() - started}ms 费用 ${cost} 估算输入 ${estimated} 实际 ${tokens}${warning}`,
      )
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

const parseArgs = argv => {
  let dir
  let maxBatches = DEFAULT_MAX_BATCHES
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--max-batches') {
      const value = Number(argv[index + 1])
      if (!Number.isInteger(value) || value < 1) throw new Error('--max-batches 必须是正整数')
      maxBatches = value
      index += 1
      continue
    }
    if (arg.startsWith('--')) throw new Error(`不认识的参数 ${arg}`)
    if (dir !== undefined) throw new Error('只接受一个会话目录')
    dir = arg
  }
  if (dir === undefined) throw new Error('用法：node scripts/noter.mjs <会话目录> [--max-batches N]')

  return { dir: path.resolve(dir), maxBatches }
}

const main = async () => {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (problem) {
    console.error(messageOf(problem))
    process.exitCode = 2

    return
  }
  if (!(await exists(args.dir))) {
    console.error(`会话目录不存在：${args.dir}`)
    process.exitCode = 2

    return
  }
  // Another run already has it: this one has nothing to say and nothing to wait for.
  if (!(await acquire(args.dir))) return
  try {
    await run(args.dir, args.maxBatches)
  } catch (problem) {
    const reason = messageOf(problem)
    await appendLog(args.dir, `失败：${reason}`)
    console.error(reason)
    process.exitCode = 1
  } finally {
    await release(args.dir)
  }
}

await main()
