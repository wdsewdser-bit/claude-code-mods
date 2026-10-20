// Pure logic of read-dedup: path normalisation, Read-result parsing, line alignment, diff text, cache bookkeeping.
// No host access here (the module runtime has no Node/DOM), so it is unit-testable in plain node.

/** One cached line: its text, and the tool_use_id of the Read result that put it in the context. */
export type Line = { t: string; src: string }
/** line number -> line, as of the last time the file was read. */
export type Lines = Map<number, Line>

export const CONTEXT_LINES = 3
export const MAX_CHANGE_RATIO = 0.3
/** How many cached lines before/after the requested range may take part in the alignment. */
export const WINDOW = 400
export const MAX_CELLS = 8_000_000
/** A read whose full text is shorter than this is never worth rewriting. */
export const MIN_SAVE_CHARS = 300

export type Op = { k: 'eq' | 'add' | 'del'; o?: number; n?: number }

export type Parsed = { filePath: string; start: number; lines: string[]; total: number }

// ---------- path ----------

/** Absolute path -> comparison key: slashes unified, `.`/`..` resolved, case folded on Windows-style paths. */
export function normPath(p: unknown): string | undefined {
  if (typeof p !== 'string' || p === '') return undefined
  let s = p.replace(/\\/g, '/')
  const isDrive = /^[A-Za-z]:\//.test(s)
  const isUnc = s.startsWith('//')
  if (!isDrive && !isUnc && !s.startsWith('/')) return undefined // relative: do not guess
  const prefix = isDrive ? s.slice(0, 2) : isUnc ? '//' : ''
  const rest = s.slice(prefix.length)
  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  s = prefix + '/' + out.join('/')
  return isDrive || isUnc ? s.toLowerCase() : s
}

/**
 * Absolute or cwd-relative path -> an absolute path with slashes unified and '.'/'..' resolved, case kept
 * (normPath folds case for the comparison key). Undefined when it cannot be made absolute.
 */
