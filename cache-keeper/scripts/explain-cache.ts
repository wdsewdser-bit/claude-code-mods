// CACHE-01: explain, request by request, why the prompt cache did or did
// not serve. Offline companion of the mod, run with Node 24+:
//
//   node scripts/explain-cache.ts <session.jsonl>              per-request table
//   node scripts/explain-cache.ts <session.jsonl> --json       the same as JSON
//   node scripts/explain-cache.ts <session.jsonl> --tail 20    only the last 20
//   node scripts/explain-cache.ts --session <session-id>       find it under ~/.claude/projects
//   node scripts/explain-cache.ts --session <id> --projects <dir>
//
// It only ever reads transcripts. Fields the transcript does not carry are
// printed as "unknown"; nothing is invented for them.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { explainTranscript, renderExplain } from '../hooks/lib/explain.ts'

const args = process.argv.slice(2)

const fail = (message: string): never => {
  console.error(message)
  process.exit(2)
}

const flagValue = (name: string): string | undefined => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    fail(`${name} needs a value`)
  }
  return value
}

const has = (name: string): boolean => args.includes(name)

const projectsRoot = (): string =>
  flagValue('--projects') ?? join(homedir(), '.claude', 'projects')

// The main transcript of a session lives one level below the projects root:
// <projects>/<project-slug>/<session-id>.jsonl. Subagent transcripts live
// deeper and are not what this command reports.
const findSession = (id: string): string => {
  const root = projectsRoot()
  if (!existsSync(root)) fail(`no projects directory at ${root}`)
  const wanted = id.endsWith('.jsonl') ? id : `${id}.jsonl`
  const matches: string[] = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, wanted)
    if (existsSync(candidate) && statSync(candidate).isFile()) matches.push(candidate)
  }
  if (matches.length === 0) fail(`no transcript named ${wanted} under ${root}`)
  if (matches.length > 1) {
    fail(`${wanted} exists in ${matches.length} projects; pass the full path instead:\n${matches.join('\n')}`)
  }

  return matches[0]!
}

const positional = args.filter(
  (arg, index) =>
    !arg.startsWith('--') &&
    !['--tail', '--session', '--projects'].includes(args[index - 1] ?? ''),
)

const sessionFlag = flagValue('--session')
const path = positional[0] ?? (sessionFlag === undefined ? undefined : findSession(sessionFlag))
if (path === undefined) {
  fail(
    'usage: node scripts/explain-cache.ts <session.jsonl> [--json] [--tail N]\n' +
      '   or: node scripts/explain-cache.ts --session <session-id> [--projects <dir>]',
  )
}
if (!existsSync(path)) fail(`no such transcript: ${path}`)

const tailFlag = flagValue('--tail')
const tail = tailFlag === undefined ? undefined : Number.parseInt(tailFlag, 10)
if (tailFlag !== undefined && (!Number.isFinite(tail) || tail! <= 0)) {
  fail('--tail needs a positive number')
}

const result = explainTranscript(readFileSync(path, 'utf8'))

if (has('--json')) {
  const rows = tail === undefined ? result.rows : result.rows.slice(-tail)
  console.log(
    JSON.stringify(
      {
        path,
        file: basename(path),
        summary: result.summary,
        parse: result.parse,
        rows,
      },
      null,
      2,
    ),
  )
} else {
  console.log(`# ${path}`)
  console.log(renderExplain(result, tail))
}
