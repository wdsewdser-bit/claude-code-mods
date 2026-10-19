// Pure history-plane logic: shard naming and packing, UTF-8 sizing without
// TextEncoder, clipping, search, paging and the whole-file write queue. Nothing
// here touches the engine, fs or a clock, so the callers inject the writer and
// this module stays testable in a bare interpreter.

import { OWN_TOOL_PREFIX } from './types.ts'
import type { HistoryRecord, Overflow, Role } from './types.ts'

/** Shards rotate well before the engine's 4 MiB read ceiling, so a whole file still reads. */
export const MAX_SHARD_BYTES = 2 * 1024 * 1024

/** One record past this is clipped, so a single row can never fill a shard by itself. */
export const MAX_RECORD_CHARS = 200_000

/** A tool call's arguments past this are clipped in the row; the rest goes to the overflow files. */
export const MAX_ARGS_CHARS = 50_000

/**
 * One overflow file holds at most this many characters: UTF-8 makes that about
 * 3 MB at worst, which stays under the engine's 4 MiB read ceiling.
 */
export const OVERFLOW_PART_CHARS = 1_000_000

/** Three digits keep shard names sorting in window order for windows up to 999. */
const windowTag = (window: number): string => `w${String(window).padStart(3, '0')}`

/**
 * Part 0 is the plain name. Parts 1..25 take the letters b..z, which keeps a
 * rotation short; later parts fall back to digits, which never run out.
 */
const partTag = (part: number): string => {
  if (part <= 0) return ''
  if (part <= 25) return `-${String.fromCharCode(97 + part)}`

  return `-p${part}`
}

/** The file a window's shard part lives in; the caller writes the whole file at once. */
export const shardName = (window: number, part: number): string =>
  `history-${windowTag(window)}${partTag(part)}.jsonl`

/**
 * The UTF-8 length of a string, counted code point by code point: TextEncoder
 * and Buffer are both out of reach in the engine's module sandbox.
 */
export const byteLength = (text: string): number => {
  let bytes = 0
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0
    if (point < 0x80) bytes += 1
    else if (point < 0x800) bytes += 2
    else if (point < 0x10000) bytes += 3
    else bytes += 4
  }

  return bytes
}

/** Whether a UTF-16 unit is the first half of a surrogate pair. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff

/** The head of an over-long field plus one line saying how long the original was and where the rest lives. */
const clipField = (text: string, limit: number): string => {
  let head = text.slice(0, limit)
  // Never cut a surrogate pair in half: the lone half would be unencodable.
  if (isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1)

  return `${head}\n[已截断：原文 ${text.length} 字符，可分页读全文，搜索只查这一段]`
}

/**
 * Cuts a text into the overflow files' contents. A part ends one unit early
 * when its last unit would split a surrogate pair, so a part's start is not
 * always a multiple of the part size: `cuts` then lists where each later part
 * starts, and is left out while the plain arithmetic holds.
 */
export const splitParts = (text: string): { parts: string[]; cuts?: number[] } => {
  const parts: string[] = []
  const cuts: number[] = []
  let isShifted = false
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + OVERFLOW_PART_CHARS)
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1
    parts.push(text.slice(start, end))
    if (end < text.length) {
      cuts.push(end)
      if (end !== parts.length * OVERFLOW_PART_CHARS) isShifted = true
    }
    start = end
  }

  return isShifted ? { parts, cuts } : { parts }
}

const overflowOf = (text: string): Overflow => {
  const { parts, cuts } = splitParts(text)

  return { chars: text.length, parts: parts.length, ...(cuts === undefined ? {} : { cuts }) }
}

/** Where an overflow file begins in the original text. */
const partStart = (overflow: Overflow, part: number): number =>
  part <= 0 ? 0 : overflow.cuts?.[part - 1] ?? part * OVERFLOW_PART_CHARS

/** The overflow file that holds one field of one row; `field` is `text` or `args`. */
export const overflowName = (seq: number, field: 'text' | 'args', part: number): string =>
  `big-${seq}-${field}-${part}.txt`

/** The parts that hold any of the characters from `start` up to `end`, in order. */
export const partsCovering = (overflow: Overflow, start: number, end: number): number[] => {
  const wanted: number[] = []
  for (let part = 0; part < overflow.parts; part += 1) {
    const from = partStart(overflow, part)
    const to = part + 1 < overflow.parts ? partStart(overflow, part + 1) : overflow.chars
    if (to > start && from < end) wanted.push(part)
  }

  return wanted
}

