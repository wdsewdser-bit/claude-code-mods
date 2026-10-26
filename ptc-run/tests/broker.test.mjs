// The read-only broker, for real: it launches the runner under the Node permission model, so this file runs as plain
// node (node --test tests/) rather than inside the plugin test engine, which cannot start processes.
//
//   node --test tests/broker.test.mjs      (from the ptc-run folder)
//
// Covers: an extra read root (PTC_RUN_READ_ROOTS -> input.readRoots) is readable and searchable, a directory outside
// it is still refused, writes and child processes stay blocked, and missing/relative entries are ignored.
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

// A cwd, one extra readable directory and one directory outside both.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-readroots-'))
const cwd = path.join(work, 'cwd')
const extra = path.join(work, 'extra')
const outside = path.join(work, 'outside')
for (const d of [cwd, extra, outside]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(cwd, 'inside.txt'), 'inside one' + NL)
fs.writeFileSync(path.join(extra, 'extra.txt'), 'MAGIC extra line' + NL)
fs.writeFileSync(path.join(outside, 'outside.txt'), 'MAGIC outside line' + NL)

const code = [
  'const J = ' + JSON.stringify({ cwd, extra, outside }),
  'const out = {}',
  'try { out.extraRead = String(await tools.read({ path: J.extra + "/extra.txt" })).trim() } catch (e) { out.extraRead = "ERR " + (e.code || "") + " " + e.message }',
  'try { out.extraGrep = (await tools.grep({ pattern: "MAGIC", path: J.extra })).items.length } catch (e) { out.extraGrep = "ERR " + (e.code || "") }',
  'try { out.extraGlob = (await tools.glob({ pattern: "*.txt", path: J.extra })).items.length } catch (e) { out.extraGlob = "ERR " + (e.code || "") }',
  'try { out.cwdRead = String(await tools.read({ path: J.cwd + "/inside.txt" })).trim() } catch (e) { out.cwdRead = "ERR " + (e.code || "") + " " + e.message }',
  'try { await tools.read({ path: J.outside + "/outside.txt" }); out.outsideRead = "ALLOWED" } catch (e) { out.outsideRead = e.code || "ERR" }',
  'try { await tools.grep({ pattern: "MAGIC", path: J.outside }); out.outsideGrep = "ALLOWED" } catch (e) { out.outsideGrep = e.code || "ERR" }',
  'try { await tools.glob({ pattern: "*.txt", path: J.outside }); out.outsideGlob = "ALLOWED" } catch (e) { out.outsideGlob = e.code || "ERR" }',
  'try { tools.write({ path: J.extra + "/w.txt", content: "x" }); out.toolWrite = "ALLOWED" } catch (e) { out.toolWrite = e.code || "ERR" }',
  'try { require("fs").writeFileSync(J.extra + "/plain.txt", "x"); out.fsWrite = "ALLOWED" } catch (e) { out.fsWrite = e.code || "ERR" }',
  'try { require("child_process").execSync("echo hi"); out.spawn = "ALLOWED" } catch (e) { out.spawn = e.code || "ERR" }',
  'console.log(JSON.stringify(out))',
].join(NL)

const runBroker = (readRoots) => new Promise((resolve, reject) => {
  const input = {
    cwd, code, rg: RG, scope: 'test-readroots', dsh: false, readRoots,
    logName: 'test-' + Math.random().toString(36).slice(2, 10), timeoutMs: 120000, boot: BOOT, runner,
  }
  const child = spawn(process.execPath, ['-e', BOOT], { cwd, windowsHide: true })
  let out = ''
  let err = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.on('error', reject)
  child.on('close', (code_) => {
    const line = out.trim().split(NL).filter(Boolean).at(-1) ?? ''
    let result = null
    try { result = JSON.parse(line) } catch {}
    resolve({ code: code_, out, err, result })
  })
  child.stdin.end(JSON.stringify(input) + NL + broker)
})

