// The runner's own additions, for real: tools.sh, tools.peek, the two library layers and lib.def. Each run() is a real
// runner process (the same bootstrap the hook uses) with PTC_RUN_LIB pointing at a temporary library home, so nothing
// here touches the person's own ~/.claude/ptc-run.
//   node --test tests/runnerlib.test.mjs      (from the ptc-run folder)
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-lib-'))
const cwd = path.join(work, 'cwd')
fs.mkdirSync(cwd, { recursive: true })
// A library home of its own: PTC_RUN_LIB names the global file, so the session libraries sit beside it.
const libHome = path.join(work, 'ptc-run')
const globalLib = path.join(libHome, 'lib.js')
const writeLib = (file, fns) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const functions = {}
  for (const [name, v] of Object.entries(fns)) functions[name] = typeof v === 'string' ? { source: v, doc: '' } : v
  fs.writeFileSync(file, JSON.stringify({ version: 1, functions }, null, 2) + NL)
}
const sessionLib = (id) => path.join(libHome, 'sessions', id, 'lib.js')
const sessionIndex = (id) => path.join(libHome, 'sessions', id, 'index.json')

let seq = 0
const spawnRun = (payload, extra) => new Promise((resolve, reject) => {
  const input = Object.assign({
    cwd, rg: RG, dsh: false, dedup: false, sessionId: 'sess-default',
    logName: 'lib-' + Math.random().toString(36).slice(2, 10), timeoutMs: 120000,
  }, payload, extra || {})
  const child = spawn(process.execPath, ['-e', BOOT], {
    cwd, windowsHide: true, env: Object.assign({}, process.env, { PTC_RUN_LIB: globalLib }),
  })
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
const run = (code, opts = {}) => spawnRun(Object.assign({ code, sessionId: opts.sessionId || 'sess-' + (++seq) }, opts), opts)
const runRo = (code, opts = {}) => spawnRun(Object.assign({ code, sessionId: opts.sessionId || 'sess-ro-' + (++seq) }, opts), Object.assign({ broker: true, boot: BOOT, runner }, opts))

test('tools.sh keeps the last lines and says how many it dropped', { timeoutMs: 60000 }, async () => {
  const { result, err } = await run([
    'const r = tools.sh("printf \'a\\nb\\nc\\nd\\ne\\n\'", { tail: 2 })',
    'console.log("@@ " + JSON.stringify({ code: r.code, text: r.text }))',
  ].join(NL))
  assert.ok(result, 'program output' + (err ? ': ' + err.slice(0, 300) : ''))
  assert.equal(result.code, 0)
  assert.equal(result.text, '…[省略前 3 行]…' + NL + 'd' + NL + 'e')
})

test('tools.sh merges stderr into the same tail, and short output is not marked', { timeoutMs: 60000 }, async () => {
  const { result } = await run([
    'const r = tools.sh("echo out; echo bad 1>&2")',
    'console.log("@@ " + JSON.stringify(r))',
  ].join(NL))
  assert.equal(result.code, 0)
  assert.equal(result.text, 'out' + NL + 'bad')
})

test('tools.peek numbers the matches with the file\'s real line numbers', { timeoutMs: 60000 }, async () => {
  const file = path.join(cwd, 'peek.txt')
  fs.writeFileSync(file, ['one', 'two', 'needle A', 'four', 'five', 'six', 'needle B', 'eight'].join(NL) + NL)
  const { result } = await run([
    'const t = tools.peek(' + JSON.stringify(file) + ', "needle", { context: 1 })',
    'console.log("@@ " + JSON.stringify({ text: t }))',
  ].join(NL))
  assert.equal(result.text, ['2: two', '3: needle A', '4: four', '--', '6: six', '7: needle B', '8: eight'].join(NL))
})

test('tools.peek honours limit and context 0', { timeoutMs: 60000 }, async () => {
  const file = path.join(cwd, 'peek2.txt')
  fs.writeFileSync(file, ['hit', 'hit', 'hit'].join(NL) + NL)
  const { result } = await run([
    'const t = tools.peek(' + JSON.stringify(file) + ', "hit", { context: 0, limit: 2 })',
    'console.log("@@ " + JSON.stringify({ text: t }))',
  ].join(NL))
  assert.equal(result.text, '1: hit' + NL + '2: hit')
})

test('the global library loads, and lib.help() marks it 全局', { timeoutMs: 60000 }, async () => {
  writeLib(globalLib, { hello: { source: '(tools, n) => "hi " + n', doc: '打招呼' } })
  const { result, out, err } = await run([
    'console.log("@@ " + JSON.stringify({ v: lib.hello("x"), help: lib.help() }))',
  ].join(NL))
  assert.ok(result, 'program output' + (err ? ': ' + err.slice(0, 300) : ''))
  assert.equal(result.v, 'hi x')
  assert.equal(result.help, 'hello（全局） — 打招呼')
  assert.ok(!out.includes('[lib]'), 'no warning for a good library: ' + out.slice(0, 200))
})

test('no library file at all: lib.help() is empty and nothing warns', { timeoutMs: 60000 }, async () => {
  fs.rmSync(libHome, { recursive: true, force: true })
  const { result, out } = await run(['console.log("@@ " + JSON.stringify({ help: lib.help() }))'].join(NL))
  assert.match(result.help, /lib 为空/)
  assert.ok(!out.includes('[lib]'), 'a missing file is not an error: ' + out.slice(0, 200))
})

test('a syntax error in the global library only adds one warning line', { timeoutMs: 60000 }, async () => {
  writeLib(globalLib, { good: { source: '(tools) => "G"', doc: '' }, bad: { source: '(tools => {', doc: '' } })
  const { result, out } = await run(['console.log("@@ " + JSON.stringify({ v: lib.good() }))'].join(NL))
  assert.equal(result.v, 'G', 'the other functions still load')
  const lines = out.split(NL).filter(Boolean)
  assert.match(lines[0], /^\[lib\] 全局库的函数 bad 有语法错误/)
  assert.equal(lines.filter(l => l.startsWith('[lib]')).length, 1)
})

test('a session library overlays the global one, and another session sees neither', { timeoutMs: 60000 }, async () => {
  writeLib(globalLib, { hello: { source: '(tools) => "global"', doc: 'g' }, onlyglobal: { source: '(tools) => "G"', doc: '' } })
  writeLib(sessionLib('sess-a'), { hello: { source: '(tools) => "session-a"', doc: 's' } })
  writeLib(sessionLib('sess-b'), { hello: { source: '(tools) => "session-b"', doc: 's' }, bsonly: { source: '(tools) => "B"', doc: '' } })
  const a = await run(['console.log("@@ " + JSON.stringify({ hello: lib.hello(), help: lib.help() }))'].join(NL), { sessionId: 'sess-a' })
  const b = await run(['console.log("@@ " + JSON.stringify({ hello: lib.hello(), help: lib.help() }))'].join(NL), { sessionId: 'sess-b' })
  assert.equal(a.result.hello, 'session-a')
  assert.match(a.result.help, /hello（本会话） — s/)
  assert.match(a.result.help, /onlyglobal（全局）/)
  assert.ok(!a.result.help.includes('bsonly'), 'session a never sees session b\'s library')
  assert.equal(b.result.hello, 'session-b')
  assert.ok(!b.result.help.includes('onlyglobal') === false)
  assert.ok(!a.result.help.includes('bsonly'))
})

test('lib.def saves a function, it works at once, and the session index lists it', { timeoutMs: 60000 }, async () => {
  fs.rmSync(libHome, { recursive: true, force: true })
  const { result } = await run([
    'const saved = lib.def("twice", "(tools, n) => n * 2", "翻倍")',
    'console.log("@@ " + JSON.stringify({ saved: saved, v: lib.twice(21), help: lib.help() }))',
  ].join(NL), { sessionId: 'sess-def' })
  assert.equal(result.saved, '已登记 twice（本会话）')
  assert.equal(result.v, 42)
  assert.match(result.help, /twice（本会话） — 翻倍/)
  const stored = JSON.parse(fs.readFileSync(sessionLib('sess-def'), 'utf8'))
  assert.equal(stored.functions.twice.source, '(tools, n) => n * 2')
  assert.equal(stored.functions.twice.doc, '翻倍')
  assert.deepEqual(JSON.parse(fs.readFileSync(sessionIndex('sess-def'), 'utf8')), [{ name: 'twice', doc: '翻倍' }])
})

test('lib.def replaces a name instead of adding a second one', { timeoutMs: 60000 }, async () => {
  const { result } = await run([
    'lib.def("f", "(tools) => 1", "one")',
    'lib.def("f", "(tools) => 2", "two")',
    'console.log("@@ " + JSON.stringify({ v: lib.f() }))',
  ].join(NL), { sessionId: 'sess-replace' })
  assert.equal(result.v, 2)
  const stored = JSON.parse(fs.readFileSync(sessionLib('sess-replace'), 'utf8'))
  assert.equal(Object.keys(stored.functions).length, 1)
  assert.equal(stored.functions.f.doc, 'two')
  assert.deepEqual(JSON.parse(fs.readFileSync(sessionIndex('sess-replace'), 'utf8')), [{ name: 'f', doc: 'two' }])
})

test('a syntax error in lib.def writes nothing', { timeoutMs: 60000 }, async () => {
  fs.rmSync(libHome, { recursive: true, force: true })
  const { result, out } = await run([
    'const fs = require("fs")',
    'const before = fs.existsSync(' + JSON.stringify(sessionLib('sess-bad')) + ')',
    'let code = ""',
    'try { lib.def("broken", "(tools => {", "x") } catch (e) { code = e.code + ": " + e.message }',
    'const after = fs.existsSync(' + JSON.stringify(sessionLib('sess-bad')) + ')',
    'console.log("@@ " + JSON.stringify({ before: before, after: after, code: code }))',
  ].join(NL), { sessionId: 'sess-bad' })
  assert.equal(result.before, false)
  assert.equal(result.after, false, 'nothing was written')
  assert.match(result.code, /INVALID_ARGUMENT: .*source is not a valid function expression/)
  assert.match(result.code, /nothing was written/)
  assert.ok(out.includes('@@ '))
})

test('lib.def refuses the reserved names and a bad name', { timeoutMs: 60000 }, async () => {
  const { result } = await run([
    'const errs = []',
    'for (const n of ["help", "def", "1bad", "has space"]) {',
    '  try { lib.def(n, "(tools) => 1") } catch (e) { errs.push(e.code) }',
    '}',
    'console.log("@@ " + JSON.stringify({ errs }))',
  ].join(NL), { sessionId: 'sess-names' })
  assert.deepEqual(result.errs, ['INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'])
})

test('without a session id the default scope refuses, and global still works', { timeoutMs: 60000 }, async () => {
  const { result } = await run([
    'let code = ""',
    'try { lib.def("x", "(tools) => 1") } catch (e) { code = e.code + ": " + e.message + " | " + (e.nextAction || "") }',
    'const saved = lib.def("g1", "(tools) => 7", "全局的", { scope: "global" })',
    'console.log("@@ " + JSON.stringify({ code: code, saved: saved, v: lib.g1(), help: lib.help() }))',
  ].join(NL), { sessionId: undefined })
  assert.match(result.code, /INVALID_ARGUMENT: .*this run has no session id/)
  assert.match(result.code, /\| .*scope:'global'/)
  assert.equal(result.saved, '已登记 g1（全局）')
  assert.equal(result.v, 7)
  assert.match(result.help, /g1（全局） — 全局的/)
  assert.ok(fs.existsSync(globalLib))
})

test('read-only mode refuses tools.sh, a library write call and lib.def', { timeoutMs: 120000 }, async () => {
  fs.rmSync(libHome, { recursive: true, force: true })
  writeLib(sessionLib('sess-ro'), {
    writeIt: { source: '(tools) => { tools.write({ path: "w.txt", content: "x" }); return "WROTE" }', doc: '' },
    readIt: { source: '(tools) => String(tools.read({ path: "inside.txt" })).trim()', doc: '读一个文件' },
  })
  fs.writeFileSync(path.join(cwd, 'inside.txt'), 'INSIDE' + NL)
  const { result, err } = await runRo([
    'const out = {}',
    'try { tools.sh("echo hi") } catch (e) { out.sh = e.code }',
    'try { out.write = lib.writeIt() } catch (e) { out.write = e.code }',
    'try { lib.def("n", "(tools) => 1") } catch (e) { out.def = e.code }',
    'out.read = lib.readIt()',
    'console.log("@@ " + JSON.stringify(out))',
  ].join(NL), { sessionId: 'sess-ro' })
  assert.ok(result, 'program output' + (err ? ': ' + err.slice(0, 400) : ''))
  assert.equal(result.sh, 'POLICY_DENIED', 'tools.sh is refused like tools.bash')
  assert.equal(result.write, 'POLICY_DENIED', 'a library function gets the read-only tools')
  assert.equal(result.def, 'POLICY_DENIED', 'lib.def cannot write in read-only mode')
  assert.equal(result.read, 'INSIDE', 'the read side still works')
  assert.equal(fs.existsSync(path.join(cwd, 'w.txt')), false)
})

test('read-only mode reads the global library too', { timeoutMs: 120000 }, async () => {
  fs.rmSync(libHome, { recursive: true, force: true })
  writeLib(globalLib, { g: { source: '(tools) => "GLOBAL"', doc: 'g' } })
  const { result } = await runRo(['console.log("@@ " + JSON.stringify({ v: lib.g(), help: lib.help() }))'].join(NL), { sessionId: 'sess-ro2' })
  assert.equal(result.v, 'GLOBAL')
  assert.match(result.help, /g（全局） — g/)
})

test('session libraries untouched for 30 days are swept, a fresh one stays', { timeoutMs: 60000 }, async () => {
  fs.rmSync(libHome, { recursive: true, force: true })
  writeLib(sessionLib('sess-old'), { old: { source: '(tools) => 1', doc: '' } })
  writeLib(sessionLib('sess-fresh'), { fresh: { source: '(tools) => 2', doc: '' } })
  const long = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
  fs.utimesSync(path.join(libHome, 'sessions', 'sess-old'), long, long)
  const { result } = await run(['console.log("@@ " + JSON.stringify({ ok: 1 }))'].join(NL), { sessionId: 'sess-fresh' })
  assert.equal(result.ok, 1)
  assert.equal(fs.existsSync(path.join(libHome, 'sessions', 'sess-old')), false, 'the stale session directory is gone')
  assert.equal(fs.existsSync(path.join(libHome, 'sessions', 'sess-fresh')), true, 'the live one stays')
  assert.equal(fs.existsSync(path.join(libHome, 'sessions', '.last-sweep')), true, 'the sweep stamps itself for a day')
})

test('the built hook embeds the runner this file exercised', () => {
  const built = fs.readFileSync(path.join(root, 'hooks/register.ts'), 'utf8')
  const m = new RegExp('const RUNNER = ("(?:[^"\\\\]|\\\\.)*")').exec(built)
  assert.ok(m, 'register.ts carries RUNNER')
  assert.equal(JSON.parse(m[1]), runner, 'hooks/register.ts embeds src/runner.js as is (run node build.cjs)')
  assert.match(built, /lib\.def/, 'the built hook carries lib.def')
  assert.match(built, /sessionId/, 'the built hook passes the session id to the runner')
})
