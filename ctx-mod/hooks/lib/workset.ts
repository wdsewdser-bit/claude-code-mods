import type { Anchor, Config, FileActivity, Snippet } from './types.ts'
import { estimateTokens } from './types.ts'

/** Two spellings of one path must map to one file: Windows folds slashes and case. */
export const pathKey = (path: string): string =>
  path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')

/** The same file spelled two ways is one file; read one field of a call the model wrote, never trusting the shape. */
const field = (input: Readonly<Record<string, unknown>>, name: string): unknown =>
  typeof input === 'object' && input !== null ? input[name] : undefined

const asPath = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

const asLine = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** The first non-blank line an Edit wrote: the text a later read of the file can be searched for. */
const hintOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  for (const row of value.split('\n')) {
    const line = row.trim()
    if (line !== '') return line.slice(0, 200)
  }

  return undefined
}

export type FileState = {
  /** The spelling of the newest activity that touched the file. */
  path: string
  lastOp: FileActivity['op']
  lastSeq: number
  reads: number
  edits: number
  lastReadSeq?: number
  lastEditSeq?: number
  isEditedSinceRead: boolean
}

/** Turns one tool call into the file activity the working set is built from; null when no file was touched. */
export const activityOf = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  meta: { seq: number; window: number; isError: boolean },
): FileActivity | null => {
  const base = (path: string, op: FileActivity['op']): FileActivity => ({
    path,
    op,
    seq: meta.seq,
    window: meta.window,
    isError: meta.isError,
  })

  if (tool === 'Read') {
    const path = asPath(field(input, 'file_path'))
    if (path === undefined) return null
    const activity = base(path, 'read')
    const offset = asLine(field(input, 'offset'))
    const limit = asLine(field(input, 'limit'))
    if (offset !== undefined) {
      activity.startLine = offset
      if (limit !== undefined) activity.endLine = offset + limit - 1
    }

    return activity
  }

  if (tool === 'Edit') {
    const path = asPath(field(input, 'file_path'))
    if (path === undefined) return null
    const activity = base(path, 'edit')
    const hint = hintOf(field(input, 'new_string'))
    if (hint !== undefined) activity.hint = hint

    return activity
  }

  if (tool === 'Write') {
    const path = asPath(field(input, 'file_path'))

    return path === undefined ? null : base(path, 'write')
  }

  if (tool === 'NotebookEdit') {
    const path = asPath(field(input, 'notebook_path'))

    return path === undefined ? null : base(path, 'edit')
  }

  if (tool === 'Grep' || tool === 'Glob') {
    const path = asPath(field(input, 'path'))

    return path === undefined ? null : base(path, 'search')
  }

  return null
}

/** One row per file the window worked in, newest activity first; failures and searches say nothing about the file. */
export const filesOf = (activities: readonly FileActivity[], window?: number): FileState[] => {
  const rows = new Map<string, FileState>()

  for (const activity of activities) {
    if (activity.isError || activity.op === 'search') continue
    if (window !== undefined && activity.window !== window) continue
    const key = pathKey(activity.path)
    let row = rows.get(key)
    if (row === undefined) {
      row = {
        path: activity.path,
        lastOp: activity.op,
        lastSeq: activity.seq,
        reads: 0,
        edits: 0,
        isEditedSinceRead: false,
      }
      rows.set(key, row)
    }
    if (activity.seq >= row.lastSeq) {
      row.lastSeq = activity.seq
      row.lastOp = activity.op
      row.path = activity.path
    }
    if (activity.op === 'read') {
      row.reads += 1
      if (row.lastReadSeq === undefined || activity.seq > row.lastReadSeq) {
        row.lastReadSeq = activity.seq
      }
    } else {
      row.edits += 1
      if (row.lastEditSeq === undefined || activity.seq > row.lastEditSeq) {
        row.lastEditSeq = activity.seq
      }
    }
  }

  const out = [...rows.values()]
  for (const row of out) {
    row.isEditedSinceRead =
      row.lastEditSeq !== undefined &&
      (row.lastReadSeq === undefined || row.lastEditSeq > row.lastReadSeq)
  }

  return out.sort((a, b) => b.lastSeq - a.lastSeq)
}

