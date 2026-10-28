// Read dedup at the output layer: tools.read always hands the program the real text; only what the program prints
// back unchanged is replaced (one line when nothing changed, a diff when the file did).
//   node --test tests/readdedup.test.mjs      (from the ptc-run folder)
// Each run() is a real runner process (the same bootstrap the hook uses), so the cross-call tests exercise the
// persisted record and the isolation between scopes for real.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const runner = fs.readFileSync(path.join(root, 'src/runner.js'), 'utf8')
const broker = fs.readFileSync(path.join(root, 'src/broker.js'), 'utf8')
const RG = path.join(root, 'bin/rg.exe')
const NL = String.fromCharCode(10)
const BOOT = 'const s=require("fs").readFileSync(0,"utf8"),k=s.indexOf(String.fromCharCode(10));globalThis.__PTC_IN=s.slice(0,k);(0,eval)(s.slice(k+1))'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-readdedup-'))
const cwd = path.join(work, 'cwd')
fs.mkdirSync(cwd, { recursive: true })
const BIG = Array.from({ length: 60 }, (_, i) => 'line ' + String(i + 1).padStart(2, '0') + ' alpha beta gamma delta epsilon').join(NL) + NL
const JSON_TXT = '{' + NL + '  "name": "alpha",' + NL + '  "items": [1, 2, 3]' + NL + '}' + NL
const bigPath = path.join(cwd, 'big.txt')
fs.writeFileSync(bigPath, BIG)
fs.writeFileSync(path.join(cwd, 'data.json'), JSON_TXT)
fs.writeFileSync(path.join(cwd, 'small.txt'), 'tiny line' + NL)

let seq = 0
const spawnRun = (payload, extra) => new Promise((resolve, reject) => {
  const input = Object.assign({
    cwd, rg: RG, dsh: false, dedupTag: 'main',
    logName: 'dd-' + Math.random().toString(36).slice(2, 10), timeoutMs: 120000,
  }, payload, extra || {})
  const child = spawn(process.execPath, ['-e', BOOT], { cwd, windowsHide: true })
  let out = ''
  let err = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.on('error', reject)
  child.on('close', (exit) => {
    let result = null
    for (const line of out.split(NL)) {
      if (!line.startsWith('@@')) continue
      try { result = JSON.parse(line.slice(2)) } catch {}
    }
    resolve({ exit, out, err, result })
  })
  child.stdin.end(JSON.stringify(input) + NL + (extra && extra.broker ? broker : runner))
})
const run = (code, opts = {}) => spawnRun(Object.assign({ code, scope: opts.scope || 'dd-' + process.pid + '-' + (++seq) }, opts))
const runRo = (code, scope) => spawnRun({ code, scope }, { broker: true, boot: BOOT, runner })
const store = (scope) => {
  const f = path.join(os.tmpdir(), 'cc-ptc', scope, 'read-dedup-main.json')
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
}
const HINT = '[read-dedup]'

test('the program always gets the real text, twice in a row', { timeoutMs: 60000 }, async () => {
  const { result, out, err } = await run([
    'const t1 = tools.read({ path: "big.txt" })',
    'const t2 = tools.read({ path: "big.txt" })',
    'const t3 = tools.read({ path: "big.txt", offset: 9, limit: 10 })',
    'console.log("@@ " + JSON.stringify({ same: t1 === BIG_REF, equal: t1 === t2, lines: t3.split("\\n").length, first: t3.split("\\n")[0], full: t1.length }))',
  ].join(NL).replace('BIG_REF', JSON.stringify(BIG)), {})
  assert.ok(result, 'program output' + (err ? ': ' + err.slice(0, 300) : ''))
  assert.equal(result.same, true, 'the read is the whole file')
  assert.equal(result.equal, true, 'a second read is the same real text, not a hint')
  assert.equal(result.lines, 10)
  assert.equal(result.first, 'line 10 alpha beta gamma delta epsilon')
  assert.equal(result.full, BIG.length)
  assert.ok(!out.includes(HINT), 'nothing was replaced: ' + out.slice(0, 200))
})

