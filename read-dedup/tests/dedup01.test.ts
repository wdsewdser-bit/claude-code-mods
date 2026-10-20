import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import * as D from '../hooks/lib/dedup.ts'
import * as H from '../hooks/lib/handler.ts'

const mkLine = i => 'row ' + i + ' ' + 'x'.repeat(24)
const fileLines = (n, f = mkLine) => Array.from({ length: n }, (_, i) => f(i + 1))

function readResult(lines, start, total, filePath = 'C:\\proj\\f.txt', eol = '\n') {
  return { type: 'text', file: { filePath, content: lines.join(eol), numLines: lines.length, startLine: start, totalLines: total } }
}
function parsed(lines, start, total, filePath, eol) {
  const p = D.parseReadResult(readResult(lines, start, total, filePath, eol))
  assert.ok(p, 'parseReadResult should parse the fixture')
  return p
}
async function doRead(store, p, id) {
  return H.decide(store, { id, agentId: 'agent', filePath: p.filePath }, p, async () => true)
}

test('parse: LF and CRLF split into identical lines', () => {
  const lf = parsed(['alpha', 'beta', 'gamma'], 1, 3, undefined, '\n')
  const crlf = parsed(['alpha', 'beta', 'gamma'], 1, 3, undefined, '\r\n')
  assert.deepEqual(crlf.lines, lf.lines)
  assert.deepEqual(crlf.lines, ['alpha', 'beta', 'gamma'])
})

test('parse: CRLF trailing newline and blank lines keep the line count', () => {
  const r = readResult(['a', '', 'b'], 1, 3)
  r.file.content = 'a\r\n\r\nb\r\n'
  const p = D.parseReadResult(r)
  assert.ok(p)
  assert.deepEqual(p.lines, ['a', '', 'b'])
  assert.equal(p.total, 3)
})

test('parse: numbered gutter (N<TAB>) is stripped from CRLF content', () => {
  const r = { type: 'text', file: { filePath: 'C:\\p\\f.txt', content: '1\ta\r\n2\tb\r\n', numLines: 2, startLine: 1, totalLines: 2 } }
  const p = D.parseReadResult(r)
  assert.ok(p)
  assert.deepEqual(p.lines, ['a', 'b'])
})

test('stripGutter preserves CRLF line endings', () => {
  assert.equal(D.stripGutter('1\ta\r\n2\tb\r\n'), 'a\r\nb\r\n')
})

test('plan: CRLF read then overlapping CRLF read computes the same ranges as LF', () => {
  const all = fileLines(100)
  const mk = () => {
    const old = new Map()
    D.commit(old, 1, all.slice(0, 50), 'r1', undefined, 'all')
    return D.planRead(old, 30, all.slice(29, 80), 100, 'f', 100000)
  }
  const lf = mk()
  const crlf = mk()
  assert.equal(crlf.kind, 'diff')
  assert.match(crlf.text, /此前未见 第 51.80 行/)
  assert.equal(crlf.text, lf.text)
})

test('normPath: Windows paths are case-insensitive and dot segments resolve', () => {
  assert.equal(D.normPath('C:\\A\\b.txt'), D.normPath('c:/a/B.TXT'))
  assert.equal(D.normPath('C:\\A\\.\\x\\..\\b.txt'), 'c:/a/b.txt')
  assert.equal(D.normPath('C:/A//b.txt'), 'c:/a/b.txt')
  assert.equal(D.normPath('relative\\x'), undefined)
  assert.equal(D.normPath(''), undefined)
  assert.equal(D.normPath(undefined), undefined)
  assert.equal(D.normPath('\\\\Server\\Share\\A.txt'), D.normPath('//server/share/a.txt'))
})

test('case variants of a Windows path share one cache entry', async () => {
  const store = H.createStore()
  const all = fileLines(100)
  const d1 = await doRead(store, parsed(all, 1, 100, 'C:\\Temp\\A\\b.txt'), 'r1')
  const d2 = await doRead(store, parsed(all, 1, 100, 'c:\\temp\\a\\B.TXT'), 'r2')
  assert.equal(d1.note, 'first read of this file')
  assert.equal(d2.note, 'same')
  assert.ok(d2.content)
})

