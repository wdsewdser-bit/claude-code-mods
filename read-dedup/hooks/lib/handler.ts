// The decision for one successful plain-text Read: pass it through, or replace its text. Host-free (liveness is injected).
import { MIN_SAVE_CHARS, align, commit, makeProbe, normPath, planRead } from './dedup.ts'
import type { Lines, Parsed } from './dedup.ts'

export type Store = {
  /** `${agentId}|${normPath}` -> cached lines */
  files: Map<string, Lines>
  /** same key -> the last Read of that file by that agent */
  last: Map<string, { range: string; omitted: boolean }>
  /** tool_use_id -> a fragment of the text that result showed */
  probes: Map<string, string>
  /** total characters saved by replacing duplicate Read results */
  savedChars: number
}

const MAX_FILES = 100
const MAX_LINES_PER_FILE = 60000
const MAX_PROBES = 4000

export function createStore(): Store {
  return { files: new Map(), last: new Map(), probes: new Map(), savedChars: 0 }
}

export type ReadCall = { id: string | undefined; agentId: string | undefined; filePath: string }
/** `content` set -> show this instead of the real text; unset -> pass the real result through. */
export type Decision = { content?: string; note: string; savedChars: number }
/**
 * Bash reads share this state with Read, but only an unchanged same-range hit may replace command output;
 * a diff/shifted/full outcome runs as it is (and is still recorded by the pass-through path).
 */
export type DecideOptions = {
  onlySame?: boolean
  /** Skip the "not worth replacing" floor. A Bash hit is always an identical repeat of the same command, so its stub is the point, not the byte saving. */
  minSave?: number
}

function remember(store: Store, key: string, lines: Lines): void {
  store.files.delete(key)
  if (lines.size <= MAX_LINES_PER_FILE) store.files.set(key, lines)
  while (store.files.size > MAX_FILES) {
    const oldest = store.files.keys().next().value as string
    store.files.delete(oldest)
    store.last.delete(oldest)
  }
}

function setProbe(store: Store, id: string, probe: string): void {
  store.probes.set(id, probe)
  while (store.probes.size > MAX_PROBES) store.probes.delete(store.probes.keys().next().value as string)
}

/** An Edit/Write/NotebookEdit of the file finished: a re-read after it is not a "doubt", so drop the escape-hatch flag (cached lines stay -> next Read gives a diff). */
export function noteEdit(store: Store, agentId: string | undefined, filePath: unknown): void {
  const norm = normPath(filePath)
  if (!norm) return
  const key = `${agentId ?? ''}|${norm}`
  const prev = store.last.get(key)
  if (prev) prev.omitted = false
}

export async function decide(
  store: Store,
  call: ReadCall,
  parsed: Parsed,
  live: (ids: string[]) => Promise<boolean>,
  opts?: DecideOptions,
): Promise<Decision> {
  const { id } = call
  if (!id) return { note: 'no tool_use_id', savedChars: 0 }
  const norm = normPath(parsed.filePath) ?? normPath(call.filePath)
  if (!norm) return { note: 'path not absolute', savedChars: 0 }
  const key = `${call.agentId ?? ''}|${norm}`
  const a = parsed.start
  const nt = parsed.lines
  const b = a + nt.length - 1
  const range = `${a}-${b}`
  const fullLen = nt.reduce((s, l) => s + l.length + 1, 0)
  const entry = store.files.get(key)
  const prev = store.last.get(key)

  const passFull = (note: string, ops?: Parameters<typeof commit>[4]): Decision => {
    const lines: Lines = entry ?? new Map()
    commit(lines, a, nt, id, entry ? (ops ?? align(entry, a, nt, parsed.total)) : undefined, 'all')
    remember(store, key, lines)
    setProbe(store, id, makeProbe(nt))
    store.last.set(key, { range, omitted: false })
    return { note, savedChars: 0 }
  }

  if (!entry) return passFull('first read of this file')
  if (prev?.omitted && prev.range === range) return passFull('escape hatch: same range read again right after an omission')
  if (fullLen < (opts?.minSave ?? MIN_SAVE_CHARS)) return passFull('small read')

  const plan = planRead(entry, a, nt, parsed.total, call.filePath, fullLen)
  if (plan.kind === 'full') return passFull(`full: ${plan.reason}`, plan.ops)
  if (opts?.onlySame === true && plan.kind !== 'same') return passFull(`bash: ${plan.kind}`, plan.ops)
  if (plan.need.length > 0 && !(await live(plan.need))) return passFull('full: an earlier Read result is no longer in the context', plan.ops)

  const text = plan.text as string
  const saved = Math.max(0, fullLen - text.length)
  const shown = plan.displayed ?? new Set<number>()
  commit(entry, a, nt, id, plan.ops, shown)
  remember(store, key, entry)
  if (plan.kind === 'diff') {
    setProbe(store, id, makeProbe([...shown].sort((x, y) => x - y).map(n => nt[n - a] as string)))
  }
  store.last.set(key, { range, omitted: true })
  store.savedChars += saved
  return { content: text, note: plan.kind, savedChars: saved }
}
