import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
// The backfill's trigger and its one-call budget are checked end to end: this runs
// scripts/noter.mjs with CTX_MOD_NOTER_CMD pointing at a fake model, so which rounds a
// call is spent on is measured by the counter file rather than assumed.
// It sits outside *.test.ts because the plugin test loader lets a test file import only
// its own files and "claude-code", and this needs a child process.
const expect = value => ({
  toBe: expected => assert.equal(value, expected),
  toContain: expected => assert.ok(value.includes(expected), String(value)),
  toEqual: expected => assert.deepEqual(value, expected),
  toBeTruthy: () => assert.ok(value),
  toBeFalsy: () => assert.ok(!value, String(value)),
})
const TS = 1_700_000_000_000
const person = (seq, text) => ({ seq, uuid: `p${seq}`, ts: TS + seq * 1_000, window: 1, role: 'user', isPerson: true, text })
const tool = (seq, name = 'Edit', text = 'ok') => ({ seq, uuid: `t${seq}`, ts: TS + seq * 1_000, window: 1, role: 'tool', tool: name, text: `${text} #${seq}` })
const reply = (seq, text) => ({ seq, uuid: `a${seq}`, ts: TS + seq * 1_000, window: 1, role: 'assistant', text })

/**
 * A stand-in for the CLI: the decision answer for a notes call, and a deliberately wrong
 * one for a backfill call (done, with evidence that was never shown) so the code's own
 * checks are what the test sees the result of.
 */
const FAKE = [
  'const chunks = []',
  'for await (const piece of process.stdin) chunks.push(piece)',
  "const input = Buffer.concat(chunks).toString('utf8')",
  'const isBackfill = input.includes("【已有任务】")',
  'const result = isBackfill',
  '  ? JSON.stringify({ entries: [{ task_id: "fix-login", title: "改登录页", status: "done", text: "按钮改成了蓝色，测试通过", evidence: [99, 7] }] })',
  '  : JSON.stringify({ add: [], revoke: [] })',
  'process.stdout.write(JSON.stringify({ is_error: false, num_turns: 1, result, usage: { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 60 }, total_cost_usd: 0.0012, duration_ms: 9 }))',
].join('\n')

const makeDir = async rows => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-backfill-'))
  await fs.writeFile(path.join(dir, 'fake-model.mjs'), FAKE, 'utf8')
  await fs.writeFile(path.join(dir, 'history-w001.jsonl'), rows.map(row => `${JSON.stringify(row)}\n`).join(''), 'utf8')

  return dir
}

/** Runs the note-taker as the hook does, and answers how many model calls the run made. */
const runNoter = async (dir, { backfill, extra = [] } = {}) => {
  const calls = path.join(dir, 'calls.txt')
  const env = {
    ...process.env,
    CTX_MOD_NOTER_CMD: JSON.stringify([process.execPath, path.join(dir, 'fake-model.mjs')]),
    CTX_MOD_MODEL_CALLS: calls,
  }
  delete env.CTX_MOD_LEDGER_BACKFILL
  if (backfill === true) env.CTX_MOD_LEDGER_BACKFILL = '1'
  const result = spawnSync(process.execPath, [path.resolve('scripts/noter.mjs'), dir, ...extra], { env, encoding: 'utf8' })
  const text = await fs.readFile(calls, 'utf8').catch(() => '')

  return { ...result, calls: text.split('\n').filter(line => line.trim() !== '').length }
}

