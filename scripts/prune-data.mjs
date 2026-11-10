#!/usr/bin/env node
/**
 * prune-data.mjs -- delete stale data the mods leave behind, dry-run by default.
 *
 *   node scripts/prune-data.mjs                      # list what would go
 *   node scripts/prune-data.mjs --apply              # actually delete
 *   node scripts/prune-data.mjs --days 14 --tmp-hours 24
 *   node scripts/prune-data.mjs --only ctx-mod,tmp --json
 *
 * Options
 *   --days N          retention for ctx-mod / delegate / cache-keeper (default 30)
 *   --ctx-days N      override --days for ctx-mod only
 *   --delegate-days N override --days for delegate only
 *   --cache-days N    override --days for cache-keeper only
 *   --tmp-hours N     retention for os.tmpdir()/cc-ptc entries (default 48)
 *   --only LIST       comma list: ctx-mod,delegate,cache-keeper,tmp
 *   --apply           really delete (without it nothing is removed)
 *   --json            machine-readable report only
 *   N < 1 is refused.
 *
 * Rules (verified against each mod's README / writing code; file contents are never read, only names,
 * sizes and mtimes):
 *   ctx-mod       ~/.claude/ctx-mod/<GUID>/ whose newest file is older than the cutoff. Root files
 *                 (costly.json, probe-*.jsonl, ...) are never touched. Same rule as
 *                 ctx-mod/scripts/prune-sessions.ps1, but "last write" is the newest mtime of the files
 *                 inside, not the directory's own mtime.
 *   delegate      ~/.claude/delegate/jobs/<jobId>/ that is old, not running, and whose status.json says
 *                 the job ended; plus its own results/<jobId>.md. Anything else (keys, config, keepalive/,
 *                 venv/, usage ledgers, results of jobs we cannot identify) is never deleted and is
 *                 reported as "unidentified, skipped".
 *   cache-keeper  ~/.claude/cache-keeper/raw/events-*.jsonl and run-*.json older than the cutoff.
 *                 cache-events.csv, experiment-summary.json, cache-report.md and anything else stay.
 *   tmp           os.tmpdir()/cc-ptc entries whose newest mtime is older than --tmp-hours (ptc-run refs
 *                 live 24h), and os.tmpdir()/cc-ptc-locks entries older than 1 day.
 *
 * Safety: every data root is one of the expected directories (injectable for tests with PRUNE_HOME and
 * PRUNE_TMPDIR), a root that resolves outside its base is refused, every target must resolve inside its
 * root, links/junctions are never followed (an entry that is one, or a directory holding one, is skipped
 * and its target left alone), and a failing delete is recorded while the rest continue.
 *
 * Exit codes: 0 nothing failed, 1 at least one delete failed, 2 bad arguments / unsafe data root.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const LIST_LIMIT = 10
const LOCK_MAX_AGE_MS = DAY_MS

const fail = (msg) => {
  console.error('prune-data: ' + msg)
  process.exit(2)
}

const usage = () => {
  console.log('usage: node scripts/prune-data.mjs [--days N] [--ctx-days N] [--delegate-days N]')
  console.log('       [--cache-days N] [--tmp-hours N] [--only ctx-mod,delegate,cache-keeper,tmp]')
  console.log('       [--apply] [--json]')
}

const positive = (name, raw) => {
  if (raw === undefined) fail(name + ' needs a value')
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) fail(name + ' must be a number >= 1 (got ' + raw + ')')
  return n
}

const parseArgs = (argv) => {
  const o = { days: 30, ctxDays: null, delegateDays: null, cacheDays: null, tmpHours: 48, only: null, apply: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--days') o.days = positive('--days', argv[++i])
    else if (a === '--ctx-days') o.ctxDays = positive('--ctx-days', argv[++i])
    else if (a === '--delegate-days') o.delegateDays = positive('--delegate-days', argv[++i])
    else if (a === '--cache-days') o.cacheDays = positive('--cache-days', argv[++i])
    else if (a === '--tmp-hours') o.tmpHours = positive('--tmp-hours', argv[++i])
    else if (a === '--only') {
      const list = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)
      const known = new Set(['ctx-mod', 'delegate', 'cache-keeper', 'tmp'])
      for (const name of list) if (!known.has(name)) fail('unknown --only value: ' + name)
      o.only = list.length ? list : null
    } else if (a === '--apply') o.apply = true
    else if (a === '--json') o.json = true
    else if (a === '--help' || a === '-h') { usage(); process.exit(0) }
    else fail('unknown argument: ' + a)
  }
  return o
}

// ---------- paths ----------
const home = path.resolve(process.env.PRUNE_HOME || os.homedir())
const tmpBase = path.resolve(process.env.PRUNE_TMPDIR || os.tmpdir())
const claudeBase = path.join(home, '.claude')

const ROOTS = {
  'ctx-mod': { dir: path.join(claudeBase, 'ctx-mod'), base: claudeBase },
  delegate: { dir: path.join(claudeBase, 'delegate'), base: claudeBase },
  'cache-keeper': { dir: path.join(claudeBase, 'cache-keeper'), base: claudeBase },
  tmp: { dir: path.join(tmpBase, 'cc-ptc'), base: tmpBase },
}
const LOCKS = { dir: path.join(tmpBase, 'cc-ptc-locks'), base: tmpBase }

const isInside = (child, parent) => {
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

/** Refuse anything but the expected root, and a root that resolves outside its base area. */
const checkRoot = (name, spec) => {
  const dir = path.resolve(spec.dir)
  if (dir === home || dir === tmpBase || dir === claudeBase || dir === path.parse(dir).root) {
    fail('refusing to use ' + dir + ' as the ' + name + ' data root')
  }
  if (!fs.existsSync(dir)) return { name, dir, real: null, missing: true }
  let real
  try {
    real = fs.realpathSync.native(dir)
  } catch (e) {
    fail('cannot resolve the ' + name + ' data root ' + dir + ': ' + String(e.message || e))
  }
  let baseReal
  try {
    baseReal = fs.realpathSync.native(spec.base)
  } catch (e) {
    fail('cannot resolve ' + spec.base + ': ' + String(e.message || e))
  }
  if (!isInside(real, baseReal)) fail('refusing to prune ' + dir + ': it resolves outside ' + spec.base)
  return { name, dir, real, missing: false }
}

