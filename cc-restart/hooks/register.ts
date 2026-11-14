// cc-restart: let the model restart the Claude desktop app, then wake every
// session that was working again. The tool records one entry per session in
// pending.json; a detached PowerShell worker (handed to WMI, so it cannot die
// with this process) restarts the desktop and reopens each session with
// 'claude --desktop --resume <id>'; each session's 'session.start' reads its
// own entry, submits the wake-up message when asked to, and removes just that
// entry under a lock.
//
// A hooks module may import its own files and "claude-code" only, so every
// file and process operation goes through $.

import type { Register } from 'claude-code'

export const PLUGIN = 'cc-restart'
export const TOOL_NAME = 'restart_cc'
export const TOOL_ID = 'mcp__cc-restart__restart_cc'
export const DEFAULT_MESSAGE = '[cc-restart] Claude Code 已重启，请读账本，接着之前的任务继续'
export const INTERRUPTED_MESSAGE =
  '[cc-restart] Claude Code 刚被重启，你上一轮被中断了。请先检查中断前在做的事情（文件、后台任务、进程）的真实状态，再接着做完；不要重复已经完成的步骤。'
export const DEFAULT_DELAY_SECONDS = 5

/** A pending entry older than this is stale: it never submits its message. */
export const MAX_AGE_MS = 10 * 60 * 1000
const MAX_DELAY_SECONDS = 600
/** Tolerate an entry stamped slightly in the future (clock drift). */
const CLOCK_SKEW_MS = 60 * 1000
/** How much of a transcript's tail the worker reads for the state judgement. */
const TAIL_BYTES = 524288

export type Interrupted = { type: string; id: string; detail: string }

export type OtherSession = {
  cliSessionId: string
  localId: string | null
  cwd: string
  title: string
  wake: boolean
  reason: string
  message: string
  interrupted: Interrupted[]
}

export type Pending = {
  sessionId: string
  cwd: string
  wake: boolean
  message: string
  ts: number
  state?: string
  reason?: string
  initiator?: boolean
  interrupted?: Interrupted[]
  others?: OtherSession[]
}

export type SessionInfo = {
  sessionId: string
  localId: string | null
  title: string
  cwd: string
  state: 'working' | 'idle'
  reason: string
  interrupted: Interrupted[]
}

export type Digest = {
  cwd: string
  lastRecordType: string
  lastMessage: { role: string; kinds: string[] } | null
  /** When the newest timestamped record was written (ms since epoch); 0 when none carries a time. */
  lastTs: number
  backgroundBash: { id: string; detail: string }[]
  backgroundAgents: { id: string; detail: string; agentId?: string }[]
  delegateStarts: { id: string; detail: string }[]
  delegateDones: string[]
  notifications: { taskId: string; toolUseId: string; interim?: boolean }[]
  monitors: { id: string; detail: string }[]
  wakeups: { id: string; detail: string; stop: boolean }[]
  crons: { id: string; detail: string }[]
  cronDeletes: string[]
  lastHumanIndex: number
  lastWakeIndex: number
}

// Real shapes (checked against ~/.claude/projects):
//   Command running in background with ID: bq25oyz93. Output is being written to: ...
//   [delegate pro · 后台任务 bg-mvfeek2b] 已启动。完成后会自动通知你...
//   【delegate 后台任务 bg-mvfeek2b 完成】
const BACKGROUND_BASH = /Command running in background with ID:\s*([A-Za-z0-9]{6,})\.\s*Output is being written to:/
const DELEGATE_START = /后台任务\s*\[?\s*(bg-[A-Za-z0-9_-]+)\]?\s*已启动/
const DELEGATE_DONE = /【delegate 后台任务\s*([^\s】]+)\s*(?:完成|失败)】/
const TASK_ID = /<task-id>\s*([^<\s]+)/
const TOOL_USE_ID = /<tool-use-id>\s*([^<\s]+)/
// An agent whose turn ended with its own background work still running gets an interim
// notice; the same task-id notifies again once that work is done.
const INTERIM_NOTICE = /waiting on its own background work|stopped with background work of its own still running/i

function blockText(block: any): string {
  const content = block?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part === 'string' ? part : String(part?.text ?? ''))).join('')
  }
  if (typeof block?.text === 'string') return block.text
  return ''
}

function messageText(message: any): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part === 'string' ? part : String(part?.text ?? ''))).join('')
  }
  return ''
}

function kindOf(block: any): string {
  return typeof block?.type === 'string' ? block.type : ''
}

/** A session silent for longer than this before the restart was not interrupted by it. */
export const STALE_AFTER_MS = 30 * 60 * 1000

