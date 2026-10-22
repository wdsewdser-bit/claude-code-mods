#!/usr/bin/env node
/**
 * replay.ts -- run dispatch-gate's rules over a transcript, offline.
 *
 * What it does
 *   Reads a Claude Code transcript (.jsonl), walks its main-session requests in
 *   order, and drives the same state machine the mod runs in a live session:
 *   one request is one unit, a dispatch clears the streak, a Claude subagent
 *   counts in its rolling hour. It prints where the reminder (L1) and the
 *   refusals (L2 and the subagent limit) would have landed.
 *
 *   The subagents' own work lives in their own sidechain files, so a main
 *   transcript is exactly the main thread's requests.
 *
 * usage
 *   node dispatch-gate/scripts/replay.ts [options] <transcript.jsonl>...
 *     --mode off|remind|soft   strength (default: soft)
 *     --remind-at N            default 4
 *     --deny-at N              default 8
 *     --agent-per-hour N       default 3
 *     --json                   print the report as JSON
 *
 * No engine, no model, no network: it only reads the file.
 */
import fs from 'node:fs'

import { DEFAULTS, createState, judge, observeRequest, resetStreak } from '../hooks/lib/gate.ts'
import type { Config, Use } from '../hooks/lib/gate.ts'

type Row = {
  type?: string
  timestamp?: string
  isSidechain?: boolean
  uuid?: string
  message?: {
    id?: string
    model?: string
    content?: unknown
  }
}

type Mark = { at: string; streak: number; tool?: string; text?: string }

type Report = {
  file: string
  requests: number
  exec: number
  dispatch: number
  book: number
  other: number
  reminds: Mark[]
  refusals: Mark[]
  agents: (Mark & { model: string; type: string; refused: boolean })[]
  first: string | null
  last: string | null
}

const rowsOf = (file: string): Row[] => {
  const out: Row[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line) as Row)
    } catch {
      // a damaged line is not a row
    }
  }

  return out
}

const usesOfRow = (row: Row): Use[] => {
  const content = row.message?.content
  if (!Array.isArray(content)) return []
  const uses: Use[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const held = block as { type?: string; name?: string; input?: unknown }
    if (held.type !== 'tool_use' || typeof held.name !== 'string') continue
    uses.push({
      tool: held.name,
      input: held.input !== null && typeof held.input === 'object' ? (held.input as Record<string, unknown>) : {},
    })
  }

  return uses
}

/** A person's own message: text, and no tool result in it. */
const isPrompt = (row: Row): boolean => {
  if (row.type !== 'user') return false
  const content = row.message?.content
  if (typeof content === 'string') return content.trim() !== ''
  if (!Array.isArray(content)) return false
  const hasResult = content.some(block => (block as { type?: string })?.type === 'tool_result')

  return !hasResult && content.some(block => (block as { type?: string; text?: string })?.type === 'text')
}

const modelOf = (row: Row): string => (typeof row.message?.model === 'string' ? row.message.model : '')

const atOf = (row: Row): number => (typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN)

/** One thing that happened in the main thread, in order: a person's message, or one model request. */
type Event = { kind: 'prompt'; at: number } | { kind: 'request'; at: number; stamp: string; uses: Use[] }

/**
 * The transcript's main-thread events in order. The engine writes one row per
 * content block, so the rows of one assistant message (its id) are one request,
 * however many tool calls they carry.
 */
const eventsOf = (rows: readonly Row[]): Event[] => {
  const events: Event[] = []
  let held: { id: string; at: number; stamp: string; uses: Use[] } | null = null
  const flush = (): void => {
    if (held !== null && held.uses.length > 0) {
      events.push({ kind: 'request', at: held.at, stamp: held.stamp, uses: held.uses })
    }
    held = null
  }
  for (const row of rows) {
    if (row.isSidechain === true) continue
    const at = atOf(row)
    if (!Number.isFinite(at)) continue
    if (isPrompt(row)) {
      flush()
      events.push({ kind: 'prompt', at })
      continue
    }
    if (row.type !== 'assistant') continue
    const uses = usesOfRow(row)
    if (uses.length === 0) {
      flush()
      continue
    }
    const id = row.message?.id ?? row.uuid ?? ''
    const stamp = String(row.timestamp)
    if (held === null || held.id !== id) {
      flush()
      held = { id, at, stamp, uses }
    } else {
      held.uses.push(...uses)
    }
  }
  flush()

  return events
}

