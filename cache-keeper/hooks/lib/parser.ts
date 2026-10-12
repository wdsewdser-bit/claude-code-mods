import type { CacheSplit, Usage } from './pricing.ts'

/** One model request, as the transcript's rows for it agree on it. */
export type TranscriptRequest = {
  key: string
  messageId: string | null
  requestId: string | null
  timestamp: string | null
  sessionId: string | null
  model: string
  isSidechain: boolean
  agentId: string | null
  version: string | null
  effort: string | null
  usage: Usage
  split: CacheSplit | null
  isSplitConsistent: boolean
  cacheMissReason: string | null
  rowCount: number
}

export type ParseResult = {
  requests: TranscriptRequest[]
  assistantRows: number
  parseErrors: number
  /** Requests whose duplicate rows disagreed on usage. */
  dedupeWarningCount: number
  /** Requests whose usage contradicted its own cache split. */
  inconsistentUsageCount: number
}

type Row = Record<string, unknown>

const isRecord = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

type Candidate = {
  order: number
  row: Row
  message: Row
  usage: Usage
  split: CacheSplit | null
  isTopNonZero: boolean
  isConsistent: boolean
  signature: string
}

const readCandidate = (row: Row, order: number): Candidate | undefined => {
  const message = row.message
  if (!isRecord(message) || !isRecord(message.usage)) return undefined
  if (message.model === '<synthetic>') return undefined
  const raw = message.usage
  const usage: Usage = {
    input_tokens: count(raw.input_tokens),
    output_tokens: count(raw.output_tokens),
    cache_read_input_tokens: count(raw.cache_read_input_tokens),
    cache_creation_input_tokens: count(raw.cache_creation_input_tokens),
  }
  const nested = raw.cache_creation
  const split: CacheSplit | null = isRecord(nested)
    ? {
        ephemeral_5m_input_tokens: count(nested.ephemeral_5m_input_tokens),
        ephemeral_1h_input_tokens: count(nested.ephemeral_1h_input_tokens),
      }
    : null
  const splitTotal =
    split === null
      ? 0
      : split.ephemeral_5m_input_tokens + split.ephemeral_1h_input_tokens
  const isTopNonZero =
    usage.input_tokens +
      usage.output_tokens +
      usage.cache_read_input_tokens +
      usage.cache_creation_input_tokens >
    0

  return {
    order,
    row,
    message,
    usage,
    split,
    isTopNonZero,
    isConsistent:
      split === null ||
      Math.abs(usage.cache_creation_input_tokens - splitTotal) <= 1,
    signature: JSON.stringify([usage, split]),
  }
}

// The most complete row of a request: one with usage at all, then one whose
// split adds up, then the furthest along the stream, then the last written.
const better = (a: Candidate, b: Candidate): Candidate => {
  if (a.isTopNonZero !== b.isTopNonZero) return a.isTopNonZero ? a : b
  if (a.isConsistent !== b.isConsistent) return a.isConsistent ? a : b
  if (a.usage.output_tokens !== b.usage.output_tokens) {
    return a.usage.output_tokens > b.usage.output_tokens ? a : b
  }

  return a.order > b.order ? a : b
}

const missReason = (candidate: Candidate): string | null => {
  const diagnostics = candidate.message.diagnostics
  if (isRecord(diagnostics)) {
    const found = text(diagnostics.cache_miss_reason)
    if (found !== null) return found
  }

  return (
    text(candidate.row.cache_miss_reason) ??
    text(candidate.row.cacheMissReason)
  )
}

/**
 * Reads a session transcript (JSONL) into one entry per model request. The
 * engine writes a row per content block, each repeating the request's usage,
 * so rows are grouped by message id and request id and never summed.
 */