test('JSON.parse and edit work on the value the program got', { timeoutMs: 60000 }, async () => {
  const { result, err } = await run([
    'const t = tools.read({ path: "data.json" })',
    'const o = JSON.parse(t)',
    'const e = tools.edit({ path: "data.json", old: \'"name": "alpha"\', new: \'"name": "beta"\' })',
    'const after = JSON.parse(tools.read({ path: "data.json" }))',
    'console.log("@@ " + JSON.stringify({ name: o.name, items: o.items.length, replaced: e.replaced, after: after.name }))',
  ].join(NL))
  assert.ok(result, 'program output' + (err ? ': ' + err.slice(0, 300) : ''))
  assert.equal(result.name, 'alpha')
  assert.equal(result.items, 3)
  assert.equal(result.replaced, 1)
  assert.equal(result.after, 'beta')
})

test('printing a read back twice: the second copy is one line', { timeoutMs: 60000 }, async () => {
  const { out, err } = await run([
    'const t = tools.read({ path: "big.txt" })',
    'console.log(t)',
    'console.log(t)',
  ].join(NL))
  const first = out.slice(0, BIG.length)
  assert.equal(first, BIG, 'the first copy is the file: ' + err.slice(0, 200))
  assert.match(out.slice(BIG.length), /\[read-dedup\] big\.txt 第 1–60 行.*已在本上下文中输出过/, 'the second copy is the note: ' + out.slice(BIG.length, BIG.length + 200))
})

test('a contained range printed again is a one-line note', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-contained-' + process.pid
  await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  const b = await run('const t = tools.read({ path: "big.txt", offset: 9, limit: 10 }); console.log(t)', { scope })
  assert.match(b.out, /^\[read-dedup\] big\.txt 第 10–19 行/, 'contained range: ' + b.out.slice(0, 160))
  assert.ok(!b.out.includes('line 10 alpha'), 'the range itself was not printed again')
})

test('filtered or sliced output is never replaced', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-filter-' + process.pid
  await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  const filtered = await run('const t = tools.read({ path: "big.txt" }); console.log(t.split("\\n").filter(l => !l.includes("line 1")).join("\\n"))', { scope })
  assert.ok(!filtered.out.includes(HINT), 'a filtered print stays as it is: ' + filtered.out.slice(0, 200))
  assert.match(filtered.out, /line 02 alpha/)
  const sliced = await run('const t = tools.read({ path: "big.txt" }); console.log(t.split("\\n").slice(5).join("\\n"))', { scope })
  assert.ok(!sliced.out.includes(HINT), 'a slice stays as it is: ' + sliced.out.slice(0, 200))
  assert.match(sliced.out, /^line 06 alpha/)
})

test('a changed file printed again gives a diff', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-diff-' + process.pid
  await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  const b = await run([
    'tools.edit({ path: "big.txt", old: "line 05 alpha", new: "line 05 FIVE" })',
    'const t = tools.read({ path: "big.txt" })',
    'console.log(t)',
  ].join(NL), { scope })
  assert.match(b.out, /^\[read-dedup\] big\.txt 第 1–60 行/, 'a diff, not the whole file: ' + b.out.slice(0, 120))
  assert.match(b.out, /\+5\tline 05 FIVE/)
  assert.match(b.out, /-5\tline 05 alpha/)
  assert.ok(b.out.length < BIG.length, 'the diff is shorter than the file')
  fs.writeFileSync(bigPath, BIG)
})

test('a short print is never replaced', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-short-' + process.pid
  await run('const t = tools.read({ path: "small.txt" }); console.log(t)', { scope })
  const b = await run('const t = tools.read({ path: "small.txt" }); console.log(t)', { scope })
  assert.equal(b.out.trim().split(NL)[0], 'tiny line')
  assert.ok(!b.out.includes(HINT))
})

test('PTC_RUN_READ_DEDUP=0 (input.dedup:false) never replaces', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-off-' + process.pid
  await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  const b = await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope, dedup: false })
  assert.equal(b.out.slice(0, BIG.length), BIG, 'the full text with dedup off')
  // the switch does not disturb the record either
  const c = await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  assert.match(c.out, /^\[read-dedup\]/)
})

test('the record survives across two run_code processes', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-cross-' + process.pid
  const a = await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  assert.equal(a.out.slice(0, BIG.length), BIG)
  const b = await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  assert.match(b.out, /^\[read-dedup\] big\.txt 第 1–60 行/)
  assert.equal(store(scope).stats.hits, 1)
})