/** Turns transcript lines (a tail, first line possibly cut) into what the judgement needs. */
export function digestFromLines(lines: readonly string[]): Digest {
  const digest: Digest = {
    cwd: '',
    lastRecordType: '',
    lastMessage: null,
    lastTs: 0,
    backgroundBash: [],
    backgroundAgents: [],
    delegateStarts: [],
    delegateDones: [],
    notifications: [],
    monitors: [],
    wakeups: [],
    crons: [],
    cronDeletes: [],
    lastHumanIndex: -1,
    lastWakeIndex: -1,
  }
  const toolUses = new Map<string, { name: string; input: any }>()
  const agentIdByUse = new Map<string, string>()
  let index = 0

  for (const line of lines) {
    if (!line || !line.trim()) continue
    let record: any
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!record || typeof record !== 'object') continue
    index++
    if (typeof record.cwd === 'string' && record.cwd) digest.cwd = record.cwd
    if (typeof record.type === 'string' && record.type) digest.lastRecordType = record.type
    if (typeof record.timestamp === 'string') {
      const ts = Date.parse(record.timestamp)
      if (Number.isFinite(ts) && ts > digest.lastTs) digest.lastTs = ts
    }

    const content = record.message?.content
    const blocks: any[] = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []
    const recordText = messageText(record.message)

    if (!record.isSidechain && (record.type === 'user' || record.type === 'assistant')) {
      const kinds: string[] = []
      for (const block of blocks) {
        const kind = kindOf(block)
        if (kind && !kinds.includes(kind)) kinds.push(kind)
      }
      digest.lastMessage = { role: String(record.message?.role ?? record.type), kinds }
      if (record.type === 'user') {
        const originKind = record.origin?.kind
        const hasToolResult = blocks.some(block => kindOf(block) === 'tool_result')
        const looksHuman =
          !hasToolResult &&
          !recordText.includes('<task-notification>') &&
          (typeof originKind !== 'string' || originKind === 'composer' || originKind === 'user')
        if (looksHuman) digest.lastHumanIndex = index
      }
    }

    for (const block of blocks) {
      const kind = kindOf(block)
      if (kind === 'tool_use') {
        const id = String(block.id ?? '')
        if (id) toolUses.set(id, { name: String(block.name ?? ''), input: block.input ?? {} })
        const name = String(block.name ?? '')
        if (name === 'ScheduleWakeup') {
          digest.wakeups.push({ id, detail: String(block.input?.reason ?? block.input?.prompt ?? ''), stop: block.input?.stop === true })
          digest.lastWakeIndex = index
        } else if (name === 'Monitor') {
          digest.monitors.push({ id, detail: String(block.input?.command ?? block.input?.description ?? '') })
        } else if (name === 'CronCreate') {
          digest.crons.push({ id, detail: String(block.input?.cron ?? block.input?.prompt ?? '').slice(0, 120) })
        } else if (name === 'CronDelete') {
          digest.cronDeletes.push(String(block.input?.id ?? ''))
        }
      }
      if (kind === 'tool_result') {
        const toolUse = toolUses.get(String(block.tool_use_id ?? ''))
        const text = blockText(block)
        const bash = BACKGROUND_BASH.exec(text)
        if (bash?.[1]) {
          digest.backgroundBash.push({
            id: bash[1],
            detail: String(toolUse?.input?.description ?? toolUse?.input?.command ?? '').slice(0, 120),
          })
        }
        // A background agent's completion notice names its agentId in <task-id>,
        // not the launching tool_use id, so remember the agentId from the launch.
        const agentId = toolUse?.name === 'Agent' ? /agentId:\s*([A-Za-z0-9]+)/.exec(text)?.[1] : undefined
        if (agentId) agentIdByUse.set(String(block.tool_use_id ?? ''), agentId)
        const delegate = DELEGATE_START.exec(text)
        if (delegate?.[1]) {
          digest.delegateStarts.push({
            id: delegate[1],
            detail: text.replace(/\s+/g, ' ').slice(0, 120),
          })
        }
      }
    }

    if (record.type === 'user') {
      const taskId = TASK_ID.exec(recordText)
      if (taskId?.[1]) {
        const toolUseId = TOOL_USE_ID.exec(recordText)
        digest.notifications.push({
          taskId: taskId[1],
          toolUseId: toolUseId?.[1] ?? '',
          ...(INTERIM_NOTICE.test(recordText) ? { interim: true } : {}),
        })
      }
      const done = DELEGATE_DONE.exec(recordText)
      if (done?.[1]) digest.delegateDones.push(done[1])
    }
  }

  for (const [id, use] of toolUses) {
    if (use.name === 'Agent' && use.input?.run_in_background === true) {
      const agentId = agentIdByUse.get(id)
      digest.backgroundAgents.push({ id, detail: String(use.input?.description ?? use.input?.prompt ?? '').slice(0, 120), ...(agentId ? { agentId } : {}) })
    }
  }

  return digest
}