export type Located =
  | { kind: 'ok'; line: number }
  | { kind: 'no-match' }
  | { kind: 'ambiguous'; count: number }

const lineAt = (text: string, at: number): number => {
  let line = 1
  for (let i = 0; i < at; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }

  return line
}

/** Finds the anchor text as one exact substring; line endings are folded so a saved \r never hides it. */
export const locate = (fileText: string, match: string): Located => {
  if (match === '') return { kind: 'no-match' }
  const text = fileText.replace(/\r\n/g, '\n')
  const needle = match.replace(/\r\n/g, '\n')
  let count = 0
  let at = text.indexOf(needle)
  if (at === -1) return { kind: 'no-match' }
  const first = at
  while (at !== -1) {
    count += 1
    at = text.indexOf(needle, at + 1)
  }

  return count === 1 ? { kind: 'ok', line: lineAt(text, first) } : { kind: 'ambiguous', count }
}

/** Takes the lines around `line`, numbered: enough for the model to edit straight away, cut at the file's edges. */
export const cut = (
  fileText: string,
  line: number,
  around: number,
): { startLine: number; endLine: number; text: string } => {
  const lines = fileText.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const total = lines.length
  // A line number from a damaged ledger must still give a usable slice: no empty range, no NaN in the text.
  if (total === 0) return { startLine: 1, endLine: 0, text: '' }
  const span = Number.isFinite(around) ? Math.max(0, Math.trunc(around)) : 0
  const at = Number.isFinite(line) ? Math.min(Math.max(1, Math.trunc(line)), total) : 1
  const startLine = Math.max(1, at - span)
  const endLine = Math.min(total, at + span)
  const rows: string[] = []
  for (let n = startLine; n <= endLine; n += 1) {
    rows.push(`${n}\t${lines[n - 1] ?? ''}`)
  }

  return { startLine, endLine, text: rows.join('\n') }
}

export type FileContent = string | { missing: true } | { tooLarge: true }
export type OpenTask = { taskId: string; anchors: readonly Anchor[] }

type HintEdit = { path: string; hint: string; seq: number }

/**
 * An anchor arrives from a ledger file written by an older version, so every field is checked and
 * a broken one is dropped rather than thrown on: a task with no anchor left is simply anchor-less.
 */
const goodAnchors = (anchors: unknown): Anchor[] => {
  if (!Array.isArray(anchors)) return []
  const out: Anchor[] = []
  for (const entry of anchors) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const path = asPath(record['path'])
    const match = record['match']
    if (path === undefined || typeof match !== 'string' || match === '') continue
    const note = record['note']
    out.push({ path, match, note: typeof note === 'string' ? note : '' })
  }

  return out
}

/** Reads an anchor list off a task row that may itself be damaged; the text of a bad id is left empty. */
const goodTask = (task: unknown): { taskId: string; anchors: readonly Anchor[] } => {
  if (typeof task !== 'object' || task === null) return { taskId: '', anchors: [] }
  const record = task as { taskId?: unknown; anchors?: unknown }

  return {
    taskId: typeof record.taskId === 'string' ? record.taskId : '',
    anchors: goodAnchors(record.anchors),
  }
}

const goodActivities = (activities: readonly FileActivity[]): readonly FileActivity[] =>
  Array.isArray(activities) ? activities : []

/** Where a task with no anchors left us: the newest edits, one per file, at most three. */
const hintEdits = (activities: readonly FileActivity[], window?: number): HintEdit[] => {
  const sorted = activities
    .filter(
      activity =>
        !activity.isError &&
        activity.op === 'edit' &&
        (window === undefined || activity.window === window),
    )
    .sort((a, b) => b.seq - a.seq)
  const picked: HintEdit[] = []
  const seen = new Set<string>()
  for (const activity of sorted) {
    const hint = activity.hint
    if (hint === undefined || hint === '') continue
    const key = pathKey(activity.path)
    if (seen.has(key)) continue
    seen.add(key)
    picked.push({ path: activity.path, hint, seq: activity.seq })
    if (picked.length === 3) break
  }

  return picked
}

