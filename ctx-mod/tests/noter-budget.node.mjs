import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
// The budget is measured, not predicted: this runs scripts/noter.mjs for real, with
// CTX_MOD_NOTER_CMD pointing at a fake model, so the line the call's measurement leaves
// in noter.log and the multiplier it leaves in noter-cursor.json are checked end to end.
// It sits outside *.test.ts because the plugin test loader lets a test file import only
// its own files and "claude-code", and this needs a child process.
const expect = value => ({
  toBe: expected => assert.equal(value, expected),
  toContain: expected => assert.ok(value.includes(expected), String(value)),
  toEqual: expected => assert.deepEqual(value, expected),
})
const person = (seq, text) => ({ seq, uuid: `p${seq}`, ts: 1_700_000_000_000 + seq * 1_000, window: 1, role: 'user', isPerson: true, text })
/** A stand-in for the CLI: prints the envelope --output-format json prints, usage from an env var. */
const FAKE = [
  "const usage = JSON.parse(process.env.CTX_MOD_NOTER_FAKE_USAGE ?? '{}')",
  "const result = '{\"add\":[],\"revoke\":[]}'",
  "process.stdout.write(JSON.stringify({ is_error: false, num_turns: 1, result, usage, total_cost_usd: 0.0042, duration_ms: 12 }))",
].join('\n')
const runNoter = (dir, fake, usage) =>
  spawnSync(process.execPath, [path.resolve('scripts/noter.mjs'), dir], {
    env: {
      ...process.env,
      CTX_MOD_NOTER_CMD: JSON.stringify([process.execPath, fake]),
      CTX_MOD_NOTER_FAKE_USAGE: JSON.stringify(usage),
    },
    encoding: 'utf8',
  })
const cursorOf = async dir => JSON.parse(await fs.readFile(path.join(dir, 'noter-cursor.json'), 'utf8'))
const scaleOf = value => Math.round(value * 1_000) / 1_000

test('a call over 90000 tokens warns in the log and turns the next batches down', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-noter-budget-'))
  try {
    const fake = path.join(dir, 'fake-model.mjs')
    await fs.writeFile(fake, FAKE, 'utf8')
    const history = path.join(dir, 'history-w001.jsonl')
    await fs.writeFile(history, `${JSON.stringify(person(1, '以后一律用 pnpm。'))}\n`, 'utf8')

    const first = runNoter(dir, fake, { input_tokens: 70_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 25_000 })
    expect(first.status).toBe(0)
    const log = await fs.readFile(path.join(dir, 'noter.log'), 'utf8')
    expect(log).toContain('估算输入')
    expect(log).toContain('实际 95000')
    expect(log).toContain('警告：接近 10 万上限')
    expect(scaleOf((await cursorOf(dir)).budgetScale)).toBe(0.7)

    // 下一批起生效：再跑一次，存下的系数被读出，一批便宜的调用把它回升。
    await fs.appendFile(history, `${JSON.stringify(person(2, '另外，界面配色改深色。'))}\n`, 'utf8')
    const second = runNoter(dir, fake, { input_tokens: 40_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 15_000 })
    expect(second.status).toBe(0)
    const after = await cursorOf(dir)
    expect(after.cursorSeq).toBe(2)
    expect(scaleOf(after.budgetScale)).toBe(0.77)
    expect(await fs.readFile(path.join(dir, 'noter.log'), 'utf8')).toContain('实际 55000')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a healthy first call leaves the multiplier at one, and the call count is in the log', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-noter-budget-'))
  try {
    const fake = path.join(dir, 'fake-model.mjs')
    await fs.writeFile(fake, FAKE, 'utf8')
    await fs.writeFile(path.join(dir, 'history-w001.jsonl'), `${JSON.stringify(person(1, '以后一律用 pnpm。'))}\n`, 'utf8')
    const run = runNoter(dir, fake, { input_tokens: 20_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5_000 })
    expect(run.status).toBe(0)
    const log = await fs.readFile(path.join(dir, 'noter.log'), 'utf8')
    expect(log).toContain('实际 25000')
    expect(log.includes('警告')).toBe(false)
    expect(scaleOf((await cursorOf(dir)).budgetScale)).toBe(1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
