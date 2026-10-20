// @ts-nocheck
// Segment-granularity benchmark: write cost and read cost of K records per segment,
// against the pre-append implementation as a baseline.
//   node tests/bench-segments.ts
// Data goes to a throwaway directory and is removed afterwards; only history files
// count, meta.json does not.
import { promises as fs } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { DEFAULTS } from '../hooks/lib/types.ts'
import { byteLength } from '../hooks/lib/history.ts'

const NEW = new URL('../hooks/lib/session.ts', import.meta.url).href
const OLD = 'file:///D:/ptcab/scratch/batchB/ctx-mod.pre/hooks/lib/session.ts'
const ROOT = 'C:/Users/yadaz/AppData/Local/Temp/claude/ctx-bench/segments'
const OUT = 'D:/ptcab/scratch/batchB/bench-segments.json'

/** Deterministic sizes shaped like a real session: mostly small, a few very large. */
const mulberry32 = seed => () => {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const sizesFor = records => {
  const rnd = mulberry32(20261019 + records)
  const sizes = []
  for (let index = 0; index < records; index += 1) {
    const draw = rnd()
    let length
    if (draw < 0.45) length = 200 + Math.floor(rnd() * 400)
    else if (draw < 0.75) length = 1_000 + Math.floor(rnd() * 2_000)
    else if (draw < 0.9) length = 5_000 + Math.floor(rnd() * 5_000)
    else if (draw < 0.98) length = 15_000 + Math.floor(rnd() * 15_000)
    else length = 50_000 + Math.floor(rnd() * 50_000)
    sizes.push(length)
  }
  return sizes
}

const textOf = (length, seq) => {
  const head = `MARK${seq} `
  return head + 'x'.repeat(Math.max(0, length - head.length))
}

const isHistory = path => {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return name.startsWith('history-') && (name.endsWith('.jsonl') || name.endsWith('.manifest.json'))
}

const nameOf = path => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

const makeIo = () => {
  let physical = 0
  let writeCalls = 0
  const io = {
    read: async path => await fs.readFile(path, 'utf8'),
    write: async (path, text) => {
      await fs.writeFile(path, text, 'utf8')
      if (!isHistory(path)) return
      physical += byteLength(text)
      writeCalls += 1
    },
    now: () => Date.now(),
    list: async path => await fs.readdir(path),
    exists: async path => {
      try { await fs.access(path); return true } catch { return false }
    },
    remove: async path => { await fs.rm(path, { force: true }) },
  }
  return { io, stats: () => ({ physical, writeCalls }) }
}

const percentile = (values, share) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * share))]
}

const time = async action => {
  const started = performance.now()
  await action()
  return performance.now() - started
}