export const parseTranscript = (jsonl: string): ParseResult => {
  const groups = new Map<string, Candidate[]>()
  let assistantRows = 0
  let parseErrors = 0
  let order = 0
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      parseErrors += 1
      continue
    }
    if (!isRecord(row) || row.type !== 'assistant') continue
    const candidate = readCandidate(row, order)
    order += 1
    if (candidate === undefined) continue
    assistantRows += 1
    const messageId = text(candidate.message.id)
    const requestId = text(row.requestId)
    const key =
      messageId !== null || requestId !== null
        ? `${messageId ?? ''}|${requestId ?? ''}`
        : `row|${text(row.uuid) ?? String(candidate.order)}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [candidate])
    else group.push(candidate)
  }

  const requests: TranscriptRequest[] = []
  let dedupeWarningCount = 0
  let inconsistentUsageCount = 0
  for (const [key, group] of groups) {
    const chosen = group.reduce(better)
    const informative = group.filter(one => one.isTopNonZero)
    if (new Set(informative.map(one => one.signature)).size > 1) {
      dedupeWarningCount += 1
    }
    const splitTotal =
      chosen.split === null
        ? 0
        : chosen.split.ephemeral_5m_input_tokens +
          chosen.split.ephemeral_1h_input_tokens
    // A row whose top-level counts are all zero while its split is not was
    // not a free request: the split is the write.
    const isZeroedWrite = !chosen.isTopNonZero && splitTotal > 0
    if (!chosen.isConsistent || isZeroedWrite) inconsistentUsageCount += 1
    requests.push({
      key,
      messageId: text(chosen.message.id),
      requestId: text(chosen.row.requestId),
      timestamp: text(chosen.row.timestamp),
      sessionId: text(chosen.row.sessionId),
      model: text(chosen.message.model) ?? 'unknown',
      isSidechain: chosen.row.isSidechain === true,
      agentId: text(chosen.row.agentId),
      version: text(chosen.row.version),
      effort: text(chosen.row.effort),
      usage: isZeroedWrite
        ? { ...chosen.usage, cache_creation_input_tokens: splitTotal }
        : chosen.usage,
      split: chosen.split,
      isSplitConsistent: chosen.isConsistent && !isZeroedWrite,
      cacheMissReason: missReason(chosen),
      rowCount: group.length,
    })
  }

  return {
    requests,
    assistantRows,
    parseErrors,
    dedupeWarningCount,
    inconsistentUsageCount,
  }
}

export type SplitMatch = {
  split: CacheSplit
  cacheMissReason: string | null
  isSplitConsistent: boolean
}

type Unresolved = {
  timestamp: string
  isSubagent: boolean
  usage: Usage
}

/**
 * Pairs requests the mod saw live (four token counts, no split) with the
 * transcript's rows for them: same four counts, same thread, at most ten
 * minutes apart, the closest pairs first and each transcript request once.
 */
export const matchSplits = (
  rows: readonly Unresolved[],
  requests: readonly TranscriptRequest[],
): (SplitMatch | null)[] => {
  const pairs: { row: number; request: TranscriptRequest; gap: number }[] = []
  for (const [index, row] of rows.entries()) {
    const at = Date.parse(row.timestamp)
    for (const request of requests) {
      if (request.split === null || request.timestamp === null) continue
      if (request.isSidechain !== row.isSubagent) continue
      const usage = request.usage
      const isSame =
        usage.input_tokens === row.usage.input_tokens &&
        usage.output_tokens === row.usage.output_tokens &&
        usage.cache_read_input_tokens === row.usage.cache_read_input_tokens &&
        usage.cache_creation_input_tokens ===
          row.usage.cache_creation_input_tokens
      const gap = Math.abs(Date.parse(request.timestamp) - at)
      if (isSame && gap <= 600_000) pairs.push({ row: index, request, gap })
    }
  }
  pairs.sort((a, b) => a.gap - b.gap)

  const matches: (SplitMatch | null)[] = rows.map(() => null)
  const used = new Set<string>()
  for (const { row, request } of pairs) {
    if (matches[row] !== null || used.has(request.key)) continue
    if (request.split === null) continue
    used.add(request.key)
    matches[row] = {
      split: request.split,
      cacheMissReason: request.cacheMissReason,
      isSplitConsistent: request.isSplitConsistent,
    }
  }

  return matches
}