const exists = async file => {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

const pendingOf = async dir => JSON.parse(await fs.readFile(path.join(dir, 'backfill-pending.json'), 'utf8'))

const eligible = [person(1, '把登录页的按钮改成蓝色'), tool(2, 'Edit'), tool(3, 'Bash'), tool(4, 'Read'), reply(5, '改好了'), person(6, '接着做')]

test('with the switch off nothing is backfilled and no call is spent on one', async () => {
  const dir = await makeDir(eligible)
  try {
    const run = await runNoter(dir, { backfill: false })
    expect(run.status).toBe(0)
    // One call for the notes alone.
    expect(run.calls).toBe(1)
    expect(await exists(path.join(dir, 'backfill-pending.json'))).toBe(false)
    expect(await exists(path.join(dir, 'backfill-state.json'))).toBe(false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a round that called ledger_append is not backfilled', async () => {
  const rows = [person(1, '把登录页的按钮改成蓝色'), tool(2, 'Edit'), tool(3, 'Bash'), tool(4, 'Read'), tool(5, 'mcp__ctx-mod__ledger_append'), person(6, '接着做')]
  const dir = await makeDir(rows)
  try {
    const run = await runNoter(dir, { backfill: true })
    expect(run.status).toBe(0)
    expect(run.calls).toBe(1)
    expect(await exists(path.join(dir, 'backfill-pending.json'))).toBe(false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a round with fewer than three calls of work is not backfilled', async () => {
  const rows = [person(1, '把登录页的按钮改成蓝色'), tool(2, 'Edit'), tool(3, 'Edit'), person(4, '接着做')]
  const dir = await makeDir(rows)
  try {
    const run = await runNoter(dir, { backfill: true })
    expect(run.status).toBe(0)
    expect(run.calls).toBe(1)
    expect(await exists(path.join(dir, 'backfill-pending.json'))).toBe(false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('one round costs one call, and done is lowered with the fake evidence dropped', async () => {
  const dir = await makeDir(eligible)
  try {
    const run = await runNoter(dir, { backfill: true })
    expect(run.status).toBe(0)
    expect(run.calls).toBe(2)
    const pending = await pendingOf(dir)
    expect(pending.round).toBe(1)
    expect(pending.entries.length).toBe(1)
    expect(pending.entries[0].status).toBe('in_progress')
    expect(pending.entries[0].evidence).toBe(undefined)
    expect(pending.entries[0].text.startsWith('〔补记〕')).toBe(true)
    expect(typeof pending.entries[0].seq).toBe('undefined')
    // The log says what the call cost, the way the notes' own calls do.
    const log = await fs.readFile(path.join(dir, 'noter.log'), 'utf8')
    expect(log).toContain('补记 #1')
    expect(log).toContain('实际')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the same round is never tried twice, so a second run spends nothing on it', async () => {
  const dir = await makeDir(eligible)
  try {
    const first = await runNoter(dir, { backfill: true })
    expect(first.calls).toBe(2)
    const second = await runNoter(dir, { backfill: true })
    expect(second.status).toBe(0)
    // No new person message, so no notes call; and the round was already booked.
    expect(second.calls).toBe(2)
    const state = JSON.parse(await fs.readFile(path.join(dir, 'backfill-state.json'), 'utf8'))
    expect(state.rounds['1'].status).toBe('ok')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a dry run prints the records and the usage, and writes nothing at all', async () => {
  const dir = await makeDir(eligible)
  try {
    const run = await runNoter(dir, { backfill: true, extra: ['--backfill-round', '1', '--dry-run'] })
    expect(run.status).toBe(0)
    expect(run.calls).toBe(1)
    const report = JSON.parse(run.stdout)
    expect(report.round).toBe(1)
    expect(report.wouldWrite.entries[0].status).toBe('in_progress')
    expect(report.measured).toBe(1260)
    expect(report.usage.input_tokens).toBe(1200)
    expect(report.estimateTokens > 0).toBe(true)
    expect(await exists(path.join(dir, 'backfill-pending.json'))).toBe(false)
    expect(await exists(path.join(dir, 'backfill-state.json'))).toBe(false)
    expect(await exists(path.join(dir, 'noter.log'))).toBe(false)
    expect(await exists(path.join(dir, 'noter.lock'))).toBe(false)
    expect(await exists(path.join(dir, 'noted.jsonl'))).toBe(false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the round list names rounds with no ledger record, and spends no call', async () => {
  const dir = await makeDir(eligible)
  try {
    const run = await runNoter(dir, { backfill: true, extra: ['--list-backfill-rounds'] })
    expect(run.status).toBe(0)
    expect(run.calls).toBe(0)
    const list = JSON.parse(run.stdout)
    expect(list.length).toBe(1)
    expect(list[0].round).toBe(1)
    expect(list[0].actions).toBe(3)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
