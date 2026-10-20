import { describe, expect, test } from 'claude-code/testing'

import { manifestName, parseHistoryText, segmentName, shardName } from '../hooks/lib/history.ts'
import { createSession } from '../hooks/lib/session.ts'
import type { Io } from '../hooks/lib/session.ts'
import { DEFAULTS, parseJsonl, toJsonl } from '../hooks/lib/types.ts'
import type { HistoryRecord } from '../hooks/lib/types.ts'

const DIR = '/ctx'

type Box = {
  files: Map<string, string>
  /** How often each path was written; a segment must always be 1. */
  writes: Map<string, number>
  bytes: Map<string, number>
  io: Io
}

/** The host's file system in memory; `list` can be left out to model a host that cannot list. */
const makeIo = (withList = true): Box => {
  const files = new Map<string, string>()
  const writes = new Map<string, number>()
  const bytes = new Map<string, number>()
  const io: Io = {
    read: async path => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    write: async (path, text) => {
      files.set(path, text)
      writes.set(path, (writes.get(path) ?? 0) + 1)
      bytes.set(path, (bytes.get(path) ?? 0) + utf8(text).length)
    },
    now: () => 1_000_000,
  }
  if (withList) {
    io.list = async dir => {
      const prefix = `${dir}/`
      return [...files.keys()].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map(path => path.slice(prefix.length))
    }
  }
  return { files, writes, bytes, io }
}

/** Every history row of one window, legacy parts and segments alike, in seq order. */
const rowsOf = (box: Box, window: number): HistoryRecord[] => {
  const head = `${DIR}/history-w${String(window).padStart(3, '0')}`
  const rows: HistoryRecord[] = []
  for (const [path, text] of box.files) {
    if (!path.startsWith(head)) continue
    const rest = path.slice(head.length)
    if (!rest.startsWith('.') && !rest.startsWith('-')) continue
    if (!path.endsWith('.jsonl')) continue
    rows.push(...parseHistoryText(text))
  }
  return rows.sort((left, right) => left.seq - right.seq)
}

/** UTF-8 bytes, counted by hand: the test sandbox offers no Buffer or TextEncoder. */
const utf8 = (text: string): number[] => {
  const bytes: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
  }
  return bytes
}

const ROT = Uint32Array.from([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2])

const rotr = (value: number, by: number): number => ((value >>> by) | (value << (32 - by))) >>> 0

/** A plain SHA-256, so the test needs no module the hooks sandbox forbids. */
const sha256 = (text: string): string => {
  const bytes = utf8(text)
  const bits = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((Math.floor(bits / 0x100000000) >>> shift) & 0xff)
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((bits >>> shift) & 0xff)

  const hash = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4
      w[index] = (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const one = (rotr(w[index - 15] ?? 0, 7) ^ rotr(w[index - 15] ?? 0, 18) ^ ((w[index - 15] ?? 0) >>> 3)) >>> 0
      const two = (rotr(w[index - 2] ?? 0, 17) ^ rotr(w[index - 2] ?? 0, 19) ^ ((w[index - 2] ?? 0) >>> 10)) >>> 0
      w[index] = ((w[index - 16] ?? 0) + one + (w[index - 7] ?? 0) + two) >>> 0
    }
    let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = hash
    for (let index = 0; index < 64; index += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const choose = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (h + s1 + choose + (ROT[index] ?? 0) + (w[index] ?? 0)) >>> 0
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const major = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (s0 + major) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0; hash[1] = ((hash[1] ?? 0) + b) >>> 0; hash[2] = ((hash[2] ?? 0) + c) >>> 0; hash[3] = ((hash[3] ?? 0) + d) >>> 0
    hash[4] = ((hash[4] ?? 0) + e) >>> 0; hash[5] = ((hash[5] ?? 0) + f) >>> 0; hash[6] = ((hash[6] ?? 0) + g) >>> 0; hash[7] = ((hash[7] ?? 0) + h) >>> 0
  }
  return Array.from(hash).map(word => word.toString(16).padStart(8, '0')).join('')
}

