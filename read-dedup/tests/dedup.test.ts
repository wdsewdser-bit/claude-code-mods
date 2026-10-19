import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commit, planRead } from '../hooks/lib/dedup.ts'
import type { Lines } from '../hooks/lib/dedup.ts'

const file = (n: number, f: (i: number) => string = i => `row ${i} gamma`) => Array.from({ length: n }, (_, i) => f(i + 1))
const slice = (all: string[], a: number, b: number) => all.slice(a - 1, b)
const full = (lines: string[]) => lines.join('\n').length + 1000

function seed(all: string[], a: number, b: number): Lines {
  const old: Lines = new Map()
  commit(old, a, slice(all, a, b), 'r1', undefined, 'all')
  return old
}

test('overlap 1-50 then 30-80: only 51-80 shown as unseen', () => {
  const all = file(100)
  const old = seed(all, 1, 50)
  const nt = slice(all, 30, 80)
  const p = planRead(old, 30, nt, 100, 'f', full(nt))
  assert.equal(p.kind, 'diff')
  assert.match(p.text as string, /此前未见 第 51.80 行/)
  assert.ok(!(p.text as string).includes('row 40 gamma'))
  assert.ok((p.text as string).includes('51\trow 51 gamma') && (p.text as string).includes('80\trow 80 gamma'))
  assert.deepEqual([...(p.displayed as Set<number>)].sort((x, y) => x - y)[0], 51)
  assert.deepEqual(p.need, ['r1'])
})

test('overlap with unseen prefix: 30-80 then 1-50', () => {
  const all = file(100)
  const old = seed(all, 30, 80)
  const nt = slice(all, 1, 50)
  const p = planRead(old, 1, nt, 100, 'f', full(nt))
  assert.equal(p.kind, 'diff')
  assert.match(p.text as string, /此前未见 第 1.29 行/)
  assert.ok(!(p.text as string).includes('row 40 gamma'))
})

test('pure extension 1-50 then 1-80', () => {
  const all = file(100)
  const old = seed(all, 1, 50)
  const nt = slice(all, 1, 80)
  const p = planRead(old, 1, nt, 100, 'f', full(nt))
  assert.equal(p.kind, 'diff')
  assert.match(p.text as string, /此前未见 第 51.80 行/)
})

test('change in seen part plus unseen tail: small change shown as hunk, ratio uses seen size', () => {
  const all = file(100)
  const old = seed(all, 1, 50)
  const now = file(100, i => (i === 40 ? 'changed 40' : `row ${i} gamma`))
  const nt = slice(now, 30, 80)
  const p = planRead(old, 30, nt, 100, 'f', full(nt))
  assert.equal(p.kind, 'diff')
  assert.ok((p.text as string).includes('+40\tchanged 40'))
  assert.ok((p.text as string).includes('-40\trow 40 gamma'))
  assert.match(p.text as string, /此前未见 第 51.80 行/)
})

test('more than 30% of seen part changed -> full', () => {
  const all = file(100)
  const old = seed(all, 1, 50)
  const now = file(100, i => (i >= 31 && i <= 40 ? `x${i}` : `row ${i} gamma`))
  const nt = slice(now, 30, 80) // seen 30-50 = 21 lines, 10 changed -> 20 ops > 6.3
  const p = planRead(old, 30, nt, 100, 'f', full(nt))
  assert.equal(p.kind, 'full')
})

test('identical re-read -> same', () => {
  const all = file(100)
  const old = seed(all, 1, 50)
  const nt = slice(all, 1, 50)
  assert.equal(planRead(old, 1, nt, 100, 'f', full(nt)).kind, 'same')
})

test('disjoint range -> full', () => {
  const all = file(200)
  const old = seed(all, 1, 50)
  const nt = slice(all, 120, 170)
  assert.equal(planRead(old, 120, nt, 200, 'f', full(nt)).kind, 'full')
})

test('commit after overlap marks unseen lines as this read', () => {
  const all = file(100)
  const old = seed(all, 1, 50)
  const nt = slice(all, 30, 80)
  const p = planRead(old, 30, nt, 100, 'f', full(nt))
  commit(old, 30, nt, 'r2', p.ops, p.displayed as Set<number>)
  assert.equal(old.get(40)?.src, 'r1')
  assert.equal(old.get(60)?.src, 'r2')
  assert.equal(old.get(10)?.src, 'r1')
})

test('stripGutter removes the host 1..N gutter only', async () => {
  const { stripGutter } = await import('../hooks/lib/dedup.ts')
  const s = '1\t[read-dedup] head\n2\t@@ 此前未见 第 51–52 行（原文） @@\n3\t51\trow 51\n4\t52\trow 52\n\n<system-reminder>x</system-reminder>'
  assert.equal(stripGutter(s), '[read-dedup] head\n@@ 此前未见 第 51–52 行（原文） @@\n51\trow 51\n52\trow 52\n\n<system-reminder>x</system-reminder>')
  assert.equal(stripGutter('     1→a\n     2→b'), 'a\nb')
})