/** Where the first of the given parts begins; the caller joins the parts it read and slices from here. */
export const partOrigin = (overflow: Overflow, part: number): number => partStart(overflow, part)

/**
 * The record as it is kept in a shard: a text or arguments field past its limit
 * keeps only its head plus one line saying how long the original was, and the
 * row notes how many overflow files the whole original goes into. Everything a
 * consumer reads from the row stays as short as it ever was.
 */
export const clipRecord = (record: HistoryRecord): HistoryRecord => {
  const clipped: HistoryRecord = { ...record }
  const overflow: NonNullable<HistoryRecord['overflow']> = {}
  if (record.text.length > MAX_RECORD_CHARS) {
    clipped.text = clipField(record.text, MAX_RECORD_CHARS)
    overflow.text = overflowOf(record.text)
  }
  if (record.args !== undefined && record.args.length > MAX_ARGS_CHARS) {
    clipped.args = clipField(record.args, MAX_ARGS_CHARS)
    overflow.args = overflowOf(record.args)
  }
  if (overflow.text !== undefined || overflow.args !== undefined) clipped.overflow = overflow

  return clipped
}

/**
 * A tool call's arguments as plain text: one `key: value` segment per top-level
 * key, strings as they are (they may span lines), anything else as JSON. The
 * live path and the import path both write it, so a row reads the same either way.
 */
export const formatArgs = (args: Readonly<Record<string, unknown>>): string => {
  const segments: string[] = []
  for (const [key, value] of Object.entries(args)) {
    let shown: string | undefined
    if (typeof value === 'string') {
      shown = value
    } else {
      try {
        shown = JSON.stringify(value)
      } catch {
        // A value JSON cannot hold (a cycle, a BigInt) is still worth its name.
        shown = String(value)
      }
    }
    if (shown !== undefined) segments.push(`${key}: ${shown}`)
  }

  return segments.join('\n')
}

/**
 * One line naming the blocks of a row that are not text, so an image or a
 * document does not vanish from the history without a trace; empty when every
 * block is text. A part that carries its own text is counted as text, as the
 * extraction of the text does; `skip` leaves out types the row already names.
 */
export const nonTextNote = (blocks: readonly unknown[], skip: readonly string[] = []): string => {
  const counts = new Map<string, number>()
  for (const block of blocks) {
    const part = typeof block === 'object' && block !== null ? (block as { type?: unknown; text?: unknown }) : {}
    if (typeof (part as { text?: unknown }).text === 'string') continue
    const type = typeof part.type === 'string' ? part.type : 'unknown'
    if (type === 'text' || skip.includes(type)) continue
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  if (counts.size === 0) return ''

  return `[非文本内容：${[...counts].map(([type, count]) => `${type}×${count}`).join('、')}]`
}

/** One shard file: its window, its rotation index, its rows and their running byte cost. */
export type Shard = { window: number; part: number; rows: HistoryRecord[]; bytes: number }

export const emptyShard = (window: number, part = 0): Shard => ({ window, part, rows: [], bytes: 0 })

/** What one row costs in a shard: its JSON, plus the newline that joins the lines. */
const recordBytes = (record: HistoryRecord): number => byteLength(JSON.stringify(record)) + 1

/**
 * Places one record into a shard, returning the shard to keep and whether a new
 * file was opened. A record from another window starts that window's part 0, and
 * one that would push a non-empty shard past the ceiling rotates within the same
 * window; a record too big for any shard still lands alone in an empty one.
 *
 * Appending into the current shard pushes onto that shard's own `rows` and hands
 * back the same array, which keeps a run of records linear rather than quadratic
 * in the array length. The shard passed in is therefore consumed: work with the
 * returned shard from then on, and never read the old one again. A rotation or a
 * window change still builds a fresh shard and leaves the old one whole, since
 * the caller has already written and stored it under its own name.
 */
export const appendRecord = (
  shard: Shard,
  record: HistoryRecord,
): { shard: Shard; isNew: boolean } => {
  const bytes = recordBytes(record)

  if (record.window !== shard.window) {
    return { shard: { ...emptyShard(record.window, 0), rows: [record], bytes }, isNew: true }
  }

  if (shard.rows.length > 0 && shard.bytes + bytes > MAX_SHARD_BYTES) {
    return { shard: { ...emptyShard(shard.window, shard.part + 1), rows: [record], bytes }, isNew: true }
  }

  shard.rows.push(record)
  shard.bytes += bytes

  return { shard, isNew: false }
}

export type SearchQuery = {
  query: string
  window?: number
  role?: Role
  tool?: string
  path?: string
  /** Only rows that came in by this door; it also lifts the default skip of the background rows. */
  door?: string
  limit?: number
}

export type SearchHit = {
  seq: number
  window: number
  role: Role
  tool?: string
  path?: string
  door?: string
  name?: string
  /** The tool call's input summary, when the row has one. */
  input?: string
  excerpt: string
}

const EXCERPT_PAD = 80
const EXCERPT_HEAD = 160
const SEARCH_LIMIT_DEFAULT = 20
const SEARCH_LIMIT_MAX = 100

/**
 * The cap the caller asked for, or the default. A value that is not a finite
 * positive number — NaN, a string, Infinity, zero, a negative — must never be
 * read as "no cap" and hand back the whole history, which is exactly what a
 * comparison against NaN does.
 */
const searchLimit = (limit: unknown): number => {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) return SEARCH_LIMIT_DEFAULT

  return Math.min(Math.floor(limit), SEARCH_LIMIT_MAX)
}

