// The shapes every part of ctx-mod shares. Pure data: no engine calls here.

export type Config = {
  /** The compaction window to assume when the engine reports no threshold. */
  compactWindow: number
  /** Percent of the limit past which a finished task is a good moment to switch windows. */
  boundaryPct: number
  /** Percent of the limit for the soft and the urgent reminder. */
  softPct: number
  urgentPct: number
  /** A cold cache switches the window only above this fill. */
  coldMinTokens: number
  /** Cache lifetime to assume when cache-keeper's state cannot be read. */
  cacheTtlSec: number
  /** At or above this 5-hour percent a switch never continues by itself. */
  noContinueAtPercent: number
  /** Main-loop model requests (one per turn step, tool call or not) that must pass between two switches. */
  cooldownRequests: number
  maxSwitchesPerHour: number
  /**
   * Hard caps, in estimated tokens — except handoffTokens, which is a target: the opening, home page,
   * last reply, subagents and tool notes are never cut, so a handoff can run past it.
   */
  handoffTokens: number
  snippetTokens: number
  homeTokens: number
  pageTokens: number
  /** Lines of context on each side of an anchor. */
  snippetLines: number
  recentActions: number
  recentRequests: number
  /** Token-equivalent weights of a cache read and a cache write. */
  wRead: number
  wWrite: number
  breakEvenSafety: number
  /** Longest `text` one ledger entry may carry, in characters. */
  maxTextChars: number
  /** Above this context, a load that rebuilds the cache waits for a window switch first. */
  gateMinTokens: number
  /** When the model asks for a switch, the most tool results allowed after the latest ledger entry. */
  freshTailSteps: number
  /** On an automatic compaction, more unrecorded tool results than this send the summary back to the engine. */
  autoTailSteps: number
}

export const DEFAULTS: Config = {
  compactWindow: 400_000,
  // Late on purpose: a switch loses working detail, so the window is used nearly
  // to its end. Urgent still leaves room for the ledger entries before the limit.
  // Of a 400k limit these are 300k, 332k and 352k.
  boundaryPct: 75,
  softPct: 83,
  urgentPct: 88,
  coldMinTokens: 100_000,
  cacheTtlSec: 3_600,
  noContinueAtPercent: 90,
  cooldownRequests: 30,
  maxSwitchesPerHour: 4,
  handoffTokens: 15_000,
  snippetTokens: 6_000,
  homeTokens: 1_500,
  pageTokens: 4_000,
  snippetLines: 30,
  recentActions: 10,
  recentRequests: 3,
  wRead: 0.025,
  wWrite: 1,
  breakEvenSafety: 1.5,
  maxTextChars: 1_500,
  gateMinTokens: 120_000,
  freshTailSteps: 5,
  autoTailSteps: 25,
}

/**
 * A rough token count with no tokenizer: an ASCII character is a quarter of a
 * token, any other (CJK, mostly) a whole one.
 */
export const estimateTokens = (text: string): number => {
  let ascii = 0
  let other = 0
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1
    else other += 1
  }

  return Math.ceil(ascii / 4) + other
}

export const toJsonl = (rows: readonly unknown[]): string =>
  rows.length === 0 ? '' : `${rows.map(row => JSON.stringify(row)).join('\n')}\n`

/** Reads JSON lines, leaving out any line that does not parse. */
export const parseJsonl = <T>(text: string): T[] => {
  const rows: T[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line) as T)
    } catch {
      // a damaged line is skipped, the rest still reads
    }
  }

  return rows
}

export type Role = 'user' | 'assistant' | 'tool'

