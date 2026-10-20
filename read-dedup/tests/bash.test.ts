import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as B from '../hooks/lib/bash.ts'
import * as D from '../hooks/lib/dedup.ts'
import * as H from '../hooks/lib/handler.ts'

const mkLine = i => 'row ' + i + ' ' + 'x'.repeat(40)
const fileLines = n => Array.from({ length: n }, (_, i) => mkLine(i + 1))
const asOutput = (ls, eol = '\n') => ls.join(eol) + eol

/** The read a Bash command would give, or a failed assertion. */
function bashRead(command, stdout, cwd = 'C:\\proj') {
  const cmd = B.parseBashRead(command, cwd)
  assert.ok(cmd, 'parseBashRead should accept: ' + command)
  const p = B.parseBashOutput(cmd, stdout)
  assert.ok(p, 'parseBashOutput should accept the output of: ' + command)
  return p
}

async function doBash(store, p, id, live = async () => true) {
  return H.decide(store, { id, agentId: 'a', filePath: p.filePath }, p, live, { onlySame: true, minSave: 0 })
}

async function doRead(store, p, id, live = async () => true) {
  return H.decide(store, { id, agentId: 'a', filePath: p.filePath }, p, live)
}

// ---------- command parsing ----------

test('bash parse: cat, sed -n a,bp, head -n N resolve to path + line range', () => {
  assert.deepEqual(B.parseBashRead('cat f.txt', 'C:\\proj'), { kind: 'cat', filePath: 'C:/proj/f.txt', start: 1 })
  assert.deepEqual(B.parseBashRead("sed -n '10,20p' f.txt", 'C:\\proj'), { kind: 'sed', filePath: 'C:/proj/f.txt', start: 10, end: 20 })
  assert.deepEqual(B.parseBashRead("sed -n '7p' f.txt", 'C:\\proj'), { kind: 'sed', filePath: 'C:/proj/f.txt', start: 7, end: 7 })
  assert.deepEqual(B.parseBashRead('head -n 50 f.txt', 'C:\\proj'), { kind: 'head', filePath: 'C:/proj/f.txt', start: 1, end: 50 })
  assert.deepEqual(B.parseBashRead('head -n50 f.txt', 'C:\\proj'), undefined)
})

test('bash parse: cd prefix changes the base directory', () => {
  assert.deepEqual(B.parseBashRead('cd "C:\\proj\\sub" && cat f.txt', 'C:\\other'), { kind: 'cat', filePath: 'C:/proj/sub/f.txt', start: 1 })
  assert.deepEqual(B.parseBashRead('cd sub && head -n 3 f.txt', 'C:/proj'), { kind: 'head', filePath: 'C:/proj/sub/f.txt', start: 1, end: 3 })
  assert.deepEqual(B.parseBashRead("cd 'sub dir' && cat g.txt", 'C:/proj'), { kind: 'cat', filePath: 'C:/proj/sub dir/g.txt', start: 1 })
})

test('bash parse: Windows, quoted and relative paths', () => {
  assert.deepEqual(B.parseBashRead('cat "C:\\Other Dir\\g.txt"', 'C:/proj'), { kind: 'cat', filePath: 'C:/Other Dir/g.txt', start: 1 })
  assert.deepEqual(B.parseBashRead('cat ./sub/../f.txt', 'C:/proj'), { kind: 'cat', filePath: 'C:/proj/f.txt', start: 1 })
  // unquoted, the shell eats the backslash too: .\f.txt is the file .f.txt
  assert.deepEqual(B.parseBashRead('cat .\\f.txt', 'C:\\proj'), { kind: 'cat', filePath: 'C:/proj/.f.txt', start: 1 })
  assert.deepEqual(B.parseBashRead('cat C:/proj/f.txt', 'C:/elsewhere'), { kind: 'cat', filePath: 'C:/proj/f.txt', start: 1 })
  // a relative path without a usable cwd cannot be placed
  assert.equal(B.parseBashRead('cat f.txt', undefined), undefined)
})