export function interruptedLabel(type: string): string {
  switch (type) {
    case 'bash':
      return '后台 Bash'
    case 'agent':
      return '后台子代理'
    case 'delegate':
      return 'delegate 后台任务'
    case 'monitor':
      return 'Monitor'
    case 'schedule-wakeup':
      return 'ScheduleWakeup'
    case 'cron':
      return 'Cron'
    default:
      return type
  }
}

/**
 * (a) the turn has not ended; or (b) the turn ended but something started
 * before the restart is still waiting for a result. Otherwise idle.
 */
export function judgeTranscript(
  digest: Digest,
  now?: number,
): { state: 'working' | 'idle'; reason: string; interrupted: Interrupted[] } {
  const interrupted: Interrupted[] = []
  const add = (item: Interrupted) => {
    if (!interrupted.some(existing => existing.type === item.type && existing.id === item.id)) interrupted.push(item)
  }
  for (const job of digest.backgroundBash) {
    if (!digest.notifications.some(note => note.taskId === job.id)) add({ type: 'bash', id: job.id, detail: job.detail })
  }
  for (const agent of digest.backgroundAgents) {
    // Only the latest notice counts: an interim one means its background work was still running.
    const notes = digest.notifications.filter(note => note.toolUseId === agent.id || (!!agent.agentId && note.taskId === agent.agentId))
    const done = notes.length > 0 && notes[notes.length - 1]?.interim !== true
    if (!done) add({ type: 'agent', id: agent.id, detail: agent.detail })
  }
  for (const job of digest.delegateStarts) {
    if (!digest.delegateDones.includes(job.id)) add({ type: 'delegate', id: job.id, detail: job.detail })
  }
  for (const monitor of digest.monitors) {
    if (!digest.notifications.some(note => note.toolUseId === monitor.id)) add({ type: 'monitor', id: monitor.id, detail: monitor.detail })
  }
  const wakeup = digest.wakeups[digest.wakeups.length - 1]
  if (wakeup && !wakeup.stop && digest.lastHumanIndex < digest.lastWakeIndex) {
    add({ type: 'schedule-wakeup', id: wakeup.id, detail: wakeup.detail })
  }
  for (const cron of digest.crons) {
    if (!digest.cronDeletes.includes(cron.id)) add({ type: 'cron', id: cron.id, detail: cron.detail })
  }

  // A transcript nothing has written to for a long while was not cut off by this restart,
  // whatever its last line looks like: a window switch after a finished turn leaves the
  // handoff (a user message) as the last message for days.
  const stale = typeof now === 'number' && digest.lastTs > 0 && now - digest.lastTs > STALE_AFTER_MS
  if (!stale && digest.lastRecordType === 'api-request') {
    return { state: 'working', reason: '最后一条记录是 api-request（正在等模型返回）', interrupted }
  }
  const last = stale ? null : digest.lastMessage
  if (last?.role === 'user') {
    return { state: 'working', reason: '最后一条消息是用户消息或工具结果，助理还没回复', interrupted }
  }
  if (last?.role === 'assistant' && last.kinds.includes('tool_use')) {
    return { state: 'working', reason: '最后一条消息带未完成的 tool_use', interrupted }
  }
  if (interrupted.length > 0) {
    return {
      state: 'working',
      reason: `回合已结束，但还有未完成的后台任务：${interrupted.map(item => `${interruptedLabel(item.type)} ${item.id}`).join('、')}`,
      interrupted,
    }
  }
  if (stale) {
    const minutes = Math.round((now! - digest.lastTs) / 60000)
    return { state: 'idle', reason: `最后一次活动在 ${minutes} 分钟前，不是这次重启打断的，也没有未完成的后台任务`, interrupted: [] }
  }
  return { state: 'idle', reason: '最后一条消息是助理的结束回复，也没有未完成的后台任务', interrupted: [] }
}

/** The wake-up text for a session judged working: names every interrupted job. */
export function workingMessage(interrupted: readonly Interrupted[]): string {
  if (interrupted.length === 0) return INTERRUPTED_MESSAGE
  const lines = interrupted.map(item => `- ${interruptedLabel(item.type)}：${item.id}${item.detail ? `（${item.detail}）` : ''}`)
  return `${INTERRUPTED_MESSAGE}

重启时还有这些后台任务在等结果，它们大概率已经随重启终止：
${lines.join('\n')}

先核对真实状态：后台 Bash 看它的输出文件是否已经写完；delegate 任务看 ~/.claude/delegate/results/<jobId>.md 是否已经写完；子代理和 Monitor 看它们的产物或日志。已完成的直接读取结果，没完成的重新发起；不要重复已经完成的步骤。`
}

export type Discovered = {
  sessionId: string
  pid?: number
  transcript?: string
  localId?: string
  title?: string
  cwd?: string
}

/**
 * The text the initiator wakes with: its own message plus the instruction to
 * reach the other sessions with the desktop's session tools. Only the
 * initiator is reopened by the worker; the rest are listed here.
 */