/** A window filter means a finite number; anything else is no filter at all. */
const windowFilter = (window: unknown): number | undefined =>
  typeof window === 'number' && Number.isFinite(window) ? window : undefined

/** Only the three role names filter; anything else is ignored, never turned into an empty answer. */
const roleFilter = (role: unknown): Role | undefined =>
  role === 'user' || role === 'assistant' || role === 'tool' ? role : undefined

/** A text filter is a string or nothing; a non-string must not throw. */
const textFilter = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** Whether a row is one of this mod's own tool calls; those stay on disk but are not the work. */
export const isOwnRow = (row: HistoryRecord): boolean =>
  typeof row.tool === 'string' && row.tool.startsWith(OWN_TOOL_PREFIX)

/**
 * Whether a row is the engine's own background (an attachment, a hook's context,
 * a note) rather than something said or done. A person's message that arrived
 * as a `queued_command` attachment is the exception: it is the work.
 */
export const isBackgroundRow = (row: Pick<HistoryRecord, 'door' | 'name'>): boolean =>
  row.door === 'hook-context' ||
  row.door === 'note' ||
  (row.door === 'attachment' && row.name !== 'queued_command')

/** A path is written with either separator; folding them makes one filter work for both. */
const flattenPath = (path: string): string => path.replace(/\\/g, '/').toLowerCase()

/** Newlines inside a one-line excerpt would break the table the caller prints. */
const oneLine = (text: string): string => text.replace(/[\r\n]/g, ' ')

/** The window around the first match, the match itself included. */
const excerptAround = (text: string, at: number, width: number): string =>
  oneLine(text.slice(Math.max(0, at - EXCERPT_PAD), Math.min(text.length, at + width + EXCERPT_PAD)))

/**
 * Literal, case-insensitive search over the records, newest first. An empty
 * query skips text matching and only applies the filters, so it doubles as
 * "what happened in this window". Every field is read defensively: the callers
 * cast a model's tool input straight to `SearchQuery`, so a missing or wrongly
 * typed field means "no filter", never a throw and never a widened answer.
 * This mod's own tool rows are skipped unless the caller names a tool filter:
 * a search is about the work, and a tool filter is how they are still found.
 * The engine's background rows are skipped the same way unless a door is named.
 */
export const search = (rows: readonly HistoryRecord[], query: SearchQuery): SearchHit[] => {
  const limit = searchLimit(query.limit)
  const window = windowFilter(query.window)
  const role = roleFilter(query.role)
  const tool = textFilter(query.tool)
  const door = textFilter(query.door)
  const skipOwn = tool === undefined
  const filterPath = textFilter(query.path)
  const needle = (typeof query.query === 'string' ? query.query : '').toLowerCase()
  const pathNeedle = filterPath === undefined ? undefined : flattenPath(filterPath)
  const hits: SearchHit[] = []

  for (const row of [...rows].sort((a, b) => b.seq - a.seq)) {
    if (hits.length >= limit) break
    if (window !== undefined && row.window !== window) continue
    if (role !== undefined && row.role !== role) continue
    if (tool !== undefined && row.tool !== tool) continue
    if (skipOwn && isOwnRow(row)) continue
    if (door !== undefined ? row.door !== door : isBackgroundRow(row)) continue
    if (pathNeedle !== undefined) {
      if (row.path === undefined || !flattenPath(row.path).includes(pathNeedle)) continue
    }

    let excerpt: string
    if (needle === '') {
      excerpt = oneLine(row.text.slice(0, EXCERPT_HEAD))
    } else {
      const at = row.text.toLowerCase().indexOf(needle)
      // A word that only survived in the call's arguments, or in their summary, still
      // matches: the point of those fields is to find a past call by what it was asked.
      const inArgs = at < 0 ? (row.args ?? '').toLowerCase().indexOf(needle) : -1
      const inInput = at < 0 && inArgs < 0 ? (row.input ?? '').toLowerCase().indexOf(needle) : -1
      if (at < 0 && inArgs < 0 && inInput < 0) continue
      excerpt =
        at >= 0
          ? excerptAround(row.text, at, needle.length)
          : inArgs >= 0
            ? excerptAround(row.args ?? '', inArgs, needle.length)
            : excerptAround(row.input ?? '', inInput, needle.length)
    }

    const hit: SearchHit = { seq: row.seq, window: row.window, role: row.role, excerpt }
    if (row.tool !== undefined) hit.tool = row.tool
    if (row.path !== undefined) hit.path = row.path
    if (row.input !== undefined) hit.input = row.input
    if (row.door !== undefined) hit.door = row.door
    if (row.name !== undefined) hit.name = row.name
    hits.push(hit)
  }

  return hits
}

