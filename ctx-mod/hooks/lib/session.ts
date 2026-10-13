// One session's state: it owns the files under `dir`, wires the pure library
// modules together and is the only thing the engine hooks talk to. Nothing here
// reaches the engine, the clock or the disk on its own — every file and every
// timestamp arrives through the injected `Io`, so the module runs in a bare
// interpreter with no fs, no DOM and no timers.

import type {
  Anchor,
  CacheState,
  Config,
  FileActivity,
  HistoryRecord,
  LedgerEntry,
  LedgerInput,
  Overflow,
  Role,
  TaskStatus,
} from './types.ts'
import { estimateTokens, isRelay, parseJsonl, toJsonl } from './types.ts'
import {
  appendRecord,
  byteLength,
  clipRecord,
  createQueue,
  emptyShard,
  loadedTools,
  personRequests,
  repliesAnswered,
  readRecord,
  recentActions,
  search,
  groupsWanted,
  isOwnRow,
  overflowName,
  partOrigin,
  partsCovering,
  shardName,
  sliceBounds,
  splitParts,
  toolGroupOf,
} from './history.ts'
import type { LoadedTool, SearchHit, Shard } from './history.ts'
import { archiveName, hasFreshEntry, pageOf, renderHome, stamp, tasksOf, turnPage, validate } from './ledger.ts'
import type { AnchorCheck, ArchivePage, TaskState } from './ledger.ts'
import { activityOf, filesOf, locate, pathKey, pathsToRead, relativePath, renderWorkset, snippetsOf } from './workset.ts'
import type { FileContent, OpenTask } from './workset.ts'
import { assemble, ENDED_STATE, renderAgents, renderCoverage, renderLoadReason, renderTools, rewriteOf } from './handoff.ts'
import type { RebuiltTool } from './handoff.ts'
import { describeFill, gateSwitch, judgeSwitch, levelOf, percentOf } from './usage.ts'

export type Io = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  now: () => number
  /** Told about every failed write, so the caller can log what the queue would otherwise swallow. */
  onWriteError?: (path: string, error: unknown) => void
  /**
   * The optional file operations the cross-session table (costly.json) can use to be written
   * safely. Each is a no-op fallback when left out: without `claim` the lock is a weaker
   * write-and-read-back check, without `rename` the table is written in place, without
   * `exists` a failed read is told from a missing file by its error text.
   */
  /** Whether the path exists; lets a failed read be told from an absent file. */
  exists?: (path: string) => Promise<boolean>
  /** Creates the file only if it is absent (like open 'wx'): true when this call created it. */
  claim?: (path: string, text: string) => Promise<boolean>
  /** Moves `from` over `to` in one step. */
  rename?: (from: string, to: string) => Promise<void>
  /** Deletes the file; a missing file is not an error. */
  remove?: (path: string) => Promise<void>
  /**
   * The session's working directory. Only the handoff text uses it, to show paths inside it
   * relative to it; what is stored on disk keeps the absolute paths. Left out, paths stay as they are.
   */
  cwd?: () => string | undefined | Promise<string | undefined>
  /** Waits roughly `ms` milliseconds; without it a real timer is used when there is one. */
  sleep?: (ms: number) => Promise<void>
}

export type Env = {
  /** The context tokens the engine last reported; unknown on the first request. */
  tokens: number | undefined
  /** The compaction threshold the fill is measured against. */
  limit: number
  /** cache-keeper's published state, when that mod is loaded at all. */
  cache: CacheState | null
  fiveHourPercent: number | undefined
}

export type ToolResult = { result: string; isError?: true }

/** A switch the model asked for and the gate stood behind, until the turn ends. */
export type Pending = { reason: string; at: number }

/** One conversation row as the engine hands it over; seq, ts and window are ours. */
export type RecordInput = {
  uuid: string
  role: Role
  isPerson?: true
  /** The engine's origin kind of a prompt row, when the caller has it. */
  origin?: string
  tool?: string
  path?: string
  /** A one-line summary of the tool call's input, when the caller has one. */
  input?: string
  isError?: true
  /** The deferred tools a ToolSearch call loaded, when the caller has them. */
  loaded?: string[]
  /** The door of a row outside prompt, response and tool-result; those three carry none. */
  door?: string
  /** The attachment type behind such a row. */
  name?: string
  /** The tool call's arguments in full, as `formatArgs` writes them. */
  args?: string
  /** The `tool_use_id` of the call behind a tool row. */
  callId?: string
  text: string
}

/**
 * One subagent as the handoff needs it. The lib declares its own shape instead
 * of importing the engine's `AgentInfo`, so it stays loadable without the
 * `claude-code` types; the register maps the engine's rows onto this.
 */
export type AgentNote = { id: string; type: string; description: string; state: string }

/**
 * A subagent the main loop started, kept in the session: the engine lists an agent
 * only while it runs, but SendMessage still reaches it by `id` after it ends, so a
 * later window has to be told about it. `ended` is set when its own turn completes.
 */
export type AgentSeen = {
  id: string
  type: string
  description: string
  model?: string
  window: number
  ts: number
  ended?: boolean
}

/**
 * A conversation row as the engine hands it over, kept to the fields this mod
 * files: the lib declares its own shape rather than importing the engine's, so
 * it stays loadable without the `claude-code` types.
 */
export type ImportedMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly {
    tool: string
    input?: unknown
    /** The tool call's input summary, computed by whoever built the message. */
    brief?: string
    /** The engine's id of the call, which later lines the conversation up with the rows. */
    callId?: string
    /** The call's arguments in full, as `formatArgs` writes them. */
    args?: string
    text?: string
    isError?: boolean
  }[]
}

/** How `openingOf` in handoff.ts begins; kept as a pattern so the window number may vary. */
const HANDOFF_OPENING = /^这是第\s*\d+\s*个窗口，上一个窗口的对话不在上下文里/

/** Whether a text is this mod's own handoff, the row a window opens with. */
export const isHandoffText = (text: string): boolean => HANDOFF_OPENING.test(text.trim())

/** Openings that are never a person's words, even from a confirmed source: a slash command is typed in the composer too. */
const ENVELOPE_OPENINGS = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<task-notification>',
  '<system-reminder>',
] as const

/** A project thread's wake, up to the tag of the message that triggered it: that tag says who wrote it. */
const WAKE_TRIGGER = /<wake\b[^>]*>[\s\S]*?(<message\b[^>]*\btrigger="true"[^>]*>)/

/**
 * Whether a text is a wake some agent's message triggered, not a person's. A
 * wake arrives from the same origin whoever wrote the message, so only the
 * `from` on the triggering message tells the two apart.
 */
const isAgentWake = (text: string): boolean => {
  const trigger = WAKE_TRIGGER.exec(text)?.[1]

  return trigger !== undefined && !/\bfrom="human"/.test(trigger)
}

/**
 * Whether a user row came from a person. The engine files its own notices —
 * system reminders, command envelopes, task notifications, the continuation
 * header — in the same door, and the handoff must not read them as a request.
 * When the origin already says a person sent it, a text that merely starts with
 * `<` (a pasted `<task>` or HTML) is theirs; without an origin any `<` is doubted.
 */
export const looksLikePerson = (text: string, isConfirmed = false): boolean => {
  const head = text.trim()

  return !(
    (isConfirmed ? ENVELOPE_OPENINGS.some(opening => head.startsWith(opening)) : head.startsWith('<')) ||
    isAgentWake(head) ||
    head.startsWith('This session is being continued from a previous conversation') ||
    head.startsWith('Caveat:') ||
    head.startsWith('ctx-mod：') ||
    // The opening line of this mod's own handoff, which a window starts with as a user row.
    HANDOFF_OPENING.test(head)
  )
}

/**
 * The person rows as the home page shows them. Rows written before the
 * injected-head rule may still carry the engine's `<system-reminder>` block, and
 * the home page must show only what the person actually wrote.
 */
const displayRequests = (rows: readonly HistoryRecord[]): HistoryRecord[] =>
  rows.map(row => {
    const text = stripInjected(row.text)

    return text === row.text ? row : { ...row, text }
  })

/** How long an approved switch stays valid: past this the model's turn never ended. */
const PENDING_MS = 120_000

/** The cross-session table's file name; it sits beside the sessions' own directories. */
const COSTLY_FILE = 'costly.json'

/** The held-back user messages, kept in the session's directory until they are delivered. */
const HELD_FILE = 'held.json'

type HeldItem = { id: number; text: string; at: number }

/** Reads held.json; a missing or damaged file means nothing is held, never an error. */
const heldFrom = (text: string | null): HeldItem[] => {
  if (text === null) return []
  try {
    const parsed: unknown = JSON.parse(text)
    const items = typeof parsed === 'object' && parsed !== null ? (parsed as { items?: unknown }).items : undefined
    if (!Array.isArray(items)) return []
    const kept: HeldItem[] = []
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      if (typeof row.id !== 'number' || !Number.isInteger(row.id) || typeof row.text !== 'string') continue
      kept.push({ id: row.id, text: row.text, at: typeof row.at === 'number' ? row.at : 0 })
    }

    return kept.sort((a, b) => a.id - b.id)
  } catch {
    return []
  }
}

/**
 * How long a measure holds: past this the table forgets it, so a load is no longer held
 * back by it, and a rebuild that still happens is measured and recorded again.
 */
const SHARED_MS = 30 * 24 * 3_600_000

const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'

/**
 * The text with the engine's injected notes stripped off its head. The engine
 * files a session-start hook's `<system-reminder>` block in the same door as a
 * person's words, so a request has to be read without it; a block that is never
 * closed is left alone, since the rest then cannot be trusted to be the person's.
 */
export const stripInjected = (text: string): string => {
  let rest = text
  for (;;) {
    const head = rest.trimStart()
    if (!head.startsWith(REMINDER_OPEN)) break
    const end = head.indexOf(REMINDER_CLOSE)
    if (end < 0) return text
    rest = head.slice(end + REMINDER_CLOSE.length)
  }

  return rest.trim()
}