export function resolvePath(cwd: unknown, p: unknown): string | undefined {
  if (typeof p !== 'string' || p === '') return undefined
  const s = p.replace(/\\/g, '/')
  const isAbs = /^[A-Za-z]:\//.test(s) || s.startsWith('//') || s.startsWith('/')
  let full: string
  if (isAbs) full = s
  else {
    if (typeof cwd !== 'string' || cwd === '') return undefined
    full = cwd.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + s
  }
  const drive = /^[A-Za-z]:/.exec(full)
  const unc = drive === null && full.startsWith('//')
  const prefix = drive !== null ? full.slice(0, 2) : unc ? '//' : ''
  const out: string[] = []
  for (const seg of full.slice(prefix.length).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  if (out.length === 0 && prefix === '') return '/'
  return prefix + '/' + out.join('/')
}

// ---------- parsing ----------

/**
 * Reads the plain-text Read record: `{ type: 'text', file: { filePath, content, numLines, startLine, totalLines } }`.
 * `content` is the raw text; a `N<TAB|→>text` numbered form is stripped too. Anything that does not add up -> undefined.
 */
export function parseReadResult(res: unknown): Parsed | undefined {
  if (typeof res !== 'object' || res === null) return undefined
  const r = res as { type?: unknown; file?: unknown }
  if (r.type !== 'text' || typeof r.file !== 'object' || r.file === null) return undefined
  const f = r.file as { filePath?: unknown; content?: unknown; numLines?: unknown; startLine?: unknown; totalLines?: unknown }
  if (typeof f.filePath !== 'string' || typeof f.content !== 'string') return undefined
  const start = f.startLine
  const numLines = f.numLines
  if (typeof start !== 'number' || !Number.isInteger(start) || start < 1) return undefined
  if (typeof numLines !== 'number' || !Number.isInteger(numLines) || numLines < 1) return undefined
  let lines = f.content.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (lines.length === numLines + 1 && lines[lines.length - 1] === '') lines = lines.slice(0, -1)
  if (lines.length !== numLines) return undefined
  // Defensive: content already carrying "N<TAB>text" / "N→text" for consecutive N from startLine.
  const numbered = lines.map(l => /^\s*(\d+)[\t→](.*)$/s.exec(l))
  if (numbered.every((m, i) => m !== null && Number(m[1]) === start + i)) {
    lines = numbered.map(m => (m as RegExpExecArray)[2] as string)
  }
  const total = typeof f.totalLines === 'number' && f.totalLines >= 1 ? f.totalLines : start + numLines - 1
  return { filePath: f.filePath, start, lines, total }
}

// ---------- alignment ----------

/** Aligns the freshly read lines `nt` (numbered from `a`) with the cached lines. Undefined when too large to align. */
export function align(old: Lines, a: number, nt: string[], total: number): Op[] | undefined {
  const n = nt.length
  const b = a + n - 1
  const ops: Op[] = []
  let p = 0
  while (p < n && old.get(a + p)?.t === nt[p]) p++
  for (let i = 0; i < p; i++) ops.push({ k: 'eq', o: a + i, n: a + i })
  const reachesEnd = b >= total
  if (p < n || reachesEnd) {
    const from = p === 0 ? Math.max(1, a - WINDOW) : a + p
    let to = b + WINDOW
    if (reachesEnd) for (const k of old.keys()) if (k > to) to = k // the file may have shrunk: look at every cached tail line
    const oNums: number[] = []
    const oTxt: string[] = []
    for (let k = from; k <= to; k++) {
      const l = old.get(k)
      if (l !== undefined) {
        oNums.push(k)
        oTxt.push(l.t)
      }
    }
    const nn = n - p
    const m = oNums.length
    if ((nn + 1) * (m + 1) > MAX_CELLS) return undefined
    // intern strings to ints
    const ids = new Map<string, number>()
    const intern = (s: string): number => {
      let v = ids.get(s)
      if (v === undefined) {
        v = ids.size
        ids.set(s, v)
      }
      return v
    }
    const X = new Int32Array(nn)
    for (let i = 0; i < nn; i++) X[i] = intern(nt[p + i] as string)
    const Y = new Int32Array(m)
    for (let j = 0; j < m; j++) Y[j] = intern(oTxt[j] as string)
    const W = m + 1
    const L = new Int32Array((nn + 1) * W)
    for (let i = nn - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * W + j] =
          X[i] === Y[j] ? (L[(i + 1) * W + j + 1] as number) + 1 : Math.max(L[(i + 1) * W + j] as number, L[i * W + j + 1] as number)
      }
    }
    const mid: Op[] = []
    let i = 0
    let j = 0
    while (i < nn && j < m) {
      if (X[i] === Y[j]) {
        mid.push({ k: 'eq', o: oNums[j], n: a + p + i })
        i++
        j++
      } else if ((L[i * W + j + 1] as number) >= (L[(i + 1) * W + j] as number)) {
        mid.push({ k: 'del', o: oNums[j] })
        j++
      } else {
        mid.push({ k: 'add', n: a + p + i })
        i++
      }
    }
    while (i < nn) mid.push({ k: 'add', n: a + p + i++ })
    while (j < m) mid.push({ k: 'del', o: oNums[j++] })
    for (const op of mid) ops.push(op)
  }
  // Drop "deletions" that only reflect the alignment window reaching beyond the requested range.
  let fe = -1
  let le = -1
  for (let i = 0; i < ops.length; i++) {
    if ((ops[i] as Op).k === 'eq') {
      if (fe < 0) fe = i
      le = i
    }
  }
  const out: Op[] = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Op
    if (op.k !== 'del') {
      out.push(op)
      continue
    }
    const o = op.o as number
    if (fe < 0) {
      if (o >= a && (o <= b || reachesEnd)) out.push(op)
    } else if (i < fe) {
      const first = ops[fe] as Op
      // a range that starts at line 1 has nothing before it: every leading old line is a real deletion
      if (a === 1 || o - ((first.o as number) - (first.n as number)) >= a) out.push(op)
    } else if (i > le) {
      const last = ops[le] as Op
      if (reachesEnd || o - ((last.o as number) - (last.n as number)) <= b) out.push(op)
    } else {
      out.push(op)
    }
  }
  return out
}

// ---------- planning ----------

export type Plan = {
  kind: 'same' | 'shifted' | 'diff' | 'full'
  reason?: string
  ops?: Op[]
  /** the one-line message (same/shifted) or the diff text (diff) */
  text?: string
  /** new-line numbers the diff text prints */
  displayed?: Set<number>
  /** tool_use_ids whose Read results must still be in the context for the elision to be honest */
  need: string[]
}

const rangeText = (a: number, b: number) => (a === b ? `${a}` : `${a}–${b}`)

export function sameMessage(path: string, a: number, b: number): string {
  return `[read-dedup] ${path} 第 ${rangeText(a, b)} 行与本上下文中此前读取的内容相同（未改动），未重复返回。如确需原文，立即再读一次同一范围。`
}

