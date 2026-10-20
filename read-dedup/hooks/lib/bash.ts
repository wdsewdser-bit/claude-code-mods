// Recognises Bash commands that are one plain file read (cat FILE, sed -n 'A,Bp' FILE,
// head -n N FILE, optionally behind `cd DIR &&`) and turns their output into the same
// "path + line range" record a Read gives. Anything it cannot parse exactly -> undefined (run as usual).
import { normPath, resolvePath } from './dedup.ts'
import type { Parsed } from './dedup.ts'

export type BashRead = {
  kind: 'cat' | 'sed' | 'head'
  /** absolute path with slashes unified (case kept) */
  filePath: string
  /** first line number, 1-based */
  start: number
  /** last line number the command asks for; undefined for cat (to the end of the file) */
  end?: number
}

type Word = { k: 'w'; text: string }
type Tok = Word | { k: 'op'; text: '&&' }

/** Shell metacharacters that end "one simple read": a pipe, a redirect, a list, a subshell, a comment. */
const META = new Set(['|', ';', '<', '>', '`', '(', ')', '#', '\n', '\r'])
/** Characters a path may not carry: expansion, globbing, brace/tilde expansion. */
const UNSAFE = /[$`*?\[\]{}~!|;<>]/

/** A tiny POSIX-ish tokenizer: quotes concatenate, backslash escapes outside them, && is the only operator. */
function tokenize(s: string): Tok[] | undefined {
  const out: Tok[] = []
  let cur = ''
  let started = false
  let i = 0
  const push = (): void => {
    if (started) out.push({ k: 'w', text: cur })
    cur = ''
    started = false
  }
  while (i < s.length) {
    const c = s[i] as string
    if (c === ' ' || c === '\t') {
      push()
      i++
      continue
    }
    if (META.has(c)) return undefined
    if (c === '&') {
      if (s[i + 1] !== '&') return undefined
      push()
      out.push({ k: 'op', text: '&&' })
      i += 2
      continue
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1)
      if (j < 0) return undefined
      cur += s.slice(i + 1, j)
      started = true
      i = j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      let closed = false
      while (j < s.length) {
        const d = s[j] as string
        if (d === '"') {
          closed = true
          j++
          break
        }
        if (d === '\\') {
          const e = s[j + 1]
          if (e === undefined || e === '\n') return undefined
          if (e === '"' || e === '\\' || e === '$' || e === '`') {
            cur += e
            j += 2
          } else {
            cur += d
            j++
          }
          continue
        }
        cur += d
        j++
      }
      if (!closed) return undefined
      started = true
      i = j
      continue
    }
    if (c === '\\') {
      const e = s[i + 1]
      if (e === undefined || e === '\n') return undefined
      cur += e
      started = true
      i += 2
      continue
    }
    if (UNSAFE.test(c)) return undefined
    cur += c
    started = true
    i++
  }
  push()
  return out
}

function safePath(t: string): boolean {
  return t !== '' && !t.startsWith('-') && !UNSAFE.test(t)
}

function make(kind: BashRead['kind'], base: unknown, raw: string, start: number, end?: number): BashRead | undefined {
  if (!safePath(raw)) return undefined
  const filePath = resolvePath(base, raw)
  if (filePath === undefined) return undefined
  return end === undefined ? { kind, filePath, start } : { kind, filePath, start, end }
}

/**
 * `cat FILE`, `sed -n 'A,Bp' FILE`, `head -n N FILE`, each optionally behind `cd DIR &&`.
 * cwd is the session directory (absolute); undefined means a relative path cannot be placed.
 */
export function parseBashRead(command: unknown, cwd: unknown): BashRead | undefined {
  if (typeof command !== 'string') return undefined
  const src = command.trim()
  if (src === '') return undefined
  const toks = tokenize(src)
  if (toks === undefined || toks.length === 0) return undefined

  let i = 0
  let base = cwd
  const first = toks[0] as Tok
  if (first.k === 'w' && first.text === 'cd') {
    if (toks.length < 4) return undefined
    const dir = toks[1] as Tok
    const sep = toks[2] as Tok
    if (dir.k !== 'w' || sep.k !== 'op') return undefined
    if (!safePath(dir.text)) return undefined
    const resolved = resolvePath(base, dir.text)
    if (resolved === undefined) return undefined
    base = resolved
    i = 3
  }

  const cmd = toks[i] as Tok | undefined
  if (cmd === undefined || cmd.k !== 'w') return undefined
  if (cmd.text === 'cat') {
    if (toks.length !== i + 2) return undefined
    const file = toks[i + 1] as Tok
    if (file.k !== 'w') return undefined
    return make('cat', base, file.text, 1)
  }
  if (cmd.text === 'sed') {
    if (toks.length !== i + 4) return undefined
    const flag = toks[i + 1] as Tok
    const script = toks[i + 2] as Tok
    const file = toks[i + 3] as Tok
    if (flag.k !== 'w' || flag.text !== '-n' || script.k !== 'w' || file.k !== 'w') return undefined
    const m = /^(\d{1,9})(?:,(\d{1,9}))?p$/.exec(script.text)
    if (m === null) return undefined
    const a = Number(m[1] ?? '')
    const b = m[2] === undefined ? a : Number(m[2])
    if (a < 1 || b < a) return undefined
    return make('sed', base, file.text, a, b)
  }
  if (cmd.text === 'head') {
    if (toks.length !== i + 4) return undefined
    const flag = toks[i + 1] as Tok
    const count = toks[i + 2] as Tok
    const file = toks[i + 3] as Tok
    if (flag.k !== 'w' || flag.text !== '-n' || count.k !== 'w' || file.k !== 'w') return undefined
    if (!/^\d{1,9}$/.test(count.text)) return undefined
    const n = Number(count.text)
    if (n < 1) return undefined
    return make('head', base, file.text, 1, n)
  }
  return undefined
}

/** One trailing newline is the line terminator, not a line; CRLF loses its \r (as Read's parser does). */
function splitLines(text: string): string[] {
  let s = text
  if (s.endsWith('\n')) s = s.slice(0, -1)
  return s.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
}

/** A cat/sed/head output larger than this is left alone: the host persists such output anyway. */
const MAX_OUTPUT_CHARS = 2_000_000

/**
 * Turns the command's stdout into a Read-shaped record. Undefined when the output cannot be that read
 * (empty, binary, larger than MAX_OUTPUT_CHARS, or more lines than the command asked for).
 */
export function parseBashOutput(read: BashRead, stdout: unknown): Parsed | undefined {
  if (typeof stdout !== 'string' || stdout === '' || stdout.includes('\0')) return undefined
  if (stdout.length > MAX_OUTPUT_CHARS) return undefined
  const lines = splitLines(stdout)
  if (lines.length === 0) return undefined
  if (read.kind === 'cat') return { filePath: read.filePath, start: 1, lines, total: lines.length }
  const want = (read.end as number) - read.start + 1
  if (lines.length > want) return undefined
  // Fewer lines than asked for: the file ended here, so its total is known. Otherwise it is at least end.
  const total = lines.length < want ? read.start + lines.length - 1 : Number.MAX_SAFE_INTEGER
  return { filePath: read.filePath, start: read.start, lines, total }
}
