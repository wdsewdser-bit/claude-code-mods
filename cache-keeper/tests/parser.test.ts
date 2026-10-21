import { describe, expect, test } from 'claude-code/testing'

import {
  classifyUsage,
  effectiveTtl,
  isTtlMismatch,
  observedTtl,
  requestedTtl,
} from '../hooks/lib/classify.ts'
import { matchSplits, parseTranscript } from '../hooks/lib/parser.ts'
import { apiEquivalentCost, breakEvenKeepalives } from '../hooks/lib/pricing.ts'

type RowOptions = {
  id?: string
  request?: string
  usage: Record<string, unknown>
  model?: string
  diagnostics?: Record<string, unknown>
  isSidechain?: boolean
  timestamp?: string
}

const row = (options: RowOptions): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: `u-${Math.random()}`,
    requestId: options.request ?? 'req_1',
    timestamp: options.timestamp ?? '2026-10-06T00:00:01.000Z',
    isSidechain: options.isSidechain ?? false,
    sessionId: 's1',
    version: '2.1.288',
    effort: 'medium',
    message: {
      id: options.id ?? 'msg_1',
      model: options.model ?? 'claude-opus-5-5',
      usage: options.usage,
      diagnostics: options.diagnostics,
    },
  })

const WRITE_1H = {
  input_tokens: 2,
  output_tokens: 679,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 77_757,
  cache_creation: { ephemeral_1h_input_tokens: 77_757, ephemeral_5m_input_tokens: 0 },
}

describe('parseTranscript', () => {
  test('counts a request once however many rows repeat its usage', () => {
    const parsed = parseTranscript(
      [row({ usage: WRITE_1H }), row({ usage: WRITE_1H }), row({ usage: WRITE_1H })].join('\n'),
    )
    expect(parsed.requests).toHaveLength(1)
    expect(parsed.assistantRows).toBe(3)
    expect(parsed.requests[0]).toMatchObject({
      rowCount: 3,
      isSplitConsistent: true,
      usage: { cache_creation_input_tokens: 77_757, output_tokens: 679 },
      split: { ephemeral_1h_input_tokens: 77_757, ephemeral_5m_input_tokens: 0 },
    })
    expect(parsed.dedupeWarningCount).toBe(0)
    expect(parsed.inconsistentUsageCount).toBe(0)
  })

  test('prefers the row with usage over a zeroed duplicate', () => {
    const zero = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }
    const parsed = parseTranscript(
      [row({ usage: zero }), row({ usage: WRITE_1H }), row({ usage: zero })].join('\n'),
    )
    expect(parsed.requests).toHaveLength(1)
    expect(parsed.requests[0]?.usage.cache_creation_input_tokens).toBe(77_757)
    expect(parsed.dedupeWarningCount).toBe(0)
  })

  test('takes the furthest row of a stream and warns that rows disagreed', () => {
    const early = { ...WRITE_1H, output_tokens: 12 }
    const parsed = parseTranscript([row({ usage: early }), row({ usage: WRITE_1H })].join('\n'))
    expect(parsed.requests[0]?.usage.output_tokens).toBe(679)
    expect(parsed.dedupeWarningCount).toBe(1)
  })

  test('does not read a zeroed row with a cache split as a free request', () => {
    const parsed = parseTranscript(
      row({
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 4_000, ephemeral_1h_input_tokens: 0 },
        },
      }),
    )
    expect(parsed.requests[0]?.usage.cache_creation_input_tokens).toBe(4_000)
    expect(parsed.requests[0]?.isSplitConsistent).toBe(false)
    expect(parsed.inconsistentUsageCount).toBe(1)
  })

  test('flags a split that does not add up to the cache write', () => {
    const parsed = parseTranscript(
      row({
        usage: {
          ...WRITE_1H,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 60_000 },
        },
      }),
    )
    expect(parsed.inconsistentUsageCount).toBe(1)
  })

  test('keeps separate requests apart and reads the miss reason', () => {
    const parsed = parseTranscript(
      [
        row({ usage: WRITE_1H }),
        row({
          id: 'msg_2',
          request: 'req_2',
          usage: WRITE_1H,
          diagnostics: { cache_miss_reason: 'system_changed' },
        }),
        row({ id: 'msg_3', request: 'req_3', model: '<synthetic>', usage: WRITE_1H }),
        '{"type":"assistant","message":',
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      ].join('\n'),
    )
    expect(parsed.requests).toHaveLength(2)
    expect(parsed.parseErrors).toBe(1)
    expect(parsed.requests[1]?.cacheMissReason).toBe('system_changed')
  })

  test('reads a compaction boundary with its trigger and position', () => {
    const parsed = parseTranscript(
      [
        row({ usage: WRITE_1H }),
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          timestamp: '2026-10-06T01:00:00.000Z',
          isSidechain: false,
          compactMetadata: {
            trigger: 'auto',
            preTokens: 250_000,
            postTokens: 1_200,
            precomputed: true,
          },
        }),
        row({ id: 'msg_2', request: 'req_2', usage: WRITE_1H }),
      ].join('\n'),
    )
    expect(parsed.compactions).toHaveLength(1)
    expect(parsed.compactions[0]).toMatchObject({
      trigger: 'auto',
      preTokens: 250_000,
      postTokens: 1_200,
      isPrecomputed: true,
      isSidechain: false,
      timestamp: '2026-10-06T01:00:00.000Z',
    })
    expect(parsed.requests[1]!.line).toBeGreaterThan(parsed.compactions[0]!.line)
  })

  test('a boundary without compactMetadata is still a boundary', () => {
    const parsed = parseTranscript(
      [
        JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
        row({ usage: WRITE_1H }),
      ].join('\n'),
    )
    expect(parsed.compactions[0]).toMatchObject({
      trigger: null,
      preTokens: null,
      postTokens: null,
      isPrecomputed: false,
    })
    expect(parsed.requests).toHaveLength(1)
  })
})

