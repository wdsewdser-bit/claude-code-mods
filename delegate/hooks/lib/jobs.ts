/** 作业记录与 runner 落盘的目录布局。
 *  每条作业单独一个 store key（job:<id>），所以并发会话不会整表覆盖；runner 在
 *  ~/.claude/delegate/jobs/<jobId>/ 里写 status.json / events.jsonl / result.json，
 *  重启后的会话据此列出作业、看进度、取消、插话。 */

export type Agent = 'flash' | 'pro' | 'gpt'
export type Mode = 'read' | 'work'
export type Ptc = 'only' | 'off'
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'orphaned'

export type JobRecord = {
  jobId: string
  /** 子代理的 session id：新建时由插件生成并 --session-id 传入，resume 时就是旧 id。 */
  sessionId: string | null
  tier: Agent
  model: string
  /** 这次实际传给 runner 的推理强度；resume 没传 effort 时沿用它。旧记录没有。 */
  effort?: string
  cwd: string
  mode: Mode
  ptc: Ptc
  /** read + ptc:'only' 时额外可读的绝对目录（cwd 以外）。resume 没传就沿用它。旧记录没有。 */
  readPaths?: string[]
  background: boolean
  status: JobStatus
  /** 开始时间（毫秒）。淘汰按它排序，不是完成时间。 */
  at: number
  endedAt?: number
  turns?: number
  error?: string
  /** 任务首行摘要，列作业时给模型认人用。 */
  summary: string
  /** 后台任务的结果通知是否已经发出（重启后据此补发，且只补一次）。 */
  notified?: boolean
  /** 派出它的主会话 id：面板默认只列本会话的，补发通知也只发给它。旧记录没有。 */
  owner?: string
}

/** runner 写的 status.json，读到什么算什么（写端非原子，字段可能缺）。 */
export type JobStatusFile = {
  jobId?: string
  pid?: number
  childPid?: number | null
  sessionId?: string | null
  phase?: string
  stream?: boolean
  turns?: number
  lastTool?: string | null
  lastText?: string
  /** 运行中数出来的输出 token 总数：assistant 行的 usage 是 0，runner 从 stream_event 里累加，result 时覆盖。 */
  outputTokens?: number
  startedAt?: number
  updatedAt?: number
  endedAt?: number
}

export const JOB_PREFIX = 'job:'
/** 保留最近多少条作业。 */
export const MAX_JOBS = 200
export const STATUSES: readonly JobStatus[] = ['running', 'done', 'failed', 'cancelled', 'orphaned']
/** status.json 的 startedAt 与本记录的 at 相差多少以内才认作同一个进程。 */
export const PID_WINDOW_MS = 120_000

export const jobKey = (id: string): string => `${JOB_PREFIX}${id}`
export const isJobKey = (key: string): boolean => key.startsWith(JOB_PREFIX)

const HEX = '0123456789abcdef'

