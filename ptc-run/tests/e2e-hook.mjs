// End-to-end smoke: PTC_RUN_READ_ROOTS, exactly as delegate's runner sets it, against the built hook's own broker and
// runner — reading a file outside the cwd, grepping there, and being refused outside it.
//   PTC_RUN_READ_ROOTS="C:/tmp/ext;D:/other" node tests/e2e-hook.mjs
// Without PTC_RUN_READ_ROOTS it only checks the refusal side (cwd stays readable).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const built = fs.readFileSync(path.join(root, 'hooks/register.ts'), 'utf8')
const grab = (name) => {
  const m = new RegExp('const ' + name + ' = ("(?:[^"\\\\]|\\\\.)*")').exec(built)
  if (!m) throw new Error('no ' + name)
  return JSON.parse(m[1])
}
const BOOT = (() => {
  const m = /^const BOOT = (.*)$/m.exec(built)
  if (!m) throw new Error('no BOOT')
  // it is built from string literals joined with +, so evaluate just that expression
  return Function('return ' + m[1])()
})()
const BROKER = grab('BROKER')
const RUNNER = grab('RUNNER')
const RG = grab('RG')

// The hook's own splitter, lifted from the built file (its types stripped) so this smoke parses the variable the same way.
const splitReadRoots = (() => {
  const start = built.indexOf('const splitReadRoots')
  if (start < 0) throw new Error('no splitReadRoots in the built hook')
  const body = built.slice(start + 'const '.length, built.indexOf('\n}', start) + 2)
  const plain = body.replace('(raw: string): string[]', '(raw)').replace('const parts: string[] = []', 'const parts = []')
  return Function(plain + '; return splitReadRoots')()
})()

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-e2e-'))
const cwd = path.join(work, 'cwd')
// When PTC_RUN_READ_ROOTS names a directory, that one is the extra root under test (created if missing).
const fromEnvEarly = splitReadRoots(process.env.PTC_RUN_READ_ROOTS || '')
const extra = fromEnvEarly.length > 0 ? path.resolve(fromEnvEarly[0]) : path.join(work, 'extra')
const outside = path.join(work, 'outside')
for (const d of [cwd, extra, outside]) fs.mkdirSync(d, { recursive: true })
if (fromEnvEarly.length === 0) fs.writeFileSync(path.join(extra, 'extra.txt'), 'E2E-EXTRA hello')
fs.writeFileSync(path.join(extra, 'extra.txt'), 'E2E-EXTRA hello')
fs.writeFileSync(path.join(outside, 'outside.txt'), 'E2E-OUTSIDE hello')

const code = [
  'const J = ' + JSON.stringify({ extra, outside }),
  'const out = {}',
  'try { out.extraRead = String(await tools.read({ path: J.extra + "/extra.txt" })).trim() } catch (e) { out.extraRead = "ERR " + (e.code || "") }',
  'try { out.extraGrep = (await tools.grep({ pattern: "E2E-EXTRA", path: J.extra })).items.length } catch (e) { out.extraGrep = "ERR " + (e.code || "") }',
  'try { await tools.read({ path: J.outside + "/outside.txt" }); out.outsideRead = "ALLOWED" } catch (e) { out.outsideRead = e.code || "ERR" }',
  'console.log(JSON.stringify(out))',
].join('\n')

const run = (readRoots) => new Promise((resolve) => {
  const input = { cwd, code, rg: RG, scope: 'e2e-readroots', dsh: false, readRoots, logName: 'e2e-' + Date.now().toString(36), timeoutMs: 120000, boot: BOOT, runner: RUNNER }
  const child = spawn(process.execPath, ['-e', BOOT], { cwd, windowsHide: true })
  let out = ''
  let err = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.on('close', (c) => resolve({ c, out, err }))
  child.stdin.end(JSON.stringify(input) + '\n' + BROKER)
})

const fromEnv = fromEnvEarly
const withRoots = await run(fromEnv.length > 0 ? fromEnv : [extra])
const without = await run([])
const parse = (r) => { try { return JSON.parse(r.out.trim().split('\n').filter(Boolean).at(-1)) } catch { return null } }
const a = parse(withRoots)
const b = parse(without)
const ok = a && b
  && a.extraRead === 'E2E-EXTRA hello'
  && a.extraGrep === 1
  && a.outsideRead === 'POLICY_DENIED'
  && /POLICY_DENIED/.test(String(b.extraRead))
  && b.outsideRead === 'POLICY_DENIED'
console.log(JSON.stringify({ readRootsFromEnv: fromEnv, withRoots: a, withoutRoots: b, pass: !!ok }, null, 1))
if (withRoots.err) console.log('[stderr] ' + withRoots.err.slice(0, 400))
process.exit(ok ? 0 : 1)