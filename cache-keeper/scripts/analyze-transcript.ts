// Offline companion of the mod, run with Node 24+ (it strips the types):
//
//   node scripts/analyze-transcript.ts <session.jsonl>            per-request table and totals
//   node scripts/analyze-transcript.ts <session.jsonl> --json     the same as JSON
//   node scripts/analyze-transcript.ts <session.jsonl> --tail N   the last N assistant rows, slimmed
//   node scripts/analyze-transcript.ts --report <dataDir>         rebuild the report files
//
// It only ever reads transcripts.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { observedTtl } from '../hooks/lib/classify.ts'
import { parseTranscript } from '../hooks/lib/parser.ts'
import { apiEquivalentCost } from '../hooks/lib/pricing.ts'
import { parseJsonl, renderReport, summarize, toCsv } from '../hooks/lib/report.ts'
import type { EventRow, RunRecord } from '../hooks/lib/report.ts'

const args = process.argv.slice(2)

const fail = (message: string): never => {
  console.error(message)
  process.exit(2)
}

// The rows the mod's own parser needs, without the message content, so the
// tail of a transcript too large for the mod to read fits in one reply.
const tail = (path: string, rows: number): void => {
  const slim: string[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('"type":"assistant"')) continue
    try {
      const row = JSON.parse(line)
      if (row.type !== 'assistant' || row.message?.usage === undefined) continue
      slim.push(
        JSON.stringify({
          type: row.type,
          uuid: row.uuid,
          requestId: row.requestId,
          timestamp: row.timestamp,
          isSidechain: row.isSidechain,
          agentId: row.agentId,
          sessionId: row.sessionId,
          version: row.version,
          effort: row.effort,
          message: {
            id: row.message.id,
            model: row.message.model,
            usage: row.message.usage,
            diagnostics: row.message.diagnostics,
          },
        }),
      )
    } catch {
      // a row cut short mid-write
    }
  }
  console.log(slim.slice(-rows).join('\n'))
}

const analyze = (path: string, asJson: boolean): void => {
  const parsed = parseTranscript(readFileSync(path, 'utf8'))
  const totals = { input: 0, output: 0, cacheRead: 0, write5m: 0, write1h: 0, usd: 0 }
  const requests = parsed.requests.map(request => {
    const cost = apiEquivalentCost(request.model, request.usage, request.split, null)
    totals.input += request.usage.input_tokens
    totals.output += request.usage.output_tokens
    totals.cacheRead += request.usage.cache_read_input_tokens
    totals.write5m += request.split?.ephemeral_5m_input_tokens ?? 0
    totals.write1h += request.split?.ephemeral_1h_input_tokens ?? 0
    totals.usd += cost.usd ?? 0

    return {
      timestamp: request.timestamp,
      thread: request.isSidechain ? 'subagent' : 'main',
      model: request.model,
      ...request.usage,
      ephemeral_5m_input_tokens: request.split?.ephemeral_5m_input_tokens ?? null,
      ephemeral_1h_input_tokens: request.split?.ephemeral_1h_input_tokens ?? null,
      ttl_observed: observedTtl(request.split) ?? '',
      cache_miss_reason: request.cacheMissReason ?? '',
      api_equivalent_usd: cost.usd,
      rows: request.rowCount,
    }
  })
  const summary = {
    path,
    requests: requests.length,
    assistantRows: parsed.assistantRows,
    parseErrors: parsed.parseErrors,
    dedupe_warning_count: parsed.dedupeWarningCount,
    inconsistent_usage_count: parsed.inconsistentUsageCount,
    totals,
  }
  if (asJson) {
    console.log(JSON.stringify({ ...summary, list: requests }, null, 2))
    return
  }
  console.table(
    requests.map(request => ({
      time: request.timestamp?.slice(11, 19),
      thread: request.thread,
      input: request.input_tokens,
      output: request.output_tokens,
      read: request.cache_read_input_tokens,
      write5m: request.ephemeral_5m_input_tokens,
      write1h: request.ephemeral_1h_input_tokens,
      miss: request.cache_miss_reason,
      usd: request.api_equivalent_usd?.toFixed(4),
      rows: request.rows,
    })),
  )
  console.log(summary)
}

const report = (dataDir: string): void => {
  const raw = join(dataDir, 'raw')
  if (!existsSync(raw)) fail(`no ${raw}`)
  const events: EventRow[] = []
  const runs: RunRecord[] = []
  // Only the two kinds of file are opened: raw/ also holds logs and folders.
  for (const name of readdirSync(raw).sort()) {
    const path = join(raw, name)
    if (/^events-.+\.jsonl$/.test(name)) {
      events.push(...parseJsonl<EventRow>(readFileSync(path, 'utf8')))
    } else if (/^run-.+\.json$/.test(name)) {
      runs.push(JSON.parse(readFileSync(path, 'utf8')) as RunRecord)
    }
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const summary = summarize(events, runs, new Date().toISOString())
  writeFileSync(join(dataDir, 'cache-events.csv'), toCsv(events))
  writeFileSync(join(dataDir, 'experiment-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(join(dataDir, 'cache-report.md'), renderReport(summary))
  console.log(`${events.length} events, ${runs.length} runs -> ${dataDir}`)
  console.log(`Conclusion type ${summary.conclusion.category}: ${summary.conclusion.text}`)
}

const [first, second, third] = args
if (first === undefined) {
  fail('usage: analyze-transcript.ts <session.jsonl> [--json | --tail N] | --report <dataDir>')
} else if (first === '--report') {
  report(second ?? '.cache-keeper')
} else if (second === '--tail') {
  tail(first, Number(third ?? 600))
} else {
  analyze(first, second === '--json')
}