/** lstat-based walk: never follows links, counts them instead. */
const inspect = (target) => {
  let st
  try {
    st = fs.lstatSync(target)
  } catch {
    return { bytes: 0, newest: 0, links: 0, files: 0, error: true }
  }
  if (st.isSymbolicLink()) return { bytes: 0, newest: st.mtimeMs, links: 1, files: 0 }
  if (!st.isDirectory()) return { bytes: st.size, newest: st.mtimeMs, links: 0, files: 1 }
  let entries = []
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return { bytes: 0, newest: st.mtimeMs, links: 0, files: 0, error: true }
  }
  let bytes = 0, newest = st.mtimeMs, links = 0, files = 0
  for (const entry of entries) {
    const info = inspect(path.join(target, entry.name))
    bytes += info.bytes
    links += info.links
    files += info.files
    if (info.newest > newest) newest = info.newest
  }
  return { bytes, newest, links, files }
}

/** The path must exist, must not be a link, and must resolve inside the root. Returns a reason or ''. */
const unsafeReason = (target, rootReal) => {
  let st
  try {
    st = fs.lstatSync(target)
  } catch {
    return 'cannot stat'
  }
  if (st.isSymbolicLink()) return 'is a link or junction'
  let real
  try {
    real = fs.realpathSync.native(target)
  } catch {
    return 'cannot resolve the real path'
  }
  if (!isInside(real, rootReal)) return 'resolves outside the data root'
  return ''
}

const alive = (pid) => {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e && e.code === 'EPERM'
  }
}

// ---------- per-category scans ----------
const category = (name, root) => ({
  name,
  root: root.dir,
  missing: root.missing,
  candidates: [],
  skipped: [],
  protectedCount: 0,
})

const addSkipped = (cat, file, reason) => cat.skipped.push({ path: file, reason })
const addCandidate = (cat, target, kind, bytes, newest) => {
  cat.candidates.push({ path: target, kind, bytes, newest })
}

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const scanCtx = (root, cutoff) => {
  const cat = category('ctx-mod', root)
  if (root.missing) return cat
  let entries
  try {
    entries = fs.readdirSync(root.dir, { withFileTypes: true })
  } catch (e) {
    addSkipped(cat, root.dir, 'cannot read the data root: ' + String(e.message || e))
    return cat
  }
  for (const entry of entries) {
    const target = path.join(root.dir, entry.name)
    if (entry.isSymbolicLink()) {
      addSkipped(cat, target, 'is a link or junction')
      continue
    }
    if (!entry.isDirectory()) {
      cat.protectedCount++ // costly.json, probe-*.jsonl and friends
      continue
    }
    if (!GUID.test(entry.name)) {
      addSkipped(cat, target, 'not a GUID-named session directory')
      continue
    }
    const info = inspect(target)
    if (info.error) {
      addSkipped(cat, target, 'cannot read the session directory')
      continue
    }
    if (info.links > 0) {
      addSkipped(cat, target, 'holds a link or junction')
      continue
    }
    if (!(info.newest < cutoff)) continue // still fresh (or no mtime at all)
    const why = unsafeReason(target, root.real)
    if (why) {
      addSkipped(cat, target, why)
      continue
    }
    addCandidate(cat, target, 'dir', info.bytes, info.newest)
  }
  return cat
}