/** The new window's own reads see the old file, not what the file looks like now: the hint files come along. */
const lastReadSeq = (activities: readonly FileActivity[], path: string): number | undefined => {
  const key = pathKey(path)
  let last: number | undefined
  for (const activity of activities) {
    if (activity.isError || activity.op !== 'read') continue
    if (pathKey(activity.path) !== key) continue
    if (last === undefined || activity.seq > last) last = activity.seq
  }

  return last
}

/** Files the caller must read before the switch: every anchor's file, plus a fallback for anchor-less tasks. */
export const pathsToRead = (
  tasks: readonly OpenTask[],
  activities: readonly FileActivity[],
  window?: number,
): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  const list: readonly unknown[] = Array.isArray(tasks) ? tasks : []
  const acts = goodActivities(activities)
  let wantsFallback = false
  const add = (path: string): void => {
    const key = pathKey(path)
    if (seen.has(key)) return
    seen.add(key)
    out.push(path)
  }

  for (const raw of list) {
    const task = goodTask(raw)
    if (task.anchors.length === 0) wantsFallback = true
    for (const anchor of task.anchors) add(anchor.path)
  }
  if (wantsFallback) {
    for (const edit of hintEdits(acts, window)) add(edit.path)
  }

  return out
}

/**
 * Turns the disk contents the caller read into the text around each anchor, within a token budget;
 * an anchor that no longer resolves is reported as needing a re-read, never guessed at.
 */
export const snippetsOf = (
  input: {
    tasks: readonly OpenTask[]
    files: ReadonlyMap<string, FileContent>
    activities: readonly FileActivity[]
    window?: number
  },
  config: Config,
): Snippet[] => {
  const out: Snippet[] = []
  const seen = new Set<string>()
  const list: readonly unknown[] = Array.isArray(input.tasks) ? input.tasks : []
  const acts = goodActivities(input.activities)
  let budget = 0
  let count = 0

  const needsRead = (path: string, taskId: string, note: string, reason: string): void => {
    const key = `${taskId}\u0000${pathKey(path)}\u0000${reason}`
    if (seen.has(key)) return
    seen.add(key)
    const seq = lastReadSeq(acts, path)
    out.push(
      seq === undefined
        ? { path, taskId, note, needsRead: reason }
        : { path, taskId, note, needsRead: reason, lastSeq: seq },
    )
  }

  const snippet = (path: string, taskId: string, note: string, startLine: number, text: string): void => {
    const key = `${taskId}\u0000${pathKey(path)}\u0000#${startLine}`
    if (seen.has(key)) return
    seen.add(key)
    const tokens = estimateTokens(text)
    if (count > 0 && budget + tokens > config.snippetTokens) {
      needsRead(path, taskId, note, '超出片段预算')
      return
    }
    budget += tokens
    count += 1
    out.push({ path, taskId, note, startLine, text })
  }

  const fromFile = (path: string, taskId: string, note: string, match: string): void => {
    const content = input.files.get(pathKey(path))
    if (content === undefined || typeof content !== 'string') {
      const isTooLarge = typeof content === 'object' && content !== null && 'tooLarge' in content
      needsRead(path, taskId, note, isTooLarge ? '文件太大，没有取片段' : '文件不存在或没有读到')
      return
    }
    const at = locate(content, match)
    if (at.kind === 'no-match') {
      needsRead(path, taskId, note, '在文件里找不到锚点原文')
      return
    }
    if (at.kind === 'ambiguous') {
      needsRead(path, taskId, note, `锚点原文出现了 ${at.count} 次，无法唯一定位`)
      return
    }
    const part = cut(content, at.line, config.snippetLines)
    snippet(path, taskId, note, part.startLine, part.text)
  }

  let didFallback = false
  for (const raw of list) {
    const task = goodTask(raw)
    if (task.anchors.length === 0) {
      if (didFallback) continue
      didFallback = true
      for (const edit of hintEdits(acts, input.window)) {
        const content = input.files.get(pathKey(edit.path))
        if (typeof content !== 'string') continue
        const at = locate(content, edit.hint)
        if (at.kind !== 'ok') continue
        const part = cut(content, at.line, config.snippetLines)
        snippet(edit.path, task.taskId, '最近改动的位置', part.startLine, part.text)
      }
      continue
    }
    for (const anchor of task.anchors) {
      fromFile(anchor.path, task.taskId, anchor.note, anchor.match)
    }
  }

  return out
}