describe('matchSplits', () => {
  test('pairs a live row with the transcript request of the same counts', () => {
    const parsed = parseTranscript(
      [
        row({ usage: WRITE_1H, timestamp: '2026-10-06T00:00:05.000Z' }),
        row({ id: 'msg_s', request: 'req_s', usage: WRITE_1H, isSidechain: true }),
      ].join('\n'),
    )
    const live = {
      timestamp: '2026-10-06T00:00:01.000Z',
      isSubagent: false,
      usage: {
        input_tokens: 2,
        output_tokens: 679,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 77_757,
      },
    }
    const [first, second] = matchSplits([live, live], parsed.requests)
    expect(first?.split.ephemeral_1h_input_tokens).toBe(77_757)
    expect(second).toBeNull()
  })
})

describe('apiEquivalentCost', () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  }

  test('prices Opus 5.5 from the split without adding the write twice', () => {
    const oneHour = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 }
    const fiveMinutes = { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 }
    expect(apiEquivalentCost('claude-opus-5-5', usage, oneHour, null)).toEqual({
      usd: 4 + 20 + 0.2 + 8,
      basis: 'split',
    })
    expect(apiEquivalentCost('claude-opus-5-5', usage, fiveMinutes, '1h').usd).toBe(
      4 + 20 + 0.2 + 5,
    )
  })

  test('prices Sonnet 5.5 and falls back to the assumed TTL without a split', () => {
    expect(apiEquivalentCost('claude-sonnet-5-5', usage, null, '5m')).toEqual({
      usd: 2 + 10 + 0.1 + 2.5,
      basis: 'assumed-5m',
    })
    expect(apiEquivalentCost('claude-sonnet-5-5', usage, null, null).basis).toBe('assumed-1h')
    expect(apiEquivalentCost('some-other-model', usage, null, '5m').usd).toBeNull()
  })

  test('break-even keepalives follow the price table', () => {
    expect(breakEvenKeepalives('claude-opus-5-5', '5m')).toBe(24)
    expect(breakEvenKeepalives('claude-opus-5-5', '1h')).toBe(39)
    expect(breakEvenKeepalives('claude-sonnet-5-5', '5m')).toBe(24)
    expect(breakEvenKeepalives('claude-haiku-5-5', '1h')).toBe(19)
  })

  test('prices Haiku 5.5 by prompt length', () => {
    const short = {
      input_tokens: 10_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 80_000,
      cache_creation_input_tokens: 10_000,
    }
    const long = { ...short, cache_read_input_tokens: 80_001 }
    const micro = (usd: number | null): number => Math.round((usd ?? 0) * 1_000_000)
    // 10k input, 80k read, 10k 1h write, 1M output: at $0.1/0.01/0.2/0.5, then at $0.5/0.05/1/2.5
    expect(micro(apiEquivalentCost('claude-haiku-5-5', short, null, '1h').usd)).toBe(503_800)
    expect(micro(apiEquivalentCost('claude-haiku-5-5', long, null, '1h').usd)).toBe(2_519_000)
    expect(apiEquivalentCost('claude-haiku-4-5-20251001', short, null, '5m').basis).toBe(
      'assumed-5m',
    )
  })
})

describe('TTL and hit classification', () => {
  test('follows the engine order: force, variable, setting, automatic', () => {
    expect(requestedTtl({ force5m: '1', envTtl: '1h', settingTtl: '1h' })).toEqual({
      ttl: '5m',
      reason: 'force_5m_env',
    })
    expect(requestedTtl({ force5m: '0', envTtl: '1h', settingTtl: '5m' }).reason).toBe('env')
    expect(requestedTtl({ settingTtl: '5m' })).toEqual({ ttl: '5m', reason: 'setting' })
    expect(requestedTtl({ envTtl: '10m' })).toEqual({ ttl: null, reason: 'automatic' })
  })

  test('reads the observed TTL off the split and spots a mismatch', () => {
    const fiveMinutes = { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 0 }
    expect(observedTtl(fiveMinutes)).toBe('5m')
    expect(observedTtl({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 })).toBeNull()
    expect(effectiveTtl(null, '1h')).toBe('1h')
    expect(effectiveTtl('5m', 'mixed')).toBe('5m')
    expect(isTtlMismatch('1h', '5m')).toBe(true)
    expect(isTtlMismatch(null, '5m')).toBe(false)
  })

  test('classifies by the share of the prompt the cache served', () => {
    const of = (read: number, write: number, input: number) =>
      classifyUsage({
        input_tokens: input,
        output_tokens: 1,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
      })
    expect(of(240_000, 0, 12)).toBe('hit')
    expect(of(100_000, 60_000, 12)).toBe('partial_hit')
    expect(of(0, 240_000, 12)).toBe('miss')
    expect(of(0, 0, 0)).toBe('cold')
  })
})