/** One row of the conversation as ctx-mod keeps it on disk. */
export type HistoryRecord = {
  /** Counts up from 1 across the whole session, never reused. */
  seq: number
  /** The engine's id of the row. */
  uuid: string
  /** Milliseconds since the epoch. */
  ts: number
  /** The context window the row was made in, from 1. */
  window: number
  role: Role
  /** True on a prompt a person typed (never a plugin's or a notification). */
  isPerson?: true
  /** The tool's name, on a tool call's result. */
  tool?: string
  /** The file a Read, Edit, Write or search was about. */
  path?: string
  /**
   * A one-line summary of a tool call's input, at most 300 characters: the
   * command behind a Bash result or the pattern behind a Grep, so the model can
   * search for what it ran instead of running it again.
   */
  input?: string
  isError?: true
  /** The deferred tools a ToolSearch call loaded, by name; only that call's result carries them. */
  loaded?: string[]
  /**
   * The door the row came in by, written only on rows outside the three original
   * ones (prompt, response, tool-result): a row without it is read as before.
   */
  door?: string
  /** The attachment type behind a `door` row, such as `queued_command`. */
  name?: string
  /**
   * The tool call's arguments in full (see `formatArgs`), cut at `MAX_ARGS_CHARS`;
   * `input` stays the short summary. Rows written before this field have none.
   */
  args?: string
  /** The engine's `tool_use_id` of the call, so a conversation can be lined up with the rows later. */
  callId?: string
  /** A field cut at the row, whose whole original sits in `big-<seq>-<field>-<n>.txt` files. */
  overflow?: { text?: Overflow; args?: Overflow }
  text: string
}

/**
 * How one over-long field was set aside: its length, how many part files hold it
 * and, only when a part was cut short to keep a surrogate pair whole, where each
 * part after the first starts.
 */
export type Overflow = { chars: number; parts: number; cuts?: number[] }

/**
 * The name prefix of every tool this mod registers. Its own calls are bookkeeping
 * rather than the work, so the recap and the search leave them out by this prefix.
 */
export const OWN_TOOL_PREFIX = 'mcp__ctx-mod__'

export type TaskStatus = 'in_progress' | 'done' | 'superseded' | 'blocked'

/** Where the next edit of a task goes: a file and a short text found once in it. */
export type Anchor = { path: string; match: string; note: string }

/** What the model hands `ledger_append`. */
export type LedgerInput = {
  task_id: string
  title: string
  status: TaskStatus
  text: string
  next_step?: string
  anchors?: Anchor[]
  /** History seqs proving a `done`. */
  evidence?: number[]
  superseded_by?: string
  /** The seq of the person's prompt the task answers; the latest when left out. */
  request_ref?: number
}

/** A ledger entry as stored: the input plus what the code stamps. */
export type LedgerEntry = Omit<LedgerInput, 'request_ref'> & {
  seq: number
  ts: number
  window: number
  request_ref: number
  /** The seq of the last history row when this entry was written; older entries lack it. */
  through?: number
}

export type FileOp = 'read' | 'edit' | 'write' | 'search'

/** One touch of a file by the main conversation's tools. */
export type FileActivity = {
  path: string
  op: FileOp
  /** The history seq of the tool result. */
  seq: number
  window: number
  isError: boolean
  /** 1-based, inclusive, when the call named a range. */
  startLine?: number
  endLine?: number
  /** The first line an Edit wrote, to find the place again later. */
  hint?: string
}

/** A piece of a file read from disk at the switch, or why there is none. */
export type Snippet =
  | {
      path: string
      taskId: string
      note: string
      /** 1-based line the text starts at. */
      startLine: number
      /** The lines, each prefixed with its number and a tab. */
      text: string
      needsRead?: undefined
    }
  | {
      path: string
      taskId: string
      note: string
      /** Why no text could be taken: the model reads the file itself. */
      needsRead: string
      /** The last history seq that read the file, when there is one. */
      lastSeq?: number
      text?: undefined
    }

/** cache-keeper's published state, as `$.state` hands it over. */
export type CacheState = {
  lastActivityAt: number | null
  ttl: '5m' | '1h' | null
  expiresAt: number | null
  cachedPrefixTokens: number
  isEnabled: boolean
  pausedReason: string | null
  bridgePhase: 'idle' | 'wrapped'
}
