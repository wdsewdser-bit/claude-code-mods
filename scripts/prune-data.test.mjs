// Tests for scripts/prune-data.mjs. Every test builds a throwaway data tree under os.tmpdir() and points
// the script at it with PRUNE_HOME / PRUNE_TMPDIR, so the real ~/.claude data is never touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(here, 'prune-data.mjs')
const DAY = 24 * 60 * 60 * 1000
const OLD_DAYS = 90

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const touchOld = (target, days = OLD_DAYS) => {
  const t = new Date(Date.now() - days * DAY)
  fs.utimesSync(target, t, t)
}

const oldTree = (dir, days = OLD_DAYS) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) oldTree(p, days)
    else touchOld(p, days)
  }
  touchOld(dir, days)
}

const GUID_OLD = '11111111-1111-4111-8111-111111111111'
const GUID_NEW = '22222222-2222-4222-8222-222222222222'

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-data-test-'))
  const home = path.join(base, 'home')
  const tmp = path.join(base, 'tmp')
  const claude = path.join(home, '.claude')
  const roots = {
    ctx: path.join(claude, 'ctx-mod'),
    delegate: path.join(claude, 'delegate'),
    cache: path.join(claude, 'cache-keeper'),
    ccptc: path.join(tmp, 'cc-ptc'),
    locks: path.join(tmp, 'cc-ptc-locks'),
  }
  for (const dir of Object.values(roots)) fs.mkdirSync(dir, { recursive: true })

  // ctx-mod: one old session dir, one fresh, and root files that must never move.
  const ctxOld = path.join(roots.ctx, GUID_OLD)
  write(path.join(ctxOld, 'session.jsonl'), 'old session')
  write(path.join(ctxOld, 'sub', 'note.txt'), 'old note')
  oldTree(ctxOld)
  const ctxNew = path.join(roots.ctx, GUID_NEW)
  write(path.join(ctxNew, 'session.jsonl'), 'new session')
  write(path.join(roots.ctx, 'costly.json'), '{}')
  write(path.join(roots.ctx, 'probe-1.jsonl'), '{}')

  // delegate: finished old job (+ its result), crashed old job, a live one, an unknown one.
  const jobs = path.join(roots.delegate, 'jobs')
  const results = path.join(roots.delegate, 'results')
  fs.mkdirSync(jobs, { recursive: true })
  fs.mkdirSync(results, { recursive: true })
  const jobOld = path.join(jobs, 'bg-old')
  write(path.join(jobOld, 'status.json'), JSON.stringify({ jobId: 'bg-old', phase: 'done', endedAt: Date.now() - 10 * DAY }))
  write(path.join(jobOld, 'events.jsonl'), 'events')
  oldTree(jobOld)
  write(path.join(results, 'bg-old.md'), 'old result')
  const jobCrashed = path.join(jobs, 'bg-crashed')
  write(path.join(jobCrashed, 'status.json'), JSON.stringify({ jobId: 'bg-crashed', pid: 999999, phase: 'working' }))
  oldTree(jobCrashed)
  const jobRunning = path.join(jobs, 'bg-running')
  write(path.join(jobRunning, 'status.json'), JSON.stringify({ jobId: 'bg-running', pid: process.pid, phase: 'working' }))
  oldTree(jobRunning)
  const jobUnknown = path.join(jobs, 'bg-nopid')
  write(path.join(jobUnknown, 'status.json'), JSON.stringify({ jobId: 'bg-nopid', phase: 'working' }))
  oldTree(jobUnknown)
  write(path.join(results, 'bg-unpaired.md'), 'nobody to pair with')
  write(path.join(roots.delegate, 'cpa-mgmt.key'), 'secret-ish')
  write(path.join(roots.delegate, 'usage-daily.json'), '{}')

  // cache-keeper: raw/ has prunable and protected files; the top level stays.
  const raw = path.join(roots.cache, 'raw')
  fs.mkdirSync(raw, { recursive: true })
  write(path.join(raw, 'events-session-0.jsonl'), 'events')
  touchOld(path.join(raw, 'events-session-0.jsonl'))
  write(path.join(raw, 'run-cell-5m-r1-abc.json'), '{}')
  touchOld(path.join(raw, 'run-cell-5m-r1-abc.json'))
  write(path.join(raw, 'events-fresh-0.jsonl'), 'events')
  write(path.join(raw, 'cli-old.log'), 'log')
  touchOld(path.join(raw, 'cli-old.log'))
  write(path.join(roots.cache, 'cache-events.csv'), 'a,b')

  // tmp: cc-ptc entries by age, and one stale + one fresh lock.
  const tmpOld = path.join(roots.ccptc, 'old-session')
  write(path.join(tmpOld, 'ref.json'), 'x')
  oldTree(tmpOld)
  const tmpNew = path.join(roots.ccptc, 'new-session')
  write(path.join(tmpNew, 'ref.json'), 'x')
  write(path.join(roots.locks, 'old.lock'), 'x')
  touchOld(path.join(roots.locks, 'old.lock'), 3)
  write(path.join(roots.locks, 'new.lock'), 'x')

  return { base, home, tmp, roots, ctxOld, ctxNew, jobs, results, jobOld, jobCrashed, jobRunning, jobUnknown, raw, tmpOld, tmpNew }
}

const envFor = (f) => {
  const env = { ...process.env, PRUNE_HOME: f.home, PRUNE_TMPDIR: f.tmp }
  delete env.DELEGATE_JOBS_DIR
  return env
}

const run = (f, args, homeOverride) => spawnSync(process.execPath, [SCRIPT, ...args], {
  env: homeOverride ? { ...envFor(f), ...homeOverride } : envFor(f),
  encoding: 'utf8',
  timeout: 120000,
})