test('overlap: fully contained re-read -> same', () => {
  const all = fileLines(100)
  const old = new Map()
  D.commit(old, 1, all.slice(0, 100), 'r1', undefined, 'all')
  const p = D.planRead(old, 30, all.slice(29, 60), 100, 'f', 100000)
  assert.equal(p.kind, 'same')
  assert.match(p.text, /第 30.60 行/)
})

test('overlap: partial overlap 1-50 then 30-80 -> only 51-80 unseen', () => {
  const all = fileLines(100)
  const old = new Map()
  D.commit(old, 1, all.slice(0, 50), 'r1', undefined, 'all')
  const p = D.planRead(old, 30, all.slice(29, 80), 100, 'f', 100000)
  assert.equal(p.kind, 'diff')
  assert.match(p.text, /此前未见 第 51.80 行/)
  assert.ok(!p.text.includes(mkLine(40)))
})

test('overlap: adjacent but not overlapping 1-50 then 51-100 -> full', () => {
  const all = fileLines(200)
  const old = new Map()
  D.commit(old, 1, all.slice(0, 50), 'r1', undefined, 'all')
  const p = D.planRead(old, 51, all.slice(50, 100), 200, 'f', 100000)
  assert.equal(p.kind, 'full')
  assert.equal(p.reason, 'no-overlap')
})

test('overlap: adjacent reverse 51-100 then 1-50 -> full', () => {
  const all = fileLines(200)
  const old = new Map()
  D.commit(old, 51, all.slice(50, 100), 'r1', undefined, 'all')
  const p = D.planRead(old, 1, all.slice(0, 50), 200, 'f', 100000)
  assert.equal(p.kind, 'full')
  assert.equal(p.reason, 'no-overlap')
})

test('external change: re-read returns the changed line, not "unchanged"', async () => {
  const store = H.createStore()
  const before = fileLines(100)
  await doRead(store, parsed(before, 1, 100), 'r1')
  const after = before.slice()
  after[39] = 'CHANGED 40 ' + 'y'.repeat(20)
  const d = await doRead(store, parsed(after, 1, 100), 'r2')
  assert.ok(d.content, 'an externally changed read must not be elided')
  assert.match(d.content, /\+40\tCHANGED 40/)
  assert.match(d.content, /-40\trow 40/)
})

test('external rewrite: more than 30% changed -> full new content', async () => {
  const store = H.createStore()
  await doRead(store, parsed(fileLines(100), 1, 100), 'r1')
  const heavy = fileLines(100, i => 'rewritten ' + i + ' ' + 'z'.repeat(20))
  const d = await doRead(store, parsed(heavy, 1, 100), 'r2')
  assert.equal(d.content, undefined)
  assert.match(d.note, /^full/)
})

test('external insertion: a shifted range is not reported as unchanged', async () => {
  const store = H.createStore()
  const before = fileLines(100)
  await doRead(store, parsed(before, 1, 50), 'r1')
  const after = before.slice()
  after.splice(9, 0, 'INSERTED LINE ' + 'i'.repeat(20))
  const d = await doRead(store, parsed(after, 1, 50), 'r2')
  assert.notEqual(d.note, 'same')
  assert.ok(d.content && d.content.includes('INSERTED LINE'))
})

test('mtime-only change (same content) is reported as unchanged', async () => {
  const store = H.createStore()
  const all = fileLines(100)
  await doRead(store, parsed(all, 1, 100), 'r1')
  const d = await doRead(store, parsed(all, 1, 100), 'r2')
  assert.ok(d.content, 'content is identical, so the unchanged notice is correct')
  assert.equal(d.note, 'same')
})