const run = async ({ label, records, k, b, rhythm, batchSize, modulePath }) => {
  const dir = `${ROOT}/${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await fs.mkdir(dir, { recursive: true })
  const { createSession } = await import(modulePath)
  const config = k === null ? DEFAULTS : { ...DEFAULTS, segmentRecords: k, segmentBytes: b }
  const { io, stats } = makeIo()
  const session = createSession(dir, io, config)
  const sizes = sizesFor(records)

  let logical = 0
  const writeStarted = performance.now()
  for (let seq = 1; seq <= records; seq += 1) {
    const row = await session.record({
      uuid: `bench-${seq}`,
      role: seq % 3 === 0 ? 'assistant' : 'tool',
      tool: 'Bash',
      path: '/tmp/example.txt',
      text: textOf(sizes[seq - 1], seq),
    })
    logical += byteLength(JSON.stringify(row)) + 1
    if (rhythm === 'immediate') await session.flush()
    else if (rhythm === 'batch' && seq % batchSize === 0) await session.flush()
  }
  await session.flush()
  const writeMs = performance.now() - writeStarted
  const measured = stats()

  const names = await fs.readdir(dir)
  const segmentFiles = names.filter(name => name.startsWith('history-') && name.endsWith('.jsonl'))
  let diskBytes = 0
  for (const name of segmentFiles) diskBytes += (await fs.stat(`${dir}/${name}`)).size

  // Cold start: a new session on the same files, timed until it is loaded and idle.
  const coldSession = createSession(dir, makeIo().io, config)
  const coldMs = await time(() => coldSession.flush())

  // Search and single-row reads on the cold session: these are the read paths a
  // user hits, not the loader.
  const step = Math.max(1, Math.floor(records / 30))
  const sample = []
  for (let seq = 1; seq <= records; seq += step) sample.push(seq)
  const hitMs = []
  for (const seq of sample) hitMs.push(await time(() => coldSession.historyTool({ action: 'search', query: `MARK${seq}` })))
  const missMs = []
  for (let index = 0; index < sample.length; index += 1) {
    missMs.push(await time(() => coldSession.historyTool({ action: 'search', query: `ZZNOPE${index}` })))
  }
  const readMs = []
  for (const seq of sample) readMs.push(await time(() => coldSession.historyTool({ action: 'read', seq })))

  // Recovery: meta.json lost, so the loader has to rediscover the seq and files.
  await fs.rm(`${dir}/meta.json`, { force: true })
  const recovered = createSession(dir, makeIo().io, config)
  const recoveryMs = await time(() => recovered.flush())
  const recoveredTop = await recovered.historyTool({ action: 'read', seq: records })

  const result = {
    label,
    records,
    k,
    bytesCap: b,
    rhythm,
    logicalNewBytes: logical,
    physicalBytesWritten: measured.physical,
    waf: Number((measured.physical / logical).toFixed(2)),
    writeCalls: measured.writeCalls,
    segmentFiles: segmentFiles.length,
    diskBytes,
    writeMs: Number(writeMs.toFixed(1)),
    coldLoadMs: Number(coldMs.toFixed(1)),
    recoveryLoadMs: Number(recoveryMs.toFixed(1)),
    searchHitP50: Number(percentile(hitMs, 0.5).toFixed(2)),
    searchHitP95: Number(percentile(hitMs, 0.95).toFixed(2)),
    searchMissP50: Number(percentile(missMs, 0.5).toFixed(2)),
    searchMissP95: Number(percentile(missMs, 0.95).toFixed(2)),
    readP50: Number(percentile(readMs, 0.5).toFixed(2)),
    readP95: Number(percentile(readMs, 0.95).toFixed(2)),
    recoveryReadsTop: recoveredTop.isError !== true,
    sessionLine: session.historyWriteStats(),
  }
  await fs.rm(dir, { recursive: true, force: true })
  return result
}

const K = 64 * 1024 * 1024
const plans = []
for (const records of [470, 5000]) {
  // The old implementation rewrites the whole shard per record; at 5000 that is
  // tens of gigabytes, so its baseline there is the 50-record batch it was meant for.
  plans.push({
    label: `old-${records}`,
    records,
    k: null,
    b: null,
    rhythm: records === 470 ? 'immediate' : 'batch',
    batchSize: 50,
    modulePath: OLD,
  })
  for (const k of [1, 8, 32, 128]) {
    plans.push({ label: `k${k}-${records}`, records, k, b: K, rhythm: 'immediate', batchSize: 0, modulePath: NEW })
  }
  // The proposed default, byte cap included.
  plans.push({ label: `default-${records}`, records, k: 8, b: 1024 * 1024, rhythm: 'immediate', batchSize: 0, modulePath: NEW })
}

const results = []
for (const plan of plans) {
  const one = await run(plan)
  results.push(one)
  console.log(
    `${one.label.padEnd(13)} WAF=${String(one.waf).padEnd(6)} files=${String(one.segmentFiles).padEnd(5)} physical=${String(one.physicalBytesWritten).padEnd(11)} write=${String(one.writeMs).padEnd(8)}ms cold=${String(one.coldLoadMs).padEnd(7)}ms recovery=${String(one.recoveryLoadMs).padEnd(7)}ms hit=${one.searchHitP50}/${one.searchHitP95} miss=${one.searchMissP50}/${one.searchMissP95} read=${one.readP50}/${one.readP95}`,
  )
}

await fs.mkdir('D:/ptcab/scratch/batchB', { recursive: true })
await fs.writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))
console.log('JSON:', OUT)
