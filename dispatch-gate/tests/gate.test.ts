// The state machine on its own: counting, clearing, grace, the two refusals and
// the configuration. No engine is involved.

import { expect, test } from 'claude-code/testing'

import {
  AGENT_WINDOW_MS,
  DEFAULTS,
  classify,
  createState,
  judge,
  modeOf,
  observeRequest,
  readConfig,
  resetStreak,
  usesOf,
  withEnv,
} from '../hooks/lib/gate.ts'
import type { Config, State, Use } from '../hooks/lib/gate.ts'

const u = (tool: string, input: Record<string, unknown> = {}): Use => ({ tool, input })
const NOW = Date.parse('2026-10-20T00:00:00.000Z')
const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULTS, ...over })

/** One execution request: the streak moves, and the outcome is returned. */
const exec = (state: State, config: Config, tool = 'Edit'): ReturnType<typeof observeRequest> =>
  observeRequest(state, config, [u(tool)])

test('classify: dispatch beats execution beats bookkeeping', () => {
  expect(classify([u('Read')])).toBe('exec')
  expect(classify([u('Read'), u('mcp__ctx-mod__ledger_append')])).toBe('exec')
  expect(classify([u('Read'), u('Agent')])).toBe('dispatch')
  expect(classify([u('mcp__delegate__delegate_pro')])).toBe('dispatch')
  expect(classify([u('SendMessage')])).toBe('dispatch')
  expect(classify([u('mcp__ccd_turn__update_plan')])).toBe('book')
  expect(classify([u('WebFetch')])).toBe('other')
  expect(classify([])).toBe('other')
})

test('a main-session-only command is neither execution nor counted', () => {
  expect(classify([u('Bash', { command: 'claude --version' })])).toBe('other')
  expect(classify([u('Bash', { command: 'node --inspect-brk app.js' })])).toBe('other')
  expect(classify([u('mcp__ptc-run__run_code', { code: 'playwright open' })])).toBe('other')
  expect(classify([u('Bash', { command: 'npm test' })])).toBe('exec')
})

test('the reminder comes at remindAt, once per streak', () => {
  const state = createState()
  const config = cfg()
  const seen = [1, 2, 3, 4, 5, 6].map(() => exec(state, config).remind)
  expect(seen).toEqual([false, false, false, true, false, false])
  expect(state.streak).toBe(6)
})

test('the refusal arms at denyAt, once per streak, and disarms on use', () => {
  const state = createState()
  const config = cfg()
  for (let i = 0; i < 7; i += 1) exec(state, config)
  expect(state.armed).toBe(false)
  exec(state, config)
  expect(state.armed).toBe(true)
  const refused = judge(state, config, 'Edit', {}, NOW)
  expect(typeof refused.deny).toBe('string')
  expect(state.armed).toBe(false)
  // the retry and everything after it in this streak runs
  expect(judge(state, config, 'Edit', {}, NOW).deny === undefined).toBe(true)
  exec(state, config)
  expect(judge(state, config, 'Edit', {}, NOW).deny === undefined).toBe(true)
})

test('a dispatch clears the streak and leaves three read-only acceptance requests free', () => {
  const state = createState()
  const config = cfg()
  for (let i = 0; i < 3; i += 1) exec(state, config)
  expect(observeRequest(state, config, [u('Agent')]).kind).toBe('dispatch')
  expect(state.streak).toBe(0)
  expect(state.grace).toBe(3)
  for (let i = 0; i < 3; i += 1) expect(exec(state, config, 'Read').remind).toBe(false)
  expect(state.streak).toBe(0)
  // the fourth read is a request like any other
  exec(state, config, 'Read')
  expect(state.streak).toBe(1)
})

test('a write during the acceptance grace ends it and counts', () => {
  const state = createState()
  const config = cfg()
  observeRequest(state, config, [u('Agent')])
  exec(state, config, 'Read')
  expect(state.grace).toBe(2)
  exec(state, config, 'Edit')
  expect(state.streak).toBe(1)
  expect(state.grace).toBe(0)
})

test('bookkeeping neither counts nor clears the streak', () => {
  const state = createState()
  const config = cfg()
  for (let i = 0; i < 3; i += 1) exec(state, config)
  observeRequest(state, config, [u('mcp__ccd_turn__update_plan')])
  observeRequest(state, config, [u('mcp__ctx-mod__ledger_read')])
  expect(state.streak).toBe(3)
  expect(exec(state, config).remind).toBe(true)
})

test('the same step seen twice counts once', () => {
  const state = createState()
  const config = cfg()
  for (let i = 0; i < 3; i += 1) observeRequest(state, config, [u('Edit')], `t1:${i}`)
  observeRequest(state, config, [u('Edit')], 't1:3')
  observeRequest(state, config, [u('Edit')], 't1:3')
  expect(state.streak).toBe(4)
})

test('a parallel batch is one request', () => {
  const state = createState()
  const config = cfg()
  for (let i = 0; i < 3; i += 1) exec(state, config)
  const batch = [u('Read'), u('Read'), u('Read'), u('Read'), u('Read')]
  expect(observeRequest(state, config, batch).remind).toBe(true)
  expect(state.streak).toBe(4)
})