test('model Edit then re-read still yields a diff', async () => {
  const store = H.createStore()
  const all = fileLines(100)
  await doRead(store, parsed(all, 1, 100), 'r1')
  const after = all.slice()
  after[39] = 'EDITED 40 ' + 'e'.repeat(20)
  H.noteEdit(store, 'agent', 'C:\\proj\\f.txt')
  const d = await doRead(store, parsed(after, 1, 100), 'r2')
  assert.equal(d.note, 'diff')
  assert.ok(d.content && d.content.includes('EDITED 40'))
})

test('symlink/junction: two spellings of one file are safe separate entries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-dedup-link-'))
  try {
    const realDir = path.join(dir, 'real')
    fs.mkdirSync(realDir)
    const realFile = path.join(realDir, 'f.txt')
    fs.writeFileSync(realFile, fileLines(100).join('\n'))
    const linkDir = path.join(dir, 'link')
    let linkFile
    try {
      fs.symlinkSync(realFile, path.join(dir, 'link-file.txt'), 'file')
      linkFile = path.join(dir, 'link-file.txt')
    } catch {
      try {
        fs.symlinkSync(realDir, linkDir, 'junction')
        linkFile = path.join(linkDir, 'f.txt')
      } catch (e) {
        t.skip('cannot create symlink or junction on this machine: ' + e.code)
        return
      }
    }
    assert.equal(fs.realpathSync(linkFile).toLowerCase(), fs.realpathSync(realFile).toLowerCase())
    const store = H.createStore()
    const d1 = await doRead(store, parsed(fileLines(100), 1, 100, realFile), 'r1')
    const d2 = await doRead(store, parsed(fileLines(100), 1, 100, linkFile), 'r2')
    assert.equal(d1.note, 'first read of this file')
    assert.equal(d2.note, 'first read of this file', 'a different spelling must not be mistaken for the same cached path')
    const d3 = await doRead(store, parsed(fileLines(100), 1, 100, linkFile), 'r3')
    assert.equal(d3.note, 'same')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('savedChars: recorded for same and diff, zero for full', async () => {
  const store = H.createStore()
  const all = fileLines(100)
  await doRead(store, parsed(all, 1, 100), 'r1')
  const same = await doRead(store, parsed(all, 1, 100), 'r2')
  assert.equal(same.note, 'same')
  const fullLen = all.reduce((s, l) => s + l.length + 1, 0)
  assert.equal(same.savedChars, fullLen - same.content.length)
  assert.equal(store.savedChars, same.savedChars)

  const changed = all.slice()
  changed[39] = 'CHANGED 40 ' + 'z'.repeat(20)
  const d = await doRead(store, parsed(changed.slice(29, 100), 30, 100), 'r3')
  assert.equal(d.note, 'diff')
  assert.ok(d.savedChars > 0)
  assert.equal(store.savedChars, same.savedChars + d.savedChars)

  const store2 = H.createStore()
  await doRead(store2, parsed(all, 1, 100), 'x1')
  const heavy = fileLines(100, i => 'totally different ' + i + ' ' + 'q'.repeat(20))
  const f = await doRead(store2, parsed(heavy, 1, 100), 'x2')
  assert.match(f.note, /^full/)
  assert.equal(f.savedChars, 0)
  assert.equal(store2.savedChars, 0)
})

test('leading deletion + trailing line: shifted claim must not hide an unread line', () => {
  const all = fileLines(200)
  const old = new Map()
  D.commit(old, 30, all.slice(29, 80), 'r1', undefined, 'all')
  const after = all.filter((_, i) => i !== 29)
  const nt = after.slice(29, 80)
  const p = D.planRead(old, 30, nt, after.length, 'f', 100000)
  assert.notEqual(p.kind, 'same')
  if (p.kind === 'shifted') {
    const cached = new Set([...old.values()].map(l => l.t))
    const hidden = nt.filter(t => !cached.has(t))
    assert.deepEqual(hidden, [], 'shifted says the text was read before, so every line must be in the cache')
  }
})