test('scopes (session / agent) are isolated from each other', { timeoutMs: 60000 }, async () => {
  const base = 'dd-iso-' + process.pid
  await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope: base + '-a' })
  const b = await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope: base + '-b' })
  assert.equal(b.out.slice(0, BIG.length), BIG, 'another session has its own record')
  const c = await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope: base + '-a', dedupTag: 'agent-x' })
  assert.equal(c.out.slice(0, BIG.length), BIG, 'another agent of the same session has its own record')
})

test('an agent tag keeps its own record inside one scope', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-tag-' + process.pid
  await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope, dedupTag: 'agent-1' })
  const other = await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope, dedupTag: 'agent-2' })
  assert.equal(other.out.slice(0, BIG.length), BIG)
  const same = await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope, dedupTag: 'agent-1' })
  assert.match(same.out, /^\[read-dedup\]/)
})

test('after compaction (dedupReset) the text comes back in full', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-compact-' + process.pid
  await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  const b = await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope, dedupReset: true })
  assert.equal(b.out.slice(0, BIG.length), BIG, 'the record is gone after a reset')
  const c = await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  assert.match(c.out, /^\[read-dedup\]/, 'and it starts over from that run')
})

test('fresh:true turns dedup off for that program output', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-fresh-' + process.pid
  await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  const b = await run([
    'const t = tools.read({ path: "big.txt", fresh: true })',
    'const t2 = tools.read({ path: "small.txt", fresh: true })',
    'console.log(t)',
  ].join(NL), { scope })
  assert.equal(b.out.slice(0, BIG.length), BIG, 'fresh keeps the output as it is')
})

test('the DSH read keeps its shape and its printed text dedups', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-dsh-' + process.pid
  const a = await run([
    'const r = await tools.read({ file_path: "big.txt" })',
    'console.log("@@ " + JSON.stringify({ keys: Object.keys(r), lines: r.lines.length, total: r.totalLines, head: r.text.slice(0, 9) }))',
    'console.log(r.text)',
  ].join(NL), { scope, dsh: true })
  assert.ok(a.result, 'program output: ' + a.err.slice(0, 300))
  assert.deepEqual(a.result.keys, ['path', 'offset', 'lines', 'totalLines'], 'enumerable shape unchanged')
  assert.equal(a.result.lines, 60)
  assert.equal(a.result.total, 60)
  const b = await run('const r = await tools.read({ file_path: "big.txt" }); console.log(r.text)', { scope, dsh: true })
  assert.match(b.out, /^\[read-dedup\] big\.txt 第 1–60 行/)
})

test('savedChars is what the replacement actually saved', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-stats-' + process.pid
  await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  const b = await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  const hint = b.out.split('[read-dedup] 本次')[0].trim()
  assert.match(hint, /^\[read-dedup\]/)
  const st = store(scope)
  assert.equal(st.stats.hits, 1)
  assert.equal(st.stats.savedChars, (BIG.length - 1) - hint.length, 'saved = printed length - note length')
})

test('a read that was never printed is not remembered', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-unshown-' + process.pid
  await run('const t = tools.read({ path: "big.txt" }); console.log("@@ " + JSON.stringify({ n: t.length }))', { scope })
  const b = await run('const t = tools.read({ path: "big.txt" }); console.log(t)', { scope })
  assert.equal(b.out.slice(0, BIG.length), BIG, 'the model never saw the text, so it comes in full')
})

test('read-only mode (broker) dedups across calls too', { timeoutMs: 120000 }, async () => {
  const scope = 'dd-ro-' + process.pid
  const a = await runRo('const t = tools.read({ path: "big.txt" }); console.log(t)', scope)
  assert.equal(a.out.slice(0, BIG.length), BIG, 'first read-only run: ' + (a.err || a.out).slice(0, 300))
  const b = await runRo('const t = tools.read({ path: "big.txt" }); console.log(t)', scope)
  assert.match(b.out, /^\[read-dedup\] big\.txt 第 1–60 行/, 'the record is written under read-only: ' + b.out.slice(0, 160))
  assert.equal(store(scope).stats.hits, 1)
})

test('a returned read result is deduped too, not only console.log', { timeoutMs: 60000 }, async () => {
  const scope = 'dd-return-' + process.pid
  const a = await run('return tools.read({ path: "big.txt" })', { scope })
  assert.equal(a.out.trim(), BIG.trim(), 'the first return is the file')
  const b = await run('return tools.read({ path: "big.txt" })', { scope })
  assert.match(b.out, /^\[read-dedup\] big\.txt 第 1–60 行/, 'the second return is the note: ' + b.out.slice(0, 120))
})

