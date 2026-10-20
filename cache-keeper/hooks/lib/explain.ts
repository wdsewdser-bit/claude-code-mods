import { classifyUsage, observedTtl } from './classify.ts'
import type { ProbeResult } from './classify.ts'
import { parseTranscript } from './parser.ts'
import type { ParseResult, TranscriptRequest } from './parser.ts'
import type { PrefixSnapshot } from './prefix.ts'
import type { Ttl } from './pricing.ts'

export type ExplainLevel = 'observed' | 'inferred' | 'unknown' | 'none'

export type ExplainReason = {
  level: ExplainLevel
  /** A stable machine code, e.g. tool_list_hash_changed. */
  code: string
  text: string
}

export type ExplainRow = {
  index: number
  timestamp: string | null
  model: string
  thread: string
  requestId: string | null
  prefix: PrefixSnapshot
  /** Which prefix hashes changed since the previous request of this thread. */
  changed: {
    systemPrompt: boolean
    toolList: boolean
    pluginSet: boolean
  }
  usage: TranscriptRequest['usage']
  result: ProbeResult
  readShare: number | null
  ttl: Ttl | null
  gapSec: number | null
  explicitMissReason: string | null
  cacheMissedTokens: number | null
  reasons: ExplainReason[]
  /** The highest-confidence level present: observed > inferred > unknown. */
  verdict: ExplainLevel
}

export type ExplainSummary = {
  requests: number
  hits: number
  partialHits: number
  misses: number
  cold: number
  observed: number
  inferred: number
  unknown: number
  noMiss: number
  unknownPrefixFields: {
    systemPrompt: number
    toolList: number
    pluginSet: number
  }
}

export type ExplainResult = {
  rows: ExplainRow[]
  summary: ExplainSummary
  parse: ParseResult
}

const TTL_MS: Record<Ttl, number> = { '5m': 300_000, '1h': 3_600_000 }

const threadOf = (request: TranscriptRequest): string =>
  request.isSidechain
    ? `subagent:${request.agentId ?? 'unknown'}`
    : 'main'

const ttlOf = (request: TranscriptRequest): Ttl | null => {
  const observed = observedTtl(request.split)
  return observed === '5m' || observed === '1h' ? observed : null
}

const seconds = (ms: number): string =>
  `${Math.round(ms / 1000)}s`

const changed = (
  previous: PrefixSnapshot,
  current: PrefixSnapshot,
  key: 'systemPromptHash' | 'toolListHash' | 'pluginSetHash',
): boolean => {
  const before = previous[key]
  const after = current[key]
  return before !== null && after !== null && before !== after
}

const push = (
  reasons: ExplainReason[],
  level: ExplainLevel,
  code: string,
  text: string,
): void => {
  if (reasons.some(reason => reason.code === code)) return
  reasons.push({ level, code, text })
}

const verdictOf = (reasons: ExplainReason[]): ExplainLevel => {
  if (reasons.some(reason => reason.level === 'observed')) return 'observed'
  if (reasons.some(reason => reason.level === 'inferred')) return 'inferred'
  if (reasons.some(reason => reason.level === 'unknown')) return 'unknown'
  return 'none'
}

/**
 * Per-request cache explanation from a transcript alone. Every field the
 * transcript does not carry is reported as null (unknown), never guessed.
 */