export function buildWakeMessage(base: string, others: readonly OtherSession[]): string {
  if (others.length === 0) return base
  const blocks = others.map((other, index) => {
    const lines = [
      `  ${index + 1}. cliSessionId: ${other.cliSessionId}`,
      `     localId: ${other.localId ?? '(没有找到映射，需要自己匹配)'}`,
      `     cwd: ${other.cwd || '(未知)'}`,
      `     标题: ${other.title || '(未知)'}`,
      `     wake: ${other.wake}`,
      `     reason: ${other.reason}`,
    ]
    if (other.wake && other.message) lines.push(`     message: ${other.message.replace(/\n/g, '\n     ')}`)
    if (other.interrupted.length > 0) {
      lines.push(`     中断的后台任务: ${other.interrupted.map(item => `${interruptedLabel(item.type)} ${item.id}`).join('、')}`)
    }
    return lines.join('\n')
  })
  return `${base}

[cc-restart] 重启后只重新打开了你这个会话，下面这些桌面版 Code 会话没有被重新打开。请用桌面版的跨会话消息工具通知需要继续的会话：
1. 先调用 mcp__ccd_session_mgmt__list_sessions，按 cwd、标题、CLI 会话 id 把下列会话对应到 local_ 会话 id；已经给出 localId 的可以直接用，对不上的跳过并在汇报里说明。
2. 对每个 wake=true 的会话，调用 mcp__ccd_session_mgmt__send_message（session_id 用 local_ 会话 id，message 用下面给出的 message；也可以用新的 SendMessage，to 填 local_ 会话 id）。目标会话会立刻开始一轮，它正在忙时消息会排队。
3. wake=false 的会话不用处理。

会话列表：
${blocks.join('\n')}

处理完后简单汇报：通知了哪些会话、哪些没对上。`
}

/** Builds the pending array: one entry for the asking session, the others inside it. */
export function buildPending(
  current: { sessionId: string; cwd: string; message: string },
  discovered: readonly SessionInfo[],
  now: number,
): Pending[] {
  const others: OtherSession[] = discovered
    .filter(info => info.sessionId !== current.sessionId)
    .map(info => {
      const working = info.state === 'working'
      return {
        cliSessionId: info.sessionId,
        localId: info.localId ?? null,
        cwd: info.cwd,
        title: info.title,
        wake: working,
        reason: info.reason,
        message: working ? workingMessage(info.interrupted) : '',
        interrupted: info.interrupted,
      }
    })
  return [
    {
      sessionId: current.sessionId,
      cwd: current.cwd,
      wake: true,
      message: buildWakeMessage(current.message, others),
      ts: now,
      state: 'working',
      reason: '发起重启的会话',
      initiator: true,
      interrupted: [],
      others,
    },
  ]
}

// ---------------------------------------------------------------- state helpers

export async function dataDir($: any): Promise<string> {
  try {
    const override = await $.env.get('CC_RESTART_DIR')
    if (typeof override === 'string' && override.trim()) return override.replace(/[\\/]+$/, '')
  } catch {
    // No override: use the home directory.
  }
  try {
    const profile = await $.env.get('USERPROFILE')
    if (typeof profile === 'string' && profile.trim()) return `${profile.replace(/[\\/]+$/, '')}/.claude/cc-restart`
  } catch {
    // Try the next source of the home directory.
  }
  try {
    const home = await $.env.get('HOME')
    if (typeof home === 'string' && home.trim()) return `${home.replace(/[\\/]+$/, '')}/.claude/cc-restart`
  } catch {
    // Fall back to a relative directory.
  }
  return '.claude/cc-restart'
}

export function markerPath(dir: string): string {
  return `${dir}/pending.json`
}

export function logPath(dir: string): string {
  return `${dir}/restart.log`
}

export function clampDelay(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DELAY_SECONDS
  return Math.min(Math.trunc(n), MAX_DELAY_SECONDS)
}

export function normalizeMessage(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : DEFAULT_MESSAGE
}

export function isFresh(entry: Pending, now: number): boolean {
  const age = now - entry.ts
  if (!Number.isFinite(age)) return false
  if (age < -CLOCK_SKEW_MS) return false
  return age <= MAX_AGE_MS
}

