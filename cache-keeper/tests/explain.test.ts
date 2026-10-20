import { describe, expect, test } from 'claude-code/testing'

import { explainTranscript } from '../hooks/lib/explain.ts'

const MODEL = 'claude-opus-5-5'
const BASE = Date.parse('2026-10-06T00:00:00.000Z')

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens: number
    ephemeral_1h_input_tokens: number
  }
}

const assistant = (
  requestId: string,
  atMs: number,
  usage: Usage,
  diagnostics?: unknown,
): Record<string, unknown> => ({
  type: 'assistant',
  uuid: `u-${requestId}`,
  requestId,
  timestamp: new Date(atMs).toISOString(),
  version: '2.1.288',
  message: {
    id: `msg-${requestId}`,
    model: MODEL,
    usage: {
      input_tokens: usage.input_tokens ?? 3,
      output_tokens: usage.output_tokens ?? 1,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      ...(usage.cache_creation === undefined
        ? {}
        : { cache_creation: usage.cache_creation }),
    },
    ...(diagnostics === undefined ? {} : { diagnostics }),
  },
})

const attachment = (value: Record<string, unknown>): Record<string, unknown> => ({
  type: 'attachment',
  attachment: value,
})

const jsonl = (rows: readonly unknown[]): string =>
  rows.map(row => JSON.stringify(row)).join('\n')

const write = (tokens: number): Usage => ({
  input_tokens: 10,
  cache_creation_input_tokens: tokens,
})

describe('explainTranscript', () => {
  test('names a visible tool-list change as the observed cause of a miss', () => {
    const text = jsonl([
      attachment({
        type: 'prompt_snapshot',
        systemPrompt: ['You are helpful.', 'Be brief.'],
      }),
      attachment({
        type: 'deferred_tools_record',
        entries: [{ name: 'Read', input_schema: { type: 'object' } }],
      }),
      attachment({ type: 'skill_listing', names: ['cache-keeper'] }),
      assistant('r1', BASE, write(1_000)),
      attachment({ type: 'deferred_tools_delta', addedNames: ['Bash'] }),
      assistant(
        'r2',
        BASE + 20_000,
        write(1_200),
        {
          cache_miss_reason: {
            type: 'tools_changed',
            cache_missed_input_tokens: 900,
          },
        },
      ),
    ])

    const result = explainTranscript(text)
    expect(result.rows).toHaveLength(2)
    const first = result.rows[0]!
    const second = result.rows[1]!
    expect(first.prefix.systemPromptHash).toMatch(/^[0-9a-f]{16}$/)
    expect(first.prefix.systemPromptChars).toBe('You are helpful.Be brief.'.length)
    expect(first.prefix.toolHashBasis).toBe('definitions')
    expect(first.prefix.pluginSetBasis).toBe('skills')
    expect(second.changed.toolList).toBe(true)
    expect(second.explicitMissReason).toBe('tools_changed')
    expect(second.cacheMissedTokens).toBe(900)
    expect(second.verdict).toBe('observed')
    expect(second.reasons.map(reason => reason.code)).toContain('tool_list_hash_changed')
    expect(second.reasons.map(reason => reason.code)).toContain('diagnostics:tools_changed')
    expect(result.summary.misses).toBe(2)
    expect(result.summary.observed).toBe(2)
  })

  test('infers an expired cache from a gap past the observed TTL', () => {
    const text = jsonl([
      assistant('r1', BASE, {
        input_tokens: 10,
        cache_creation_input_tokens: 1_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 0 },
      }),
      assistant('r2', BASE + 400_000, {
        input_tokens: 10,
        cache_creation_input_tokens: 1_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 0 },
      }),
    ])

    const result = explainTranscript(text)
    const second = result.rows[1]!
    expect(second.ttl).toBe('5m')
    expect(second.gapSec).toBe(400)
    expect(second.verdict).toBe('inferred')
    expect(second.reasons.map(reason => reason.code)).toContain('idle_exceeds_ttl')
    expect(result.summary.inferred).toBe(1)
  })

  test('says unknown instead of inventing a cause when nothing is visible', () => {
    const text = jsonl([
      assistant('r1', BASE, write(1_000)),
      assistant('r2', BASE + 10_000, write(1_100)),
    ])

    const result = explainTranscript(text)
    const second = result.rows[1]!
    expect(second.prefix.systemPromptHash).toBeNull()
    expect(second.prefix.toolListHash).toBeNull()
    expect(second.prefix.pluginSetHash).toBeNull()
    expect(second.verdict).toBe('unknown')
    expect(second.reasons.map(reason => reason.code)).toContain('prefix_fields_unavailable')
    expect(result.summary.unknownPrefixFields).toEqual({
      systemPrompt: 2,
      toolList: 2,
      pluginSet: 2,
    })
  })

  test('a diagnostics reason the transcript carries is observed even without a visible hash', () => {
    const text = jsonl([
      assistant('r1', BASE, write(1_000)),
      assistant('r2', BASE + 10_000, write(1_100), {
        cache_miss_reason: { type: 'tools_changed', cache_missed_input_tokens: 700 },
      }),
    ])

    const result = explainTranscript(text)
    const second = result.rows[1]!
    expect(second.verdict).toBe('observed')
    expect(second.reasons.map(reason => reason.code)).toEqual(
      expect.arrayContaining(['diagnostics:tools_changed', 'tools_changed_not_visible']),
    )
  })

  test('a hit has no reason and a first request is its own observed cause', () => {
    const text = jsonl([
      assistant('r1', BASE, write(1_000)),
      assistant('r2', BASE + 10_000, { input_tokens: 3, cache_read_input_tokens: 50_000 }),
    ])

    const result = explainTranscript(text)
    expect(result.rows[0]!.verdict).toBe('observed')
    expect(result.rows[0]!.reasons[0]?.code).toBe('first_request_in_thread')
    expect(result.rows[1]!.result).toBe('hit')
    expect(result.rows[1]!.reasons).toHaveLength(0)
    expect(result.rows[1]!.verdict).toBe('none')
  })
})