/** --session-id 要一个 UUID；生成 v4 形状的即可。 */
export const uuid = (): string => {
  const chars = Array.from({ length: 32 }, () => HEX[Math.floor(Math.random() * 16)])
  chars[12] = '4'
  chars[16] = HEX[8 + Math.floor(Math.random() * 4)]
  const s = chars.join('')

  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

/** 作业 id：前台 fg-，后台 bg-（后台前缀保留，通知里一直是这么叫的）。 */
export const newJobId = (background: boolean, now: number, salt: number): string =>
  `${background ? 'bg' : 'fg'}-${now.toString(36)}${salt === 0 ? '' : `-${salt.toString(36)}`}`

/** 任务说明压成一行，给列表用。 */
export const summarize = (task: string, max = 100): string => {
  const one = task.replace(/\s+/g, ' ').trim()

  return one.length > max ? `${one.slice(0, max)}…` : one
}

/** ~/.claude/delegate/jobs，和 runner 的 os.homedir() 对齐。 */
export const jobsRootOf = (home: string | undefined): string | undefined => {
  if (home === undefined || home.trim() === '') return undefined
  const clean = home.replace(/\\/g, '/').replace(/\/+$/, '')

  return `${clean}/.claude/delegate/jobs`
}

export const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 本地时间 MM-DD HH:mm（跨年时带年份）。 */
export const timeOf = (ms: number | undefined, now: number): string => {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '?'
  const d = new Date(ms)
  const sameYear = new Date(now).getFullYear() === d.getFullYear()

  return `${sameYear ? '' : `${d.getFullYear()}-`}${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export const agoOf = (ms: number | undefined, now: number): string => {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '?'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86_400) return `${Math.round(s / 3600)} 小时前`

  return `${Math.round(s / 86_400)} 天前`
}

/** 跑了多久：1 分 20 秒 / 2 小时 3 分。 */
export const spanOf = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`

  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`
}

const STATUS_TEXT: Record<JobStatus, string> = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  orphaned: '已中断（宿主重启，可 resume）',
}

export const statusText = (status: JobStatus): string => STATUS_TEXT[status]

export const isStatus = (v: unknown): v is JobStatus =>
  typeof v === 'string' && (STATUSES as readonly string[]).includes(v)

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const agentOf = (v: unknown): Agent => (v === 'pro' || v === 'gpt' ? v : 'flash')

/** 额外可读目录：只留非空字符串，去掉末尾分隔符并去重（Windows 上不区分大小写）。空数组就是“没有”。 */
export const normalizeReadPaths = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '') continue
    // 盘符根（C:/、D:\）保留分隔符，其余去掉末尾的
    const cleaned = /^[A-Za-z]:[\\/]?$/.test(trimmed) ? trimmed.slice(0, 2) : trimmed.replace(/[\\/]+$/, '')
    if (cleaned === '') continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
  }

  return out
}

/** 读回来的记录（store 里可能是旧版本或垃圾）。 */
export const normalizeRecord = (raw: unknown, jobId: string): JobRecord | undefined => {
  if (!isRecord(raw)) return undefined
  const at = num(raw.at)

  return {
    jobId: str(raw.jobId) || jobId,
    sessionId: str(raw.sessionId) === '' ? null : str(raw.sessionId),
    tier: agentOf(raw.tier),
    model: str(raw.model),
    cwd: str(raw.cwd),
    mode: raw.mode === 'work' ? 'work' : 'read',
    ptc: raw.ptc === 'off' ? 'off' : 'only',
    ...(normalizeReadPaths(raw.readPaths).length === 0 ? {} : { readPaths: normalizeReadPaths(raw.readPaths) }),
    background: raw.background === true,
    status: isStatus(raw.status) ? raw.status : 'done',
    at: at ?? 0,
    ...(num(raw.endedAt) === undefined ? {} : { endedAt: num(raw.endedAt) }),
    ...(num(raw.turns) === undefined ? {} : { turns: num(raw.turns) }),
    ...(str(raw.error) === '' ? {} : { error: str(raw.error) }),
    summary: str(raw.summary),
    ...(raw.notified === true ? { notified: true } : {}),
    ...(str(raw.owner) === '' ? {} : { owner: str(raw.owner) }),
    ...(str(raw.effort) === '' ? {} : { effort: str(raw.effort) }),
  }
}

/** 旧版整表 jobs 里的备注（tier/cwd/mode/ptc/at）转成一条记录。 */
export const recordFromNote = (id: string, raw: unknown): JobRecord | undefined => {
  if (!isRecord(raw)) return undefined
  const base = normalizeRecord(
    {
      ...raw,
      jobId: id,
      // 旧表的键就是 agent id：没有单独记 sessionId 的记录，键本身就是它。
      sessionId: raw.sessionId ?? id,
      status: raw.status ?? 'done',
      background: raw.background ?? false,
      summary: raw.summary ?? '',
    },
    id,
  )

  return base
}

export const normalizeStatus = (raw: unknown): JobStatusFile | undefined => {
  if (!isRecord(raw)) return undefined

  return {
    ...(str(raw.jobId) === '' ? {} : { jobId: str(raw.jobId) }),
    ...(num(raw.pid) === undefined ? {} : { pid: num(raw.pid) }),
    ...(num(raw.childPid) === undefined ? {} : { childPid: num(raw.childPid) }),
    ...(str(raw.sessionId) === '' ? {} : { sessionId: str(raw.sessionId) }),
    ...(str(raw.phase) === '' ? {} : { phase: str(raw.phase) }),
    stream: raw.stream === true,
    turns: num(raw.turns),
    lastTool: str(raw.lastTool) === '' ? null : str(raw.lastTool),
    lastText: str(raw.lastText),
    ...(num(raw.outputTokens) === undefined || num(raw.outputTokens)! < 0 ? {} : { outputTokens: num(raw.outputTokens) }),
    startedAt: num(raw.startedAt),
    updatedAt: num(raw.updatedAt),
    endedAt: num(raw.endedAt),
  }
}

/** status.json 里的 pid 是不是这条作业的：id 对得上，开始时间也在窗口内。 */
export const pidMatches = (status: JobStatusFile | undefined, rec: JobRecord): boolean => {
  if (status === undefined || status.pid === undefined) return false
  if (status.jobId !== undefined && status.jobId !== rec.jobId) return false
  if (status.startedAt === undefined) return false

  return Math.abs(status.startedAt - rec.at) <= PID_WINDOW_MS
}

const agentLine = (rec: JobRecord): string =>
  `agent ${rec.sessionId ?? '?'} · ${rec.tier} / ${rec.model === '' ? '?' : rec.model} · ${rec.mode} · ${rec.background ? '后台' : '前台'}`

/** delegate_list 的输出：一行一条，摘要单独一行。 */
export const formatList = (
  records: readonly JobRecord[],
  opts: { now: number; limit: number; filter: string; live: Record<string, JobStatusFile> },
): string => {
  if (records.length === 0) {
    return opts.filter === ''
      ? '还没有作业记录。delegate_flash / delegate_pro / delegate_gpt 派出的每个任务都会记在这里。'
      : `没有状态为「${opts.filter}」的作业。`
  }
  const shown = records.slice(0, opts.limit)
  const head = `共 ${records.length} 个作业${opts.filter === '' ? '' : `（状态 ${opts.filter}）`}，显示最近 ${shown.length} 个：`
  const rows = shown.map((rec, i) => {
    const st = opts.live[rec.jobId]
    const turns = st?.turns ?? rec.turns
    const when = `${timeOf(rec.at, opts.now)}（${agoOf(rec.at, opts.now)}）`
    const took =
      rec.endedAt === undefined
        ? st?.updatedAt === undefined
          ? ''
          : ` · 已跑 ${spanOf((st.endedAt ?? st.updatedAt) - rec.at)}`
        : ` · 结束 ${timeOf(rec.endedAt, opts.now)} · 用时 ${spanOf(rec.endedAt - rec.at)}`
    const liveBit =
      rec.status === 'running'
        ? `${st?.phase === undefined ? '' : ` · ${st.phase}`}${st?.lastTool ? ` · 最后工具 ${st.lastTool}` : ''}`
        : ''
    const tail = [
      rec.status === 'running' || rec.status === 'orphaned'
        ? `   ↳ 接着做：resume "${rec.sessionId ?? rec.jobId}"（delegate_flash/pro/gpt 的 resume 参数）`
        : '',
      rec.status === 'running' ? `   ↳ 看进度：delegate_status "${rec.jobId}" · 取消：delegate_cancel "${rec.jobId}"` : '',
      rec.error === undefined ? '' : `   ↳ 失败原因：${rec.error.slice(0, 200)}`,
    ].filter(s => s !== '')
    const summary = rec.summary === '' ? '' : `   ${rec.summary}`

    return [
      `${i + 1}. ${rec.jobId} · ${statusText(rec.status)}${turns === undefined ? '' : ` · ${turns} 轮`} · ${when}${took}${liveBit}`,
      `   ${agentLine(rec)}${rec.cwd === '' ? '' : ` · cwd ${rec.cwd}`}`,
      summary,
      ...tail,
    ]
      .filter(s => s !== '')
      .join('\n')
  })

  return [head, ...rows].join('\n')
}

/** 事件日志一行压成一句，给 delegate_status 的“最近事件”。 */
export const eventLine = (raw: string, max = 140): string => {
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return raw.replace(/\s+/g, ' ').trim().slice(0, max)
  }
  if (!isRecord(o)) return raw.slice(0, max)
  const type = str(o.type)
  if (type === 'assistant') {
    const blocks = Array.isArray((o.message as Record<string, unknown> | undefined)?.content)
      ? ((o.message as Record<string, unknown>).content as unknown[])
      : []
    const parts: string[] = []
    for (const b of blocks) {
      if (!isRecord(b)) continue
      if (b.type === 'text') parts.push(`说：${str(b.text).replace(/\s+/g, ' ').trim()}`)
      else if (b.type === 'tool_use') parts.push(`用工具 ${str(b.name)}`)
      else if (b.type === 'thinking') parts.push('思考')
    }
    const line = parts.join(' · ') || '（空）'

    return `assistant ${line.length > max ? `${line.slice(0, max)}…` : line}`
  }
  if (type === 'user') {
    const content = (o.message as Record<string, unknown> | undefined)?.content
    if (Array.isArray(content)) {
      const names = content
        .filter(c => isRecord(c) && c.type === 'tool_result')
        .map(c => (isRecord(c) && typeof c.is_error === 'boolean' && c.is_error ? '工具结果（失败）' : '工具结果'))
      if (names.length > 0) return `user ${names.join(' · ')}`
    }

    return `user ${typeof content === 'string' ? content.replace(/\s+/g, ' ').trim().slice(0, max) : '（消息）'}`
  }
  if (type === 'result') {
    const text = str(o.result).replace(/\s+/g, ' ').trim()

    return `result ${o.is_error === true ? '失败' : 'ok'}${text === '' ? '' : `：${text.slice(0, max)}`}`
  }
  if (type === 'system') {
    return `system ${str(o.subtype)}`
  }

  return `${type || '事件'} ${raw.replace(/\s+/g, ' ').trim().slice(0, max)}`
}

/** delegate_status 的输出。 */
export const formatStatus = (
  rec: JobRecord | undefined,
  status: JobStatusFile | undefined,
  events: readonly string[],
  result: { ok?: boolean; text?: string; error?: string; sessionId?: string | null } | undefined,
  now: number,
): string => {
  if (rec === undefined && status === undefined) return '没有这条作业。用 delegate_list 看有哪些。'
  const jobId = rec?.jobId ?? status?.jobId ?? '?'
  const live = status?.phase
  const running = rec?.status === 'running'
  const started = status?.startedAt ?? rec?.at
  const last = status?.updatedAt ?? rec?.endedAt
  const lines = [
    `作业 ${jobId}${rec === undefined ? '' : `（${rec.tier} / ${rec.model || '?'} · ${rec.mode} · ${rec.background ? '后台' : '前台'}）`}`,
    rec === undefined
      ? `状态：${live ?? '?'}（没有作业记录，只有落盘状态）`
      : `状态：${statusText(rec.status)}${live === undefined ? '' : `（runner 阶段 ${live}）`}${running && started !== undefined && last !== undefined ? ` · 已跑 ${spanOf(last - started)}` : ''}`,
  ]
  const turns = status?.turns ?? rec?.turns
  if (turns !== undefined) lines.push(`轮数：${turns}`)
  if (status?.lastTool) lines.push(`最后工具：${status.lastTool}`)
  const agent = status?.sessionId ?? rec?.sessionId
  if (agent) lines.push(`agent：${agent}（resume 用这个）`)
  if (rec?.cwd) lines.push(`cwd：${rec.cwd}`)
  // 只在真正生效时显示（read + ptc:'only'）：work 模式或 ptc:'off' 时这些目录不起作用，记下来只为 resume 沿用。
  if (rec?.readPaths !== undefined && rec.readPaths.length > 0 && rec.mode === 'read' && rec.ptc === 'only') {
    lines.push(`额外可读目录：${rec.readPaths.join('、')}`)
  }
  if (started !== undefined) lines.push(`开始：${timeOf(started, now)}（${agoOf(started, now)}）`)
  if (rec?.endedAt !== undefined) lines.push(`结束：${timeOf(rec.endedAt, now)} · 用时 ${spanOf(rec.endedAt - rec.at)}`)
  if (status?.pid !== undefined) lines.push(`进程：runner pid ${status.pid}${status.childPid ? ` · claude pid ${status.childPid}` : ''}`)
  if (rec?.summary) lines.push(`任务：${rec.summary}`)
  const text = (result?.text ?? status?.lastText ?? '').replace(/\s+/g, ' ').trim()
  if (text !== '') lines.push(`最后输出：${text.length > 400 ? `${text.slice(0, 400)}…` : text}`)
  if (result?.error !== undefined && result.error !== '') lines.push(`错误：${result.error}`)
  if (events.length > 0) {
    lines.push('最近事件（旧→新）：')
    for (const e of events) lines.push(`  ${e}`)
  }

  return lines.join('\n')
}

/** 实时面板的一行事件：工具调用、子代理说的话、你的插话、收尾。 */
export type LiveEvent = { kind: 'tool' | 'text' | 'think' | 'you' | 'end'; title: string; detail: string }

/** 面板只要这几类行：先按字面挑出来再 JSON.parse，省掉大量 system 行的解析。 */
const WANTED = ['"type":"assistant"', '"type":"sent"', '"type":"result"']
const wanted = (raw: string): boolean => WANTED.some(w => raw.includes(w))

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()

  return t.length > max ? `${t.slice(0, max)}…` : t
}

// 工具参数里挑最能认出“它在干什么”的那个字段。
const toolDetail = (input: unknown): string => {
  if (!isRecord(input)) return ''
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'code']) {
    const v = input[k]
    if (typeof v === 'string' && v.trim() !== '') {
      return k === 'code' ? oneLine(v.split('\n').find(l => l.trim() !== '' && !l.trim().startsWith('//')) ?? v, 90) : oneLine(v, 90)
    }
  }

  return ''
}

const toolTitle = (name: string): string => name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '')

/** events.jsonl 的若干行 → 面板事件（只要工具调用、文本、插话、结果；思考和工具结果不单列）。 */
export const liveEvents = (lines: readonly string[], max = 14): LiveEvent[] => {
  const out: LiveEvent[] = []
  for (const raw of lines) {
    if (!wanted(raw)) continue
    let o: unknown
    try {
      o = JSON.parse(raw)
    } catch {
      continue
    }
    if (!isRecord(o)) continue
    const type = str(o.type)
    if (type === 'assistant') {
      const content = isRecord(o.message) && Array.isArray(o.message.content) ? o.message.content : []
      for (const b of content) {
        if (!isRecord(b)) continue
        if (b.type === 'tool_use') out.push({ kind: 'tool', title: toolTitle(str(b.name)), detail: toolDetail(b.input) })
        else if (b.type === 'text' && str(b.text).trim() !== '') out.push({ kind: 'text', title: '', detail: oneLine(str(b.text), 160) })
        else if (b.type === 'thinking' && str(b.thinking).trim() !== '') out.push({ kind: 'think', title: '', detail: oneLine(str(b.thinking), 160) })
      }
    } else if (type === 'sent') {
      out.push({ kind: 'you', title: '', detail: oneLine(str(o.text), 160) })
    } else if (type === 'result') {
      out.push({ kind: 'end', title: o.is_error === true ? '结束（出错）' : '本轮结束', detail: oneLine(str(o.result), 160) })
    }
  }

  return out.slice(-max)
}

/** 1234567 → 1.2M，56789 → 57K。 */
export const tokensOf = (n: number | undefined): string => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '–'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`

  return String(n)
}

/** 从事件流算用量：上下文 = 最近一次请求的输入（含缓存），输出 = 各条消息输出之和（同一消息只算一次）。
 *  上游网关只在半成品事件里给 usage，每条 assistant 行的 output_tokens 是 0，所以输出还要看 result 行：
 *  它带着整次运行的真实总数（同一作业目录里更早一次运行留下的 result 不算，取最后一条）。 */
export const usageOf = (lines: readonly string[]): { context: number; output: number } => {
  const seen = new Map<string, number>()
  let context = 0
  let resultOutput = 0
  for (const raw of lines) {
    if (!raw.includes('"type":"assistant"') && !raw.includes('"type":"result"')) continue
    let o: unknown
    try {
      o = JSON.parse(raw)
    } catch {
      continue
    }
    if (!isRecord(o)) continue
    if (o.type === 'result') {
      const u = isRecord(o.usage) ? o.usage : undefined
      const v = typeof u?.output_tokens === 'number' && Number.isFinite(u.output_tokens) ? u.output_tokens : 0
      if (v > 0) resultOutput = v
      continue
    }
    if (o.type !== 'assistant' || !isRecord(o.message) || !isRecord(o.message.usage)) continue
    const u = o.message.usage
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const input = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
    if (input > 0) context = input
    const id = str(o.message.id) || String(seen.size)
    seen.set(id, Math.max(seen.get(id) ?? 0, num(u.output_tokens)))
  }
  let output = 0
  for (const v of seen.values()) output += v

  return { context, output: Math.max(output, resultOutput) }
}
