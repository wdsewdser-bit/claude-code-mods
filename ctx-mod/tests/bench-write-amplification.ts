// @ts-nocheck
// Write-amplification sampling for the history shard path, run on its own:
//   node tests/bench-write-amplification.ts
// It mirrors what session.record does (clipRecord -> appendRecord -> toJsonl ->
// queue.push) and writes to a throwaway directory under the system temp folder.
import { promises as fs } from 'node:fs'
import { performance } from 'node:perf_hooks'
import {
  MAX_SHARD_BYTES,
  appendRecord,
  byteLength,
  clipRecord,
  createQueue,
  emptyShard,
  shardName,
} from '../hooks/lib/history.ts'
import { toJsonl } from '../hooks/lib/types.ts'

const ROOT = 'C:/Users/yadaz/AppData/Local/Temp/claude/ctx-bench/a04'
const K256 = 256 * 1024
const K1024 = 1024 * 1024
const bucketOf = bytes => (bytes <= K256 ? '0-256K' : bytes <= K1024 ? '256K-1M' : '1M-2M')

const emptySegments = () => ({
  '0-256K': { logical: 0, physical: 0, writes: 0 },
  '256K-1M': { logical: 0, physical: 0, writes: 0 },
  '1M-2M': { logical: 0, physical: 0, writes: 0 },
})

const textOf = (length, seq) => {
  const tag = `#${seq} `
  return tag + 'x'.repeat(Math.max(0, length - tag.length))
}

const runSession = async ({ label, records, textLength, rhythm, batchSize }) => {
  const dir = `${ROOT}/${label}-${rhythm}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await fs.mkdir(dir, { recursive: true })

  const writeLatencies = []
  const errors = []
  const sizes = new Map()
  const written = new Map()
  let physical = 0
  let writeCalls = 0
  let coalesced = 0
  const segments = emptySegments()

  const isShardPath = p => /(?:^|[\\/])history-[^\\/]+\.jsonl$/.test(p)
  const queue = createQueue(
    async (p, text) => {
      const started = performance.now()
      await fs.writeFile(p, text, 'utf8')
      writeLatencies.push(performance.now() - started)
    },
    (p, error) => errors.push(`${p}: ${String(error && error.message ? error.message : error)}`),
    {
      onWrite: (p, bytes) => {
        if (!isShardPath(p)) return
        physical += bytes
        writeCalls += 1
        // The text actually written carries exactly the rows added since the last write
        // to this path, so its size minus that earlier size is the logical share.
        const previous = written.get(p) ?? 0
        const delta = Math.max(0, bytes - previous)
        const seg = segments[bucketOf(bytes)]
        seg.physical += bytes
        seg.logical += delta
        seg.writes += 1
        written.set(p, bytes)
      },
      onCoalesce: p => {
        if (isShardPath(p)) coalesced += 1
      },
    },
  )

  let shard = emptyShard(1, 0)
  let logical = 0
  let rotations = 0
  let maxShardBytes = 0
  let shardFiles = new Set()
  let fullWrites = 0
  const started = performance.now()

  for (let seq = 1; seq <= records; seq += 1) {
    const row = {
      seq,
      uuid: `bench-${seq}`,
      ts: 1_700_000_000_000 + seq,
      window: 1,
      role: seq % 3 === 0 ? 'assistant' : 'tool',
      text: textOf(textLength, seq),
      tool: 'Bash',
      path: '/tmp/example.txt',
    }
    const clipped = clipRecord(row)
    logical += byteLength(JSON.stringify(clipped)) + 1
    const next = appendRecord(shard, clipped)
    if (next.isNew && shard.rows.length > 0) {
      rotations += 1
      maxShardBytes = Math.max(maxShardBytes, shard.bytes)
    }
    shard = next.shard
    const name = shardName(shard.window, shard.part)
    shardFiles.add(name)
    sizes.set(`${dir}/${name}`, shard.bytes)
    const write = queue.push(`${dir}/${name}`, toJsonl(shard.rows))
    if (rhythm === 'immediate') {
      await write
      fullWrites += 1
    } else if (rhythm === 'batch') {
      if (seq % batchSize === 0) await queue.idle()
    }
  }

  await queue.idle()
  const elapsed = performance.now() - started
  maxShardBytes = Math.max(maxShardBytes, shard.bytes)

  const segOut = {}
  for (const [name, seg] of Object.entries(segments)) {
    if (seg.writes === 0) continue
    segOut[name] = {
      logicalBytes: seg.logical,
      physicalBytes: seg.physical,
      writes: seg.writes,
      waf: seg.logical === 0 ? null : Number((seg.physical / seg.logical).toFixed(2)),
    }
  }

  const result = {
    label,
    rhythm,
    records,
    textLength,
    logicalNewBytes: logical,
    physicalBytesWritten: physical,
    waf: Number((physical / logical).toFixed(2)),
    writeCalls,
    coalesced,
    avgAppendMs: Number((elapsed / records).toFixed(3)),
    avgWriteMs: writeLatencies.length === 0 ? null : Number((writeLatencies.reduce((a, b) => a + b, 0) / writeLatencies.length).toFixed(3)),
    maxWriteMs: writeLatencies.length === 0 ? null : Number(Math.max(...writeLatencies).toFixed(3)),
    rotations,
    shardFiles: shardFiles.size,
    maxShardBytes,
    segments: segOut,
    errors,
    elapsedMs: Number(elapsed.toFixed(1)),
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
    const one = await runSession({ ...session, ...rhythm })
    results.push(one)
    console.log(
      `${one.label.padEnd(6)} ${one.rhythm.padEnd(9)} records=${one.records} logical=${one.logicalNewBytes} physical=${one.physicalBytesWritten} WAF=${one.waf} writes=${one.writeCalls} coalesced=${one.coalesced} avgAppend=${one.avgAppendMs}ms avgWrite=${one.avgWriteMs}ms rotations=${one.rotations}`,
    )
  }
}

await fs.mkdir(ROOT, { recursive: true })
await fs.writeFile(`${ROOT}/a04.json`, JSON.stringify({ maxShardBytes: MAX_SHARD_BYTES, results }, null, 2))
console.log('JSON:', `${ROOT}/a04.json`)