/** How much of the previous window's last assistant reply the handoff carries. */
const LAST_REPLY_CHARS = 6_000

/** What the model reads when a switch is approved: it has to end the turn now. */
const APPROVED =
  '已批准换窗口。请立即结束本回合：不要再调用任何工具，用一句话说明你停在哪里即可。'

/** Activities kept in memory (and in meta): enough for the working set, not the whole session. */
const MAX_ACTIVITIES = 500

/** Subagents kept for the handoff; past this the oldest are dropped, which keeps meta.json small. */
const MAX_ROSTER = 50

/**
 * A request rebuilt the cache when it read under this share of the request before it,
 * and by more than the minimum: a small drop in a small window is not a rebuild.
 */
const REBUILT_READ_SHARE = 0.9
const REBUILT_MIN_DROP = 5_000

/** The assumptions used when a session has never switched and cannot say what its prefix costs. */
const DEFAULT_PREFIX = 30_000
const DEFAULT_HANDOFF = 8_000

/** The requests assumed to remain when the model does not say more work is coming. */
const REMAINING_REQUESTS = 100
const REMAINING_REQUESTS_LAST = 5

/** How many ledger entries one query may return. */
const MAX_QUERY_HITS = 30

/** How many windows a default history search covers. */
const SEARCH_WINDOWS = 3

const STATUS_LABEL: Record<TaskStatus, string> = {
  in_progress: '进行中',
  done: '已完成',
  superseded: '已被取代',
  blocked: '受阻',
}

type State = {
  window: number
  part: number
  seq: number
  ledgerSeq: number
  switchTimes: number[]
  requestsSinceSwitch: number
  /** Only remembered in memory: a reloaded session has no live turn to measure the cache against. */
  lastRequestAt: number | null
  reminded: { soft: boolean; urgent: boolean }
  archive: ArchivePage[]
  activities: FileActivity[]
  roster: AgentSeen[]
  /** Tool group -> the tokens its first load rewrote, the latest such load's; persisted, so a reloaded session still knows. */
  costlyLoads: Record<string, number>
  /** Groups a ToolSearch loaded since the last main-loop request: not persisted, judged by the next request's usage. */
  pendingLoads: string[]
  /** The main loop's last request context (input + read + write); not persisted. Null at a window's start. */
  lastContext: number | null
  /** Groups the gate has held back in this window: each is held back once, the second try goes through. Not persisted. */
  gateAsked: string[]
  /** Groups the gate held back and no load has taken yet: a switch made now is for them. Not persisted. */
  gateWanted: string[]
  lastPrefix: number | null
  lastHandoff: number | null
  /** The current ledger page, exactly what ledger.jsonl holds. */
  page: LedgerEntry[]
  pending: Pending | null
}

export type Session = {
  record: (row: RecordInput) => Promise<HistoryRecord>
  activity: (tool: string, input: Readonly<Record<string, unknown>>, seq: number, isError: boolean) => void
  noteRequest: () => void
  reminder: (env: Env) => string | null
  ledgerAppend: (input: unknown, env: Env) => Promise<ToolResult>
  ledgerRead: (input: unknown) => Promise<ToolResult>
  historyTool: (input: unknown) => Promise<ToolResult>
  status: (env: Env) => string
  requestSwitch: (input: unknown, env: Env) => ToolResult
  /**
   * Holds back a ToolSearch that would load a costly group while the context is large: the
   * returned text sends the model to switch windows first. `null` lets the call through.
   * `await ready()` first.
   */
  gateLoad: (query: unknown, tokens: number | undefined) => string | null
  /** Loads the files and the recent requests: `await` it before the sync readers. */
  ready: () => Promise<void>
  /** The switch the model is waiting for, if any; `await ready()` is not needed (memory only). */
  pending: () => Pending | null
  clearPending: () => void
  /** Copies a conversation that predates this mod; a no-op once anything is on disk. */
  importMessages: (messages: readonly ImportedMessage[]) => Promise<number>
  buildHandoff: (opts: { isMidTurn: boolean; agents?: readonly AgentNote[] }) => Promise<string>
  commitSwitch: (info: { trigger: string; tokensBefore: number | undefined; handoffText: string }) => Promise<void>
  notePrefix: (tokens: number) => void
  /** The window the conversation is in; `await ready()` first, or it reads 1. */
  window: () => number
  /** Waits for the queued writes, then retries once whatever failed to write. */
  flush: () => Promise<void>
  /** The files (names only, sorted) whose last write failed and has not succeeded since. */
  unsaved: () => string[]
  /**
   * Keeps a user's message on disk before it is held back, so a reload cannot lose it. Resolves to
   * the item's id, or null when the write failed and the message must not be held.
   */
  hold: (text: string) => Promise<number | null>
  /** The held messages, oldest first; `await ready()` first. */
  heldItems: () => { id: number; text: string; at: number }[]
  /** Drops one held message and writes the rest back; an unknown id changes nothing. */
  release: (id: number) => Promise<void>
  /** The latest person prompt's seq; `await ready()` first. */
  latestPersonSeq: () => number | null
  /** The latest hand-off's seq (a coordinator's or a schedule's, never a person's); `await ready()` first. */
  latestRelaySeq: () => number | null
  /** Whether the ledger gained an entry after the latest person prompt of this window; `await ready()` first. */
  isLedgerFresh: () => boolean
  /** Whether a compaction may skip the engine's summary: a fresh ledger with a short unrecorded tail; `await ready()` first. */
  canSkipSummary: () => boolean
  /** The time of the last noted request, or null before the first one; `await ready()` first. */
  lastRequestAt: () => number | null
  /** Notes a subagent the main loop started, by id; a repeat of the id updates its row. `await ready()` is not needed. */
  noteAgent: (input: { id: string; type: string; description: string; model?: string }) => Promise<void>
  /** Tags a noted subagent as ended; an id never noted changes nothing. */
  agentEnded: (id: string) => Promise<void>
  /** Reads one main-loop request's usage: a request right after a deferred load that rewrote the cache names that load's group. `await ready()` is not needed. */
  noteStep: (usage: { input: number; read: number; write: number }) => Promise<void>
  /** The costly groups this session judges by: the cross-session table with this session's own measures on top. `await ready()` first. */
  costlyGroups: () => Record<string, number>
}

const emptyState = (): State => ({
  window: 1,
  part: 0,
  seq: 0,
  ledgerSeq: 0,
  switchTimes: [],
  requestsSinceSwitch: 0,
  lastRequestAt: null,
  reminded: { soft: false, urgent: false },
  archive: [],
  activities: [],
  roster: [],
  costlyLoads: {},
  pendingLoads: [],
  lastContext: null,
  gateAsked: [],
  gateWanted: [],
  lastPrefix: null,
  lastHandoff: null,
  page: [],
  pending: null,
})

const errorOf = (result: string): ToolResult => ({ isError: true, result })

/** The message of whatever a failing `io.read` threw, whatever shape it had. */
const messageOf = (problem: unknown): string => {
  if (problem instanceof Error) return problem.message
  if (typeof problem === 'string') return problem

  return ''
}

const asInt = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback

const asNumberArray = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []

const asRecordArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

/** One roster row as meta.json holds it, or null when it lacks what a row needs. */
const seenOf = (value: unknown): AgentSeen | null => {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || typeof row.type !== 'string' || typeof row.description !== 'string') return null
  if (typeof row.window !== 'number' || !Number.isFinite(row.window)) return null
  if (typeof row.ts !== 'number' || !Number.isFinite(row.ts)) return null

  return {
    id: row.id,
    type: row.type,
    description: row.description,
    ...(typeof row.model === 'string' ? { model: row.model } : {}),
    window: row.window,
    ts: row.ts,
    ...(row.ended === true ? { ended: true } : {}),
  }
}

/** A meta.json from before the roster has none, which reads as an empty roster; a damaged row is dropped alone. */
const rosterFrom = (value: unknown): AgentSeen[] =>
  (Array.isArray(value) ? value : []).map(seenOf).filter((seen): seen is AgentSeen => seen !== null).slice(-MAX_ROSTER)

/**
 * The costly loads as meta.json holds them. A meta.json from before the measure has
 * none, and a damaged entry is dropped alone: only a finite, positive count is a rewrite.
 */
const costlyFrom = (value: unknown): Record<string, number> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const costly: Record<string, number> = {}
  for (const [name, rewritten] of Object.entries(value)) {
    if (typeof rewritten === 'number' && Number.isFinite(rewritten) && rewritten > 0) costly[name] = rewritten
  }

  return costly
}

/** One group's measure as the cross-session table holds it; a hand-written entry may leave `context` out. */
type SharedCost = { write: number; context?: number; at: number }

/**
 * Where the cross-session table lives: one level above this session's directory, so every
 * session under the same mod directory reads and writes one file. A root with no slash has
 * no parent to hold it, and then there is no table at all.
 */
const sharedPath = (root: string): string | null => {
  const cut = root.lastIndexOf('/')

  return cut < 0 ? null : `${root.slice(0, cut)}/${COSTLY_FILE}`
}

/**
 * The table as the file holds it, keeping only the measures that are a finite positive
 * rewrite stamped within the expiry. A missing or damaged file is an empty table, never a throw.
 */
const sharedFrom = (text: string | null, now: number): Record<string, SharedCost> => {
  const table: Record<string, SharedCost> = {}
  if (text === null) return table
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return table
  }
  const groups =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).groups : undefined
  if (typeof groups !== 'object' || groups === null || Array.isArray(groups)) return table
  for (const [name, value] of Object.entries(groups)) {
    if (typeof value !== 'object' || value === null) continue
    const { write, context, at } = value as Record<string, unknown>
    if (typeof write !== 'number' || !Number.isFinite(write) || write <= 0) continue
    if (typeof at !== 'number' || !Number.isFinite(at) || now - at > SHARED_MS) continue
    table[name] = {
      write,
      ...(typeof context === 'number' && Number.isFinite(context) ? { context } : {}),
      at,
    }
  }

  return table
}

