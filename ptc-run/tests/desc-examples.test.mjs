// The examples in the tool description are run for real, and tools.help() is read from a real runner process: the
// example text comes straight out of src/register.tpl.ts (the same array build.cjs reads), "npm test" is replaced by an
// echo, and the program runs in a temporary directory. If an example drifts away from the API, this fails.
//   node --test tests/desc-examples.test.mjs      (from the ptc-run folder)
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

// DESC_PARTS exactly the way build.cjs reads it.
const tpl = fs.readFileSync(path.join(root, 'src/register.tpl.ts'), 'utf8')
const m = /const DESC_PARTS = \[([\s\S]*?)\]\n/.exec(tpl)
assert.ok(m, 'DESC_PARTS not found in src/register.tpl.ts')
const PARTS = eval('[' + m[1] + ']')
const at = PARTS.findIndex((p) => p.startsWith('// Examples'))
assert.ok(at >= 0, 'the examples part is missing from DESC_PARTS')
const EXAMPLE = PARTS[at]
assert.ok(EXAMPLE.includes('tools.grep') && EXAMPLE.includes('lib.def'), EXAMPLE)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-example-'))
const cwd = path.join(work, 'cwd')
fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
fs.writeFileSync(path.join(cwd, 'src/app.ts'), 'const oldName = 1' + NL + 'export { oldName }' + NL)
const libHome = path.join(work, 'ptc-run')
const globalLib = path.join(libHome, 'lib.js')

let seq = 0
const spawnRun = (payload, extra) => new Promise((resolve, reject) => {
  const input = Object.assign({
    cwd, rg: RG, dsh: false, dedup: false, sessionId: 'sess-example',
    logName: 'ex-' + Math.random().toString(36).slice(2, 10), timeoutMs: 120000,
  }, payload, extra || {})
  const child = spawn(process.execPath, ['-e', BOOT], {
    cwd, windowsHide: true, env: Object.assign({}, process.env, { PTC_RUN_LIB: globalLib }),
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
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
const run = (code, opts = {}) => spawnRun(Object.assign({ code, scope: 'ex-' + process.pid + '-' + (++seq) }, opts), opts)
const runRo = (code, opts = {}) => spawnRun(Object.assign({ code, scope: 'ex-ro-' + process.pid + '-' + (++seq) }, opts), Object.assign({ broker: true, boot: BOOT, runner }, opts))

test('the two examples in the description run as they are written', { timeoutMs: 60000 }, async () => {
  const code = EXAMPLE.replace(/npm test/g, 'echo ok')
  const { out, err, exit } = await run(code)
  assert.equal(exit, 0, 'the example must run: ' + out.slice(0, 400) + (err ? ' | ' + err.slice(0, 300) : ''))
  const lines = out.split(NL).filter((l) => l.trim() !== '')
  // the runner leads with the write note (the replace changed two places), then the two console.log lines
  assert.deepEqual(lines.slice(-2), ['2 1 ok', 'ok'], 'locate+change+verify, then the shortcut: ' + out.slice(0, 400))
  assert.ok(out.includes('replace src/app.ts'), 'the write note names the file: ' + out.slice(0, 200))
  const after = fs.readFileSync(path.join(cwd, 'src/app.ts'), 'utf8')
  assert.ok(!after.includes('oldName'), 'the replace really changed the file: ' + after)
  assert.equal((after.match(/newName/g) || []).length, 2)
})

test('tools.help() lists the topics, and each topic returns the full original text', { timeoutMs: 60000 }, async () => {
  const { result, err } = await run([
    'const topics = tools.help()',
    'const bash = tools.help("bash")',
    'const read = tools.help("read")',
    'const edit = tools.help("edit")',
    'let bad = ""',
    'try { tools.help("nope") } catch (e) { bad = e.message }',
    'console.log("@@ " + JSON.stringify({ topics, bash, read, edit, bad }))',
  ].join(NL))
  assert.ok(result, 'program output' + (err ? ': ' + err.slice(0, 300) : ''))
  for (const topic of ['paths', 'read', 'edit', 'grep', 'replace', 'batch', 'bash', 'ref']) {
    assert.ok(result.topics.includes(topic), 'topic list names ' + topic + ': ' + result.topics)
  }
  // the details the compressed description had to drop
  assert.ok(result.bash.includes('promote:false kills it on timeout instead'), result.bash)
  assert.ok(result.bash.includes('promoted to a background job'), result.bash)
  assert.ok(result.bash.includes('timeoutMs'), result.bash)
  assert.ok(result.bash.includes('tools.job({id,wait?,tailChars?=4000})'), result.bash)
  assert.ok(result.read.includes('[read-dedup]'), result.read)
  assert.ok(result.read.includes('PTC_RUN_READ_DEDUP=0'), result.read)
  assert.ok(result.edit.includes('LOCKED after ~2 s'), result.edit)
  assert.ok(result.edit.includes('expectedRevision'), result.edit)
  assert.ok(result.bad.includes('[INVALID_ARGUMENT]'), result.bad)
})

test('the read-only sandbox has tools.help too, and refuses the write tools', { timeoutMs: 60000 }, async () => {
  const { result, err } = await runRo([
    'let denied = ""',
    'try { tools.edit({path: "src/app.ts", old: "newName", new: "x"}) } catch (e) { denied = e.message }',
    'console.log("@@ " + JSON.stringify({ ref: tools.help("ref").slice(0, 40), denied }))',
  ].join(NL))
  assert.ok(result, 'program output' + (err ? ': ' + err.slice(0, 300) : ''))
  assert.ok(result.ref.startsWith('ref.put(v)->id'), result.ref)
  assert.ok(result.denied.includes('POLICY_DENIED'), result.denied)
})