const FINISHED_PHASES = new Set(['done', 'failed', 'cancelled'])

/** true when the job may still be running (or its state cannot be trusted). */
const jobRunning = (status) => {
  const pids = [status.pid, status.childPid]
    .filter((p) => typeof p === 'number' && Number.isFinite(p) && p > 0)
  if (pids.some(alive)) return true
  const ended = typeof status.endedAt === 'number' && Number.isFinite(status.endedAt) && status.endedAt > 0
  const phase = typeof status.phase === 'string' ? status.phase : ''
  if (ended || FINISHED_PHASES.has(phase)) return false
  // No completion record: a recorded pid that is gone means the runner died (crashed); a status without
  // any pid says nothing at all, so that job is kept.
  return pids.length === 0
}

const readStatus = (file) => {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.size > (1 << 20)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const scanDelegate = (root, cutoff) => {
  const cat = category('delegate', root)
  if (root.missing) return cat
  const resultsRoot = path.join(root.dir, 'results')
  let jobsRoot = path.join(root.dir, 'jobs')
  const override = process.env.DELEGATE_JOBS_DIR
  if (override) {
    const resolved = path.resolve(override)
    if (!isInside(resolved, root.real)) {
      addSkipped(cat, resolved, 'DELEGATE_JOBS_DIR points outside the data root, jobs left alone')
      jobsRoot = null
    } else {
      jobsRoot = resolved
    }
  }
  const pairedResults = new Set()
  if (jobsRoot) {
    let jobs = []
    try {
      jobs = fs.readdirSync(jobsRoot, { withFileTypes: true })
    } catch (e) {
      addSkipped(cat, jobsRoot, 'cannot read jobs/: ' + String(e.message || e))
    }
    for (const entry of jobs) {
      const target = path.join(jobsRoot, entry.name)
      const id = entry.name
      if (entry.isSymbolicLink()) {
        addSkipped(cat, target, 'is a link or junction')
        continue
      }
      if (!entry.isDirectory()) {
        addSkipped(cat, target, 'file in jobs/, not a job directory')
        continue
      }
      const info = inspect(target)
      if (info.error) {
        addSkipped(cat, target, 'cannot read the job directory')
        continue
      }
      if (info.links > 0) {
        addSkipped(cat, target, 'holds a link or junction')
        continue
      }
      if (!(info.newest < cutoff)) continue // recent: not due yet
      const status = readStatus(path.join(target, 'status.json'))
      if (status === null || typeof status !== 'object') {
        addSkipped(cat, target, 'no readable status.json, job state unknown')
        continue
      }
      if (jobRunning(status)) {
        addSkipped(cat, target, 'job may be running')
        continue
      }
      const why = unsafeReason(target, root.real)
      if (why) {
        addSkipped(cat, target, why)
        continue
      }
      addCandidate(cat, target, 'dir', info.bytes, info.newest)
      const result = path.join(resultsRoot, id + '.md')
      try {
        if (fs.lstatSync(result).isFile()) {
          const rinfo = inspect(result)
          const rwhy = unsafeReason(result, root.real)
          if (rwhy) addSkipped(cat, result, rwhy)
          else {
            addCandidate(cat, result, 'file', rinfo.bytes, rinfo.newest)
            pairedResults.add(result)
          }
        }
      } catch {
        // no result file for this job: nothing else to remove
      }
    }
  }
  let results = []
  try {
    results = fs.readdirSync(resultsRoot, { withFileTypes: true })
  } catch {
    // no results/ directory
  }
  for (const entry of results) {
    const target = path.join(resultsRoot, entry.name)
    if (pairedResults.has(target)) continue
    addSkipped(cat, target, 'result has no prunable job of its own')
  }
  for (const entry of fs.readdirSync(root.dir, { withFileTypes: true })) {
    if (entry.name === 'jobs' || entry.name === 'results') continue
    cat.protectedCount++ // keys, config, keepalive/, venv/, logs, usage ledgers
  }
  return cat
}

const scanCache = (root, cutoff) => {
  const cat = category('cache-keeper', root)
  if (root.missing) return cat
  const raw = path.join(root.dir, 'raw')
  let entries = []
  try {
    entries = fs.readdirSync(raw, { withFileTypes: true })
  } catch {
    addSkipped(cat, raw, 'no raw/ directory to prune')
    return cat
  }
  const wanted = (name) => /^events-.+\.jsonl$/.test(name) || /^run-.+\.json$/.test(name)
  for (const entry of entries) {
    const target = path.join(raw, entry.name)
    if (entry.isSymbolicLink()) {
      addSkipped(cat, target, 'is a link or junction')
      continue
    }
    if (!entry.isFile() || !wanted(entry.name)) {
      addSkipped(cat, target, 'not a raw events-/run- file')
      continue
    }
    const info = inspect(target)
    if (!(info.newest < cutoff)) continue
    const why = unsafeReason(target, root.real)
    if (why) {
      addSkipped(cat, target, why)
      continue
    }
    addCandidate(cat, target, 'file', info.bytes, info.newest)
  }
  for (const entry of fs.readdirSync(root.dir, { withFileTypes: true })) {
    if (entry.name === 'raw') continue
    cat.protectedCount++ // cache-events.csv, experiment-summary.json, cache-report.md, ...
  }
  return cat
}

const scanTmp = (root, locks, hours) => {
  const cutoff = Date.now() - hours * HOUR_MS
  const cat = category('tmp', root)
  if (!root.missing) {
    let entries = []
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true })
    } catch (e) {
      addSkipped(cat, root.dir, 'cannot read cc-ptc: ' + String(e.message || e))
    }
    for (const entry of entries) {
      const target = path.join(root.dir, entry.name)
      if (entry.isSymbolicLink()) {
        addSkipped(cat, target, 'is a link or junction')
        continue
      }
      const info = inspect(target)
      if (info.error) {
        addSkipped(cat, target, 'cannot read the entry')
        continue
      }
      if (info.links > 0) {
        addSkipped(cat, target, 'holds a link or junction')
        continue
      }
      if (!(info.newest < cutoff)) continue
      const why = unsafeReason(target, root.real)
      if (why) {
        addSkipped(cat, target, why)
        continue
      }
      addCandidate(cat, target, entry.isDirectory() ? 'dir' : 'file', info.bytes, info.newest)
    }
  }
  if (!locks.missing) {
    const lockCutoff = Date.now() - LOCK_MAX_AGE_MS
    let entries = []
    try {
      entries = fs.readdirSync(locks.dir, { withFileTypes: true })
    } catch (e) {
      addSkipped(cat, locks.dir, 'cannot read cc-ptc-locks: ' + String(e.message || e))
    }
    for (const entry of entries) {
      const target = path.join(locks.dir, entry.name)
      if (entry.isSymbolicLink()) {
        addSkipped(cat, target, 'is a link or junction')
        continue
      }
      const info = inspect(target)
      if (info.links > 0) {
        addSkipped(cat, target, 'holds a link or junction')
        continue
      }
      if (!(info.newest < lockCutoff)) continue
      const why = unsafeReason(target, locks.real)
      if (why) {
        addSkipped(cat, target, why)
        continue
      }
      addCandidate(cat, target, entry.isDirectory() ? 'dir' : 'file', info.bytes, info.newest)
    }
  }
  return cat
}