export type ReadResult =
  | { found: false }
  | {
      found: true
      seq: number
      window: number
      role: Role
      tool?: string
      path?: string
      ts: number
      /** Which field the slice is of: the result's text, or the call's arguments. */
      field: ReadField
      text: string
      total: number
      hasMore: boolean
      /** Said before the text when the field is not what the caller asked for in full. */
      note?: string
      /** Set when the field was cut at the row: the whole original is in the overflow files. */
      overflow?: Overflow
    }

type FoundResult = Extract<ReadResult, { found: true }>

/** What `history` read can page through: a row's text, or the arguments of the call behind it. */
export type ReadField = 'text' | 'input'

const READ_LENGTH_DEFAULT = 4_000
const READ_LENGTH_MAX = 20_000

/** A count that must be a finite number to be usable, floor included; otherwise the fallback. */
const countOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback

/** The slice a read of `total` characters covers, with the same defaults and caps for every field. */
export const sliceBounds = (total: number, offset: unknown, length: unknown): { start: number; end: number } => {
  const start = Math.max(0, countOr(offset, 0))
  const asked = countOr(length, READ_LENGTH_DEFAULT)

  return { start, end: Math.min(total, start + Math.max(0, Math.min(asked, READ_LENGTH_MAX))) }
}

/**
 * Reads one record's text in slices, so a clipped-in-shard row can be paged
 * back in full without pulling megabytes through a single tool result. The
 * seq, offset and length come from a cast tool input, so a value that is not a
 * finite number reads as "not found", "from the start" and "the default slice"
 * rather than as a NaN that would silently slice nothing. What a row keeps
 * inline is all this reads: when it names an `overflow`, the caller reads the
 * files behind it and slices there.
 */
export const readRecord = (
  rows: readonly HistoryRecord[],
  seq: number,
  offset = 0,
  length = READ_LENGTH_DEFAULT,
  field: ReadField = 'text',
): ReadResult => {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return { found: false }
  const row = rows.find(candidate => candidate.seq === seq)
  if (row === undefined) return { found: false }

  const isInput = field === 'input'
  // A row from before the arguments were kept has only the summary, and says so.
  const body = isInput ? row.args ?? row.input ?? '' : row.text
  const { start, end } = sliceBounds(body.length, offset, length)

  const result: FoundResult = {
    found: true,
    seq: row.seq,
    window: row.window,
    role: row.role,
    ts: row.ts,
    field,
    text: body.slice(start, end),
    total: body.length,
    hasMore: end < body.length,
  }
  if (row.tool !== undefined) result.tool = row.tool
  if (row.path !== undefined) result.path = row.path
  if (isInput && row.args === undefined) {
    result.note =
      row.input === undefined ? '这一行没有记录调用参数。' : '这是旧记录，只留了参数摘要，没有参数全文。'
  }
  const overflow = isInput ? row.overflow?.args : row.overflow?.text
  if (overflow !== undefined) result.overflow = overflow

  return result
}

export type Action = { seq: number; tool: string; path?: string; input?: string; isError: boolean; head: string }

const HEAD_CHARS = 80

/** The head kept for a call made in the step that asked for the switch: its summary is the only result the new window sees. */
const SWITCH_HEAD_CHARS = 800

