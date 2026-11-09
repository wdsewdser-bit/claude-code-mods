// Dry run: list the Code sessions the desktop launched, judge each from its
// transcript, then show the pending entry and the wake-up message the initiator
// would receive (including the 'others' list). Nothing is stopped or started.
//
//   node --experimental-strip-types scripts/dryrun.ts
//   node --experimental-strip-types scripts/dryrun.ts --transcript <file.jsonl>

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_MESSAGE, buildPending, digestFromLines, judgeTranscript, interruptedLabel, type SessionInfo } from '../hooks/register.ts'

const script = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'restart-claude.ps1')
const ps = (args: string[]): string =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  }).toString('utf8')

function judge(id: string, transcript: string, tail: string) {
  const digest = digestFromLines(tail.split(/\r?\n/))
  const verdict = judgeTranscript(digest)
  console.log(`- ${id}  ${verdict.state === 'working' ? '干活' : '空闲'}`)
  console.log(`    cwd: ${digest.cwd || '(未知)'}`)
  console.log(`    transcript: ${transcript}`)
  console.log(`    依据: ${verdict.reason}`)
  for (const item of verdict.interrupted) {
    console.log(`    中断的后台任务: ${interruptedLabel(item.type)} ${item.id}${item.detail ? ' — ' + item.detail : ''}`)
  }
  return { digest, verdict }
}

const at = process.argv.indexOf('--transcript')
if (at >= 0 && process.argv[at + 1]) {
  const file = process.argv[at + 1]
  console.log('=== fixture transcript ===')
  judge('(fixture)', file, fs.readFileSync(file, 'utf8'))
  process.exit(0)
}

const discovered = JSON.parse(ps(['-Discover']) || '[]')
const list = Array.isArray(discovered) ? discovered : [discovered]
console.log(`=== desktop-launched Code sessions: ${list.length} ===`)

const infos: SessionInfo[] = []
for (const session of list) {
  const tail = session.transcript ? ps(['-Tail', '-Transcript', session.transcript, '-Bytes', '524288']) : ''
  const { digest, verdict } = judge(session.sessionId, session.transcript || '(no transcript)', tail)
  console.log(`    title: ${session.title || '(无)'}  localId: ${session.localId || '(无映射)'}`)
  infos.push({
    sessionId: session.sessionId,
    localId: session.localId || null,
    title: session.title || '',
    cwd: digest.cwd || session.cwd || '',
    state: verdict.state,
    reason: verdict.reason,
    interrupted: verdict.interrupted,
  })
}

const initiator = infos[0]
if (!initiator) process.exit(0)
console.log(`\n=== pending.json (模拟；发起会话取列表第一个 ${initiator.sessionId}) ===`)
const entries = buildPending({ sessionId: initiator.sessionId, cwd: initiator.cwd, message: DEFAULT_MESSAGE }, infos, Date.now())
console.log(JSON.stringify(entries, null, 2))
console.log('\n=== 发起会话的唤醒消息全文 ===')
console.log(entries[0]?.message ?? '')