// ---------- apply ----------
const failures = []

const applyCategory = (cat) => {
  const deleted = []
  for (const item of cat.candidates) {
    try {
      fs.rmSync(item.path, { recursive: item.kind === 'dir', force: false, maxRetries: 2 })
      deleted.push(item)
    } catch (e) {
      failures.push({ path: item.path, error: String((e && e.message) || e) })
    }
  }
  return deleted
}

// ---------- output ----------
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1)
const when = (ms) => (ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '?')

const printHuman = (cats, opts, deletedByCat) => {
  console.log('prune-data  ' + (opts.apply ? 'APPLY' : 'dry-run') + '  ' + new Date().toISOString().slice(0, 19) + 'Z')
  console.log('retention: ctx-mod ' + (opts.ctxDays ?? opts.days) + 'd, delegate ' +
              (opts.delegateDays ?? opts.days) + 'd, cache-keeper ' + (opts.cacheDays ?? opts.days) +
              'd, cc-ptc ' + opts.tmpHours + 'h, cc-ptc-locks 24h')
  let totalItems = 0
  let totalBytes = 0
  let totalSkipped = 0
  let totalDeleted = 0
  for (const cat of cats) {
    const bytes = cat.candidates.reduce((sum, c) => sum + c.bytes, 0)
    totalItems += cat.candidates.length
    totalBytes += bytes
    totalSkipped += cat.skipped.length
    if (deletedByCat) totalDeleted += deletedByCat.get(cat.name) || 0
    console.log('')
    console.log(cat.name + '  (' + cat.root + ')')
    if (cat.missing) {
      console.log('  data root does not exist, nothing to do')
      continue
    }
    console.log('  ' + (opts.apply ? 'deleted ' : 'would delete ') + cat.candidates.length +
                ' item(s), ' + mb(bytes) + ' MB; skipped ' + cat.skipped.length +
                (cat.protectedCount ? '; protected ' + cat.protectedCount + ' entry(ies) not considered' : ''))
    for (const item of cat.candidates.slice(0, LIST_LIMIT)) {
      console.log('    - ' + item.path + '  (' + item.kind + ', ' + mb(item.bytes) + ' MB, newest ' + when(item.newest) + ')')
    }
    if (cat.candidates.length > LIST_LIMIT) console.log('    ... and ' + (cat.candidates.length - LIST_LIMIT) + ' more')
    const shown = cat.skipped.slice(0, LIST_LIMIT)
    for (const item of shown) console.log('    skipped: ' + item.path + '  (' + item.reason + ')')
    if (cat.skipped.length > shown.length) console.log('    ... and ' + (cat.skipped.length - shown.length) + ' more skipped')
  }
  console.log('')
  if (opts.apply) console.log('deleted ' + totalDeleted + ' of ' + totalItems + ' item(s), ' + mb(totalBytes) + ' MB total')
  else console.log('total: ' + totalItems + ' item(s), ' + mb(totalBytes) + ' MB would be deleted; ' +
                   totalSkipped + ' skipped (unidentified / running / links / protected)')
  if (opts.apply && !opts.json) {
    if (failures.length === 0) console.log('no failures')
    else {
      console.log(failures.length + ' delete(s) failed:')
      for (const f of failures) console.log('  - ' + f.path + ': ' + f.error)
    }
  }
  if (!opts.apply) console.log('dry-run: nothing was deleted. Add --apply to delete.')
}