const exists = (p) => fs.existsSync(p)

test('dry-run lists what it would delete and deletes nothing', (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }))
  const r = run(f, [])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /dry-run: nothing was deleted/)
  assert.match(r.stdout, /ctx-mod/)
  assert.match(r.stdout, /delegate/)
  assert.match(r.stdout, /cache-keeper/)
  assert.match(r.stdout, /cc-ptc/)
  for (const p of [f.ctxOld, f.jobOld, path.join(f.results, 'bg-old.md'), path.join(f.raw, 'events-session-0.jsonl'),
    f.tmpOld, path.join(f.roots.locks, 'old.lock'), f.ctxNew]) {
    assert.ok(exists(p), 'dry-run must not delete ' + p)
  }
})

test('apply deletes only the stale, finished, unprotected entries', (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }))
  const r = run(f, ['--apply'])
  assert.equal(r.status, 0, r.stdout + r.stderr)

  // ctx-mod: the old GUID dir goes, the fresh one and the root files stay.
  assert.equal(exists(f.ctxOld), false)
  assert.equal(exists(f.ctxNew), true)
  assert.equal(exists(path.join(f.roots.ctx, 'costly.json')), true)
  assert.equal(exists(path.join(f.roots.ctx, 'probe-1.jsonl')), true)

  // delegate: finished old job and its result go; running/unknown jobs, keys and ledgers stay.
  assert.equal(exists(f.jobOld), false)
  assert.equal(exists(path.join(f.results, 'bg-old.md')), false)
  assert.equal(exists(f.jobCrashed), false)
  assert.equal(exists(f.jobRunning), true)
  assert.equal(exists(f.jobUnknown), true)
  assert.equal(exists(path.join(f.results, 'bg-unpaired.md')), true)
  assert.equal(exists(path.join(f.roots.delegate, 'cpa-mgmt.key')), true)
  assert.equal(exists(path.join(f.roots.delegate, 'usage-daily.json')), true)

  // cache-keeper: raw events-/run- old files go; the fresh one, a foreign log and the csv stay.
  assert.equal(exists(path.join(f.raw, 'events-session-0.jsonl')), false)
  assert.equal(exists(path.join(f.raw, 'run-cell-5m-r1-abc.json')), false)
  assert.equal(exists(path.join(f.raw, 'events-fresh-0.jsonl')), true)
  assert.equal(exists(path.join(f.raw, 'cli-old.log')), true)
  assert.equal(exists(path.join(f.roots.cache, 'cache-events.csv')), true)

  // tmp: the old entry and the stale lock go, the fresh ones stay.
  assert.equal(exists(f.tmpOld), false)
  assert.equal(exists(f.tmpNew), true)
  assert.equal(exists(path.join(f.roots.locks, 'old.lock')), false)
  assert.equal(exists(path.join(f.roots.locks, 'new.lock')), true)
})

test('links and junctions are skipped, never followed', (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }))
  const outside = path.join(f.base, 'outside')
  write(path.join(outside, 'keep.txt'), 'outside data')
  oldTree(outside)
  const link = path.join(f.roots.ctx, '33333333-3333-4333-8333-333333333333')
  try {
    fs.symlinkSync(outside, link, 'junction')
  } catch (e) {
    t.skip('cannot create a junction here: ' + e.message)
    return
  }
  const r = run(f, ['--only', 'ctx-mod', '--apply'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(exists(path.join(outside, 'keep.txt')), true, 'the link target must survive')
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the junction itself is left alone')
  assert.match(r.stdout, /link or junction/)
})

test('a data root that resolves outside its base is refused', (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }))
  const outside = path.join(f.base, 'elsewhere')
  fs.mkdirSync(outside, { recursive: true })
  const link = path.join(f.home, '.claude', 'ctx-mod')
  fs.rmSync(link, { recursive: true, force: true })
  try {
    fs.symlinkSync(outside, link, 'junction')
  } catch (e) {
    t.skip('cannot create a junction here: ' + e.message)
    return
  }
  const r = run(f, ['--only', 'ctx-mod', '--apply'])
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /refusing to prune/)
})

test('retention and selector arguments are validated', (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }))
  for (const args of [['--days', '0'], ['--ctx-days', '-1'], ['--tmp-hours', '0'], ['--only', 'nope'], ['--bogus']]) {
    const r = run(f, args)
    assert.equal(r.status, 2, args.join(' ') + ' should be refused')
  }
})

test('--json reports the same plan', (t) => {
  const f = fixture()
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }))
  const r = run(f, ['--json'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const report = JSON.parse(r.stdout)
  assert.equal(report.dryRun, true)
  const byName = new Map(report.categories.map((c) => [c.name, c]))
  assert.deepEqual([...byName.keys()], ['ctx-mod', 'delegate', 'cache-keeper', 'tmp'])
  const paths = (name) => byName.get(name).candidates.map((c) => c.path)
  assert.deepEqual(paths('ctx-mod'), [f.ctxOld])
  assert.ok(paths('delegate').includes(f.jobOld))
  assert.ok(paths('delegate').includes(path.join(f.results, 'bg-old.md')))
  assert.ok(!paths('delegate').includes(f.jobRunning))
  assert.deepEqual(paths('cache-keeper').sort(), [
    path.join(f.raw, 'events-session-0.jsonl'), path.join(f.raw, 'run-cell-5m-r1-abc.json'),
  ].sort())
  assert.ok(paths('tmp').includes(f.tmpOld))
  for (const p of paths('ctx-mod').concat(paths('delegate'))) assert.ok(exists(p), 'json is still a dry-run')
})