test('bash parse: anything but one plain read passes through', () => {
  const bad = [
    'cat a.txt b.txt',
    'cat a.txt | head -n 3',
    'cat a.txt > out.txt',
    'cat a.txt >> out.txt',
    'cat < a.txt',
    'cat *.txt',
    'cat $HOME/a.txt',
    'cat ~/a.txt',
    'cat "a$(echo b).txt"',
    'cat -n a.txt',
    'cat a.txt && cat b.txt',
    'cat a.txt; cat b.txt',
    'cd sub && cat f.txt && cat g.txt',
    'cd sub',
    'sed -n "1,20d" a.txt',
    'sed -n "0,20p" a.txt',
    'sed -n "20,10p" a.txt',
    'sed -n "1,20p" a.txt b.txt',
    'sed "1,20p" a.txt',
    'head -n 0 a.txt',
    'head -n -5 a.txt',
    'head a.txt',
    'head -n 5 a.txt b.txt',
    'cat "unterminated',
    "cat 'unterminated",
    'cat a.txt\ncat b.txt',
    'echo cat a.txt',
    '  ',
    '',
  ]
  for (const c of bad) assert.equal(B.parseBashRead(c, 'C:/proj'), undefined, 'should pass through: ' + JSON.stringify(c))
  assert.equal(B.parseBashRead(undefined, 'C:/proj'), undefined)
  assert.equal(B.parseBashRead(42, 'C:/proj'), undefined)
})

// ---------- output parsing ----------

test('bash output: trailing newline and CRLF do not add a line', () => {
  const ls = fileLines(5)
  const lf = bashRead('cat f.txt', asOutput(ls))
  assert.equal(lf.start, 1)
  assert.equal(lf.total, 5)
  assert.deepEqual(lf.lines, ls)
  const crlf = bashRead('cat f.txt', asOutput(ls, '\r\n'))
  assert.deepEqual(crlf.lines, ls)
  assert.equal(crlf.total, 5)
  // no trailing newline: still the same lines
  assert.deepEqual(bashRead('cat f.txt', ls.join('\n')).lines, ls)
})

test('bash output: sed/head ranges and their totals', () => {
  const ls = fileLines(100)
  const sedFull = bashRead("sed -n '10,20p' f.txt", asOutput(ls.slice(9, 20)))
  assert.equal(sedFull.start, 10)
  assert.equal(sedFull.total, Number.MAX_SAFE_INTEGER)
  assert.deepEqual(sedFull.lines, ls.slice(9, 20))
  // the file ended inside the range -> the total is known exactly
  const sedTail = bashRead("sed -n '95,120p' f.txt", asOutput(ls.slice(94)))
  assert.equal(sedTail.start, 95)
  assert.equal(sedTail.total, 100)
  assert.equal(sedTail.lines.length, 6)
  const head = bashRead('head -n 50 f.txt', asOutput(ls.slice(0, 50)))
  assert.equal(head.start, 1)
  assert.equal(head.total, Number.MAX_SAFE_INTEGER)
  // a short file: head got fewer lines than asked for
  const short = bashRead('head -n 50 f.txt', asOutput(ls.slice(0, 3)))
  assert.equal(short.total, 3)
})

test('bash output: not a plain text read -> undefined', () => {
  const ls = fileLines(10)
  assert.equal(B.parseBashOutput(B.parseBashRead('cat f.txt', 'C:/proj'), ''), undefined)
  assert.equal(B.parseBashOutput(B.parseBashRead('cat f.txt', 'C:/proj'), 'a\0b'), undefined)
  assert.equal(B.parseBashOutput(B.parseBashRead('cat f.txt', 'C:/proj'), 42), undefined)
  // more lines than the command asked for: the command did not behave like a plain read
  assert.equal(B.parseBashOutput(B.parseBashRead('head -n 2 f.txt', 'C:/proj'), asOutput(ls)), undefined)
  assert.equal(B.parseBashOutput(B.parseBashRead("sed -n '1,2p' f.txt", 'C:/proj'), asOutput(ls)), undefined)
})

// ---------- dedup decisions ----------

test('bash dedup: the same file and range read twice -> stub', async () => {
  const ls = fileLines(100)
  const store = H.createStore()
  const first = await doBash(store, bashRead('cat f.txt', asOutput(ls)), 'b1')
  assert.equal(first.content, undefined)
  const second = await doBash(store, bashRead('cat f.txt', asOutput(ls)), 'b2')
  assert.equal(typeof second.content, 'string')
  assert.match(second.content, /read-dedup/)
  assert.match(second.content, /未改动/)
  assert.match(second.content, /f\.txt/)
  assert.ok(second.savedChars > 0)
})

test('bash dedup: a different range does not hit', async () => {
  const ls = fileLines(100)
  const store = H.createStore()
  // only lines 1-50 were seen; a full read has unseen lines 51-100, so it must run
  await doBash(store, bashRead("sed -n '1,50p' f.txt", asOutput(ls.slice(0, 50))), 'b1')
  const other = await doBash(store, bashRead('cat f.txt', asOutput(ls)), 'b2')
  assert.equal(other.content, undefined)
  // and now the full file is known: the same full read hits
  const again = await doBash(store, bashRead('cat f.txt', asOutput(ls)), 'b3')
  assert.equal(typeof again.content, 'string')
})