const main = () => {
  const opts = parseArgs(process.argv.slice(2))
  const selected = (name) => !opts.only || opts.only.includes(name)
  const now = Date.now()
  const cats = []
  if (selected('ctx-mod')) {
    const root = checkRoot('ctx-mod', ROOTS['ctx-mod'])
    cats.push(scanCtx(root, now - (opts.ctxDays ?? opts.days) * DAY_MS))
  }
  if (selected('delegate')) {
    const root = checkRoot('delegate', ROOTS.delegate)
    cats.push(scanDelegate(root, now - (opts.delegateDays ?? opts.days) * DAY_MS))
  }
  if (selected('cache-keeper')) {
    const root = checkRoot('cache-keeper', ROOTS['cache-keeper'])
    cats.push(scanCache(root, now - (opts.cacheDays ?? opts.days) * DAY_MS))
  }
  if (selected('tmp')) {
    const root = checkRoot('tmp', ROOTS.tmp)
    const locks = checkRoot('cc-ptc-locks', LOCKS)
    cats.push(scanTmp(root, locks, opts.tmpHours))
  }

  let deletedByCat = null
  if (opts.apply) {
    deletedByCat = new Map()
    for (const cat of cats) deletedByCat.set(cat.name, applyCategory(cat).length)
  }

  if (opts.json) {
    const report = {
      generatedAt: new Date().toISOString(),
      dryRun: !opts.apply,
      retention: {
        days: opts.days,
        ctxDays: opts.ctxDays ?? opts.days,
        delegateDays: opts.delegateDays ?? opts.days,
        cacheDays: opts.cacheDays ?? opts.days,
        tmpHours: opts.tmpHours,
        lockHours: 24,
      },
      categories: cats.map((cat) => ({
        name: cat.name,
        root: cat.root,
        missing: !!cat.missing,
        wouldDelete: cat.candidates.length,
        bytes: cat.candidates.reduce((sum, c) => sum + c.bytes, 0),
        deleted: deletedByCat ? deletedByCat.get(cat.name) || 0 : 0,
        candidates: cat.candidates,
        skipped: cat.skipped,
        protectedEntries: cat.protectedCount,
      })),
      failures,
    }
    console.log(JSON.stringify(report, null, 1))
  } else {
    printHuman(cats, opts, deletedByCat)
  }

  if (opts.apply && failures.length > 0) process.exit(1)
}

main()