export function shiftedMessage(path: string, a: number, b: number, deltas: number[]): string {
  const d = deltas.length === 1 ? `新行号 = 旧行号 ${(deltas[0] as number) >= 0 ? '+' : '-'} ${Math.abs(deltas[0] as number)}` : '各处偏移量不同'
  return `[read-dedup] ${path} 第 ${rangeText(a, b)} 行的文本与本上下文中此前读取的内容相同，但文件别处有增删，行号已偏移（${d}），未重复返回。如确需原文，立即再读一次同一范围。`
}

export function planRead(old: Lines, a: number, nt: string[], total: number, path: string, fullLen: number): Plan {
  const n = nt.length
  const b = a + n - 1
  const ops = align(old, a, nt, total)
  if (!ops) return { kind: 'full', reason: 'too-large', need: [] }
  // "unseen": added lines before the first / after the last matched line whose (shift-corrected) old number was never cached,
  // i.e. the part of the range that only extends past what was read before. Shown on its own, not counted as change.
  let fe = -1
  let le = -1
  for (let i = 0; i < ops.length; i++) {
    if ((ops[i] as Op).k === 'eq') {
      if (fe < 0) fe = i
      le = i
    }
  }
  if (fe < 0) return { kind: 'full', reason: 'no-overlap', ops, need: [] }
  const unseen = new Array<boolean>(ops.length).fill(false)
  const firstEq = ops[fe] as Op
  const lastEq = ops[le] as Op
  for (let i = fe - 1; i >= 0; i--) {
    const op = ops[i] as Op
    if (op.k === 'del') continue
    if (old.has((op.n as number) + (firstEq.o as number) - (firstEq.n as number))) break
    unseen[i] = true
  }
  for (let i = le + 1; i < ops.length; i++) {
    const op = ops[i] as Op
    if (op.k === 'del') continue
    if (old.has((op.n as number) + (lastEq.o as number) - (lastEq.n as number))) break
    unseen[i] = true
  }
  let adds = 0
  let dels = 0
  let unseenCount = 0
  const deltas = new Set<number>()
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Op
    if (unseen[i]) unseenCount++
    else if (op.k === 'add') adds++
    else if (op.k === 'del') dels++
    else deltas.add((op.n as number) - (op.o as number))
  }
  const changes = adds + dels
  const seenN = n - unseenCount
  const srcOf = (o: number) => (old.get(o) as Line).src
  if (changes === 0 && unseenCount === 0) {
    const need = [...new Set(ops.map(op => srcOf(op.o as number)))]
    const shifted = [...deltas].some(d => d !== 0)
    return shifted
      ? { kind: 'shifted', ops, text: shiftedMessage(path, a, b, [...deltas]), need }
      : { kind: 'same', ops, text: sameMessage(path, a, b), need }
  }
  if (changes > MAX_CHANGE_RATIO * seenN) return { kind: 'full', reason: `changed ${changes}/${seenN} > 30%`, ops, need: [] }

  // hunks: every change plus CONTEXT_LINES equal lines each side
  const keep = new Array<boolean>(ops.length).fill(false)
  for (let c = 0; c < ops.length; c++) {
    if ((ops[c] as Op).k === 'eq' || unseen[c]) continue
    keep[c] = true
    for (const dir of [-1, 1]) {
      let cnt = 0
      for (let t = c + dir; t >= 0 && t < ops.length && !unseen[t] && cnt < CONTEXT_LINES; t += dir) {
        keep[t] = true
        if ((ops[t] as Op).k === 'eq') cnt++
      }
    }
  }
  const displayed = new Set<number>()
  const body: string[] = []
  let i = 0
  while (i < ops.length) {
    if (unseen[i]) {
      const block: string[] = []
      let first = 0
      let last = 0
      for (; i < ops.length && unseen[i]; i++) {
        const op = ops[i] as Op
        if (op.k === 'del') continue
        const num = op.n as number
        if (block.length === 0) first = num
        last = num
        displayed.add(num)
        block.push(`${num}	${nt[num - a]}`)
      }
      body.push(`@@ 此前未见 第 ${rangeText(first, last)} 行（原文） @@`, ...block)
      continue
    }
    if (!keep[i]) {
      i++
      continue
    }
    const hunk: string[] = []
    let first: number | undefined
    let last: number | undefined
    for (; i < ops.length && keep[i]; i++) {
      const op = ops[i] as Op
      if (op.k === 'del') {
        hunk.push(`-${op.o}\t${(old.get(op.o as number) as Line).t}`)
        continue
      }
      const num = op.n as number
      first ??= num
      last = num
      displayed.add(num)
      hunk.push(`${op.k === 'add' ? '+' : ' '}${num}\t${nt[num - a]}`)
    }
    body.push(first === undefined ? '@@ @@' : `@@ 新第 ${rangeText(first, last as number)} 行 @@`, ...hunk)
  }
  const head =
    `[read-dedup] ${path} 第 ${rangeText(a, b)} 行：部分或全部此前读取过，只返回变动和此前未见的行（diff 风格：" "上下文，"-"已删除（旧行号），"+"新增/改动（新行号）；` +
    `"此前未见"块为原文；未列出的行与此前读取相同，行号以新行号为准）。如确需原文，立即再读一次同一范围。`
  const text = [head, ...body].join('\n')
  if (text.length >= fullLen) return { kind: 'full', reason: 'diff-not-smaller', ops, need: [] }
  const need = new Set<string>()
  for (const op of ops) if (op.k === 'eq' && !displayed.has(op.n as number)) need.add(srcOf(op.o as number))
  return { kind: 'diff', ops, text, displayed, need: [...need] }
}

