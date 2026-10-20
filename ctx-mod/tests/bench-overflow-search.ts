// @ts-nocheck -- a standalone benchmark, not part of the plugin test run.
// Run: node tests/bench-overflow-search.ts
//
// Scale and failure benchmark for history search over overflow parts.
// Records are built the way clipRecord stores them, but with 2-3 parts of
// 1,000,000 characters (the real OVERFLOW_PART_CHARS): a part the reader does
// not need to materialize is one shared filler string, so 10,000 records fit in
// memory while the search still scans every byte it would scan on disk.
import { performance } from 'node:perf_hooks'
import { writeFileSync, mkdirSync } from 'node:fs'
import { clipRecord, MAX_RECORD_CHARS, OVERFLOW_PART_CHARS, search } from '../hooks/lib/history.ts'

const PART = OVERFLOW_PART_CHARS
const OUT_DIR = 'C:/Users/yadaz/AppData/Local/Temp/claude/ctx-bench'
const MARK_TAIL = 'RAREWORD-ALPHA'
const MARK_BOUNDARY = 'BOUNDARY-WORD-END'
const MARK_INLINE = 'INLINEWORD'

/** The head clipRecord keeps in the row, shared by every ordinary row. */
const HEAD = clipRecord({ seq: 0, uuid: 'u', ts: 0, window: 1, role: 'tool', text: 'x'.repeat(MAX_RECORD_CHARS + 10) }).text

const fillerCache = new Map()
const filler = len => {
  let text = fillerCache.get(len)
  if (text === undefined) {
    text = 'f'.repeat(len)
    fillerCache.set(len, text)
  }
  return text
}

const partLength = (spec, part) => (part + 1 < spec.parts ? PART : spec.chars - PART * (spec.parts - 1))
const originOf = (spec, part) => part * PART

/** Rows plus the part contents that differ from the filler. */
const buildRows = count => {
  const specs = new Map()
  const specials = new Map()
  const rows = []
  const boundarySeq = Math.min(5000, Math.max(2, Math.floor(count / 2)))
  for (let seq = 1; seq <= count; seq += 1) {
    const parts = seq === 1 ? 3 : seq % 2 === 0 ? 3 : 2
    const chars = parts === 3 ? 2_500_000 : 1_500_000
    const spec = { chars, parts }
    specs.set(seq, spec)
    let head = HEAD
    if (seq === count) {
      head = 'h'.repeat(1000) + MARK_INLINE + 'h'.repeat(MAX_RECORD_CHARS - 1000 - MARK_INLINE.length)
    }
    rows.push({
      seq,
      uuid: 'u' + seq,
      ts: seq,
      window: 1,
      role: 'tool',
      text: head,
      overflow: { text: { chars, parts } },
    })
  }
  // (a) the unique word at the very tail of the oldest record, in part 2.
  const tailLen = partLength(specs.get(1), 2)
  specials.set('1:text:2', filler(tailLen - MARK_TAIL.length) + MARK_TAIL)
  // (d) a word straddling the part 0 / part 1 boundary of a middle record.
  specials.set(boundarySeq + ':text:0', filler(PART - 10) + 'BOUNDARY-W')
  specials.set(boundarySeq + ':text:1', 'ORD-END' + filler(partLength(specs.get(boundarySeq), 1) - 7))
  return { rows, specs, specials, boundarySeq }
}

const makeReader = (specs, specials) => {
  let files = 0
  let bytes = 0
  const reader = async (seq, field, part) => {
    files += 1
    const text = specials.get(seq + ':' + field + ':' + part) ?? filler(partLength(specs.get(seq), part))
    bytes += text.length
    return text
  }
  return {
    reader,
    reset: () => {
      files = 0
      bytes = 0
    },
    stats: () => ({ files, bytes }),
  }
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]

const measure = async (rows, query, limit, counter, runs) => {
  const times = []
  let files = 0
  let bytes = 0
  let hits = 0
  for (let run = 0; run < runs; run += 1) {
    counter.reset()
    const started = performance.now()
    const found = await search(rows, { query, limit }, counter.reader)
    times.push(performance.now() - started)
    const stats = counter.stats()
    files += stats.files
    bytes += stats.bytes
    hits = found.length
  }
  const sorted = [...times].sort((a, b) => a - b)
  return {
    p50: Number(percentile(sorted, 50).toFixed(1)),
    p95: Number(percentile(sorted, 95).toFixed(1)),
    min: Number(sorted[0].toFixed(1)),
    files: Math.round(files / runs),
    bytes: Math.round(bytes / runs),
    hits,
  }
}

