import { describe, expect, test } from 'claude-code/testing'

import { boot, MODEL, turn, world } from './world.ts'

const QUIET = { timeoutMs: 120_000, options: { enabled: false, maxIdleKeepalives: 0 } }

describe('chunks', () => {
  test('a full chunk moves on only after the turn that filled it has completed', QUIET, async ($, on) => {
    const w = world(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, 's-chunks')
    await boot($)
    // 1,000 rows fill a chunk; the 1,000th is the step of the turn left open below.
    for (let i = 0; i < 999; i++) await turn($, `t${i}`, 'hi')
    await $.turn.start({ text: 'hi', turnId: 't999' })
    const step = $.turn.step({
      turnId: 't999',
      index: 0,
      model: MODEL,
      effort: 'medium',
      messageCount: 1,
    })
    for await (const chunk of step) void chunk
    const stored = () => w.store.get('s:s-chunks') as { chunk: number }
    // Still on the chunk that holds the open turn's row, so its reconcile and step end can find it.
    expect(stored().chunk).toBe(0)
    await $.turn.complete({
      answer: 'OK',
      durationMs: 1,
      isAborted: false,
      turnId: 't999',
      reason: 'answer',
    })
    expect(stored().chunk).toBe(1)
  })
})