function validEntry(value: unknown): Pending | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.sessionId !== 'string' || !v.sessionId) return null
  if (typeof v.ts !== 'number' || !Number.isFinite(v.ts)) return null
  const interrupted = Array.isArray(v.interrupted)
    ? v.interrupted.filter((item): item is Interrupted => Boolean(item) && typeof item === 'object')
    : []
  const others: OtherSession[] = Array.isArray(v.others)
    ? v.others
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map(item => ({
          cliSessionId: typeof item.cliSessionId === 'string' ? item.cliSessionId : '',
          localId: typeof item.localId === 'string' ? item.localId : null,
          cwd: typeof item.cwd === 'string' ? item.cwd : '',
          title: typeof item.title === 'string' ? item.title : '',
          wake: item.wake === true,
          reason: typeof item.reason === 'string' ? item.reason : '',
          message: typeof item.message === 'string' ? item.message : '',
          interrupted: Array.isArray(item.interrupted)
            ? item.interrupted.filter((part): part is Interrupted => Boolean(part) && typeof part === 'object')
            : [],
        }))
        .filter(item => item.cliSessionId)
    : []
  return {
    sessionId: v.sessionId,
    cwd: typeof v.cwd === 'string' ? v.cwd : '',
    wake: v.wake === true,
    message: typeof v.message === 'string' ? v.message : '',
    ts: v.ts,
    state: typeof v.state === 'string' ? v.state : undefined,
    reason: typeof v.reason === 'string' ? v.reason : undefined,
    initiator: v.initiator === true,
    interrupted,
    others,
  }
}

async function readText($: any, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

export async function readPending($: any, dir: string): Promise<Pending[]> {
  const text = await readText($, markerPath(dir))
  if (text === null) return []
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.map(validEntry).filter((entry): entry is Pending => entry !== null)
  } catch {
    return []
  }
}

export async function writePending($: any, dir: string, entries: readonly Pending[]): Promise<void> {
  await $.fs.write(markerPath(dir), JSON.stringify(entries, null, 2))
}

export async function appendLog($: any, dir: string, text: string): Promise<void> {
  try {
    const path = logPath(dir)
    const old = await readText($, path)
    await $.fs.write(path, `${old ?? ''}${new Date().toISOString()} [register] ${text}\n`)
  } catch {
    // A log we cannot write never fails the hook.
  }
}

/** The worker script: scripts/ next to the plugin root. */
export async function workerScript($: any): Promise<string | null> {
  for (const candidate of [`${$.plugin.root}/scripts/restart-claude.ps1`, `${$.plugin.root}/../scripts/restart-claude.ps1`]) {
    try {
      if (await $.fs.exists(candidate)) return candidate
    } catch {
      // Try the next layout.
    }
  }
  return null
}

function powershell(argv: string[]) {
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...argv]
}

export async function discoverSessions($: any, script: string): Promise<Discovered[]> {
  const run = await $.process.run(powershell([script, '-Discover']), { timeoutMs: 30000 })
  if (run.exitCode !== 0) return []
  const text = String(run.stdout ?? '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((item): item is Discovered => Boolean(item) && typeof item.sessionId === 'string')
  } catch {
    return []
  }
}

export async function readTranscriptTail($: any, script: string, transcript: string): Promise<string> {
  const run = await $.process.run(powershell([script, '-Tail', '-Transcript', transcript, '-Bytes', String(TAIL_BYTES)]), {
    timeoutMs: 30000,
  })
  return run.exitCode === 0 ? String(run.stdout ?? '') : ''
}

export async function consumeEntry($: any, script: string, dir: string, sessionId: string): Promise<boolean> {
  try {
    const run = await $.process.run(
      powershell([script, '-Consume', '-SessionId', sessionId, '-PendingPath', markerPath(dir), '-LogPath', logPath(dir)]),
      { timeoutMs: 20000 },
    )
    return run.exitCode === 0
  } catch {
    return false
  }
}

/**
 * Runs the worker in detach mode: it hands itself to WMI and exits at once,
 * so the real wait/restart/resume runs from the WMI service, not from this
 * process tree and not from this process's lifetime.
 */
export async function launchWorker(
  $: any,
  script: string,
  dir: string,
  delaySeconds: number,
): Promise<{ exitCode: number; stderr: string }> {
  const run = await $.process.run(
    powershell([script, '-Detach', '-NoResume', '-PendingPath', markerPath(dir), '-LogPath', logPath(dir), '-DelaySeconds', String(delaySeconds)]),
    { timeoutMs: 30000 },
  )
  return { exitCode: run.exitCode, stderr: String(run.stderr ?? '') }
}

type ToolInput = { message?: unknown; delaySeconds?: unknown; wakeTaskId?: unknown }

/** How long after the first call the one-shot wake task fires. */
export const WAKE_TASK_LEAD_MS = 45 * 1000

/** The restart must land at least this long before the wake task fires. */
export const WAKE_TASK_MARGIN_MS = 10 * 1000

/**
 * Milliseconds left before the wake task fires, read back from the task id
 * (cc-restart-wake-<ms>), or null when the id is not one we generated.
 */
export function wakeTaskRemainingMs(taskId: string, now: number): number | null {
  const m = /^cc-restart-wake-(\d+)$/.exec(taskId)
  if (!m) return null
  return Number(m[1]) + WAKE_TASK_LEAD_MS - now
}

/** ISO 8601 with the local UTC offset, as create_scheduled_task's fireAt wants. */
export function localIso(ms: number): string {
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0')
  const local = new Date(ms + off * 60000).toISOString().slice(0, 19)
  return `${local}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`
}