const sha = (row: HistoryRecord): string => sha256(JSON.stringify(row))

const legacyRow = (seq: number, text: string): HistoryRecord => ({
  seq,
  uuid: `legacy-${seq}`,
  ts: 1_000 + seq,
  window: 1,
  role: 'user',
  text,
})

describe('append-style history', () => {
  test('with a cap of one, each record lands in a segment of its own and no segment is rewritten', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, { ...DEFAULTS, segmentRecords: 1 })
    for (let index = 1; index <= 5; index += 1) {
      await session.record({ uuid: `u${index}`, role: 'user', text: `row ${index} ${'x'.repeat(200)}` })
    }
    await session.flush()

    for (let seq = 1; seq <= 5; seq += 1) {
      const path = `${DIR}/${segmentName(1, seq)}`
      expect(box.writes.get(path)).toBe(1)
      expect(box.files.get(path)?.trim().split('\n')).toHaveLength(1)
      expect(parseJsonl<HistoryRecord>(box.files.get(path) ?? '')[0]?.seq).toBe(seq)
    }
    // The old whole-shard file is not even created.
    expect(box.files.has(`${DIR}/${shardName(1, 0)}`)).toBe(false)
    expect(rowsOf(box, 1).map(row => row.seq)).toEqual([1, 2, 3, 4, 5])

    // Logical bytes are exactly the bytes on disk for history: WAF is 1.
    const line = session.historyWriteStats()
    const logical = Number(/逻辑 ([\d.]+) KB/.exec(line)?.[1])
    const physical = Number(/实际 ([\d.]+) KB/.exec(line)?.[1])
    expect(logical).toBeGreaterThan(0)
    expect(physical).toBe(logical)
    expect(Number(/写盘 (\d+) 次/.exec(line)?.[1])).toBe(5)
  })

  test('records share a segment until the record cap, then roll', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, { ...DEFAULTS, segmentRecords: 8 })
    for (let index = 1; index <= 17; index += 1) {
      await session.record({ uuid: `u${index}`, role: 'user', text: `row ${index}` })
    }
    await session.flush()

    // Three files, not seventeen: 8 + 8 + 1 rows.
    expect(box.files.has(`${DIR}/${segmentName(1, 1)}`)).toBe(true)
    expect(box.files.has(`${DIR}/${segmentName(1, 9)}`)).toBe(true)
    expect(box.files.has(`${DIR}/${segmentName(1, 17)}`)).toBe(true)
    expect(box.files.has(`${DIR}/${segmentName(1, 2)}`)).toBe(false)
    expect(box.files.get(`${DIR}/${segmentName(1, 1)}`)?.trim().split('\n')).toHaveLength(8)
    expect(box.files.get(`${DIR}/${segmentName(1, 9)}`)?.trim().split('\n')).toHaveLength(8)
    expect(box.files.get(`${DIR}/${segmentName(1, 17)}`)?.trim().split('\n')).toHaveLength(1)
    // The first segment is rewritten as it grows (pending rewrites may coalesce),
    // and the last one is written once.
    expect(box.writes.get(`${DIR}/${segmentName(1, 1)}`)).toBeGreaterThan(1)
    expect(box.writes.get(`${DIR}/${segmentName(1, 1)}`)).toBeLessThanOrEqual(8)
    expect(box.writes.get(`${DIR}/${segmentName(1, 17)}`)).toBe(1)
    expect(rowsOf(box, 1).map(row => row.seq)).toEqual(Array.from({ length: 17 }, (_, index) => index + 1))
  })

  test('the byte cap rolls a segment even when the record cap has room', async () => {
    const box = makeIo()
    const session = createSession(DIR, box.io, { ...DEFAULTS, segmentRecords: 100, segmentBytes: 1_000 })
    const big = 'x'.repeat(600)
    for (let index = 1; index <= 3; index += 1) {
      await session.record({ uuid: `u${index}`, role: 'user', text: big })
    }
    // One record larger than the cap still lands, alone in its own segment.
    await session.record({ uuid: 'huge', role: 'user', text: 'y'.repeat(5_000) })
    await session.flush()

    for (let seq = 1; seq <= 4; seq += 1) {
      expect(box.files.get(`${DIR}/${segmentName(1, seq)}`)?.trim().split('\n')).toHaveLength(1)
    }
    expect(rowsOf(box, 1).map(row => row.seq)).toEqual([1, 2, 3, 4])
  })

  test('old one-row segments sit beside new multi-row ones', async () => {
    const box = makeIo()
    // Data written by the first append format: a segment file per record.
    for (let seq = 1; seq <= 3; seq += 1) {
      box.files.set(`${DIR}/${segmentName(1, seq)}`, toJsonl([legacyRow(seq, `旧 ${seq}`)]))
    }
    box.files.set(`${DIR}/meta.json`, '{"seq":3,"window":1,"part":0}')

    const session = createSession(DIR, box.io, { ...DEFAULTS, segmentRecords: 8 })
    await session.record({ uuid: 'u4', role: 'user', text: '新 4' })
    await session.record({ uuid: 'u5', role: 'user', text: '新 5' })
    await session.flush()

    // The newest old segment absorbs the new rows; the older ones are untouched.
    expect(box.files.get(`${DIR}/${segmentName(1, 3)}`)?.trim().split('\n')).toHaveLength(3)
    expect(box.writes.get(`${DIR}/${segmentName(1, 1)}`)).toBeUndefined()
    expect(box.writes.get(`${DIR}/${segmentName(1, 2)}`)).toBeUndefined()
    expect(rowsOf(box, 1).map(row => row.seq)).toEqual([1, 2, 3, 4, 5])

    const reloaded = createSession(DIR, box.io, DEFAULTS)
    for (let seq = 1; seq <= 5; seq += 1) {
      expect((await reloaded.historyTool({ action: 'read', seq })).isError).not.toBe(true)
    }
  })

  test('reads a legacy shard, leaves it untouched and appends new rows beside it', async () => {
    const box = makeIo()
    const legacy = [legacyRow(1, '旧的第一条'), legacyRow(2, '旧的第二条')]
    const legacyText = toJsonl(legacy)
    box.files.set(`${DIR}/${shardName(1, 0)}`, legacyText)
    box.files.set(`${DIR}/meta.json`, '{"seq":2,"window":1,"part":0}')

    const session = createSession(DIR, box.io, DEFAULTS)
    const third = await session.record({ uuid: 'u3', role: 'assistant', text: '新的第三条' })
    expect(third.seq).toBe(3)
    await session.flush()

    expect(box.files.get(`${DIR}/${shardName(1, 0)}`)).toBe(legacyText)
    expect(box.files.get(`${DIR}/${segmentName(1, 3)}`)?.trim().split('\n')).toHaveLength(1)
    expect(rowsOf(box, 1).map(row => row.seq)).toEqual([1, 2, 3])

    const reloaded = createSession(DIR, box.io, DEFAULTS)
    expect((await reloaded.historyTool({ action: 'read', seq: 1 })).result).toContain('旧的第一条')
    expect((await reloaded.historyTool({ action: 'read', seq: 3 })).result).toContain('新的第三条')
  })

  test('drops an unfinished trailing line and skips a complete but damaged one', async () => {
    const box = makeIo()
    const first = legacyRow(1, '完整的一行')
    const broken = '{"seq":2,"uuid":"x","ts":1,"window":1,"role":"user","text":'
    const third = legacyRow(3, '又一条完整的')
    // A crash left the second line cut off and a fourth row without its newline.
    box.files.set(`${DIR}/${shardName(1, 0)}`, `${JSON.stringify(first)}\nnot json\n${JSON.stringify(third)}\n${broken}`)
    box.files.set(`${DIR}/meta.json`, '{"seq":3,"window":1,"part":0}')

    const session = createSession(DIR, box.io, DEFAULTS)
    expect((await session.historyTool({ action: 'read', seq: 2 })).isError).toBe(true)
    expect((await session.historyTool({ action: 'read', seq: 3 })).result).toContain('又一条完整的')
    const next = await session.record({ uuid: 'u4', role: 'user', text: '恢复之后的一行' })
    expect(next.seq).toBe(4)
    await session.flush()
    expect(rowsOf(box, 1).map(row => row.seq)).toEqual([1, 3, 4])
  })

  test('a segment cut off mid-line is read for its complete rows only', async () => {
    const box = makeIo()
    const good = legacyRow(1, '整行')
    box.files.set(`${DIR}/${segmentName(1, 1)}`, `${JSON.stringify(good)}\n{"seq":2,"uuid":"half`)
    box.files.set(`${DIR}/meta.json`, '{"seq":1,"window":1,"part":0}')

    const session = createSession(DIR, box.io, DEFAULTS)
    expect((await session.historyTool({ action: 'read', seq: 1 })).result).toContain('整行')
    expect((await session.historyTool({ action: 'read', seq: 2 })).isError).toBe(true)
    expect(await session.record({ uuid: 'u2', role: 'user', text: '接着写' })).toMatchObject({ seq: 2 })
  })

  test('the test SHA-256 matches the standard vectors', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  test('every legacy row keeps its seq and its SHA-256 when the new format opens it', async () => {
    const box = makeIo()
    const legacy = [
      legacyRow(1, '第一条：带中文和符号 ✓'),
      legacyRow(2, '第二条 ' + 'y'.repeat(500)),
      legacyRow(3, '第三条\n带一个换行'),
    ]
    const before = new Map(legacy.map(row => [row.seq, sha(row)]))
    box.files.set(`${DIR}/${shardName(1, 0)}`, toJsonl(legacy))
    box.files.set(`${DIR}/meta.json`, '{"seq":3,"window":1,"part":0}')

    const session = createSession(DIR, box.io, DEFAULTS)
    await session.flush()
    // Opening old data is not a rewrite: the legacy bytes are exactly as they were.
    expect(box.files.get(`${DIR}/${shardName(1, 0)}`)).toBe(toJsonl(legacy))
    // A new row goes beside them, not through them.
    const added = await session.record({ uuid: 'u4', role: 'assistant', text: '迁移之后的新行' })
    await session.flush()
    expect(added.seq).toBe(4)

    const reloaded = createSession(DIR, box.io, DEFAULTS)
    const rows = rowsOf(box, 1)
    expect(rows.map(row => row.seq)).toEqual([1, 2, 3, 4])
    for (const row of rows.filter(one => one.seq <= 3)) {
      expect(sha(row)).toBe(before.get(row.seq))
    }
    // The reload sees the same rows with the same hashes.
    expect((await reloaded.historyTool({ action: 'read', seq: 1 })).result).toContain('第一条')
    expect(rowsOf(box, 1).filter(one => one.seq <= 3).map(sha)).toEqual([...before.values()])
  })

  test('finds every segment through the manifest when the host cannot list a directory', async () => {
    const box = makeIo(false)
    const session = createSession(DIR, box.io, DEFAULTS)
    for (let index = 1; index <= 70; index += 1) {
      await session.record({ uuid: `u${index}`, role: 'user', text: `row ${index}` })
    }
    await session.flush()
    const manifest = JSON.parse(box.files.get(`${DIR}/${manifestName(1)}`) ?? '{}') as Record<string, unknown>
    expect(manifest).toMatchObject({
      version: 2,
      window: 1,
      firstSeq: 1,
      lastSeq: 70,
      count: 70,
      segments: [1, 9, 17, 25, 33, 41, 49, 57, 65],
    })

    // Without meta.json the range still comes back from the manifest and the segments.
    box.files.delete(`${DIR}/meta.json`)
    const reloaded = createSession(DIR, box.io, DEFAULTS)
    expect((await reloaded.historyTool({ action: 'read', seq: 1 })).result).toContain('row 1')
    expect((await reloaded.historyTool({ action: 'read', seq: 70 })).result).toContain('row 70')
    expect(await reloaded.record({ uuid: 'u71', role: 'user', text: 'row 71' })).toMatchObject({ seq: 71 })
  })
})
