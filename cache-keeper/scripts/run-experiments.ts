// Runs experiment cells unattended through the Claude Code CLI (Node 24+):
// one fresh headless session per cell, the TTL set in its environment, the
// mod's own runner started by a slash command, the session kept open until the
// mod has written the cell's run record.
//
//   node scripts/run-experiments.ts --dry-run
//   node scripts/run-experiments.ts --set smoke              A at 5m, 1.5 min
//   node scripts/run-experiments.ts                          A, B, then C1 three times per TTL
//   node scripts/run-experiments.ts --set full               the above, C2 and D
//   node scripts/run-experiments.ts --cells keeper:5m,keeper-control:1h --reps 3
//
// Options: --model (claude-haiku-5-5) --effort (medium) --reps (3) --tokens
// (60000) --delay seconds before the first cell (90) --stop-at percent (85).
//
// Leave the account alone while it runs: every other Claude session, the
// desktop app and claude.ai included, moves the same usage meter.
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { planDurationSec, planNamed } from '../hooks/lib/experiment.ts'
import type { Plan } from '../hooks/lib/experiment.ts'
import { meterDelta } from '../hooks/lib/report.ts'
import type { RunRecord } from '../hooks/lib/report.ts'

type Cell = { plan: Plan; ttl: '5m' | '1h' }

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(homedir(), '.claude', 'cache-keeper')
const rawDir = join(dataDir, 'raw')
const workDir = join(homedir(), 'cache-keeper-bench')