/**
 * The desktop app cannot be told to reopen a session from outside (neither
 * `claude --desktop --resume` nor the claude:// link starts it), but a
 * scheduled task due while the app is closed runs on next launch, and
 * send_message starts a closed session. So the initiator schedules a one-shot
 * task that messages it back after the restart.
 */
export function wakeTaskPlan(localId: string, now: number): { taskId: string; fireAt: string; prompt: string } {
  const taskId = `cc-restart-wake-${now}`
  const prompt =
    `只做一件事：调用 mcp__ccd_session_mgmt__send_message（未加载就先用 ToolSearch 加载 select:mcp__ccd_session_mgmt__send_message），` +
    `session_id 填 ${localId}，message 填「[cc-restart] 桌面版已重启，这条消息由一次性定时任务 ${taskId} 代发，用来重新打开你这个会话。」。` +
    `发送后用一句话报告送达结果，不做任何其他事情。`
  return { taskId, fireAt: localIso(now + WAKE_TASK_LEAD_MS), prompt }
}

/**
 * The first call leaves the plan here, so the second call finds the task id
 * even when the model's tool schema is stale and drops wakeTaskId.
 */
export const WAKE_PLAN_FILE = 'wake-plan.json'

export function wakePlanPath(dir: string): string {
  return `${dir}/${WAKE_PLAN_FILE}`
}

export type WakePlan = { taskId: string; ts: number }

export async function readWakePlan($: any, dir: string): Promise<WakePlan | null> {
  const text = await readText($, wakePlanPath(dir))
  if (!text || !text.trim()) return null
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    const taskId = typeof parsed.taskId === 'string' ? parsed.taskId.trim() : ''
    if (!taskId) return null
    const ts = Number(parsed.ts)
    return { taskId, ts: Number.isFinite(ts) ? ts : 0 }
  } catch {
    return null
  }
}

export async function writeWakePlan($: any, dir: string, plan: WakePlan): Promise<void> {
  try {
    await $.fs.write(wakePlanPath(dir), JSON.stringify(plan, null, 2))
  } catch {
    // A plan we cannot write only costs the next call one more first step.
  }
}

/** $.fs has no delete: an empty file reads back as "no plan". */
export async function clearWakePlan($: any, dir: string): Promise<void> {
  try {
    await $.fs.write(wakePlanPath(dir), '')
  } catch {
    // Same as above: never fails the tool.
  }
}

/** The desktop app's own data, named by its MSIX package family. */
export const DESKTOP_PACKAGE = 'claude_pzs8sxrjxfjjc'

/** LOCALAPPDATA, or the same place built from the profile, as -Discover's ps1 assumes. */
export async function localAppData($: any): Promise<string> {
  try {
    const local = await $.env.get('LOCALAPPDATA')
    if (typeof local === 'string' && local.trim()) return local.replace(/[\\/]+$/, '')
  } catch {
    // Try the profile.
  }
  try {
    const profile = await $.env.get('USERPROFILE')
    if (typeof profile === 'string' && profile.trim()) return `${profile.replace(/[\\/]+$/, '')}/AppData/Local`
  } catch {
    // Nothing left to try.
  }
  return ''
}

export function desktopSessionsRoot(base: string): string {
  return `${base.replace(/[\\/]+$/, '')}/Claude-Data/${DESKTOP_PACKAGE}/claude-code-sessions`
}

async function listDirs($: any, path: string): Promise<string[]> {
  try {
    const entries = await $.fs.list(path)
    return (Array.isArray(entries) ? entries : [])
      .filter((entry: any) => entry && entry.kind === 'dir' && typeof entry.name === 'string')
      .map((entry: any) => String(entry.name))
  } catch {
    return []
  }
}

/** Whether one scheduled-tasks.json holds the task, not disabled. */
export function hasEnabledTask(text: string, taskId: string): boolean {
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed?.scheduledTasks) ? parsed.scheduledTasks : []
    return list.some((task: any) => task && String(task.id ?? '') === taskId && task.enabled !== false)
  } catch {
    return false
  }
}

/**
 * The desktop keeps its scheduled tasks per account and workspace:
 * claude-code-sessions/<account>/<workspace>/scheduled-tasks.json. Both levels
 * are unknown, so every one of them is checked.
 */
