// The last keepalive of an idle stretch can do more than answer OK: it can ask
// the model, over the same cached prefix, what is still open in the main
// conversation. Parsed here, published through the plugin's own state, and
// booked by ctx-mod into its ledger when the expired cache makes it switch
// windows. Pure: no engine calls, no clock.

/** How a task the model still has open stands. */
export type SnapshotStatus = 'in_progress' | 'blocked'

/** One still-open task as the keepalive's answer states it. */
export type SnapshotEntry = {
  task_id: string
  title: string
  status: SnapshotStatus
  text: string
  next_step?: string
}

/** The whole answer, stamped with when its request started. */
export type LedgerSnapshot = {
  at: number | null
  entries: SnapshotEntry[]
}

/** What the state slot holds before any keepalive asked. */
export const EMPTY_SNAPSHOT: LedgerSnapshot = { at: null, entries: [] }

/** More open tasks than this are cut: the ledger page is a summary, not a dump. */
export const MAX_SNAPSHOT_ENTRIES = 8

/**
 * The one user message that last keepalive sends. It shares the main
 * conversation's cached prefix like every keepalive, so it costs a little
 * output rather than a rewritten prompt, and it asks for no tool.
 */
export const LEDGER_SNAPSHOT_PROMPT = [
  'Cache keepalive from the cache-keeper plugin. Call no tools and change nothing.',
  'This session goes idle from here, so answer from the conversation as it stands: reply with one JSON array and nothing else.',
  'Each item is a task still in progress or blocked, at most eight:',
  '{"task_id": "...", "title": "...", "status": "in_progress" | "blocked", "text": "...", "next_step": "..."}',
  'Reuse the task_id of the task as the conversation already names it, ledger entries included.',
  '"text" says where the task stands and what a new window has to know; "next_step" says what to do next and is required for in_progress.',
  'Reply with [] when nothing is open.',
].join('\n')

const FENCED = /```(?:json)?\s*([\s\S]*?)```/i

/** The first bracketed run of a text: from the first `[` to the last `]`. */
const bracketed = (text: string): string | null => {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')

  return start === -1 || end <= start ? null : text.slice(start, end + 1)
}

/**
 * The array an answer carries, as it stands, wrapped in a code fence, or with
 * words on either side of it; null when no text of it is an array.
 */
const arrayOf = (text: string): unknown[] | null => {
  const fenced = FENCED.exec(text)?.[1] ?? ''
  const candidates = [fenced, text, bracketed(fenced) ?? '', bracketed(text) ?? '']
  for (const candidate of candidates) {
    if (candidate.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // try the next spelling
    }
  }

  return null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** One item, or null when it lacks a field or states a status the ledger has no use for. */
const entryOf = (value: unknown): SnapshotEntry | null => {
  if (!isRecord(value)) return null
  const taskId = textOf(value.task_id)
  const title = textOf(value.title)
  const text = textOf(value.text)
  const status = value.status
  if (taskId === '' || title === '' || text === '') return null
  if (status !== 'in_progress' && status !== 'blocked') return null
  const nextStep = textOf(value.next_step)

  return {
    task_id: taskId,
    title,
    status,
    text,
    ...(nextStep === '' ? {} : { next_step: nextStep }),
  }
}

/**
 * The entries one answer states, or null when no array can be read out of it:
 * the caller treats that as "no snapshot" and keeps the keepalive's own result.
 * A single bad item is dropped alone.
 */
export const parseSnapshot = (answer: string): SnapshotEntry[] | null => {
  const parsed = arrayOf(answer)
  if (parsed === null) return null
  const entries: SnapshotEntry[] = []
  for (const item of parsed) {
    const entry = entryOf(item)
    if (entry === null) continue
    entries.push(entry)
    if (entries.length >= MAX_SNAPSHOT_ENTRIES) break
  }

  return entries
}
