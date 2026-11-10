#!/usr/bin/env node
// Unified test entry: every mod's plugin tests, the plain node:test files the plugin test engine cannot run,
// the scripts' own tests, and finally the engine compatibility check.
//
//   node scripts/test-all.mjs                 # everything
//   node scripts/test-all.mjs ptc-run         # one mod (its plugin tests and its node:test files)
//   node scripts/test-all.mjs --no-compat     # skip the compatibility check at the end
//
// Plain node, built-in modules only. Every item is judged on its own output, not just its exit code:
// "claude plugin test" prints " N pass" / " N fail" (a missing pass line or a non-zero fail count is a failure);
// "node --test" is judged on its exit code and its pass/fail counters; the compat check passes on exit 0 and is
// shown as skipped (not failed) when it exits 2, i.e. when it cannot find a claude binary to inspect. Any
// failure exits 1.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT_MS = 900000

// Mods with bun-style .test.ts suites, in the order they are run.
const PLUGIN_MODS = ['away-autopilot', 'cache-keeper', 'cc-restart', 'ctx-mod', 'delegate', 'dispatch-gate', 'effort-auto', 'ptc-run']
// The same mods that also (or instead) have node:test files. read-dedup has only node:test files, so it is listed here
// alone: a "claude plugin test read-dedup" run would report cannot import "node:test" by design.
const NODE_TESTS = {
  'read-dedup': ['read-dedup/tests/dedup.test.ts', 'read-dedup/tests/dedup01.test.ts', 'read-dedup/tests/bash.test.ts'],
  'ptc-run': ['ptc-run/tests/broker.test.mjs', 'ptc-run/tests/readdedup.test.mjs'],
  delegate: [
    'delegate/tests/ask.test.mjs',
    'delegate/tests/keepalive.test.mjs',
    'delegate/tests/gpt-source.test.mjs',
    'delegate/tests/cpa-admin.test.mjs',
    'delegate/tests/run-delegate.test.mjs',
  ],
}
// Plain node:test files for the repo's own scripts; run only in the full run.
const SCRIPT_TESTS = ['scripts/prune-data.test.mjs']

const argv = process.argv.slice(2)
const noCompat = argv.includes('--no-compat')
const positional = argv.filter((a) => !a.startsWith('--'))
const unknownFlags = argv.filter((a) => a.startsWith('--') && a !== '--no-compat')
if (unknownFlags.length) {
  console.error('unknown option(s): ' + unknownFlags.join(' '))
  process.exit(2)
}
const only = positional[0]
const known = new Set([...PLUGIN_MODS, ...Object.keys(NODE_TESTS)])
if (positional.length > 1) {
  console.error('one mod at a time, please (got: ' + positional.join(' ') + ')')
  process.exit(2)
}
if (only && !known.has(only)) {
  console.error('unknown mod: ' + only + ' (known: ' + [...known].join(', ') + ')')
  process.exit(2)
}
const selected = (mod) => !only || only === mod

// "claude plugin test <mod>" — spawnSync with shell:true so Windows finds the claude.cmd shim.
const pluginItem = (mod) => {
  const started = Date.now()
  const r = spawnSync('claude plugin test ' + mod, [], { cwd: root, shell: true, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 << 20 })
  const text = String(r.stdout || '') + String(r.stderr || '')
  const failM = /^\s*(\d+)\s+fail\s*$/m.exec(text)
  const passM = /^\s*(\d+)\s+pass\s*$/m.exec(text)
  const fail = failM ? Number(failM[1]) : null
  const pass = passM ? Number(passM[1]) : null
  const ok = fail !== null && pass !== null && fail === 0
  const why = ok ? '' : fail === null || pass === null ? 'no " N pass" / " N fail" line in the output (exit ' + r.status + ')' : fail + ' failing'
  return { name: 'claude plugin test ' + mod, pass, fail, ms: Date.now() - started, ok, why }
}