const runScale = async count => {
  const { rows, specs, specials, boundarySeq } = buildRows(count)
  const counter = makeReader(specs, specials)
  const runs = count >= 10_000 ? 3 : 7
  const table = {}
  table['a-tail-hit'] = await measure(rows, MARK_TAIL, 20, counter, runs)
  table['b-no-hit'] = await measure(rows, 'NOSUCHWORD-ANYWHERE', 20, counter, runs)
  table['c-inline-only'] = await measure(rows, MARK_INLINE, 1, counter, runs)
  table['d-part-boundary'] = await measure(rows, MARK_BOUNDARY, 1, counter, runs)
  return { count, runs, boundarySeq, table }
}

/** A small set with a word in part 2, used to drive the three failure modes. */
const failureSet = () => {
  const specs = new Map([[1, { chars: 2_500_000, parts: 3 }]])
  const specials = new Map([['1:text:2', filler(500_000 - 'DEEP-WORD'.length) + 'DEEP-WORD']])
  const rows = [
    {
      seq: 1,
      uuid: 'u1',
      ts: 1,
      window: 1,
      role: 'tool',
      text: HEAD,
      overflow: { text: { chars: 2_500_000, parts: 3 } },
    },
  ]
  return { rows, specs, specials }
}

const runFailures = async () => {
  const { rows, specs, specials } = failureSet()
  const base = makeReader(specs, specials).reader
  const cases = [
    ['missing-part-1', async (seq, field, part) => (part === 1 ? null : base(seq, field, part))],
    ['truncated-part-0', async (seq, field, part) => (part === 0 ? (await base(seq, field, part)).slice(0, 500_000) : base(seq, field, part))],
    [
      'unreadable-part-1',
      async (seq, field, part) => {
        if (part === 1) throw new Error('EIO: big-1-text-1.txt')
        return base(seq, field, part)
      },
    ],
  ]
  const results = {}
  for (const [name, reader] of cases) {
    const failures = []
    let threw = null
    let hits = null
    try {
      const found = await search(rows, { query: 'DEEP-WORD' }, reader, { onOverflowError: failure => failures.push(failure) })
      hits = found.map(hit => ({ seq: hit.seq, overflow: hit.overflow }))
    } catch (error) {
      threw = String(error)
    }
    results[name] = { threw, hits, failures }
  }
  return results
}

/** 20 rows with the word at a random position; the reported offset must equal the original index. */
const runOffsets = async () => {
  const specs = new Map()
  const specials = new Map()
  const rows = []
  const expected = []
  for (let index = 0; index < 20; index += 1) {
    const seq = index + 1
    const chars = 2_500_000
    const parts = 3
    specs.set(seq, { chars, parts })
    const word = 'SAMPLEWORD-' + index + '-ZZ'
    const part = index % 3
    const length = part + 1 < parts ? PART : chars - PART * (parts - 1)
    const within = Math.floor((length - word.length - 2) * ((index * 37) % 97) / 97)
    const content = filler(within) + word + filler(length - within - word.length)
    specials.set(seq + ':text:' + part, content)
    rows.push({
      seq,
      uuid: 'u' + seq,
      ts: seq,
      window: 1,
      role: 'tool',
      text: HEAD,
      overflow: { text: { chars, parts } },
    })
    expected.push({ seq, word, offset: originOf(specs.get(seq), part) + within })
  }
  const counter = makeReader(specs, specials)
  const checked = []
  for (const item of expected) {
    const found = await search(rows, { query: item.word, limit: 1 }, counter.reader)
    checked.push({ seq: item.seq, expected: item.offset, got: found[0]?.overflow?.offset ?? null, ok: found[0]?.overflow?.offset === item.offset })
  }
  return { checked: checked.length, mismatches: checked.filter(item => !item.ok) }
}

const main = async () => {
  mkdirSync(OUT_DIR, { recursive: true })
  const scales = []
  for (const count of [100, 1000, 10_000]) {
    process.stdout.write('running scale ' + count + '...\n')
    scales.push(await runScale(count))
  }
  const failures = await runFailures()
  const offsets = await runOffsets()
  const report = { generatedAt: new Date().toISOString(), partChars: PART, scales, failures, offsets }
  writeFileSync(OUT_DIR + '/a03.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