/**
 * The tail of one window's tool calls, oldest first, as a short recap of what was
 * done. This mod's own calls are dropped before the tail is taken, so the count
 * is spent on the work rather than on the ledger and history calls that record it.
 */
export const recentActions = (
  rows: readonly HistoryRecord[],
  window: number,
  count: number,
  /** The history seq at the switch's approval: calls after it keep a longer head. */
  longFrom?: number,
): Action[] => {
  if (count <= 0) return []

  const picked = [...rows]
    .filter(row => row.window === window && row.role === 'tool' && !isOwnRow(row))
    .sort((a, b) => a.seq - b.seq)
    .slice(-count)

  return picked.map(row => {
    const action: Action = {
      seq: row.seq,
      tool: row.tool ?? '',
      isError: row.isError === true,
      head: oneLine(row.text.slice(0, longFrom !== undefined && row.seq > longFrom ? SWITCH_HEAD_CHARS : HEAD_CHARS)),
    }
    if (row.path !== undefined) action.path = row.path
    if (row.input !== undefined) action.input = row.input

    return action
  })
}

/** One deferred tool a window loaded and used: an MCP server's tools share one line. */
export type LoadedTool = { name: string; calls: number }

const MAX_LOADED_TOOLS = 8
const MCP_PREFIX = 'mcp__'
const SELECT_PREFIX = 'select:'

/**
 * The group a tool is listed under: an MCP tool under its server (`mcp__<server>__*`),
 * any other name stands alone. Exported so the cache measure and the handoff name a
 * load by the same group.
 */
export const toolGroupOf = (name: string): string => {
  if (!name.startsWith(MCP_PREFIX)) return name
  const rest = name.slice(MCP_PREFIX.length)
  const cut = rest.indexOf('__')

  return cut <= 0 || cut + 2 >= rest.length ? name : `${MCP_PREFIX}${rest.slice(0, cut)}__*`
}

/**
 * The groups a ToolSearch query would load, out of the `known` ones, in `known`'s order. A
 * `select:` query names its tools. Any other query is a keyword, matched against each group's
 * core name (the server of an MCP group, the name of any other); the dashes and underscores
 * of both sides are read as spaces in a second try, so `computer use` finds `computer-use`.
 */
export const groupsWanted = (query: string, known: readonly string[]): string[] => {
  const groups = [...new Set(known)]
  const text = query.trim()
  if (text.startsWith(SELECT_PREFIX)) {
    const named = new Set(
      text
        .slice(SELECT_PREFIX.length)
        .split(',')
        .map(part => part.trim())
        .filter(part => part !== '')
        .map(toolGroupOf),
    )

    return groups.filter(group => named.has(group))
  }

  const needle = text.toLowerCase()
  const spaced = needle.replace(/[-_]/g, ' ')

  return groups.filter(group => {
    const core = (group.startsWith(MCP_PREFIX) && group.endsWith('__*') ? group.slice(MCP_PREFIX.length, -3) : group).toLowerCase()

    return needle.includes(core) || spaced.includes(core.replace(/[-_]/g, ' '))
  })
}

/**
 * The names one ToolSearch row loaded. Rows written before `loaded` existed only
 * kept the query, so for those the `select:` names are read back out of it.
 */
const loadedOf = (row: HistoryRecord): string[] => {
  if (Array.isArray(row.loaded)) return row.loaded.filter(name => typeof name === 'string')
  const query = row.input ?? ''
  if (!query.startsWith(SELECT_PREFIX)) return []

  return query
    .slice(SELECT_PREFIX.length)
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
}

/**
 * The deferred tools one window loaded and then actually called, most useful
 * first by when they were loaded. A tool loaded and never used is left out, and
 * an MCP server's tools are summed into one line so a big toolkit stays short.
 */
export const loadedTools = (rows: readonly HistoryRecord[], window: number): LoadedTool[] => {
  const inWindow = [...rows]
    .filter(row => row.window === window && row.role === 'tool')
    .sort((a, b) => a.seq - b.seq)

  const calls = new Map<string, number>()
  for (const row of inWindow) {
    const name = row.tool ?? ''
    calls.set(name, (calls.get(name) ?? 0) + 1)
  }

  const loaded = new Set<string>()
  for (const row of inWindow) {
    if (row.tool !== 'ToolSearch') continue
    for (const name of loadedOf(row)) loaded.add(name)
  }

  const tools = new Map<string, number>()
  for (const name of loaded) {
    const used = calls.get(name) ?? 0
    if (used === 0) continue
    const key = toolGroupOf(name)
    tools.set(key, (tools.get(key) ?? 0) + used)
  }

  return [...tools]
    .slice(0, MAX_LOADED_TOOLS)
    .map(([name, count]) => ({ name, calls: count }))
}