test('extra read roots: readable and searchable, the rest still refused', { timeoutMs: 180000 }, async () => {
  const { result, err, code: exit } = await runBroker([extra])
  assert.equal(exit, 0, 'broker exit' + (err ? ': ' + err.slice(0, 400) : ''))
  assert.ok(result, 'the program printed a JSON result: ' + err.slice(0, 400))
  assert.equal(result.extraRead, 'MAGIC extra line', 'read inside an extra root')
  assert.equal(result.extraGrep, 1, 'grep inside an extra root')
  assert.equal(result.extraGlob, 1, 'glob inside an extra root')
  assert.equal(result.cwdRead, 'inside one', 'read inside the cwd still works')
  assert.equal(result.outsideRead, 'POLICY_DENIED', 'read outside the extra roots is refused')
  assert.equal(result.outsideGrep, 'POLICY_DENIED', 'grep outside the extra roots is refused')
  assert.equal(result.outsideGlob, 'POLICY_DENIED', 'glob outside the extra roots is refused')
  assert.equal(result.toolWrite, 'POLICY_DENIED', 'tools.write stays refused')
  assert.equal(result.fsWrite, 'ERR_ACCESS_DENIED', 'plain fs writes stay refused')
  assert.equal(result.spawn, 'ERR_ACCESS_DENIED', 'child processes stay refused')
  assert.equal(fs.existsSync(path.join(extra, 'w.txt')), false, 'nothing was written into the extra root')
})

test('without extra read roots the same directory is refused', { timeoutMs: 180000 }, async () => {
  const { result, err } = await runBroker([])
  assert.ok(result, 'the program printed a JSON result: ' + err.slice(0, 400))
  assert.equal(result.cwdRead, 'inside one')
  // the Node permission model refuses first, before the broker's own rg check ever sees the path
  assert.match(result.extraRead, /POLICY_DENIED/)
  assert.match(result.extraGrep, /POLICY_DENIED/)
  assert.match(result.extraGlob, /POLICY_DENIED/)
})

test('a missing or relative entry is ignored, the good ones still work', { timeoutMs: 180000 }, async () => {
  const { result, err } = await runBroker([path.join(work, 'does-not-exist'), extra, 'relative/dir'])
  assert.ok(result, 'the program printed a JSON result: ' + err.slice(0, 400))
  assert.equal(result.extraRead, 'MAGIC extra line')
  assert.equal(result.extraGrep, 1)
  assert.equal(result.outsideRead, 'POLICY_DENIED')
})

test('an extra root may also be the read-only root target (root: inside it)', { timeoutMs: 180000 }, async () => {
  const input = {
    cwd, code: 'const J = ' + JSON.stringify({ extra }) + '; console.log(String(await tools.read({ path: J.extra + "/extra.txt" })))',
    rg: RG, scope: 'test-readroots', dsh: false, readRoots: [extra], root: extra,
    logName: 'test-root-' + Math.random().toString(36).slice(2, 10), timeoutMs: 120000, boot: BOOT, runner,
  }
  const res = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', BOOT], { cwd, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', () => resolve({ out, err }))
    child.stdin.end(JSON.stringify(input) + NL + broker)
  })
  assert.match(res.out, /MAGIC extra line/, 'root may point into an extra read root: ' + res.err.slice(0, 300))
})
// hooks/register.ts is generated by build.cjs from src/broker.js + src/runner.js: the broker this file just exercised
// must be the one the hook actually starts.
test('the built hook embeds this broker and runner', () => {
  const built = fs.readFileSync(path.join(root, 'hooks/register.ts'), 'utf8')
  const grab = (name) => {
    const m = new RegExp('const ' + name + ' = ("(?:[^"\\\\]|\\\\.)*")').exec(built)
    assert.ok(m, 'register.ts carries ' + name)
    return JSON.parse(m[1])
  }
  assert.equal(grab('BROKER'), broker, 'hooks/register.ts embeds src/broker.js as is (run node build.cjs)')
  assert.equal(grab('RUNNER'), runner, 'hooks/register.ts embeds src/runner.js as is (run node build.cjs)')
  assert.match(built, /PTC_RUN_READ_ROOTS/, 'the hook reads PTC_RUN_READ_ROOTS')
  assert.match(built, /readRoots/, 'the hook hands the read roots to the broker')
})