export const explainTranscript = (jsonl: string): ExplainResult => {
  const parse = parseTranscript(jsonl)
  const ordered = [...parse.requests].sort((a, b) => a.order - b.order)
  const previousByThread = new Map<string, TranscriptRequest>()
  const rows: ExplainRow[] = []

  for (const [index, request] of ordered.entries()) {
    const thread = threadOf(request)
    const previous = previousByThread.get(thread)
    const result = classifyUsage(request.usage)
    const prompt =
      request.usage.input_tokens +
      request.usage.cache_read_input_tokens +
      request.usage.cache_creation_input_tokens
    const readShare = prompt === 0 ? null : request.usage.cache_read_input_tokens / prompt
    const ttl = ttlOf(request)
    const gapMs =
      previous?.timestamp === null || previous?.timestamp === undefined ||
      request.timestamp === null
        ? null
        : Date.parse(request.timestamp) - Date.parse(previous.timestamp)
    const gapSec = gapMs === null || !Number.isFinite(gapMs) ? null : Math.round(gapMs / 1000)
    const prefix = request.prefix
    const changedFlags = {
      systemPrompt:
        previous !== undefined &&
        changed(previous.prefix, prefix, 'systemPromptHash'),
      toolList:
        previous !== undefined && changed(previous.prefix, prefix, 'toolListHash'),
      pluginSet:
        previous !== undefined && changed(previous.prefix, prefix, 'pluginSetHash'),
    }
    const reasons: ExplainReason[] = []

    if (result === 'cold') {
      push(reasons, 'observed', 'no_prompt_tokens', 'the request carried no prompt tokens')
    } else if (result !== 'hit') {
      if (previous === undefined) {
        push(
          reasons,
          'observed',
          'first_request_in_thread',
          'no earlier request in this thread is in the transcript to reuse a cache from',
        )
      }
      if (request.cacheMissReason !== null) {
        const type = request.cacheMissReason
        const missed =
          request.cacheMissedTokens === null
            ? ''
            : ` (${request.cacheMissedTokens} tokens)`
        push(
          reasons,
          'observed',
          `diagnostics:${type}`,
          `transcript diagnostics say ${type}${missed}`,
        )
        if (type === 'tools_changed') {
          if (changedFlags.toolList) {
            push(
              reasons,
              'observed',
              'tool_list_hash_changed',
              'the observable deferred-tool set changed since the previous request',
            )
          } else {
            push(
              reasons,
              'unknown',
              'tools_changed_not_visible',
              'diagnostics say tools changed, but the observable deferred-tool hash did not; the change may be in tool definitions the transcript does not carry',
            )
          }
        }
        if (type === 'previous_message_not_found') {
          push(
            reasons,
            'inferred',
            'server_eviction',
            'the cache entry was gone server-side: expired or evicted',
          )
        }
      }
      if (changedFlags.systemPrompt) {
        push(
          reasons,
          'observed',
          'system_prompt_hash_changed',
          'the prompt_snapshot system prompt changed since the previous request',
        )
      }
      if (changedFlags.toolList) {
        push(
          reasons,
          'observed',
          'tool_list_hash_changed',
          'the observable deferred-tool set changed since the previous request',
        )
      }
      if (changedFlags.pluginSet) {
        push(
          reasons,
          'observed',
          'plugin_set_hash_changed',
          'the observable MCP-server/skill set changed since the previous request',
        )
      }
      if (previous !== undefined && ttl !== null && gapSec !== null && gapSec * 1000 > TTL_MS[ttl]) {
        push(
          reasons,
          'inferred',
          'idle_exceeds_ttl',
          `${seconds(gapSec * 1000)} since the previous request, past the ${ttl} TTL`,
        )
      }
      if (previous !== undefined && previous.model !== request.model) {
        push(
          reasons,
          'inferred',
          'model_changed',
          `model changed from ${previous.model} to ${request.model}`,
        )
      }
      if (
        previous !== undefined &&
        previous.version !== null &&
        request.version !== null &&
        previous.version !== request.version
      ) {
        push(
          reasons,
          'inferred',
          'client_version_changed',
          `Claude Code changed from ${previous.version} to ${request.version}`,
        )
      }
      if (reasons.length === 0) {
        if (
          prefix.systemPromptHash === null &&
          prefix.toolListHash === null &&
          prefix.pluginSetHash === null
        ) {
          push(
            reasons,
            'unknown',
            'prefix_fields_unavailable',
            'the transcript carries none of the system-prompt, tool-list or plugin-set fields',
          )
        } else {
          push(
            reasons,
            'unknown',
            'no_visible_cause',
            'no hash change, no diagnostics reason and no idle gap past the TTL is visible',
          )
        }
      }
    }

    rows.push({
      index,
      timestamp: request.timestamp,
      model: request.model,
      thread,
      requestId: request.requestId,
      prefix,
      changed: changedFlags,
      usage: request.usage,
      result,
      readShare,
      ttl,
      gapSec,
      explicitMissReason: request.cacheMissReason,
      cacheMissedTokens: request.cacheMissedTokens,
      reasons,
      verdict: verdictOf(reasons),
    })
    previousByThread.set(thread, request)
  }

  const count = (level: ExplainLevel): number =>
    rows.filter(row => row.reasons.some(reason => reason.level === level)).length
  const summary: ExplainSummary = {
    requests: rows.length,
    hits: rows.filter(row => row.result === 'hit').length,
    partialHits: rows.filter(row => row.result === 'partial_hit').length,
    misses: rows.filter(row => row.result === 'miss').length,
    cold: rows.filter(row => row.result === 'cold').length,
    observed: count('observed'),
    inferred: count('inferred'),
    unknown: count('unknown'),
    noMiss: rows.filter(row => row.result === 'hit' || row.result === 'cold').length,
    unknownPrefixFields: {
      systemPrompt: rows.filter(row => row.prefix.systemPromptHash === null).length,
      toolList: rows.filter(row => row.prefix.toolListHash === null).length,
      pluginSet: rows.filter(row => row.prefix.pluginSetHash === null).length,
    },
  }

  return { rows, summary, parse }
}