/** Removes a leading `1<TAB>`, `2<TAB>`, ... gutter (consecutive from 1, also `N→`) from the lines that carry it; other lines are kept as they are. */
export function stripGutter(text: string): string {
  let next = 1
  return text
    .split('\n')
    .map(l => {
      const m = /^\s*(\d+)[\t→]/.exec(l)
      if (m === null || Number(m[1]) !== next) return l
      next++
      return l.slice(m[0].length)
    })
    .join('\n')
}

// ---------- cache update ----------

/** Folds this read into the cached lines. `displayed` = new-line numbers whose text is in this call's result ('all' for a full result). */
export function commit(old: Lines, a: number, nt: string[], id: string, ops: Op[] | undefined, displayed: Set<number> | 'all'): void {
  const n = nt.length
  const b = a + n - 1
  const oldOf = new Map<number, number>() // new number -> matched old number
  let shifted = ops === undefined
  for (const op of ops ?? []) {
    if (op.k === 'eq') {
      oldOf.set(op.n as number, op.o as number)
      if (op.n !== op.o) shifted = true
    }
  }
  const fresh: Array<[number, Line]> = []
  for (let i = 0; i < n; i++) {
    const num = a + i
    const o = oldOf.get(num)
    const keepOld = displayed !== 'all' && !displayed.has(num) && o !== undefined
    fresh.push([num, { t: nt[i] as string, src: keepOld ? (old.get(o as number) as Line).src : id }])
  }
  for (const op of ops ?? []) if (op.k === 'del') old.delete(op.o as number)
  if (shifted) {
    for (const k of [...old.keys()]) if (k < a || k > b) old.delete(k)
  }
  for (let k = a; k <= b; k++) old.delete(k)
  for (const [k, l] of fresh) old.set(k, l)
}

/** A short ASCII fragment of the text a result shows, to recognise that result in the context later. '' if none fits. */
export function makeProbe(lines: string[]): string {
  for (const l of lines) {
    const t = l.trim()
    if (t.length >= 6 && /^[\x20-\x7e]+$/.test(t)) return t.slice(0, 48)
  }
  return ''
}

const CLEARED = /^\s*\[(old )?(tool )?(result|output|content)[^\]]{0,80}(cleared|removed|truncated|omitted|elided)/i

/** Whether a tool_result's text still looks like the original (not cleared by micro-compaction). */
export function resultStillHolds(text: string, probe: string): boolean {
  if (text.trim() === '') return false
  if (CLEARED.test(text)) return false
  return probe === '' || text.includes(probe)
}

/** Text of a tool_result block's content (string or text blocks). */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('')
}

/** Whether every tool_use_id in `ids` still has its (uncleared) result in the Messages-API rows `messages`. */
export function contextHasResults(messages: unknown[], ids: string[], probes: Map<string, string>): boolean {
  const want = new Set(ids)
  if (want.size === 0) return true
  const ok = new Set<string>()
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const msg = m as { role?: unknown; content?: unknown }
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: unknown; tool_use_id?: unknown; is_error?: unknown; content?: unknown }
      if (b.type !== 'tool_result') continue
      const tid = b.tool_use_id
      if (typeof tid !== 'string' || !want.has(tid) || b.is_error === true) continue
      if (resultStillHolds(blockText(b.content), probes.get(tid) ?? '')) ok.add(tid)
    }
  }
  return ok.size === want.size
}