/** The table as the file holds it: the version the format is read by. */
/** The lock file sits beside the table; a holder that died leaves it, so it goes stale. */
const SHARED_LOCK_SUFFIX = '.lock'
const SHARED_LOCK_STALE_MS = 10_000
const SHARED_LOCK_TRIES = 8
const SHARED_LOCK_PAUSE_MS = 40

/** Whether a failed read says the file is simply not there (as opposed to unreadable). */
const isMissingError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (code === 'ENOENT' || code === 'ENOTDIR') return true

  return typeof message === 'string' && /ENOENT|no such file|not found|does not exist/i.test(message)
}

const sharedJson = (table: Record<string, SharedCost>): string => JSON.stringify({ version: 1, groups: table })

/** A tool use's arguments, as the activity reader and the path reader both want them. */
const asInput = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** The file a tool call named, in the order the engine's own tools spell it. */
const pathOf = (input: Readonly<Record<string, unknown>>): string | undefined => {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    if (typeof input[key] === 'string') return input[key] as string
  }

  return undefined
}

const k = (tokens: number): number => Math.round(tokens / 1000)

/** A damaged meta.json is an empty session, never a throw. */
/** The handoff a window opened with; every switch writes one, so it also marks that the window exists. */
const handoffName = (window: number): string => `handoff-w${String(window).padStart(3, '0')}.md`

const stateFrom = (raw: Record<string, unknown> | null): State => {
  const state = emptyState()
  if (raw === null) return state

  state.window = Math.max(1, asInt(raw.window, 1))
  state.part = asInt(raw.part, 0)
  state.seq = asInt(raw.seq, 0)
  state.ledgerSeq = asInt(raw.ledgerSeq, 0)
  state.switchTimes = asNumberArray(raw.switchTimes)
  state.requestsSinceSwitch = asInt(raw.requestsSinceSwitch, 0)
  state.archive = asRecordArray<ArchivePage>(raw.archive)
  state.activities = asRecordArray<FileActivity>(raw.activities)
  state.roster = rosterFrom(raw.roster)
  state.costlyLoads = costlyFrom(raw.costlyLoads)
  state.lastPrefix = typeof raw.lastPrefix === 'number' ? raw.lastPrefix : null
  state.lastHandoff = typeof raw.lastHandoff === 'number' ? raw.lastHandoff : null
  const reminded = typeof raw.reminded === 'object' && raw.reminded !== null ? (raw.reminded as Record<string, unknown>) : {}
  state.reminded = { soft: reminded.soft === true, urgent: reminded.urgent === true }

  return state
}

/**
 * The subagents the handoff names: the engine's live list as it gave it, then the
 * noted ones it no longer lists, as ended and newest first. An id both sides hold
 * keeps the engine's row, so each agent is named once.
 */
const agentsForHandoff = (live: readonly AgentNote[], roster: readonly AgentSeen[]): AgentNote[] => {
  const listed = new Set(live.map(agent => agent.id))
  const ended = roster
    .filter(seen => !listed.has(seen.id))
    .sort((left, right) => right.ts - left.ts)
    .map((seen): AgentNote => ({ id: seen.id, type: seen.type, description: seen.description, state: ENDED_STATE }))

  return [...live, ...ended]
}

/**
 * The deferred tools the window loaded and used whose first load rebuilt the cache,
 * each with the tokens it rewrote. A group no request has measured is left out: the
 * handoff advises only the loads that cost the whole cached prefix.
 */
const costlyToolsOf = (tools: readonly LoadedTool[], costly: Record<string, number>): RebuiltTool[] =>
  tools.flatMap(tool => {
    if (!Object.hasOwn(costly, tool.name)) return []
    const rebuilt = costly[tool.name]

    return rebuilt === undefined ? [] : [{ name: tool.name, calls: tool.calls, rebuilt }]
  })

/** The most unrecorded steps the handoff lists one by one. */
const MAX_TAIL_ACTIONS = 25