const argv = process.argv.slice(2)
const option = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`)

  return at >= 0 ? (argv[at + 1] ?? fallback) : fallback
}
const isDryRun = argv.includes('--dry-run')
// Haiku by default: a cell only needs cache writes and reads, not capability,
// and it spends the least of a subscription's quota.
const model = option('model', 'claude-haiku-5-5')
const effort = option('effort', 'medium')
const reps = Number(option('reps', '3'))
const tokens = Number(option('tokens', '60000'))
const delaySec = Number(option('delay', '90'))
const stopAt = Number(option('stop-at', '85'))

const fail = (message: string, code = 2): never => {
  console.error(message)
  process.exit(code)
}

const stamp = (): string => new Date().toISOString().slice(11, 19)
const say = (message: string): void => console.log(`[${stamp()}] ${message}`)
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

const cell = (name: string, ttl: string): Cell => {
  const plan = planNamed(name)
  if (plan === undefined) return fail(`unknown plan: ${name}`)
  if (ttl !== '5m' && ttl !== '1h') return fail(`unknown TTL: ${ttl}`)
  if (plan.requiresTtl !== null && plan.requiresTtl !== ttl) {
    return fail(`${plan.name} needs TTL ${plan.requiresTtl}`)
  }

  return { plan, ttl }
}

// Replicates alternate the cells of a group, so drift over the hours of a run
// (a window resetting, the service's load) falls on every cell alike.
const repeated = (group: readonly Cell[]): Cell[] =>
  Array.from({ length: reps }, () => group).flat()

const once = [cell('ttl', '5m'), cell('ttl', '1h'), cell('renew', '5m'), cell('renew-control', '5m')]
const active = repeated([cell('active', '5m'), cell('active', '1h')])
const SETS: Record<string, Cell[]> = {
  smoke: [cell('ttl', '5m')],
  minimal: [...once, ...active],
  full: [
    ...once,
    ...active,
    ...repeated([cell('intermittent', '5m'), cell('intermittent', '1h')]),
    ...repeated([cell('keeper', '5m'), cell('keeper-control', '5m'), cell('keeper-control', '1h')]),
  ],
}

const chosen: Cell[] = argv.includes('--cells')
  ? repeated(
      option('cells', '')
        .split(',')
        .filter(Boolean)
        .map(spec => {
          const [name = '', ttl = ''] = spec.split(':')

          return cell(name, ttl)
        }),
    )
  : (SETS[option('set', 'minimal')] ?? fail(`unknown set: ${option('set', '')}`))
// --skip N resumes a set after its first N cells.
const cells = chosen.slice(Number(option('skip', '0')))

const findClaude = (): string => {
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
    encoding: 'utf8',
  })
  const first = onPath.status === 0 ? onPath.stdout.split(/\r?\n/)[0]?.trim() : ''
  if (first) return first
  // The engine the Claude desktop app ships, newest first.
  const packages = join(process.env.LOCALAPPDATA ?? '', 'Packages')
  const found: { path: string; at: number }[] = []
  for (const name of existsSync(packages) ? readdirSync(packages) : []) {
    if (!name.startsWith('Claude_')) continue
    const root = join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'claude-code')
    for (const version of existsSync(root) ? readdirSync(root) : []) {
      for (const build of readdirSync(join(root, version))) {
        const path = join(root, version, build, 'claude.exe')
        if (existsSync(path)) found.push({ path, at: statSync(path).mtimeMs })
      }
    }
  }
  found.sort((a, b) => b.at - a.at)

  return found[0]?.path ?? fail('Claude Code was not found on PATH or in the Claude desktop app.')
}

// A plain terminal's environment: nothing a host session set for its own
// engine (its base URL, its messaging socket, its session ids) reaches the cell.
const cleanEnv = (ttl: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(CLAUDE|ANTHROPIC|FORCE_PROMPT_CACHING|CTX_MOD)/i.test(name)) env[name] = value
  }
  env.CLAUDE_CODE_PROMPT_CACHE_TTL = ttl

  return env
}

const isLoggedIn = (claude: string): boolean => {
  const ran = spawnSync(claude, ['auth', 'status'], { encoding: 'utf8', env: cleanEnv('1h') })
  try {
    return JSON.parse(ran.stdout).loggedIn === true
  } catch {
    return false
  }
}

// A fresh session has no meter reading before its first response, so the mod
// starts a cell from the reading the previous session left. One minimal
// request in a throwaway session leaves a current one; with no tools and a
// system prompt of its own it shares no cache prefix with any cell, and what
// it spends itself is spent before the reading is taken.
const primeMeter = (claude: string): void => {
  spawnSync(
    claude,
    [
      '-p', 'OK',
      '--model', 'claude-haiku-5-5',
      '--system-prompt', 'Reply with OK.',
      '--tools', '',
      '--strict-mcp-config',
    ],
    { cwd: workDir, env: cleanEnv('5m'), encoding: 'utf8', input: '', timeout: 120_000 },
  )
}

const runFiles = (): Set<string> =>
  new Set(existsSync(rawDir) ? readdirSync(rawDir).filter(name => name.startsWith('run-')) : [])

type Outcome = { ok: true; record: RunRecord } | { ok: false; why: string }

const runCell = async (claude: string, one: Cell, index: number): Promise<Outcome> => {
  const before = runFiles()
  const log = join(rawDir, `cli-${one.plan.id}-${one.ttl}-${Date.now()}.log`)
  const child = spawn(
    claude,
    [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--effort', effort,
      '--strict-mcp-config',
    ],
    { cwd: workDir, env: cleanEnv(one.ttl), stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let refusal: string | undefined
  let hasExited = false
  const watch = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    appendFileSync(log, text)
    const found = /Not logged in|needs a session started with|needs a fresh session|is running; \/cache-keeper|Unknown (slash )?command|aborted \(([^)]*)\)/.exec(text)
    if (found !== null) refusal ??= found[0]
  }
  child.stdout.on('data', watch)
  child.stderr.on('data', watch)
  child.on('exit', () => {
    hasExited = true
  })
  child.stdin.write(
    `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `/cache-keeper experiment ${one.plan.name} tokens=${tokens}` }],
      },
    })}\n`,
  )

  const stop = async (): Promise<void> => {
    child.stdin.end()
    for (let waited = 0; waited < 15 && !hasExited; waited += 1) await sleep(1_000)
    if (!hasExited) child.kill()
  }
  const deadline = Date.now() + (planDurationSec(one.plan) + 420) * 1_000
  const pattern = new RegExp(`^run-${one.plan.id}-${one.ttl}-r\\d+-.+\\.json$`)
  while (Date.now() < deadline) {
    await sleep(2_000)
    const made = [...runFiles()].find(name => !before.has(name) && pattern.test(name))
    if (made !== undefined) {
      await sleep(3_000)
      await stop()

      return { ok: true, record: JSON.parse(readFileSync(join(rawDir, made), 'utf8')) as RunRecord }
    }
    if (refusal !== undefined) {
      await stop()

      return { ok: false, why: `${refusal} (see ${log})` }
    }
    if (hasExited) return { ok: false, why: `the session ended early (see ${log})` }
  }
  await stop()

  return { ok: false, why: `cell ${index + 1} wrote no run record in time (see ${log})` }
}

const totalSec = cells.reduce((sum, one) => sum + planDurationSec(one.plan) + 30, delaySec)
say(`${cells.length} cells, about ${Math.ceil(totalSec / 60)} min · model ${model} · effort ${effort} · filler ${tokens} tokens`)
for (const [index, one] of cells.entries()) {
  console.log(`  ${String(index + 1).padStart(2)}. ${one.plan.id.padEnd(16)} TTL ${one.ttl}  ${Math.ceil(planDurationSec(one.plan) / 60)} min`)
}
if (isDryRun) process.exit(0)

const claude = findClaude()
say(`Claude Code: ${claude}`)
if (!isLoggedIn(claude)) {
  fail(`Not logged in. Sign in once, then run this again:\n  & "${claude}" auth login`, 3)
}
mkdirSync(rawDir, { recursive: true })
mkdirSync(workDir, { recursive: true })
say(`waiting ${delaySec} s so nothing else is using the account when the first cell starts`)
await sleep(delaySec * 1_000)

let failures = 0
let clean = 0
for (const [index, one] of cells.entries()) {
  say(`cell ${index + 1}/${cells.length}: ${one.plan.id} at TTL ${one.ttl}`)
  primeMeter(claude)
  const outcome = await runCell(claude, one, index)
  if (!outcome.ok) {
    failures += 1
    say(`  FAILED: ${outcome.why}`)
    // The first cell failing means the setup is wrong, not the cell.
    if (index === 0 || failures >= 2) fail('Stopping: fix the cause above before spending more quota.', 1)
    continue
  }
  const { record } = outcome
  const moved = meterDelta(record.meter_start, record.meter_end)
  if (!record.contaminated) clean += 1
  say(
    `  r${record.replicate} ${record.contaminated ? 'CONTAMINATED' : 'clean'} · TTL observed ${record.ttl_observed || 'unverified'} · steps ${record.steps.map(step => `${step.kind}:${step.result}`).join(' ')}`,
  )
  say(
    `  meter ${Object.entries(moved).map(([kind, points]) => `${kind} ${points === null ? 'reset' : `+${points}`}`).join(' · ') || 'no reading'}`,
  )
  for (const note of [...record.contamination, ...record.warnings]) say(`  note: ${note}`)
  const high = record.meter_end.find(limit => limit.percentUsed >= stopAt)
  if (high !== undefined && index < cells.length - 1) {
    say(`Stopping before the next cell: ${high.kind} is at ${high.percentUsed}% (--stop-at ${stopAt}).`)
    break
  }
  await sleep(10_000)
}

const report = spawnSync(process.execPath, [join(here, 'analyze-transcript.ts'), '--report', dataDir], {
  encoding: 'utf8',
})
say(`${clean} clean run(s), ${failures} failed`)
console.log(report.stdout.trim() || report.stderr.trim())
console.log(`Report: ${join(dataDir, 'cache-report.md')}`)