test('bash dedup: a changed file does not hit, and the change is remembered', async () => {
  const before = fileLines(100)
  const after = fileLines(100).map((l, i) => (i === 3 ? 'row 4 CHANGED ' + 'y'.repeat(40) : l))
  const store = H.createStore()
  await doBash(store, bashRead('cat f.txt', asOutput(before)), 'b1')
  const changed = await doBash(store, bashRead('cat f.txt', asOutput(after)), 'b2')
  assert.equal(changed.content, undefined)
  const again = await doBash(store, bashRead('cat f.txt', asOutput(after)), 'b3')
  assert.equal(typeof again.content, 'string')
})

test('bash dedup: escape hatch - the same range right after an omission runs in full', async () => {
  const ls = fileLines(100)
  const store = H.createStore()
  await doBash(store, bashRead('cat f.txt', asOutput(ls)), 'b1')
  assert.equal(typeof (await doBash(store, bashRead('cat f.txt', asOutput(ls)), 'b2')).content, 'string')
  assert.equal((await doBash(store, bashRead('cat f.txt', asOutput(ls)), 'b3')).content, undefined)
})

test('bash dedup: an earlier result gone from the context does not hit', async () => {
  const ls = fileLines(100)
  const store = H.createStore()
  await doBash(store, bashRead('cat f.txt', asOutput(ls)), 'b1')
  const miss = await doBash(store, bashRead('cat f.txt', asOutput(ls)), 'b2', async () => false)
  assert.equal(miss.content, undefined)
})

test('cross: Bash then Read hits, and Read then Bash hits', async () => {
  const ls = fileLines(100)
  const store = H.createStore()
  await doBash(store, bashRead('cat f.txt', asOutput(ls)), 'b1')
  const viaRead = D.parseReadResult({ type: 'text', file: { filePath: 'C:\\proj\\f.txt', content: ls.join('\n'), numLines: ls.length, startLine: 1, totalLines: ls.length } })
  assert.ok(viaRead)
  const r = await doRead(store, viaRead, 'r1')
  assert.equal(typeof r.content, 'string')
  assert.match(r.content, /read-dedup/)

  const store2 = H.createStore()
  const first = D.parseReadResult({ type: 'text', file: { filePath: 'C:\\proj\\f.txt', content: ls.join('\n'), numLines: ls.length, startLine: 1, totalLines: ls.length } })
  await doRead(store2, first, 'r1')
  const b = await doBash(store2, bashRead('cat f.txt', asOutput(ls)), 'b1')
  assert.equal(typeof b.content, 'string')
  assert.match(b.content, /read-dedup/)
})

test('cross: a Bash read only replaces an unchanged same range (a diff still runs)', async () => {
  const ls = fileLines(100)
  const store = H.createStore()
  const first = D.parseReadResult({ type: 'text', file: { filePath: 'C:\\proj\\f.txt', content: ls.join('\n'), numLines: ls.length, startLine: 1, totalLines: ls.length } })
  // Read saw only lines 1-50: a full Bash read has unseen lines, so it runs as is
  const partial = D.parseReadResult({ type: 'text', file: { filePath: 'C:\\proj\\f.txt', content: ls.slice(0, 50).join('\n'), numLines: 50, startLine: 1, totalLines: 100 } })
  assert.ok(partial)
  await doRead(store, partial, 'r1')
  const part = await doBash(store, bashRead('cat f.txt', asOutput(ls)), 'b1')
  assert.equal(part.content, undefined)
})

// Regression: a 15-byte file (rd.txt = l1/l2/MAGIC=rd) is far below MIN_SAVE_CHARS, so the old floor made every
// Bash read pass through and the smoke test never saw a stub. A Bash hit is an identical repeat, so it stubs anyway.
test('bash dedup: a tiny file (below MIN_SAVE_CHARS) still gets a stub', async () => {
  const tiny = ['l1', 'l2', 'MAGIC=rd']
  const store = H.createStore()
  const first = await doBash(store, bashRead('cat rd.txt', asOutput(tiny)), 'b1')
  assert.equal(first.content, undefined)
  const second = await doBash(store, bashRead('cat rd.txt', asOutput(tiny)), 'b2')
  assert.equal(typeof second.content, 'string')
  assert.match(second.content, /未改动/)
  // the Read path keeps its floor: replacing a tiny Read costs more than it saves
  const p = D.parseReadResult({ type: 'text', file: { filePath: 'C:\proj\rd.txt', content: tiny.join('\n'), numLines: 3, startLine: 1, totalLines: 3 } })
  assert.ok(p)
  const store2 = H.createStore()
  await doRead(store2, p, 'r1')
  assert.equal((await doRead(store2, p, 'r2')).content, undefined)
})