/**
 * A path shown relative to the working directory, for text the model reads. A path outside
 * the directory, one that is already relative, or no directory at all leaves it as it was;
 * what is stored on disk is never passed through here.
 */
export const relativePath = (path: string, base: string | undefined): string => {
  if (base === undefined) return path
  const root = base.replace(/[\\/]+$/, '')
  if (root === '') return path
  // Windows folds case, and a drive-letter or backslash root marks it; a POSIX path keeps its case.
  const isWindows = /^[A-Za-z]:/.test(root) || root.includes('\\')
  const fold = (text: string): string => {
    const slashed = text.replace(/\\/g, '/')

    return isWindows ? slashed.toLowerCase() : slashed
  }
  const prefix = `${fold(root)}/`
  const full = fold(path)
  // Backslash and slash are the same length, so the cut in the folded text is the cut in the original.
  if (!full.startsWith(prefix) || full.length === prefix.length) return path

  return path.slice(prefix.length)
}

/** How many working-set rows the model is shown before the rest are only counted. */
export const MAX_LISTED_FILES = 30

/**
 * The block a brand-new window reads first: what was worked in, and the exact places to carry on from.
 * With a `base` (the working directory) the paths shown are relative to it where they lie inside it.
 */
export const renderWorkset = (
  files: readonly FileState[],
  snippets: readonly Snippet[],
  /** Tasks whose anchors were carried over from an earlier entry, by the entry's seq. */
  inherited: ReadonlyMap<string, number> = new Map(),
  base?: string,
): string => {
  const lines: string[] = ['【文件工作集】']
  const shown = (path: string): string => relativePath(path, base)
  const isShortened =
    base !== undefined &&
    (files.slice(0, MAX_LISTED_FILES).some(file => shown(file.path) !== file.path) ||
      snippets.some(snippet => shown(snippet.path) !== snippet.path))
  if (isShortened) lines.push(`路径相对工作目录 ${base}`)
  if (files.length === 0) {
    lines.push('本窗口没有读写过文件')
  } else {
    for (const file of files.slice(0, MAX_LISTED_FILES)) {
      const edited = file.isEditedSinceRead ? ' · 改后未重读' : ''
      lines.push(
        `${shown(file.path)} · 读 ${file.reads} 次/改 ${file.edits} 次 · 最后活动 #${file.lastSeq}${edited}`,
      )
    }
    if (files.length > MAX_LISTED_FILES) lines.push(`另有 ${files.length - MAX_LISTED_FILES} 个`)
  }

  if (snippets.length > 0) {
    lines.push('', '【待改位置】')
    const marked = new Set<string>()
    for (const snippet of snippets) {
      // Marked once per task, on its first row, so the section is not repeated at every anchor.
      const from = inherited.get(snippet.taskId)
      const mark =
        from === undefined || marked.has(snippet.taskId) ? '' : `（沿用 #L${from} 的记录，可能已过时）`
      marked.add(snippet.taskId)
      if (snippet.needsRead !== undefined) {
        const seen =
          snippet.lastSeq === undefined ? '' : `（上次读取见 #${snippet.lastSeq}）`
        lines.push(
          `- 任务 ${snippet.taskId}${mark} · ${shown(snippet.path)} · ${snippet.note} · 需重读：${snippet.needsRead}${seen}`,
        )
        continue
      }
      lines.push(`- 任务 ${snippet.taskId}${mark} · ${shown(snippet.path)}:${snippet.startLine} · ${snippet.note}`)
      lines.push('```')
      lines.push(snippet.text)
      lines.push('```')
    }
  }

  return lines.join('\n')
}