export const createSession =(dir: string, io: Io, config: Config): Session => {
  const root = dir.replace(/\/+$/, '')
  const pathIn = (name: string): string => `${root}/${name}`
  /**
   * Paths whose last write failed, with the text that did not land: a read that comes
   * back empty can say why, and `flush` can try the same content once more.
   */
  const failedWrites = new Map<string, string>()
  /** Writes through to the engine, keeping the failure visible to the readers. */
  const writeThrough = async (path: string, text: string): Promise<void> => {
    try {
      await io.write(path, text)
      failedWrites.delete(path)
    } catch (problem) {
      failedWrites.set(path, text)
      try {
        io.onWriteError?.(path, problem)
      } catch {
        // A reporter that throws must not change how the write fails.
      }

      throw problem
    }
  }
  const queue = createQueue(writeThrough)
  const state = emptyState()
  /** Every shard this session has in memory, the current one included: old windows stay searchable. */
  const shards = new Map<string, Shard>()
  /** Windows whose every part is in `shards`. */
  const fullWindows = new Set<number>()
  const archives = new Map<number, LedgerEntry[]>()
  /**
   * The events file as this session knows it. Its own reads go straight to the
   * disk and miss a write still queued, so every switch appends to this text.
   */
  let eventsText: string | null = null
  /** The cross-session table's file, or null when this session's directory has no parent to hold one. */
  const sharedFile = sharedPath(root)
  /** The table as this session last read or wrote it: never persisted, read again at each load. */
  let sharedCostly: Record<string, SharedCost> = {}
  /** The messages held back and not yet delivered, as held.json has them. */
  let held: HeldItem[] = []
  const heldJson = (): string => JSON.stringify({ items: held })

  const readText = async (path: string): Promise<string | null> => {
    try {
      return await io.read(path)
    } catch {
      // Absent, unreadable or too large: every caller here treats them the same.
      return null
    }
  }

  const allRows = (): HistoryRecord[] => {
    const rows: HistoryRecord[] = []
    for (const shard of shards.values()) rows.push(...shard.rows)

    return rows.sort((left, right) => left.seq - right.seq)
  }

  const bySeq = (seq: number): HistoryRecord | undefined => {
    for (const shard of shards.values()) {
      const found = shard.rows.find(row => row.seq === seq)
      if (found !== undefined) return found
    }

    return undefined
  }

  const latestPersonRow = (): HistoryRecord | null => {
    let best: HistoryRecord | null = null
    for (const shard of shards.values()) {
      for (const row of shard.rows) {
        if (row.isPerson !== true) continue
        if (best === null || row.seq > best.seq) best = row
      }
    }

    return best
  }

  /** The latest hand-off among the loaded rows: a task's source in a session no person started. */
  const latestRelayRow = (): HistoryRecord | null => {
    let best: HistoryRecord | null = null
    for (const shard of shards.values()) {
      for (const row of shard.rows) {
        if (!isRelay(row)) continue
        if (best === null || row.seq > best.seq) best = row
      }
    }

    return best
  }

  const latestAssistantRow = (): HistoryRecord | null => {
    let best: HistoryRecord | null = null
    for (const shard of shards.values()) {
      for (const row of shard.rows) {
        // A row with a door is the engine's delivery or note, never the model's own reply.
        if (row.role !== 'assistant' || row.door !== undefined) continue
        if (best === null || row.seq > best.seq) best = row
      }
    }

    return best
  }

  const metaJson = (): string =>
    JSON.stringify({
      window: state.window,
      part: state.part,
      seq: state.seq,
      ledgerSeq: state.ledgerSeq,
      switchTimes: state.switchTimes,
      requestsSinceSwitch: state.requestsSinceSwitch,
      reminded: state.reminded,
      archive: state.archive,
      activities: state.activities,
      roster: state.roster,
      costlyLoads: state.costlyLoads,
      lastPrefix: state.lastPrefix,
      lastHandoff: state.lastHandoff,
    })

  /** Only ever writes what is loaded: saving before the load would erase the file. */
  const saveMeta = (): void => {
    if (!loaded) return
    void queue.push(pathIn('meta.json'), metaJson())
  }

  /**
   * Reads one window's shards from part 0 up to the first absent part, and says
   * how many there were. A shard's size says nothing about a later part: a
   * rotation happens before the ceiling is reached, so a rotated shard is
   * always under it.
   */
  const readWindow = async (window: number): Promise<number> => {
    let parts = 0
    for (; ; parts += 1) {
      const name = shardName(window, parts)
      const text = await readText(pathIn(name))
      if (text === null) break
      shards.set(name, { window, part: parts, rows: parseJsonl<HistoryRecord>(text), bytes: byteLength(text) })
    }

    return parts
  }

  const loadWindow = async (window: number): Promise<void> => {
    if (fullWindows.has(window)) return
    await readWindow(window)
    fullWindows.add(window)
  }

  /** The highest seq among one window's rows in memory, or 0 when it has none. */
  const topSeqOf = (window: number): number => {
    let top = 0
    for (const shard of shards.values()) {
      if (shard.window !== window) continue
      for (const row of shard.rows) {
        if (Number.isInteger(row.seq) && row.seq > top) top = row.seq
      }
    }

    return top
  }

  const loadArchive = async (page: number): Promise<LedgerEntry[] | null> => {
    const cached = archives.get(page)
    if (cached !== undefined) return cached
    const text = await readText(pathIn(archiveName(page)))
    if (text === null) return null
    const entries = parseJsonl<LedgerEntry>(text)
    archives.set(page, entries)

    return entries
  }

  const load = async (): Promise<void> => {
    const text = await readText(pathIn('meta.json'))
    let raw: Record<string, unknown> | null = null
    if (text !== null) {
      try {
        const parsed: unknown = JSON.parse(text)
        raw = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
      } catch {
        raw = null
      }
    }
    Object.assign(state, stateFrom(raw))

    // meta.json is written after the files it describes and can be lost, stale
    // or damaged, so the files have the last word on everything they can tell:
    // the window, the part, the seq and the archive pages. A seq or an archive
    // page handed out twice would make one name mean two things.
    for (;;) {
      const next = state.window + 1
      const isOpened =
        (await readText(pathIn(handoffName(next)))) !== null ||
        (await readText(pathIn(shardName(next, 0)))) !== null
      if (!isOpened) break
      state.window = next
      state.requestsSinceSwitch = 0
      state.reminded = { soft: false, urgent: false }
    }

    state.part = Math.max(0, (await readWindow(state.window)) - 1)
    fullWindows.add(state.window)
    // A window that was only just opened has no row yet; the seq is then in an earlier one.
    let top = topSeqOf(state.window)
    for (let window = state.window - 1; top === 0 && window >= 1; window -= 1) {
      await loadWindow(window)
      top = topSeqOf(window)
    }
    state.seq = Math.max(state.seq, top)

    const ledgerText = await readText(pathIn('ledger.jsonl'))
    state.page = ledgerText === null ? [] : parseJsonl<LedgerEntry>(ledgerText)
    for (const entry of state.page) state.ledgerSeq = Math.max(state.ledgerSeq, entry.seq)
    for (let page = state.archive.length + 1; ; page += 1) {
      const entries = await loadArchive(page)
      if (entries === null) break
      state.archive.push(pageOf(page, entries))
      for (const entry of entries) state.ledgerSeq = Math.max(state.ledgerSeq, entry.seq)
    }
    // Another session may have measured a group this one has not met, so the whole table is read.
    if (sharedFile !== null) sharedCostly = sharedFrom(await readText(sharedFile), io.now())
    held = heldFrom(await readText(pathIn(HELD_FILE)))
  }

  let loading: Promise<void> | null = null
  let loaded = false
  const ensureLoaded = (): Promise<void> => {
    if (loading === null) {
      loading = load().then(() => {
        loaded = true
      })
    }

    return loading
  }

  /**
   * What every synchronous reader below needs in memory: the files, and the
   * recent person requests that may sit in an earlier window.
   */
  const ready = async (): Promise<void> => {
    await ensureLoaded()
    await ensureRequests()
  }

  /**
   * Pulls older windows in until every referenced seq and at least one person
   * prompt are in memory, so `ledger.validate` can look the whole session up.
   */
  const ensureHistory = async (seqs: readonly number[]): Promise<void> => {
    const wanted = [...new Set(seqs.filter(seq => Number.isInteger(seq) && seq > 0))]
    for (let window = state.window - 1; window >= 1; window -= 1) {
      if (wanted.every(seq => bySeq(seq) !== undefined) && latestPersonRow() !== null) break
      await loadWindow(window)
    }
  }

  /**
   * Pulls older windows in until the most recent person prompts are in memory:
   * a reloaded session holds only the current window's shard, and the handoff,
   * the page turn and the home view all have to name the requests of the session.
   */
  const ensureRequests = async (): Promise<void> => {
    for (let window = state.window - 1; window >= 1; window -= 1) {
      if (personRequests(allRows(), config.recentRequests).length >= config.recentRequests) break
      await loadWindow(window)
    }
  }

  /**
   * Pulls older windows in until each recent request has the reply it came after in
   * memory. That reply sits in the request's own window or the one before, so the
   * session's very first request never drags every window in.
   */
  const ensureAnswered = async (): Promise<void> => {
    for (let window = state.window - 1; window >= 1; window -= 1) {
      const rows = allRows()
      const requests = personRequests(rows, config.recentRequests)
      const answered = repliesAnswered(rows, requests)
      if (requests.every(request => answered.has(request.seq) || request.window - 1 > window)) break
      await loadWindow(window)
    }
  }

  /**
   * Pulls older windows in until the last assistant reply is in memory: a
   * reloaded session holds only the current window's shard, and the handoff has
   * to carry what the model last concluded.
   */
  const ensureReplies = async (): Promise<void> => {
    for (let window = state.window - 1; window >= 1; window -= 1) {
      if (latestAssistantRow() !== null) break
      await loadWindow(window)
    }
  }

  /**
   * The hand-off the open work came from, for the home page: the one an open
   * task points at, else, in a session no person has spoken in, the latest one.
   */
  const relayForHome = async (): Promise<HistoryRecord | undefined> => {
    const refs = tasksOf(state.page)
      .filter(task => task.status === 'in_progress' || task.status === 'blocked')
      .flatMap(task => task.entries.map(entry => entry.request_ref))
    await ensureHistory(refs)
    let best: HistoryRecord | undefined
    for (const seq of refs) {
      const row = bySeq(seq)
      if (row !== undefined && isRelay(row) && (best === undefined || row.seq > best.seq)) best = row
    }
    if (best === undefined && latestPersonRow() === null) best = latestRelayRow() ?? undefined

    return best === undefined ? undefined : displayRequests([best])[0]
  }

  /** The last thing the model said, cut to its tail when it is too long to carry. */
  const lastReplyOf = (): string | null => {
    const row = latestAssistantRow()
    if (row === null) return null
    if (row.text.length <= LAST_REPLY_CHARS) return row.text

    return `（前文已省略，用 history 工具查看 #${row.seq}）\n${row.text.slice(row.text.length - LAST_REPLY_CHARS)}`
  }

  const shardAt = (window: number, part: number): Shard =>
    shards.get(shardName(window, part)) ?? emptyShard(window, part)

  const record = async (row: RecordInput): Promise<HistoryRecord> => {
    await ensureLoaded()
    const seq = state.seq + 1
    const full: HistoryRecord = {
      seq,
      uuid: row.uuid,
      ts: io.now(),
      window: state.window,
      role: row.role,
      text: row.text,
    }
    if (row.isPerson === true) full.isPerson = true
    if (row.origin !== undefined) full.origin = row.origin
    if (row.tool !== undefined) full.tool = row.tool
    if (row.path !== undefined) full.path = row.path
    if (row.input !== undefined) full.input = row.input
    if (row.isError === true) full.isError = true
    if (row.loaded !== undefined) full.loaded = row.loaded
    if (row.door !== undefined) full.door = row.door
    if (row.name !== undefined) full.name = row.name
    if (row.args !== undefined) full.args = row.args
    if (row.callId !== undefined) full.callId = row.callId
    // A load is judged by the next request's usage, which says whether the cache was rebuilt.
    if (row.tool === 'ToolSearch' && row.loaded !== undefined) {
      for (const name of row.loaded) {
        const group = toolGroupOf(name)
        if (!state.pendingLoads.includes(group)) state.pendingLoads.push(group)
        // A group the model loaded itself, instead of switching first, no longer needs the switch.
        state.gateWanted = state.gateWanted.filter(wanted => wanted !== group)
      }
    }

    const clipped = clipRecord(full)
    const shard = appendRecord(shardAt(state.window, state.part), clipped).shard
    state.seq = seq
    state.window = shard.window
    state.part = shard.part
    const name = shardName(shard.window, shard.part)
    shards.set(name, shard)
    fullWindows.add(shard.window)
    // The whole original of a clipped field goes out before the row that points at it. A part
    // that fails to land is kept by `writeThrough` like any other file, so `flush` retries it.
    for (const field of ['text', 'args'] as const) {
      if (clipped.overflow?.[field] === undefined) continue
      splitParts(field === 'text' ? full.text : full.args ?? '').parts.forEach((part, index) => {
        void queue.push(pathIn(overflowName(seq, field, index)), part)
      })
    }
    void queue.push(pathIn(name), toJsonl(shard.rows))
    saveMeta()

    return clipped
  }

  const activity = (tool: string, input: Readonly<Record<string, unknown>>, seq: number, isError: boolean): void => {
    const found = activityOf(tool, input, { seq, window: state.window, isError })
    if (found === null) return
    state.activities.push(found)
    if (state.activities.length > MAX_ACTIVITIES) {
      state.activities.splice(0, state.activities.length - MAX_ACTIVITIES)
    }
    // The activity is part of what the next window reads, so it has to be on disk
    // even when no further row is recorded this turn.
    saveMeta()
  }

  /**
   * Notes a subagent the main loop started. The engine lists an agent only while it
   * runs, yet SendMessage still reaches it by this id after it ends, so the handoff
   * has to keep its id, type and task. A repeat of the id updates the row instead.
   */
  const noteAgent = async (input: { id: string; type: string; description: string; model?: string }): Promise<void> => {
    await ensureLoaded()
    const known = state.roster.find(seen => seen.id === input.id)
    if (known === undefined) {
      state.roster.push({
        id: input.id,
        type: input.type,
        description: input.description,
        ...(input.model === undefined ? {} : { model: input.model }),
        window: state.window,
        ts: io.now(),
      })
      if (state.roster.length > MAX_ROSTER) state.roster.splice(0, state.roster.length - MAX_ROSTER)
    } else {
      known.type = input.type
      known.description = input.description
      if (input.model === undefined) delete known.model
      else known.model = input.model
      delete known.ended
    }
    saveMeta()
  }

  /**
   * Tags a noted subagent as ended once its own turn completes. An id the roster
   * does not hold changes nothing, and a tag already set is not written again.
   */
  const agentEnded = async (id: string): Promise<void> => {
    await ensureLoaded()
    const known = state.roster.find(seen => seen.id === id)
    if (known === undefined || known.ended === true) return
    known.ended = true
    saveMeta()
  }

  /**
   * Judges the loads still waiting on the next main-loop request. Loading a tool group
   * changes the tool list the cached prefix was made over, so the first request after
   * a load reads far less from the cache than the request before it. A group loaded
   * again in the same window does not rebuild, so only the first load is recorded.
   */
  /**
   * Puts one measured group into the cross-session table. The file is read again first:
   * another session may have written it since this one loaded, and its groups must stay.
   */
  const recordShared = async (group: string, write: number, context: number): Promise<void> => {
    if (sharedFile === null) return
    const file = sharedFile
    const lockPath = `${file}${SHARED_LOCK_SUFFIX}`
    const report = (problem: unknown): void => {
      try {
        io.onWriteError?.(file, problem)
      } catch {
        // A reporter that throws must not change how the write fails.
      }
    }
    const pause = async (): Promise<void> => {
      if (io.sleep !== undefined) return await io.sleep(SHARED_LOCK_PAUSE_MS)
      const timer = (globalThis as { setTimeout?: (run: () => void, ms: number) => unknown }).setTimeout
      if (typeof timer === 'function') {
        await new Promise<void>(resolve => {
          timer(resolve, SHARED_LOCK_PAUSE_MS)
        })
      }
    }
    /** The lock file's holder time: null when it is absent, -Infinity when it is damaged, undefined when unreadable. */
    const lockTime = async (): Promise<number | null | undefined> => {
      let text: string
      try {
        text = await io.read(lockPath)
      } catch (problem) {
        const isGone = io.exists === undefined ? isMissingError(problem) : !(await io.exists(lockPath).catch(() => true))

        return isGone ? null : undefined
      }
      if (text === '') return Number.NEGATIVE_INFINITY
      try {
        const at = (JSON.parse(text) as { at?: unknown }).at

        return typeof at === 'number' && Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY
      } catch {
        return Number.NEGATIVE_INFINITY
      }
    }
    /** Takes the lock, or gives up after a few tries: a measure is never worth waiting long for. */
    const acquire = async (token: string): Promise<boolean> => {
      for (let attempt = 0; attempt < SHARED_LOCK_TRIES; attempt += 1) {
        const body = JSON.stringify({ token, at: io.now() })
        const held = await lockTime()
        if (held === undefined) {
          await pause()
          continue
        }
        const isFree = held === null || io.now() - held > SHARED_LOCK_STALE_MS
        if (io.claim !== undefined) {
          if (held !== null && isFree) await io.remove?.(lockPath)
          if ((held === null || isFree) && (await io.claim(lockPath, body))) return true
        } else if (isFree) {
          // No exclusive create here: write, then read back, so the loser of a close race usually notices.
          await io.write(lockPath, body)
          if ((await readText(lockPath)) === body) return true
        }
        await pause()
      }

      return false
    }
    const release = async (token: string): Promise<void> => {
      try {
        const text = await readText(lockPath)
        if (text === null || (JSON.parse(text) as { token?: unknown }).token !== token) return
        if (io.remove !== undefined) await io.remove(lockPath)
        else await io.write(lockPath, '')
      } catch {
        // A lock that cannot be released goes stale by itself.
      }
    }
    /** The table as the file holds it: {} when there is no file, null when it is there but cannot be trusted. */
    const readCurrent = async (): Promise<Record<string, SharedCost> | null> => {
      let text: string
      try {
        text = await io.read(file)
      } catch (problem) {
        const isGone = io.exists === undefined ? isMissingError(problem) : !(await io.exists(file).catch(() => true))

        return isGone ? {} : null
      }
      try {
        const parsed: unknown = JSON.parse(text)
        const groups = typeof parsed === 'object' && parsed !== null ? (parsed as { groups?: unknown }).groups : undefined
        if (typeof groups !== 'object' || groups === null || Array.isArray(groups)) return null
      } catch {
        return null
      }

      return sharedFrom(text, io.now())
    }

    const token = `${io.now()}-${Math.random().toString(36).slice(2)}`
    let isLocked = false
    try {
      isLocked = await acquire(token)
      if (!isLocked) {
        report(new Error('costly.json is locked by another session: this measure was not recorded'))

        return
      }
      const current = await readCurrent()
      if (current === null) {
        // Written over, a table that merely failed to read would lose every other session's groups.
        report(new Error('costly.json could not be read or parsed: left as it is, this measure was not recorded'))

        return
      }
      const now = io.now()
      const table = { ...current, [group]: { write, context, at: now } }
      const text = sharedJson(table)
      if (io.rename === undefined) {
        await io.write(file, text)
      } else {
        const temp = `${file}.${token}.tmp`
        await io.write(temp, text)
        try {
          await io.rename(temp, file)
        } catch (problem) {
          await io.remove?.(temp).catch(() => undefined)
          throw problem
        }
      }
      sharedCostly = table
    } catch (problem) {
      report(problem)
    } finally {
      if (isLocked) await release(token)
    }
  }

  const noteStep = async (usage: { input: number; read: number; write: number }): Promise<void> => {
    await ensureLoaded()
    const before = state.lastContext
    // Two groups loaded in one step rewrote the cache together: neither can be blamed for it alone.
    if (state.pendingLoads.length === 1 && before !== null) {
      const rebuilt =
        usage.read < before * REBUILT_READ_SHARE && before - usage.read > REBUILT_MIN_DROP && usage.write > 0
      if (rebuilt) {
        for (const group of state.pendingLoads) {
          state.costlyLoads[group] = usage.write
          await recordShared(group, usage.write, before)
        }
        saveMeta()
      }
    }
    state.pendingLoads = []
    state.lastContext = usage.input + usage.read + usage.write
  }

  /**
   * The costly groups this session judges by: the table's measures, with this session's own
   * on top where both name a group. `await ready()` first, so the table is in memory.
   */
  const costlyGroups = (): Record<string, number> => {
    const groups: Record<string, number> = {}
    for (const [name, cost] of Object.entries(sharedCostly)) groups[name] = cost.write

    return { ...groups, ...state.costlyLoads }
  }

  /**
   * Where the part of the engine's conversation the mod has not recorded begins.
   * A message has no id of its own, so it is lined up with the rows by what it
   * carries: a tool call's id, the `[#n]` this mod appended to a result, and
   * last by its words (equal once whitespace is gone, or one inside the other
   * with the shorter at least a dozen characters). The last known message
   * wins; the words are compared only with rows after the last tool row found
   * by id, since earlier rows cannot belong to the tail.
   */
  const firstUnrecorded = (messages: readonly ImportedMessage[]): number => {
    const rows = allRows()
    const seqOfCall = new Map<string, number>()
    for (const row of rows) {
      if (row.role === 'tool' && row.callId !== undefined) seqOfCall.set(row.callId, row.seq)
    }
    let last = -1
    let anchor = 0
    messages.forEach((message, index) => {
      let hit = 0
      for (const use of message.toolUses) {
        const seq = use.callId === undefined ? undefined : seqOfCall.get(use.callId)
        if (seq !== undefined) hit = Math.max(hit, seq)
        const suffix = typeof use.text === 'string' ? /\[#(\d+)\]\s*$/.exec(use.text) : null
        const number = suffix === null ? 0 : Number(suffix[1])
        if (number >= 1 && number <= state.seq) hit = Math.max(hit, number)
      }
      if (hit > 0) {
        last = index
        anchor = hit
      }
    })

    const spoken = rows
      .filter(row => row.seq > anchor && row.role !== 'tool')
      .map(row => row.text.replace(/\s+/g, ''))
      .filter(text => text !== '')
    const isSame = (left: string, right: string): boolean => {
      const [short, long] = left.length <= right.length ? [left, right] : [right, left]

      return short === long || (short.length >= 12 && long.includes(short))
    }
    // From the end: the first message found is the last known one, and nothing before it matters.
    for (let index = messages.length - 1; index > last; index -= 1) {
      const text = (messages[index]?.text ?? '').replace(/\s+/g, '')
      if (text !== '' && spoken.some(row => isSame(text, row))) {
        last = index
        break
      }
    }

    return last + 1
  }

  /**
   * Files the part of a conversation the mod has no rows for: all of a session
   * that predates the mod, or just the tail added while the mod was off or a
   * hook missed a row. Rows already on disk are recognised, so a repeated call
   * files nothing and the numbering every file rests on is never disturbed.
   */
  const importMessages = async (messages: readonly ImportedMessage[]): Promise<number> => {
    await ensureLoaded()
    // With history on disk only the tail the mod has not seen is filed; with none, everything is.
    const from = state.seq === 0 ? 0 : firstUnrecorded(messages)

    let imported = 0
    for (const message of messages.slice(from)) {
      if (message.text.trim() !== '') {
        // A row that only carries the engine's reminder is nobody's request: the
        // head has to be stripped before the person check, and something has to
        // be left of it.
        const stripped = stripInjected(message.text)
        await record(
          message.role === 'user'
            ? {
                uuid: '',
                role: 'user',
                ...(stripped !== '' && looksLikePerson(stripped) ? { isPerson: true as const } : {}),
                text: message.text,
              }
            : { uuid: '', role: 'assistant', text: message.text },
        )
        imported += 1
      }
      if (message.role !== 'assistant') continue
      for (const use of message.toolUses) {
        // A call still in flight carries no text: nothing was answered, nothing to file.
        if (typeof use.text !== 'string') continue
        const input = asInput(use.input)
        const path = pathOf(input)
        const isError = use.isError === true
        const row = await record({
          uuid: '',
          role: 'tool',
          tool: use.tool,
          ...(path === undefined ? {} : { path }),
          ...(use.brief === undefined ? {} : { input: use.brief }),
          ...(use.args === undefined ? {} : { args: use.args }),
          ...(use.callId === undefined ? {} : { callId: use.callId }),
          ...(isError ? { isError: true as const } : {}),
          text: use.text,
        })
        activity(use.tool, input, row.seq, isError)
        imported += 1
      }
    }
    // The rows went through the queue; the meta is saved last, so a reader that
    // sees the new `seq` also sees the activities that came with it. An empty
    // import writes nothing at all, so a session with no history stays untouched.
    if (imported > 0) saveMeta()

    return imported
  }

  const noteRequest = (): void => {
    state.requestsSinceSwitch += 1
    state.lastRequestAt = io.now()
  }

  const reminder = (env: Env): string | null => {
    if (env.tokens === undefined) return null
    const level = levelOf(env.tokens, env.limit, config)
    if (level !== 'soft' && level !== 'urgent') return null
    const pct = percentOf(env.tokens, env.limit)

    if (level === 'soft') {
      if (state.reminded.soft || state.reminded.urgent) return null
      state.reminded.soft = true

      return `上下文已用 ${pct}%（${k(env.tokens)}k/${k(env.limit)}k）。如果当前阶段即将结束，请先把进度写进账本，然后调用 context 工具换窗口；如果正处在一个小步骤中间，先完成这一步。`
    }

    if (state.reminded.urgent) return null
    // Urgent carries the whole instruction itself, so a skipped soft is never sent late.
    state.reminded.urgent = true
    state.reminded.soft = true

    return `上下文已用 ${pct}%。请立刻：1）为每个未完成的任务追加一条账本记录，写明 next_step 和 anchors；2）把已完成的任务标为 done 并附证据；3）调用 context 工具（action: "new"）换窗口。`
  }

  const ledgerAppend = async (input: unknown, env: Env): Promise<ToolResult> => {
    await ensureLoaded()
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return errorOf('ledger_append 的输入必须是一个对象，至少包含 task_id、title、status、text 四个字段。')
    }
    const raw = input as Record<string, unknown>
    if (typeof raw.text !== 'string') return errorOf('text 必须是字符串，请用一句话说明这一步的要点。')

    const candidate: LedgerInput = {
      task_id: raw.task_id as string,
      title: raw.title as string,
      status: raw.status as TaskStatus,
      text: raw.text,
    }
    if (typeof raw.next_step === 'string') candidate.next_step = raw.next_step
    if (Array.isArray(raw.anchors)) candidate.anchors = raw.anchors as Anchor[]
    if (Array.isArray(raw.evidence)) candidate.evidence = raw.evidence as number[]
    if (typeof raw.superseded_by === 'string') candidate.superseded_by = raw.superseded_by
    if (typeof raw.request_ref === 'number') candidate.request_ref = raw.request_ref

    const files = new Map<string, string>()
    const absent = new Set<string>()
    for (const anchor of candidate.anchors ?? []) {
      if (typeof anchor !== 'object' || anchor === null) continue
      const path = typeof anchor.path === 'string' ? anchor.path.trim() : ''
      if (path === '') continue
      const key = pathKey(path)
      if (files.has(key) || absent.has(key)) continue
      const text = await readText(path)
      if (text === null) absent.add(key)
      else files.set(key, text)
    }
    const checkAnchor = (anchor: Anchor): AnchorCheck => {
      const path = typeof anchor.path === 'string' ? anchor.path : ''
      const text = files.get(pathKey(path))
      if (text === undefined) return 'missing-file'

      return locate(text, typeof anchor.match === 'string' ? anchor.match : '').kind
    }

    const referenced: number[] = []
    if (typeof candidate.request_ref === 'number') referenced.push(candidate.request_ref)
    if (candidate.evidence !== undefined) referenced.push(...candidate.evidence)
    await ensureHistory(referenced)

    const latest = latestPersonRow()
    const latestPersonSeq = latest === null ? null : latest.seq
    const latestRelaySeq = latestRelayRow()?.seq ?? null
    const problems = validate(candidate, {
      entries: state.page,
      history: seq => bySeq(seq),
      latestPersonSeq,
      latestRelaySeq,
      checkAnchor,
      config,
    })
    if (problems.length > 0) {
      return errorOf(`账本记录未通过校验：\n- ${problems.join('\n- ')}`)
    }

    // An omitted next_step or anchors is stored as omitted: tasksOf reads it as "unchanged" and says which entry it came from.
    const seq = state.ledgerSeq + 1
    const entry = stamp(candidate, {
      seq,
      ts: io.now(),
      window: state.window,
      latestPersonSeq,
      latestRelaySeq,
      through: state.seq,
    })
    state.ledgerSeq = seq
    state.page.push(entry)
    const ledgerWrite = queue.push(pathIn('ledger.jsonl'), toJsonl(state.page))
    saveMeta()
    const isWritten = await ledgerWrite

    // The row it was bound to is said back, so a default that picked the wrong request is seen at once.
    const bound = entry.request_ref > 0 ? bySeq(entry.request_ref) : undefined
    const boundKind = bound === undefined ? '' : bound.isPerson === true ? '用户消息' : '转交'
    const isDefault = candidate.request_ref === undefined
    let result = `已记录 #L${seq}。`
    result +=
      bound === undefined
        ? '没有可对应的请求（request_ref 记为 0）。'
        : `对应请求 #${bound.seq}（${boundKind}${isDefault ? '，省略 request_ref 时取最近一条' : ''}）。`
    // Not an error: the entry is in memory, and an error would make the model record it twice.
    if (!isWritten) {
      result += '\n注意：账本这次没能写进磁盘（内存里有，本会话内仍然有效）；下次记账会重写整个文件。'
    }
    const stillOpen = tasksOf(state.page).some(task => task.status === 'in_progress')
    if (
      entry.status === 'done' &&
      !stillOpen &&
      env.tokens !== undefined &&
      levelOf(env.tokens, env.limit, config) !== 'none'
    ) {
      result += `\n当前没有进行中的任务，上下文已用 ${k(env.tokens)}k。现在换窗口代价最小，建议调用 context 工具（action: "new"）。`
    }

    return { result }
  }

  const renderEntry = (entry: LedgerEntry): string => {
    const parts = [entry.task_id, STATUS_LABEL[entry.status], entry.title, entry.text]
    if (entry.next_step !== undefined && entry.next_step.trim() !== '') parts.push(`下一步：${entry.next_step}`)
    if (Array.isArray(entry.evidence) && entry.evidence.length > 0) {
      parts.push(`证据：${entry.evidence.map(seq => `#${seq}`).join('、')}`)
    }
    if (entry.superseded_by !== undefined && entry.superseded_by !== '') {
      parts.push(`由 ${entry.superseded_by} 取代`)
    }

    return `#L${entry.seq} · ${parts.join(' · ')}`
  }

  const renderEntries = (entries: readonly LedgerEntry[]): string =>
    entries.length === 0 ? '账本里还没有条目。' : entries.map(renderEntry).join('\n')

  const queryLedger = async (query: string): Promise<string> => {
    const needle = query.toLowerCase()
    const matches = (entry: LedgerEntry): boolean => {
      const fields: unknown[] = [entry.task_id, entry.title, entry.text, entry.next_step ?? '']
      return fields.some(field => typeof field === 'string' && field.toLowerCase().includes(needle))
    }
    const all: LedgerEntry[] = [...state.page]
    for (let page = 1; page <= state.archive.length; page += 1) {
      const entries = await loadArchive(page)
      if (entries !== null) all.push(...entries)
    }
    const hits = all.filter(matches).slice(0, MAX_QUERY_HITS)

    return hits.length === 0 ? `没有匹配「${query}」的账本条目。` : hits.map(renderEntry).join('\n')
  }

  const ledgerRead = async (input: unknown): Promise<ToolResult> => {
    await ensureLoaded()
    const raw =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
    const view = typeof raw.view === 'string' && raw.view.trim() !== '' ? raw.view.trim() : 'home'
    const query = typeof raw.query === 'string' && raw.query.trim() !== '' ? raw.query.trim() : null
    if (query !== null) return { result: await queryLedger(query) }

    if (view === 'home') {
      await ensureRequests()
      await ensureAnswered()
      const relay = await relayForHome()
      const rows = allRows()
      const requests = personRequests(rows, config.recentRequests)

      return {
        result: renderHome(
          {
            window: state.window,
            entries: state.page,
            requests: displayRequests(requests),
            ...(relay === undefined ? {} : { relay }),
            answered: repliesAnswered(rows, requests),
            archive: state.archive,
          },
          config,
        ),
      }
    }
    if (view === 'current') return { result: renderEntries(state.page) }

    const archive = /^archive:(\d+)$/.exec(view)
    if (archive !== null) {
      const page = Number(archive[1] ?? '')
      if (!Number.isInteger(page) || page < 1) return errorOf(`archive 的页号必须是正整数，收到的是「${view}」。`)
      const entries = await loadArchive(page)
      if (entries === null) {
        return errorOf(
          failedWrites.has(pathIn(archiveName(page)))
            ? `归档页 archive:${page} 读不到：归档页文件缺失，那次写入没有落盘。`
            : `没有找到归档页 archive:${page}。`,
        )
      }

      return { result: renderEntries(entries) }
    }

    return errorOf(`view 只能是 home、current 或 archive:N，收到的是「${view}」。`)
  }

  const renderHit = (hit: SearchHit): string =>
    `#${hit.seq} w${hit.window} ${hit.role}${
      hit.door === undefined ? '' : ` <${hit.door}${hit.name === undefined ? '' : `/${hit.name}`}>`
    }${hit.tool === undefined ? '' : ` [${hit.tool}]`}${
      hit.input === undefined ? '' : ` ${hit.input}`
    }${hit.path === undefined ? '' : ` [${hit.path}]`}：${hit.excerpt}`

  const historySearch = async (raw: Record<string, unknown>): Promise<ToolResult> => {
    const problems: string[] = []
    const windowField = raw.window
    if (
      windowField !== undefined &&
      (typeof windowField !== 'number' || !Number.isInteger(windowField) || windowField < 1)
    ) {
      problems.push('window 必须是大于等于 1 的整数。')
    }
    const roleField = raw.role
    if (roleField !== undefined && roleField !== 'user' && roleField !== 'assistant' && roleField !== 'tool') {
      problems.push('role 只能是 user、assistant 或 tool 之一。')
    }
    for (const name of ['query', 'tool_name', 'path', 'door'] as const) {
      if (raw[name] !== undefined && typeof raw[name] !== 'string') problems.push(`${name} 必须是字符串。`)
    }
    if (raw.limit !== undefined && (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 0)) {
      problems.push('limit 必须是非负整数。')
    }
    if (problems.length > 0) return errorOf(`history 的输入有问题：\n- ${problems.join('\n- ')}`)

    const target = windowField as number | undefined
    const searchIn = async (windows: readonly number[]): Promise<SearchHit[]> => {
      for (const window of windows) await loadWindow(window)
      const wanted = new Set(windows)

      return search(
        allRows().filter(row => wanted.has(row.window)),
        {
          query: typeof raw.query === 'string' ? raw.query : '',
          window: target,
          role: raw.role as Role | undefined,
          tool: typeof raw.tool_name === 'string' ? raw.tool_name : undefined,
          path: typeof raw.path === 'string' ? raw.path : undefined,
          door: typeof raw.door === 'string' ? raw.door : undefined,
          limit: raw.limit as number | undefined,
        },
      )
    }

    if (target !== undefined) {
      const found = await searchIn([target])

      return { result: found.length === 0 ? `第 ${target} 个窗口里没有匹配（只搜了这个窗口）。` : found.map(renderHit).join('\n') }
    }

    // A miss in the recent windows does not mean it never happened, so older ones are added one at a time until something hits.
    let first = Math.max(1, state.window - SEARCH_WINDOWS + 1)
    const recent: number[] = []
    for (let window = first; window <= state.window; window += 1) recent.push(window)
    let hits = await searchIn(recent)
    while (hits.length === 0 && first > 1) {
      first -= 1
      hits = await searchIn([first])
    }

    const span = (from: number, to: number): string => (from === to ? `第 ${from} 个窗口` : `第 ${from}–${to} 个窗口`)
    if (hits.length === 0) {
      return { result: state.window === 1 ? '没有匹配。' : `${span(1, state.window)}里都没有匹配。` }
    }
    const body = hits.map(renderHit).join('\n')
    if (first === 1) return { result: body }

    return { result: `${body}\n（搜了${span(first, state.window)}；${span(1, first - 1)}没搜，要搜用 window 指定）` }
  }

  const historyRead = async (raw: Record<string, unknown>): Promise<ToolResult> => {
    const problems: string[] = []
    const seqField = raw.seq
    if (seqField === undefined || typeof seqField !== 'number' || !Number.isInteger(seqField)) {
      problems.push('seq 必须是整数：用 history search 查到的历史编号。')
    }
    for (const name of ['offset', 'length'] as const) {
      if (raw[name] !== undefined && (typeof raw[name] !== 'number' || !Number.isInteger(raw[name]) || raw[name] < 0)) {
        problems.push(`${name} 必须是非负整数。`)
      }
    }
    if (raw.field !== undefined && raw.field !== 'text' && raw.field !== 'input') {
      problems.push('field 只能是 text（结果正文，默认）或 input（调用参数全文）。')
    }
    if (problems.length > 0) return errorOf(`history 的输入有问题：\n- ${problems.join('\n- ')}`)

    const seq = seqField as number
    const offset = typeof raw.offset === 'number' ? raw.offset : 0
    const length = typeof raw.length === 'number' ? raw.length : undefined
    const field = raw.field === 'input' ? 'input' : 'text'
    const readAt = (): ReturnType<typeof readRecord> => {
      const rows = allRows()

      return length === undefined ? readRecord(rows, seq, offset, undefined, field) : readRecord(rows, seq, offset, length, field)
    }

    let result = readAt()
    for (let window = state.window - 1; !result.found && window >= 1; window -= 1) {
      await loadWindow(window)
      result = readAt()
    }
    if (!result.found) return errorOf(`历史里没有 #${seq} 这条记录。`)

    let { text, total, hasMore } = result
    const notes: string[] = result.note === undefined ? [] : [result.note]
    if (result.overflow !== undefined) {
      const whole = await readOverflow(result.seq, result.field === 'input' ? 'args' : 'text', result.overflow, offset, length)
      if (whole === null) {
        // Never pass the row's head off as the whole: the reader must know the rest was lost.
        notes.push('这一段原文没有写进磁盘，下面只有行内保存的开头，不是全文。')
      } else {
        text = whole.text
        total = whole.total
        hasMore = whole.hasMore
      }
    }

    const header = `#${result.seq} w${result.window} ${result.role}${
      result.tool === undefined ? '' : ` [${result.tool}]`
    }${result.path === undefined ? '' : ` [${result.path}]`}${result.field === 'input' ? ' 调用参数' : ''} 共 ${total} 字符${
      hasMore ? '，还有后续，用 offset 继续读' : ''
    }`

    return { result: `${[header, ...notes].join('\n')}\n${text}` }
  }

  /**
   * One slice of a field whose whole original lives in the overflow files, or null when a part
   * it needs cannot be had. A part whose write failed is still in memory and serves the read.
   */
  const readOverflow = async (
    seq: number,
    field: 'text' | 'args',
    overflow: Overflow,
    offset: unknown,
    length: unknown,
  ): Promise<{ text: string; total: number; hasMore: boolean } | null> => {
    // A part queued a moment ago is not on disk yet.
    await queue.idle()
    const { start, end } = sliceBounds(overflow.chars, offset, length)
    const wanted = start < end ? partsCovering(overflow, start, end) : []
    let joined = ''
    for (const part of wanted) {
      const path = pathIn(overflowName(seq, field, part))
      const text = failedWrites.get(path) ?? (await readText(path))
      if (text === null) return null
      joined += text
    }
    const origin = wanted.length === 0 ? 0 : partOrigin(overflow, wanted[0] ?? 0)
    const slice = wanted.length === 0 ? '' : joined.slice(start - origin, end - origin)
    // A part cut short on disk would hand back a slice that is not what the offset names.
    if (slice.length !== Math.max(0, end - start)) return null

    return { text: slice, total: overflow.chars, hasMore: end < overflow.chars }
  }

  const historyTool = async (input: unknown): Promise<ToolResult> => {
    await ensureLoaded()
    const raw =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
    if (raw.action !== 'search' && raw.action !== 'read') {
      return errorOf('history 工具需要 action："search" 或 "read"。')
    }

    return raw.action === 'search' ? historySearch(raw) : historyRead(raw)
  }

  const status = (env: Env): string => {
    const now = io.now()
    const switches = state.switchTimes.filter(at => at > now - 3_600_000 && at <= now).length
    const open = tasksOf(state.page).filter(task => task.status === 'in_progress').length

    const unwritten = unsaved()

    return `${describeFill(env.tokens, env.limit, state.window)} · 距上次换窗口 ${state.requestsSinceSwitch} 次请求 · 本小时已换窗口 ${switches} 次 · 进行中任务 ${open} 个${unwritten.length === 0 ? '' : ` · 有 ${unwritten.length} 个文件没写进磁盘`}`
  }

  /** Whether the current page of the ledger carries an entry made after the latest person prompt. */
  const isLedgerFresh = (): boolean => {
    const latest = latestPersonRow()

    return hasFreshEntry(state.page, latest === null ? 0 : latest.ts, state.window)
  }

  /**
   * The work done after the window's latest ledger entry: tool results of the main conversation
   * (this mod's own calls are not work) that the entry did not cover. An entry from before
   * `through` existed is compared by time instead of by history number.
   */
  const tailOf = (): { steps: number; from: number | null; to: number | null; entrySeq: number | null } => {
    let latest: LedgerEntry | null = null
    for (const entry of state.page) {
      if (entry.window === state.window && (latest === null || entry.seq > latest.seq)) latest = entry
    }
    const covered = latest
    let steps = 0
    let from: number | null = null
    let to: number | null = null
    for (const row of allRows()) {
      if (row.window !== state.window || row.role !== 'tool' || row.door !== undefined || isOwnRow(row)) continue
      if (covered !== null) {
        const isCovered = typeof covered.through === 'number' ? row.seq <= covered.through : row.ts <= covered.ts
        if (isCovered) continue
      }
      steps += 1
      if (from === null || row.seq < from) from = row.seq
      if (to === null || row.seq > to) to = row.seq
    }

    return { steps, from, to, entrySeq: covered === null ? null : covered.seq }
  }

  /** Whether a compaction can leave the summary to the ledger: it is fresh and little happened since. */
  const canSkipSummary = (): boolean => isLedgerFresh() && tailOf().steps <= config.autoTailSteps

  /**
   * Holds back a ToolSearch that would load a costly group, once the context is past the gate:
   * the model is sent to record its progress and switch first, and the load waits for the new
   * window. A group is held back once per window, so a repeat goes through and a refused switch
   * cannot stall the session. A group this window already loaded is not held back again.
   */
  const gateLoad = (query: unknown, tokens: number | undefined): string | null => {
    if (typeof query !== 'string' || tokens === undefined || tokens <= config.gateMinTokens) return null
    const costly = costlyGroups()
    const named = groupsWanted(query, Object.keys(costly))
    if (named.length === 0) return null
    const loadedHere = new Set<string>()
    for (const row of allRows()) {
      if (row.window !== state.window || row.tool !== 'ToolSearch' || row.loaded === undefined) continue
      for (const name of row.loaded) loadedHere.add(toolGroupOf(name))
    }
    const wanted = named.filter(group => !loadedHere.has(group) && !state.gateAsked.includes(group))
    if (wanted.length === 0) return null

    state.gateAsked = [...state.gateAsked, ...wanted]
    state.gateWanted = [...new Set([...state.gateWanted, ...wanted])]
    const names = wanted.join('、')
    const biggest = Math.max(...wanted.map(group => costly[group] ?? 0))

    return `先不加载：加载 ${names} 会让整段对话的缓存重建（上次加载后重写了${rewriteOf(biggest)} token），当前上下文 ${k(tokens)}k。请先用 ledger_append 把进度记进账本，next_step 写明“换窗后第一步用 ToolSearch 加载 ${names}”，然后调用 context 工具（action: "new"），在新窗口里加载。如果换窗口被拒绝，或者只差这一步就做完，再调用一次 ToolSearch 即可照常加载。`
  }

  const requestSwitch = (input: unknown, env: Env): ToolResult => {
    // An approval already stands: asking again changes nothing, and re-stamping it
    // would only stretch the time the model has to end the turn.
    if (pending() !== null) return { result: APPROVED }

    const raw =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
    const reason = typeof raw.reason === 'string' ? raw.reason : ''
    const now = io.now()
    const judgement = judgeSwitch(
      {
        before: env.tokens ?? 0,
        prefix: state.lastPrefix ?? DEFAULT_PREFIX,
        handoff: state.lastHandoff ?? DEFAULT_HANDOFF,
        reread: config.snippetTokens,
        remainingRequests: raw.expect_more_work === false ? REMAINING_REQUESTS_LAST : REMAINING_REQUESTS,
      },
      config,
    )
    const isFresh = isLedgerFresh()
    const tail = tailOf()
    const isTailShort = tail.steps <= config.freshTailSteps
    let staleReason: string | undefined
    if (!isFresh) {
      staleReason = '账本还不新：这个窗口里在最近一次用户请求之后还没有记过账。'
    } else if (!isTailShort) {
      const range = tail.from === null || tail.to === null ? '' : `（#${tail.from}–#${tail.to}）`
      staleReason = `账本还不新：最近一次记账（#L${tail.entrySeq ?? 0}）之后又有 ${tail.steps} 个工具结果没有记进账本${range}。`
    }
    const gate = gateSwitch(
      {
        requestsSinceSwitch: state.requestsSinceSwitch,
        switchTimes: state.switchTimes,
        now,
        hasFreshLedger: isFresh && isTailShort,
        ...(staleReason === undefined ? {} : { staleReason }),
        level: env.tokens === undefined ? 'none' : levelOf(env.tokens, env.limit, config),
        judgement,
        // A switch made in front of a held-back load may skip the cooldown and the payoff.
        isForLoad: state.gateWanted.length > 0,
      },
      config,
    )
    if (!gate.isAllowed) return errorOf(`暂不换窗口：${gate.reason}`)

    state.pending = { reason, at: now }

    return { result: APPROVED }
  }

  const pending = (): Pending | null => {
    if (state.pending === null) return null
    if (io.now() - state.pending.at > PENDING_MS) {
      state.pending = null

      return null
    }

    return state.pending
  }

  const clearPending = (): void => {
    state.pending = null
  }

  const buildHandoff = async (opts: { isMidTurn: boolean; agents?: readonly AgentNote[] }): Promise<string> => {
    await ensureLoaded()
    await ensureRequests()
    await ensureReplies()
    await ensureAnswered()
    const relay = await relayForHome()
    const rows = allRows()
    const requests = displayRequests(personRequests(rows, config.recentRequests))
    const answered = repliesAnswered(rows, requests)
    const window = state.window + 1
    const agents = renderAgents(agentsForHandoff(opts.agents ?? [], state.roster))
    const home = renderHome(
      { window, entries: state.page, requests, ...(relay === undefined ? {} : { relay }), answered, archive: state.archive },
      config,
    )
    // A running task is already spelled out in the home page: repeating the last
    // reply beside it would only spend the handoff's budget twice on the same turn.
    const running = tasksOf(state.page).some(task => task.status === 'in_progress')
    const lastReply = running ? null : lastReplyOf()
    const open: TaskState[] = tasksOf(state.page)
      .filter(task => task.status === 'in_progress' || task.status === 'blocked')
      .sort((left, right) => right.latest.ts - left.latest.ts || right.latest.seq - left.latest.seq)
    const tasks: OpenTask[] = open.map(task => ({ taskId: task.taskId, anchors: task.anchors?.value ?? [] }))
    const inherited = new Map<string, number>()
    for (const task of open) {
      if (task.anchors?.isInherited === true) inherited.set(task.taskId, task.anchors.seq)
    }

    const files = new Map<string, FileContent>()
    for (const path of pathsToRead(tasks, state.activities, state.window)) {
      const key = pathKey(path)
      if (files.has(key)) continue
      try {
        files.set(key, await io.read(path))
      } catch (problem) {
        files.set(key, messageOf(problem).includes('ENOENT') ? { missing: true } : { tooLarge: true })
      }
    }

    const snippets = snippetsOf(
      { tasks, files, activities: state.activities, window: state.window },
      config,
    )
    // Only the text the model reads is shortened: the activities, meta and shards keep absolute paths.
    let base: string | undefined
    try {
      base = (await io.cwd?.()) || undefined
    } catch {
      // No working directory known: the paths are shown as they are.
    }
    const workset = renderWorkset(filesOf(state.activities, state.window), snippets, inherited, base)
    const tail = tailOf()
    // The whole uncovered stretch is listed (up to a cap), since the ledger holds nothing of it.
    const actions = recentActions(
      rows,
      state.window,
      Math.max(config.recentActions, Math.min(MAX_TAIL_ACTIONS, tail.steps)),
    ).map(action => (action.path === undefined ? action : { ...action, path: relativePath(action.path, base) }))
    const coverage = renderCoverage(tail)
    const tools = renderTools(costlyToolsOf(loadedTools(rows, state.window), costlyGroups()))
    const loadReason = renderLoadReason(state.gateWanted)

    return assemble(
      {
        window,
        home,
        workset,
        actions,
        isMidTurn: opts.isMidTurn,
        ...(loadReason === '' ? {} : { loadReason }),
        ...(coverage === '' ? {} : { coverage }),
        ...(agents === '' ? {} : { agents }),
        ...(tools === '' ? {} : { tools }),
        ...(lastReply === null ? {} : { lastReply }),
      },
      config,
    )
  }

  const commitSwitch = async (info: {
    trigger: string
    tokensBefore: number | undefined
    handoffText: string
  }): Promise<void> => {
    await ensureLoaded()
    await ensureRequests()
    const now = io.now()
    if (eventsText === null) eventsText = (await readText(pathIn('events.jsonl'))) ?? ''
    const event = {
      at: now,
      window: state.window,
      trigger: info.trigger,
      reason: state.pending === null ? null : state.pending.reason,
      tokensBefore: info.tokensBefore ?? null,
      handoffTokens: estimateTokens(info.handoffText),
      requestsSinceSwitch: state.requestsSinceSwitch,
    }
    // Kept beside the history so a person can read what each window opened with.
    void queue.push(
      pathIn(handoffName(state.window + 1)),
      info.handoffText,
    )
    eventsText = `${eventsText}${JSON.stringify(event)}\n`
    void queue.push(pathIn('events.jsonl'), eventsText)

    const requests = personRequests(allRows(), config.recentRequests)
    const requestSeqs = new Set(requests.map(row => row.seq))
    const protectedIds = new Set(
      state.page.filter(entry => requestSeqs.has(entry.request_ref)).map(entry => entry.task_id),
    )
    const { moved } = turnPage(state.page, protectedIds, config)
    if (moved.length > 0) {
      const page = state.archive.length + 1
      const archivePath = pathIn(archiveName(page))
      // The entries leave the ledger only once their page is on disk; otherwise they would survive in memory alone.
      const isArchived = await queue.push(archivePath, toJsonl(moved))
      if (!isArchived) {
        // This attempt is abandoned and the next switch rebuilds the page, so a retry of the stale text must not land.
        failedWrites.delete(archivePath)
      } else if (state.archive.length + 1 === page) {
        state.archive.push(pageOf(page, moved))
        // Entries recorded while the page was being written stay: only the archived ones leave.
        const movedSeqs = new Set(moved.map(entry => entry.seq))
        state.page = state.page.filter(entry => !movedSeqs.has(entry.seq))
        void queue.push(pathIn('ledger.jsonl'), toJsonl(state.page))
      }
    }

    state.window += 1
    state.part = 0
    state.requestsSinceSwitch = 0
    state.reminded = { soft: false, urgent: false }
    state.switchTimes = [...state.switchTimes, now].filter(at => at > now - 3_600_000)
    state.lastHandoff = estimateTokens(info.handoffText)
    state.pending = null
    // The new window's first request has no earlier context to judge a load against.
    state.lastContext = null
    state.pendingLoads = []
    // The gate's memory is per window: the new one may hold back its own loads again.
    state.gateAsked = []
    state.gateWanted = []
    const opened = emptyShard(state.window, 0)
    shards.set(shardName(state.window, 0), opened)
    fullWindows.add(state.window)
    saveMeta()
  }

  const notePrefix = (tokens: number): void => {
    state.lastPrefix = Math.max(0, tokens - (state.lastHandoff ?? 0))
  }

  const flush = async (): Promise<void> => {
    await ensureLoaded()
    await queue.idle()
    if (failedWrites.size === 0) return
    // Only with the queue empty: a queued newer text for the same path would be overwritten by the old one.
    for (const [path, text] of [...failedWrites]) void queue.push(path, text)
    await queue.idle()
  }

  // Only this session's own files: the cross-session table sits outside the directory, and a
  // new window never needs it to pick the work up.
  const hold = async (text: string): Promise<number | null> => {
    await ensureLoaded()
    const id = held.reduce((top, item) => Math.max(top, item.id), 0) + 1
    held = [...held, { id, text, at: io.now() }]
    const isWritten = await queue.push(pathIn(HELD_FILE), heldJson())
    if (isWritten) return id

    // Not on disk, so the message must not be held: it goes in as usual. The failed text
    // would come back from a flush retry otherwise, with this item in it.
    held = held.filter(item => item.id !== id)
    failedWrites.delete(pathIn(HELD_FILE))

    return null
  }

  const heldItems = (): HeldItem[] => held.map(item => ({ ...item }))

  const release = async (id: number): Promise<void> => {
    await ensureLoaded()
    if (!held.some(item => item.id === id)) return
    held = held.filter(item => item.id !== id)
    // A failed write is left to flush's retry; the item is delivered either way.
    await queue.push(pathIn(HELD_FILE), heldJson())
  }

  const unsaved = (): string[] =>
    [...failedWrites.keys()]
      .filter(path => path.startsWith(`${root}/`))
      .map(path => path.slice(root.length + 1))
      .sort()

  const latestPersonSeq = (): number | null => {
    const latest = latestPersonRow()

    return latest === null ? null : latest.seq
  }

  const latestRelaySeq = (): number | null => latestRelayRow()?.seq ?? null

  return {
    record,
    activity,
    noteAgent,
    agentEnded,
    noteStep,
    costlyGroups,
    importMessages,
    noteRequest,
    reminder,
    ledgerAppend,
    ledgerRead,
    historyTool,
    status,
    requestSwitch,
    gateLoad,
    ready,
    pending,
    clearPending,
    buildHandoff,
    commitSwitch,
    notePrefix,
    window: () => state.window,
    flush,
    unsaved,
    hold,
    heldItems,
    release,
    latestPersonSeq,
    latestRelaySeq,
    isLedgerFresh,
    canSkipSummary,
    lastRequestAt: () => state.lastRequestAt,
  }
}
