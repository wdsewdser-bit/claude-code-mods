// @ts-nocheck
// Session-level write-amplification sampling, run on its own:
//   CTX_SESSION=<hooks/lib/session.ts> CTX_BENCH_TAG=after node tests/bench-append.ts
// It drives the real session.record/flush path against a real file system in a
// throwaway directory, so "before" (the backup) and "after" (this tree) are
// measured by the same harness. Only the history files count; meta.json does not.
import { promises as fs } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { DEFAULTS } from '../hooks/lib/types.ts'
import { byteLength } from '../hooks/lib/history.ts'

const sessionPath = process.env.CTX_SESSION ?? new URL('../hooks/lib/session.ts', import.meta.url).href
const tag = process.env.CTX_BENCH_TAG ?? 'after'
const { createSession } = await import(sessionPath)

const ROOT = `C:/Users/yadaz/AppData/Local/Temp/claude/ctx-bench/b01-${tag}`

const textOf = (length, seq) => {
  const head = `#${seq} `
  return head + 'x'.repeat(Math.max(0, length - head.length))
}

const isHistory = path => {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return name.startsWith('history-') && (name.endsWith('.jsonl') || name.endsWith('.manifest.json'))
}

const makeIo = () => {
  const counts = new Map()
  let physical = 0
  let writeCalls = 0
  const io = {
    read: async path => await fs.readFile(path, 'utf8'),
    write: async (path, text) => {
      await fs.writeFile(path, text, 'utf8')
      if (!isHistory(path)) return
      physical += byteLength(text)
      writeCalls += 1
      const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    },
    now: () => Date.now(),
    list: async path => await fs.readdir(path),
    exists: async path => {
      try { await fs.access(path); return true } catch { return false }
    },
    remove: async path => { await fs.rm(path, { force: true }) },
  }
  return { io, stats: () => ({ physical, writeCalls, counts }) }
}

const run = async ({ label, records, textLength, rhythm, batchSize }) => {
  const dir = `${ROOT}/${label}-${rhythm}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await fs.mkdir(dir, { recursive: true })
  const { io, stats } = makeIo()
  const session = createSession(dir, io, DEFAULTS)

  let logical = 0
  const started = performance.now()
  for (let seq = 1; seq <= records; seq += 1) {
    const row = await session.record({
      uuid: `bench-${seq}`,
      role: seq % 3 === 0 ? 'assistant' : 'tool',
      tool: 'Bash',
      path: '/tmp/example.txt',
      text: textOf(textLength, seq),
    })
    logical += byteLength(JSON.stringify(row)) + 1
    if (rhythm === 'immediate') await session.flush()
    else if (rhythm === 'batch' && seq % batchSize === 0) await session.flush()
  }
  await session.flush()
  const elapsed = performance.now() - started
  const measured = stats()
  const perPath = [...measured.counts.values()]
  const line = session.historyWriteStats()

  const result = {
    label,
    rhythm,
    records,
    textLength,
    logicalNewBytes: logical,
    physicalBytesWritten: measured.physical,
    waf: Number((measured.physical / logical).toFixed(2)),
    writeCalls: measured.writeCalls,
    historyFiles: measured.counts.size,
    maxWritesToOneFile: perPath.length === 0 ? 0 : Math.max(...perPath),
    sessionLine: line,
    elapsedMs: Number(elapsed.toFixed(1)),
    avgRecordMs: Number((elapsed / records).toFixed(3)),
  }
  await fs.rm(dir, { recursive: true, force: true })
  return result
}

const sessions = [
  { label: 'short', records: 200, textLength: 240 },
  { label: 'medium', records: 210, textLength: 5000 },
  { label: 'long', records: 470, textLength: 5000 },
]
const rhythms = [
  { rhythm: 'immediate', batchSize: 0 },
  { rhythm: 'batch', batchSize: 50 },
  { rhythm: 'burst', batchSize: Number.POSITIVE_INFINITY },
]

const results = []
for (const session of sessions) {
  for (const rhythm of rhythms) {
    const one = await run({ ...session, ...rhythm })
    results.push(one)
    console.log(
      `${one.label.padEnd(6)} ${one.rhythm.padEnd(9)} records=${one.records} logical=${one.logicalNewBytes} physical=${one.physicalBytesWritten} WAF=${one.waf} writes=${one.writeCalls} files=${one.historyFiles} maxWrites/${'file'}=${one.maxWritesToOneFile} avg=${one.avgRecordMs}ms`,
    )
  }
}

await fs.mkdir('D:/ptcab/scratch/batchB', { recursive: true })
await fs.writeFile(`D:/ptcab/scratch/batchB/bench-${tag}.json`, JSON.stringify({ tag, sessionPath, results }, null, 2))
console.log('JSON:', `D:/ptcab/scratch/batchB/bench-${tag}.json`)