export async function scheduledTaskExists($: any, taskId: string): Promise<boolean> {
  const base = await localAppData($)
  if (!base) return false
  const root = desktopSessionsRoot(base)
  for (const account of await listDirs($, root)) {
    const accountDir = `${root}/${account}`
    for (const workspace of await listDirs($, accountDir)) {
      const text = await readText($, `${accountDir}/${workspace}/scheduled-tasks.json`)
      if (text === null) continue
      if (hasEnabledTask(text, taskId)) return true
    }
  }
  return false
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL_NAME,
      description:
        '重启 Claude 桌面版，并在重启后唤醒所有正在干活的 Code 会话（包括发起重启的会话）。分两步：第一次调用只返回一个一次性定时任务的参数，不会重启；按返回的参数调用 create_scheduled_task 建好任务后，立刻用同样的参数再调用一次本工具才真正重启（不需要传 wakeTaskId，计划已经记在本地）。参数 message 是发起会话的唤醒文字（可选），delaySeconds 是调用后等待多少秒再重启（默认 5）。',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: `发起会话的唤醒文字；默认「${DEFAULT_MESSAGE}」`,
          },
          wakeTaskId: {
            type: 'string',
            description: '可选，一般不用传：第一次调用返回的定时任务 id 会自动记在本地，第二次调用直接读它。传 none 表示跳过唤醒任务直接重启（重启后需手动打开本会话）',
          },
          delaySeconds: {
            type: 'number',
            description: `调用后等待多少秒再重启，默认 ${DEFAULT_DELAY_SECONDS}，上限 ${MAX_DELAY_SECONDS}`,
          },
        },
        required: [],
      },
      isDeferred: false,
    })

    let dir = ''
    try {
      dir = await dataDir($)
      const entries = await readPending($, dir)
      if (entries.length === 0) {
        await appendLog($, dir, 'no pending entry')
        return next(e)
      }
      const sessionId = await $.session.id().catch(() => undefined)
      if (!sessionId) return next(e)
      const mine = entries.find(entry => entry.sessionId === sessionId)
      if (!mine) {
        await appendLog($, dir, `no entry for this session (pending=${entries.length})`)
        return next(e)
      }
      if (mine.wake && isFresh(mine, Date.now())) {
        await $.prompt.submit({ text: mine.message })
        await appendLog($, dir, `woke session=${sessionId} after ${Date.now() - mine.ts}ms`)
      } else {
        await appendLog($, dir, `no wake for session=${sessionId}: wake=${mine.wake} fresh=${isFresh(mine, Date.now())}`)
      }
      const script = await workerScript($)
      if (script) await consumeEntry($, script, dir, sessionId)
    } catch (error) {
      if (dir) await appendLog($, dir, `wake failed: ${String(error)}`)
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL_ID as never }, async ($: any, e: any) => ({ result: toolText(await restartTool($, e)) }))
}

/** The runtime checks a hook's `result` against the tool's output shape: a string or content array. */
export function toolText(r: { result: any; text: string }): string {
  const code = r.result && typeof r.result.error === 'string' ? ` [${r.result.error}]` : ''
  return r.text + code
}