/**
 * The person's own last prompts, across windows: what to carry into a new window.
 * Only rows marked as a person's count, so the engine's deliveries, notices and
 * attachments never become a request; a message typed mid-turn is marked when
 * the hook recognises it.
 */
export const personRequests = (rows: readonly HistoryRecord[], count: number): HistoryRecord[] => {
  if (count <= 0) return []

  return [...rows]
    .filter(row => row.isPerson === true)
    .sort((a, b) => a.seq - b.seq)
    .slice(-count)
}

/**
 * The model's reply each request came after, by the request's seq: a "可以" says
 * nothing without the question it answers. `rows` are in seq order.
 *
 * Only a reply made since the person last spoke counts: a second message in a row,
 * or one typed mid-turn before the model said anything, answers no new reply, and
 * pointing it at the previous turn's would mislead. Such a request is left out.
 */
export const repliesAnswered = (
  rows: readonly HistoryRecord[],
  requests: readonly HistoryRecord[],
): Map<number, HistoryRecord> => {
  const answered = new Map<number, HistoryRecord>()
  for (const request of requests) {
    let reply: HistoryRecord | undefined
    for (const row of rows) {
      if (row.seq >= request.seq) break
      if (row.isPerson === true) reply = undefined
      // A row with a door is the engine's delivery or note, never the model's own reply.
      else if (row.role === 'assistant' && row.door === undefined && row.text.trim() !== '') reply = row
    }
    if (reply !== undefined) answered.set(request.seq, reply)
  }

  return answered
}

/** One whole-file write waiting its turn. */
type Job = {
  path: string
  text: string
  done: Promise<boolean>
  finish: (ok: boolean) => void
}

export type Queue = {
  /**
   * Queues one whole-file write, merging into a same-path write that has not started.
   * Resolves to whether the write that finally ran succeeded, so a caller can tell a
   * file on disk from one that only exists in memory; it never rejects.
   */
  push: (path: string, text: string) => Promise<boolean>
  /** Resolves once every write queued so far has finished. */
  idle: () => Promise<void>
}

/**
 * Serializes whole-file writes, since the engine can only overwrite a file
 * whole: one write runs at a time, a not-yet-started write to the same path is
 * replaced by the newer text, and a failing write is reported but never stalls
 * the queue or rejects the caller's promise.
 */
export const createQueue = (
  write: (path: string, text: string) => Promise<void>,
  onError?: (path: string, error: unknown) => void,
): Queue => {
  const pending: Job[] = []
  const idlers: (() => void)[] = []
  let isRunning = false

  const settleIdle = (): void => {
    if (isRunning || pending.length > 0) return
    while (idlers.length > 0) idlers.pop()?.()
  }

  /**
   * Reports a failed write without letting the reporter break the queue: a
   * throwing `onError` would otherwise escape the run loop and leave every
   * queued push, and its promise, waiting forever.
   */
  const report = (path: string, error: unknown): void => {
    try {
      onError?.(path, error)
    } catch {
      // The reporter's own failure is the caller's to notice, not the queue's to stall on.
    }
  }

  const run = async (): Promise<void> => {
    if (isRunning) return
    isRunning = true
    try {
      for (;;) {
        const job = pending.shift()
        if (job === undefined) break
        let ok = false
        try {
          await write(job.path, job.text)
          ok = true
        } catch (error) {
          report(job.path, error)
        } finally {
          // Settled on either path, so no push is ever left hanging.
          job.finish(ok)
        }
      }
    } finally {
      isRunning = false
      settleIdle()
    }
  }

  const push = (path: string, text: string): Promise<boolean> => {
    const open = pending.find(job => job.path === path)
    if (open !== undefined) {
      open.text = text
      return open.done
    }

    let settle = (_ok: boolean): void => {}
    const done = new Promise<boolean>(resolve => {
      settle = resolve
    })
    const job: Job = { path, text, done, finish: ok => settle(ok) }
    pending.push(job)
    // The loop already contains its own failures; the catch is the last guard
    // that a drain can never surface as an unhandled rejection.
    void run().catch(() => {})

    return job.done
  }

  const idle = (): Promise<void> =>
    new Promise<void>(resolve => {
      if (!isRunning && pending.length === 0) {
        resolve()
        return
      }
      idlers.push(resolve)
    })

  return { push, idle }
}