// "node --test <file>" — the exit code is the verdict; the counters are only reported.
const nodeItem = (file) => {
  const started = Date.now()
  const r = spawnSync(process.execPath, ['--test', file], { cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 << 20 })
  const text = String(r.stdout || '') + String(r.stderr || '')
  const failM = /^\u2139\s+fail\s+(\d+)\s*$/m.exec(text)
  const passM = /^\u2139\s+pass\s+(\d+)\s*$/m.exec(text)
  const ok = r.status === 0
  return {
    name: 'node --test ' + file,
    pass: passM ? Number(passM[1]) : null,
    fail: failM ? Number(failM[1]) : null,
    ms: Date.now() - started,
    ok,
    why: ok ? '' : 'exit ' + (r.status === null ? String(r.signal || 'null') : r.status) + (r.error ? ' ' + r.error.message : ''),
  }
}

// The engine compatibility check: exit 0 passes, exit 1 is a failure, exit 2 means it could not run (skipped).
const compatItem = () => {
  const started = Date.now()
  const r = spawnSync(process.execPath, ['scripts/mod-compat-check.ts', '--quiet'], {
    cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 << 20,
  })
  const text = String(r.stdout || '') + String(r.stderr || '')
  const lines = text.split(/\r?\n/)
  const summary = (lines.find((l) => l.startsWith('summary:')) || '').trim()
  const missing = lines.filter((l) => /^\s+MISSING\s/.test(l)).map((l) => l.trim())
  if (r.status === 2) {
    const reason = lines.filter(Boolean).slice(-2).join(' ') || 'exit 2'
    return { name: 'compat (mod-compat-check)', pass: null, fail: null, ms: Date.now() - started, ok: true, skipped: true, why: 'cannot check: ' + reason }
  }
  const ok = r.status === 0
  return {
    name: 'compat (mod-compat-check)',
    pass: ok ? 1 : 0,
    fail: ok ? 0 : 1,
    ms: Date.now() - started,
    ok,
    skipped: false,
    why: ok ? '' : 'exit ' + r.status + (summary ? ' — ' + summary : ''),
    detail: ok ? '' : missing.join('\n'),
  }
}

const items = []
for (const mod of PLUGIN_MODS) if (selected(mod)) items.push(() => pluginItem(mod))
for (const [mod, files] of Object.entries(NODE_TESTS)) {
  if (!selected(mod)) continue
  for (const f of files) items.push(() => nodeItem(f))
}
if (!only) {
  for (const f of SCRIPT_TESTS) items.push(() => nodeItem(f))
  if (!noCompat) items.push(compatItem)
}

const results = []
for (const run of items) {
  const r = run()
  results.push(r)
  const state = r.skipped ? 'skip' : r.ok ? 'ok  ' : 'FAIL'
  const note = r.skipped ? ' — ' + r.why : r.ok ? '' : ' — ' + r.why
  console.log('[' + state + '] ' + r.name + ' (' + (r.ms / 1000).toFixed(1) + 's)' + note)
}

const fmt = (n) => (n === null ? '-' : String(n))
const width = Math.max(...results.map((r) => r.name.length), 4)
const line = '-'.repeat(width + 26)
console.log('')
console.log('name'.padEnd(width) + '  pass  fail   time')
console.log(line)
let totalPass = 0
let totalFail = 0
for (const r of results) {
  totalPass += r.pass || 0
  totalFail += r.fail || 0
  const state = r.skipped ? '  SKIP' : r.ok ? '' : '  FAIL'
  console.log('     ' + r.name.padEnd(width) + '  ' + fmt(r.pass).padStart(4) + '  ' + fmt(r.fail).padStart(4) + '  ' + (r.ms / 1000).toFixed(1) + 's' + state)
}
console.log(line)
const failed = results.filter((r) => !r.ok && !r.skipped)
const skipped = results.filter((r) => r.skipped)
console.log('     ' + (results.length + ' items').padEnd(width) + '  ' + String(totalPass).padStart(4) + '  ' + String(totalFail).padStart(4))
if (skipped.length) console.log('     (' + skipped.length + ' skipped: ' + skipped.map((r) => r.name).join(', ') + ')')
if (failed.length) {
  console.log('')
  console.log(failed.length + ' failed item(s):')
  for (const r of failed) {
    console.log('  - ' + r.name + ': ' + r.why)
    if (r.detail) console.log(r.detail.split('\n').map((l) => '      ' + l).join('\n'))
  }
  process.exit(1)
}
console.log('')
console.log('all green: ' + (results.length - skipped.length) + ' item(s)' + (skipped.length ? ', ' + skipped.length + ' skipped' : ''))