test('resetStreak restores the grace and clears the flags', () => {
  const state = createState()
  const config = cfg()
  for (let i = 0; i < 8; i += 1) exec(state, config)
  expect(state.armed).toBe(true)
  resetStreak(state, config)
  expect(state.streak).toBe(0)
  expect(state.armed).toBe(false)
  expect(state.reminded).toBe(false)
  expect(state.denied).toBe(false)
  expect(state.grace).toBe(3)
})

test('the Claude-subagent limit refuses the fourth dispatch of an hour, once', () => {
  const state = createState()
  const config = cfg()
  for (let i = 0; i < 3; i += 1) {
    observeRequest(state, config, [u('Agent')])
    expect(judge(state, config, 'Agent', {}, NOW + i * 1000).deny === undefined).toBe(true)
  }
  const refused = judge(state, config, 'Agent', {}, NOW + 3000)
  expect(typeof refused.deny).toBe('string')
  expect(refused.deny).toContain('合并')
  // the retry runs, and the rest of the hour refuses no more
  expect(judge(state, config, 'Agent', {}, NOW + 4000).deny === undefined).toBe(true)
  for (let i = 0; i < 6; i += 1) expect(judge(state, config, 'Agent', {}, NOW + 5000 + i).deny === undefined).toBe(true)
})

test('the subagent limit is a rolling hour', () => {
  const state = createState()
  const config = cfg()
  for (let i = 0; i < 3; i += 1) judge(state, config, 'Agent', {}, NOW + i * 1000)
  expect(judge(state, config, 'Agent', {}, NOW + 3000).deny === undefined).toBe(false)
  judge(state, config, 'Agent', {}, NOW + 4000)
  // an hour after the last dispatch of the window, the window is empty again
  const later = NOW + AGENT_WINDOW_MS + 4000
  for (let i = 0; i < 3; i += 1) expect(judge(state, config, 'Agent', {}, later + i).deny === undefined).toBe(true)
  expect(judge(state, config, 'Agent', {}, later + 10).deny === undefined).toBe(false)
})

test('delegating to DeepSeek is unlimited and clears the self-work count', () => {
  const state = createState()
  const config = cfg()
  for (let i = 0; i < 10; i += 1) expect(judge(state, config, 'mcp__delegate__delegate_pro', {}, NOW + i).deny === undefined).toBe(true)
  for (let i = 0; i < 3; i += 1) exec(state, config)
  judge(state, config, 'mcp__delegate__delegate_flash', {}, NOW)
  expect(state.streak).toBe(0)
  expect(state.agentCalls).toHaveLength(0)
})

test('mode=off counts nothing and refuses nothing', () => {
  const state = createState()
  const config = cfg({ mode: 'off' })
  const outcomes = Array.from({ length: 10 }, () => exec(state, config))
  expect(outcomes.every(outcome => outcome.remind === false)).toBe(true)
  expect(state.armed).toBe(false)
  expect(judge(state, config, 'Edit', {}, NOW).deny === undefined).toBe(true)
  for (let i = 0; i < 8; i += 1) expect(judge(state, config, 'Agent', {}, NOW + i).deny === undefined).toBe(true)
})

test('mode=remind reminds but never refuses', () => {
  const state = createState()
  const config = cfg({ mode: 'remind' })
  let reminds = 0
  for (let i = 0; i < 12; i += 1) if (exec(state, config).remind) reminds += 1
  expect(reminds).toBe(1)
  expect(state.armed).toBe(false)
  expect(judge(state, config, 'Edit', {}, NOW).deny === undefined).toBe(true)
  for (let i = 0; i < 8; i += 1) expect(judge(state, config, 'Agent', {}, NOW + i).deny === undefined).toBe(true)
})

test('usesOf reads the engine\'s tool uses, however they are spelled', () => {
  expect(usesOf({ toolUses: [{ tool: 'Read', input: { file_path: 'a' } }] })).toEqual([{ tool: 'Read', input: { file_path: 'a' } }])
  expect(usesOf({ toolUses: [{ name: 'Grep', input: null }] })).toEqual([{ tool: 'Grep', input: {} }])
  expect(usesOf({ toolUses: [null, { no: 'name' }] })).toEqual([])
  expect(usesOf(null)).toEqual([])
  expect(usesOf({})).toEqual([])
})

test('readConfig: defaults, overrides and the environment switch', () => {
  expect(readConfig(undefined)).toEqual(DEFAULTS)
  expect(readConfig({ mode: 'remind', remindAt: 2, denyAt: 5, agentPerHour: 1, grace: 0 })).toEqual({
    mode: 'remind',
    remindAt: 2,
    denyAt: 5,
    agentPerHour: 1,
    grace: 0,
  })
  expect(readConfig({ mode: 'nonsense', remindAt: 'x' }).mode).toBe('soft')
  expect(readConfig({ mode: 'nonsense', remindAt: 'x' }).remindAt).toBe(DEFAULTS.remindAt)
  expect(modeOf('OFF')).toBe('off')
  expect(withEnv(DEFAULTS, '0', undefined).mode).toBe('off')
  expect(withEnv(DEFAULTS, undefined, 'remind').mode).toBe('remind')
  expect(withEnv(DEFAULTS, undefined, undefined).mode).toBe('soft')
})