const short = (hash: string | null, isChanged: boolean): string => {
  if (hash === null) return 'unknown'
  return `${hash.slice(0, 8)}${isChanged ? '*' : ''}`
}

const reasonText = (row: ExplainRow): string =>
  row.reasons.length === 0
    ? 'hit'
    : row.reasons
        .map(reason => `${reason.level}:${reason.code}`)
        .join(', ')

/** The plain-text table the command and script print. */
export const renderExplain = (result: ExplainResult, tail?: number): string => {
  const rows = tail === undefined ? result.rows : result.rows.slice(-tail)
  const head = [
    '#'.padStart(4),
    'time'.padEnd(10),
    'model'.padEnd(18),
    'thread'.padEnd(12),
    'tools'.padEnd(10),
    'sys'.padEnd(10),
    'plugin'.padEnd(10),
    'read'.padStart(9),
    'write'.padStart(9),
    'result'.padEnd(11),
    'reason',
  ].join(' ')
  const lines = rows.map(row => {
    const time = row.timestamp === null ? 'unknown' : row.timestamp.slice(11, 19)
    return [
      String(row.index + 1).padStart(4),
      time.padEnd(10),
      row.model.padEnd(18),
      row.thread.slice(0, 12).padEnd(12),
      short(row.prefix.toolListHash, row.changed.toolList).padEnd(10),
      short(row.prefix.systemPromptHash, row.changed.systemPrompt).padEnd(10),
      short(row.prefix.pluginSetHash, row.changed.pluginSet).padEnd(10),
      String(row.usage.cache_read_input_tokens).padStart(9),
      String(row.usage.cache_creation_input_tokens).padStart(9),
      row.result.padEnd(11),
      reasonText(row),
    ].join(' ')
  })
  const s = result.summary
  const foot = [
    '',
    `requests ${s.requests} · hit ${s.hits} · partial ${s.partialHits} · miss ${s.misses} · cold ${s.cold}`,
    `reasons: observed ${s.observed} · inferred ${s.inferred} · unknown ${s.unknown}`,
    `prefix fields unavailable: system ${s.unknownPrefixFields.systemPrompt}/${s.requests} · tools ${s.unknownPrefixFields.toolList}/${s.requests} · plugin ${s.unknownPrefixFields.pluginSet}/${s.requests}`,
    'tools = deferred-tool set from deferred_tools_record/delta; sys = prompt_snapshot.systemPrompt; plugin = MCP-server set + skill listing (observed proxy, not an authoritative plugin list).',
    'unknown means the transcript does not carry the field; no value is inferred for it.',
  ]
  return [head, ...lines, ...foot].join('\n')
}