async function restartTool($: any, e: any): Promise<{ result: any; text: string }> {
    const input = (e.input ?? {}) as ToolInput
    const inputWakeTaskId = typeof input.wakeTaskId === 'string' && input.wakeTaskId.trim() ? input.wakeTaskId.trim() : ''
    const baseMessage = normalizeMessage(input.message)
    const delaySeconds = clampDelay(input.delaySeconds)
    const dir = await dataDir($)

    const script = await workerScript($)
    if (!script) {
      return {
        result: { error: 'worker-script-missing' },
        text: `cc-restart 未重启：找不到 scripts/restart-claude.ps1（插件目录 ${$.plugin.root}）。`,
      }
    }

    let sessionId: string
    let cwd: string
    try {
      sessionId = await $.session.id()
      cwd = await $.session.cwd()
    } catch (error) {
      return { result: { error: String(error) }, text: `cc-restart 未重启：读不到当前会话（${String(error)}）。` }
    }

    const discovered: SessionInfo[] = []
    let selfLocalId = ''
    try {
      for (const session of await discoverSessions($, script)) {
        if (session.sessionId === sessionId) {
          if (session.localId) selfLocalId = String(session.localId)
          continue
        }
        let tail = ''
        if (session.transcript) {
          try {
            tail = await readTranscriptTail($, script, session.transcript)
          } catch {
            tail = ''
          }
        }
        const digest = digestFromLines(tail.split(/\r?\n/))
        const verdict = judgeTranscript(digest, Date.now())
        discovered.push({
          sessionId: session.sessionId,
          localId: session.localId ? String(session.localId) : null,
          title: String(session.title ?? ''),
          cwd: digest.cwd || String(session.cwd ?? ''),
          state: verdict.state,
          reason: verdict.reason,
          interrupted: verdict.interrupted,
        })
      }
    } catch (error) {
      await appendLog($, dir, `discover failed: ${String(error)}`)
    }

    // The second call finds the plan on disk, so a stale tool schema that
    // drops wakeTaskId still reaches the real restart.
    let wakeTaskId = inputWakeTaskId
    if (!wakeTaskId) {
      const planned = await readWakePlan($, dir)
      // A plan left behind by an abandoned first step has run out of time:
      // drop it and start over instead of failing on wake-task-missing forever.
      const left = planned ? wakeTaskRemainingMs(planned.taskId, Date.now()) : null
      if (planned && left !== null && left < delaySeconds * 1000 + WAKE_TASK_MARGIN_MS) {
        await clearWakePlan($, dir)
      } else if (planned) {
        wakeTaskId = planned.taskId
      }
    }

    if (!wakeTaskId) {
      if (!selfLocalId) {
        return {
          result: { error: 'no-local-id' },
          text: 'cc-restart 未重启：找不到本会话的桌面版 local_ 会话 id，重启后没法自动唤醒。要重启的话，带 wakeTaskId: "none" 再调用一次（重启后需要用户手动打开本会话）。',
        }
      }
      const now = Date.now()
      const plan = wakeTaskPlan(selfLocalId, now)
      await writeWakePlan($, dir, { taskId: plan.taskId, ts: now })
      return {
        result: { ok: false, step: 'create-wake-task', ...plan },
        text:
          `cc-restart 还没重启。请先调用 mcp__scheduled-tasks__create_scheduled_task，参数：taskId=${plan.taskId}，fireAt=${plan.fireAt}，notifyOnCompletion=false，` +
          `description=cc-restart 重启后唤醒发起会话，prompt 原样用下面这段：\n${plan.prompt}\n` +
          `建好后立刻再调用一次本工具（参数同这次，不需要 wakeTaskId），就真正重启。计划已记在 ${wakePlanPath(dir)}。定时任务会在桌面版重启后补跑，用 send_message 重新打开你这个会话。`,
      }
    }

    if (wakeTaskId !== 'none') {
      // The task must really exist in the desktop's registry: the second call
      // is only trusted once create_scheduled_task has landed.
      if (!(await scheduledTaskExists($, wakeTaskId))) {
        await appendLog($, dir, `wake task ${wakeTaskId} not in the desktop registry`)
        return {
          result: { error: 'wake-task-missing', taskId: wakeTaskId },
          text: `cc-restart 未重启：定时任务 ${wakeTaskId} 还没建好，请先按上一次返回的参数调用 create_scheduled_task（taskId=${wakeTaskId}，fireAt 与 prompt 同上一次），建好后立刻再调用一次本工具。`,
        }
      }
      const remaining = wakeTaskRemainingMs(wakeTaskId, Date.now())
      if (remaining !== null && remaining < delaySeconds * 1000 + WAKE_TASK_MARGIN_MS) {
        await clearWakePlan($, dir)
        return {
          result: { error: 'wake-task-too-close', remainingMs: remaining },
          text: `cc-restart 未重启：定时任务 ${wakeTaskId} 离到点只剩 ${Math.round(remaining / 1000)} 秒，会在重启前就触发。请用 mcp__scheduled-tasks__delete_scheduled_task 删掉它，再调用一次本工具（会生成新的计划），并尽快完成第二步。`,
        }
      }
    }

    const message =
      wakeTaskId && wakeTaskId !== 'none'
        ? `${baseMessage}\n\n（唤醒用的一次性定时任务 ${wakeTaskId} 已经跑完，可以用 mcp__scheduled-tasks__delete_scheduled_task 删除它。）`
        : baseMessage
    const entries = buildPending({ sessionId, cwd, message }, discovered, Date.now())
    try {
      await writePending($, dir, entries)
      const launched = await launchWorker($, script, dir, delaySeconds)
      if (launched.exitCode !== 0) {
        await appendLog($, dir, `detach worker exited ${launched.exitCode}: ${launched.stderr}`)
        return {
          result: { error: 'detach-failed', exitCode: launched.exitCode, stderr: launched.stderr },
          text: `cc-restart 未重启：独立进程启动失败（exit ${launched.exitCode}）。${launched.stderr}`,
        }
      }
    } catch (error) {
      await appendLog($, dir, `schedule failed: ${String(error)}`)
      return { result: { error: String(error) }, text: `cc-restart 未重启：${String(error)}` }
    }
    await clearWakePlan($, dir)
    await appendLog(
      $,
      dir,
      `scheduled restart in ${delaySeconds}s for ${entries.length} session(s): ${entries.map(entry => `${entry.sessionId}(${entry.wake ? 'wake' : 'open'})`).join(', ')}`,
    )
    const initiator = entries[0]
    const others = initiator?.others ?? []
    const woken = others.filter(other => other.wake).length
    const wakeNote =
      wakeTaskId === 'none' ? '重启后需要你手动打开这个会话' : `重启后由定时任务 ${wakeTaskId} 发消息重新打开你这个会话`
    return {
      result: { ok: true, sessionId, delaySeconds, entries, marker: markerPath(dir), log: logPath(dir), wakeTaskId },
      text: `即将重启 Claude 桌面版：${delaySeconds} 秒后由独立 PowerShell 进程执行。${wakeNote}；另外 ${others.length} 个会话会被列进唤醒消息，其中 ${woken} 个需要你用 session 工具通知。标记文件：${markerPath(dir)}；日志：${logPath(dir)}。`,
    }
}