const replay = (file: string, config: Config): Report => {
  const report: Report = {
    file,
    requests: 0,
    exec: 0,
    dispatch: 0,
    book: 0,
    other: 0,
    reminds: [],
    refusals: [],
    agents: [],
    first: null,
    last: null,
  }
  const state = createState()
  for (const event of eventsOf(rowsOf(file))) {
    if (event.kind === 'prompt') {
      resetStreak(state, config)
      continue
    }
    const at = event.at
    const stamp = event.stamp
    report.first ??= stamp
    report.last = stamp
    const uses = event.uses

    report.requests += 1
    const outcome = observeRequest(state, config, uses)
    report[outcome.kind] += 1
    if (outcome.remind) report.reminds.push({ at: stamp, streak: state.streak })

    // The request's tool calls, in the order the model asked for them.
    for (const use of uses) {
      const verdict = judge(state, config, use.tool, use.input, at)
      const isAgent = use.tool === 'Agent' || use.tool === 'Task'
      if (isAgent) {
        const model = typeof use.input['model'] === 'string' ? use.input['model'] : ''
        const type = typeof use.input['subagent_type'] === 'string' ? use.input['subagent_type'] : ''
        report.agents.push({ at: stamp, streak: state.streak, model, type, refused: verdict.deny !== undefined })
      }
      if (verdict.deny !== undefined) {
        report.refusals.push({ at: stamp, streak: state.streak, tool: use.tool, text: verdict.deny.slice(0, 40) })
      }
    }
  }

  return report
}

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = process.argv[index + 1]

  return value !== undefined && !value.startsWith('--') ? value : undefined
}

const number = (name: string, fallback: number): number => {
  const raw = option(name)
  const parsed = raw === undefined ? NaN : Number(raw)

  return Number.isFinite(parsed) ? parsed : fallback
}

/** The options that take a value, so the value is not mistaken for a file. */
const VALUE_OPTIONS = new Set(['mode', 'remind-at', 'deny-at', 'agent-per-hour'])
const files: string[] = []
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i] ?? ''
  if (arg.startsWith('--')) {
    if (VALUE_OPTIONS.has(arg.slice(2))) i += 1
    continue
  }
  files.push(arg)
}
if (files.length === 0) {
  console.error('usage: node dispatch-gate/scripts/replay.ts [--mode off|remind|soft] [--remind-at N] [--deny-at N] [--agent-per-hour N] [--json] <transcript.jsonl>...')
  process.exit(2)
}

const mode = option('mode')
const config: Config = {
  ...DEFAULTS,
  mode: mode === 'off' || mode === 'remind' || mode === 'soft' ? mode : DEFAULTS.mode,
  remindAt: number('remind-at', DEFAULTS.remindAt),
  denyAt: number('deny-at', DEFAULTS.denyAt),
  agentPerHour: number('agent-per-hour', DEFAULTS.agentPerHour),
}

const reports = files.map(file => replay(file, config))
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ config, reports }, null, 2))
} else {
  for (const report of reports) {
    console.log(`== ${report.file}`)
    console.log(`   span ${report.first} -> ${report.last}`)
    console.log(`   requests ${report.requests}: exec ${report.exec}, dispatch ${report.dispatch}, book ${report.book}, other ${report.other}`)
    console.log(`   L1 reminders ${report.reminds.length}`)
    for (const mark of report.reminds) console.log(`     ${mark.at}  streak ${mark.streak}`)
    console.log(`   refusals ${report.refusals.length}`)
    for (const mark of report.refusals) console.log(`     ${mark.at}  ${mark.tool}  streak ${mark.streak}`)
    console.log(`   Claude subagents ${report.agents.length}, refused ${report.agents.filter(agent => agent.refused).length}`)
    for (const agent of report.agents) {
      console.log(`     ${agent.at}  ${agent.model || '?'}  ${agent.type || '?'}${agent.refused ? '  REFUSED' : ''}`)
    }
  }
}
