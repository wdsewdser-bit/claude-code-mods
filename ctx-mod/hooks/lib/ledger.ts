// The task ledger: append-only entries, checked by code, turned into the home
// page a fresh window opens with and paged into the archive when it grows.
// Pure: no disk, no clock, no engine calls — the caller supplies all of that.

import type {
  Anchor,
  Config,
  HistoryRecord,
  LedgerEntry,
  LedgerInput,
  TaskStatus,
} from './types.ts'
import { estimateTokens, toJsonl } from './types.ts'

/** Why an anchor cannot be used: absent, not found, or not unique. */
export type AnchorCheck = 'ok' | 'missing-file' | 'no-match' | 'ambiguous'

export type ValidateContext = {
  entries: readonly LedgerEntry[]
  history: (seq: number) => HistoryRecord | undefined
  latestPersonSeq: number | null
  checkAnchor: (anchor: Anchor) => AnchorCheck
  config: Config
}

const TASK_ID = /^[\w.-]{1,64}$/
const MAX_TITLE_CHARS = 200
const MAX_ANCHORS = 8
const MAX_MATCH_CHARS = 300
const MAX_REQUEST_CHARS = 2_000
const MAX_SUPERSEDED_SHOWN = 5
/** An active task shows at most this many notes from its latest window, within a combined text budget. */
const MAX_WINDOW_NOTES = 3
const WINDOW_NOTES_CHARS = 3_000
/** Open tasks beyond the newest this many are shown as a short summary, so the home page has an upper bound. */
const MAX_FULL_ACTIVE = 5
const SHORT_FIELD_CHARS = 200
const STATUSES: readonly TaskStatus[] = ['in_progress', 'done', 'superseded', 'blocked']

const STATUS_LABEL: Record<TaskStatus, string> = {
  in_progress: '进行中',
  done: '已完成',
  superseded: '已被取代',
  blocked: '受阻',
}

/** The only thing a tool input safely can be: a plain JSON object. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A seq or ts the rest of the code may index with: a finite, whole number. */
const asInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined

const asStatus = (value: unknown): TaskStatus =>
  (STATUSES as readonly string[]).includes(value as string) ? (value as TaskStatus) : 'in_progress'

/** Shows a bad value without ever throwing on it (an object's toString may be garbage). */
const describe = (value: unknown): string => {
  try {
    if (typeof value === 'string') return value
    const text = JSON.stringify(value)

    return text === undefined ? typeof value : text
  } catch {
    return `（${typeof value}）`
  }
}

/**
 * Every problem with one `ledger_append`, in Chinese, one sentence each, so the
 * model can fix them all in one retry: the rules are independent, so nothing
 * here returns after the first failure. The input is whatever the model sent,
 * so every field is re-typed here before it is trusted.
 */
export const validate = (input: LedgerInput, context: ValidateContext): string[] => {
  if (!isRecord(input)) {
    return ['ledger_append 的输入必须是一个对象，至少包含 task_id、title、status、text 四个字段。']
  }
  const raw: Record<string, unknown> = input
  const problems: string[] = []

  const taskId = raw.task_id
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
    problems.push(
      'task_id 只能由字母、数字、下划线、点和短横线组成，长度 1-64 个字符，请改成一个这样的短标识。',
    )
  }

  const title = asText(raw.title).trim()
  if (title === '') {
    problems.push('title 不能为空，请用一句话说明这个任务要做什么。')
  } else if (title.length > MAX_TITLE_CHARS) {
    problems.push(`title 有 ${title.length} 个字符，最多 ${MAX_TITLE_CHARS} 个，请压缩。`)
  }

  const status = raw.status as string
  if (!(STATUSES as readonly string[]).includes(status)) {
    problems.push(
      `status 只能是 in_progress、done、superseded、blocked 之一，收到的是「${describe(raw.status)}」。`,
    )
  }

  if (raw.text === undefined || typeof raw.text !== 'string') {
    problems.push('text 必须是字符串，请用一句话说明这一步的要点。')
  } else if (raw.text.trim() === '') {
    // An empty entry would still count as booked progress while carrying none.
    problems.push('text 不能为空，请用一句话说明这一步的要点。')
  } else if (raw.text.length > context.config.maxTextChars) {
    problems.push(
      `text 有 ${raw.text.length} 个字符，超过上限 ${context.config.maxTextChars}，请拆成多条 ledger_append，这一条只留当前这一步的要点。`,
    )
  }

  if (raw.next_step !== undefined && typeof raw.next_step !== 'string') {
    problems.push('next_step 必须是字符串，请用一句话写下一步做什么；不需要就整个省略。')
  }

  if (status === 'in_progress') {
    const given = raw.next_step
    // An omitted next_step carries over from the task's latest entry, so that one counts as given.
    const earlier = tasksOf(context.entries).find(task => task.taskId === taskId)?.nextStep?.value
    const hasStep = typeof given === 'string' ? given.trim() !== '' : given === undefined && (earlier ?? '').trim() !== ''
    if (!hasStep && (given === undefined || typeof given === 'string')) {
      problems.push('status 是 in_progress，必须写 next_step：换窗口后要接着做的下一步。任务做完了就标 done。')
    }
  }

  if (raw.superseded_by !== undefined && typeof raw.superseded_by !== 'string') {
    problems.push('superseded_by 必须是字符串：取代它的那个 task_id。')
  }

  const refSeq = asInt(raw.request_ref)
  if (raw.request_ref !== undefined && refSeq === undefined) {
    problems.push('request_ref 必须是历史编号（有限整数），请用 history 查一个真实的编号。')
  } else if (refSeq !== undefined) {
    const record = context.history(refSeq)
    if (record === undefined) {
      problems.push(`request_ref #${refSeq} 在历史里不存在，请用 history 查一个真实的历史编号。`)
    } else if (record.isPerson !== true) {
      problems.push(
        `request_ref #${refSeq} 的 role 是 ${record.role}，不是真人请求，请指向用户亲口提的那条消息。`,
      )
    }
  } else if (context.latestPersonSeq === null) {
    problems.push('省略了 request_ref，但本会话到目前还没有真人请求，请显式给出 request_ref。')
  }

  const evidenceGiven = raw.evidence !== undefined
  const evidence = Array.isArray(raw.evidence) ? raw.evidence : []
  if (evidenceGiven && !Array.isArray(raw.evidence)) {
    problems.push('evidence 必须是历史编号的数组，例如 [12, 15]，请把非编号的内容去掉。')
  } else {
    const junk = evidence.filter(item => asInt(item) === undefined)
    if (junk.length > 0) {
      problems.push(
        `evidence 里只能放历史编号（有限整数），有 ${junk.length} 项不是，请把它们去掉。`,
      )
    }
  }

  if (status === 'done') {
    const seqs = evidence.filter((item): item is number => asInt(item) !== undefined)
    if (seqs.length === 0) {
      problems.push('status 是 done，必须给出 evidence：至少一个能证明做完的历史编号。')
    }
    const startTs = taskStartTs(taskId, refSeq, context)
    for (const seq of seqs) {
      const record = context.history(seq)
      if (record === undefined) {
        problems.push(`evidence #${seq} 在历史里不存在，请换成真实的历史编号。`)
      } else if (record.role !== 'tool') {
        problems.push(`evidence #${seq} 的 role 是 ${record.role}，不是 tool，完成的证据要是工具结果。`)
      } else if (record.isError === true) {
        problems.push(`evidence #${seq} 是一次报错的工具结果，不能当作完成的证据，请换成成功的工具结果。`)
      } else if (startTs !== null && record.ts < startTs) {
        problems.push(`evidence #${seq} 的时间早于这个任务的起点，请换成任务开始之后的工具结果。`)
      }
    }
  }

  if (status === 'superseded') {
    const by = asText(raw.superseded_by).trim()
    if (by === '') {
      if (typeof raw.superseded_by === 'string' || raw.superseded_by === undefined) {
        problems.push('status 是 superseded，必须写 superseded_by：取代它的那个 task_id。')
      }
    } else if (by === taskId) {
      problems.push('superseded_by 不能是任务自己，请写真正取代它的另一个 task_id。')
    }
  }

  const rawAnchors = raw.anchors
  if (rawAnchors !== undefined && !Array.isArray(rawAnchors)) {
    problems.push('anchors 必须是数组，每项是一个含 path、match、note 三个字符串字段的对象。')
  } else {
    const anchors: readonly unknown[] = Array.isArray(rawAnchors) ? rawAnchors : []
    if (anchors.length > MAX_ANCHORS) {
      problems.push(`anchors 最多 ${MAX_ANCHORS} 个，收到 ${anchors.length} 个，请删掉不重要的。`)
    }
    anchors.forEach((anchor, index) => {
      const at = index + 1
      if (!isRecord(anchor)) {
        problems.push(`锚点 ${at} 必须是对象，含 path、match、note 三个字符串字段，请改写。`)
        return
      }
      const wrong: string[] = []
      if (typeof anchor.path !== 'string') wrong.push('path')
      if (typeof anchor.match !== 'string') wrong.push('match')
      if (anchor.note !== undefined && typeof anchor.note !== 'string') wrong.push('note')
      if (wrong.length > 0) {
        problems.push(`锚点 ${at} 的 ${wrong.join('、')} 必须是字符串（note 可以省略），请改正。`)
      }

      const path = asText(anchor.path).trim()
      const match = asText(anchor.match).trim()
      if (typeof anchor.path === 'string' && path === '') {
        problems.push(`锚点 ${at} 的 path 不能为空，请给出文件路径。`)
      }
      if (typeof anchor.match === 'string') {
        if (match === '') {
          problems.push(`锚点 ${at} 的 match 不能为空，请给一段在文件里能找到的原文。`)
        } else if (match.length > MAX_MATCH_CHARS) {
          problems.push(`锚点 ${at} 的 match 有 ${match.length} 个字符，最多 ${MAX_MATCH_CHARS} 个，请截短。`)
        }
      }
      if (path === '' || match === '') return

      const check = context.checkAnchor({
        path,
        match,
        note: typeof anchor.note === 'string' ? anchor.note : '',
      })
      if (check === 'missing-file') {
        problems.push(`锚点 ${at} 的文件不存在：${path}，请确认路径，或先用工具读一下再写。`)
      } else if (check === 'no-match') {
        problems.push(`锚点 ${at} 在 ${path} 里找不到 match 这段原文，请换一段确实存在于文件里的原文。`)
      } else if (check === 'ambiguous') {
        problems.push(`锚点 ${at} 的 match 在 ${path} 里出现多次，请换一段能唯一定位的原文。`)
      }
    })
  }

  return problems
}

/** The earliest moment a task could have started: its own first entry, else its request. */
const taskStartTs = (
  taskId: unknown,
  refSeq: number | undefined,
  context: ValidateContext,
): number | null => {
  const first = context.entries.find(entry => entry.task_id === taskId)
  if (first !== undefined) return asInt(first.ts) ?? null

  const seq = refSeq ?? context.latestPersonSeq
  if (seq === null || seq === undefined) return null
  const record = context.history(seq)

  return record === undefined ? null : record.ts
}

/** Keeps exactly the three string fields an anchor is, nothing else. */
const anchorOf = (value: unknown): Anchor | undefined => {
  if (!isRecord(value)) return undefined

  return {
    path: asText(value.path),
    match: asText(value.match),
    note: asText(value.note),
  }
}

const anchorsOf = (value: unknown): Anchor[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const anchors: Anchor[] = []
  for (const item of value) {
    const anchor = anchorOf(item)
    if (anchor !== undefined) anchors.push(anchor)
  }

  return anchors
}

const intsOf = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const ints: number[] = []
  for (const item of value) {
    const int = asInt(item)
    if (int !== undefined) ints.push(int)
  }

  return ints
}

/**
 * Turns a checked input into the row that is stored: seq, time and window come
 * from the caller, and an omitted request_ref falls back to the latest person
 * prompt so every entry points at a real request. Whatever the model sent, only
 * values of the right type are written — a bad field is dropped, not copied on.
 */
export const stamp = (
  input: LedgerInput,
  meta: { seq: number; ts: number; window: number; latestPersonSeq: number | null; through?: number },
): LedgerEntry => {
  const raw: Record<string, unknown> = isRecord(input) ? input : {}
  const entry: LedgerEntry = {
    task_id: asText(raw.task_id),
    title: asText(raw.title),
    status: asStatus(raw.status),
    text: asText(raw.text),
    seq: meta.seq,
    ts: meta.ts,
    window: meta.window,
    request_ref: asInt(raw.request_ref) ?? meta.latestPersonSeq ?? 0,
  }
  if (typeof raw.next_step === 'string') entry.next_step = raw.next_step
  const anchors = anchorsOf(raw.anchors)
  if (anchors !== undefined) entry.anchors = anchors
  const evidence = intsOf(raw.evidence)
  if (evidence !== undefined) entry.evidence = evidence
  if (typeof raw.superseded_by === 'string') entry.superseded_by = raw.superseded_by
  // Lets a later check tell which history rows this entry did not cover.
  if (meta.through !== undefined) entry.through = meta.through

  return entry
}

/** A field's value as the task stands now, and which entry it was written in. */
export type Resolved<T> = { value: T; seq: number; isInherited: boolean }

export type TaskState = {
  taskId: string
  /** The latest entry's title. */
  title: string
  /** The latest entry's status. */
  status: LedgerEntry['status']
  first: LedgerEntry
  latest: LedgerEntry
  entries: LedgerEntry[]
  /** The next step in force: the latest entry's own, else the newest earlier one; absent once cleared or closed. */
  nextStep?: Resolved<string>
  /** The anchors in force, resolved the same way as the next step. */
  anchors?: Resolved<Anchor[]>
}

const isClosedStatus = (status: LedgerEntry['status']): boolean =>
  status === 'done' || status === 'superseded'

/**
 * An omitted field means "unchanged", so it is read from the newest entry that
 * gave one. An empty value is a given value that clears, and ends the search;
 * so does a closed entry, because a finished task has no step left to carry.
 */
const resolveField = <T>(
  entries: readonly LedgerEntry[],
  pick: (entry: LedgerEntry) => T | undefined,
  isEmpty: (value: T) => boolean,
): Resolved<T> | undefined => {
  const last = entries[entries.length - 1]
  if (last === undefined || isClosedStatus(last.status)) return undefined
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const entry = entries[at]
    if (entry === undefined || (at < entries.length - 1 && isClosedStatus(entry.status))) return undefined
    const value = pick(entry)
    if (value === undefined) continue

    return isEmpty(value) ? undefined : { value, seq: entry.seq, isInherited: at < entries.length - 1 }
  }

  return undefined
}

/** Groups entries by task in first-seen order; later entries win as the latest. */
export const tasksOf = (entries: readonly LedgerEntry[]): TaskState[] => {
  const byId = new Map<string, TaskState>()
  for (const entry of entries) {
    const found = byId.get(entry.task_id)
    if (found === undefined) {
      byId.set(entry.task_id, {
        taskId: entry.task_id,
        title: entry.title,
        status: entry.status,
        first: entry,
        latest: entry,
        entries: [entry],
      })
      continue
    }
    found.entries.push(entry)
    found.title = entry.title
    found.status = entry.status
    found.latest = entry
  }

  const tasks = [...byId.values()]
  for (const task of tasks) {
    const nextStep = resolveField(
      task.entries,
      entry => (typeof entry.next_step === 'string' ? entry.next_step : undefined),
      value => value.trim() === '',
    )
    if (nextStep !== undefined) task.nextStep = nextStep
    const anchors = resolveField(
      task.entries,
      entry => (Array.isArray(entry.anchors) ? entry.anchors : undefined),
      value => value.length === 0,
    )
    if (anchors !== undefined) task.anchors = anchors
  }

  return tasks
}

/** Whether this window has booked anything since the latest person prompt. */
export const hasFreshEntry = (
  entries: readonly LedgerEntry[],
  sinceTs: number,
  window: number,
): boolean => entries.some(entry => entry.window === window && entry.ts >= sinceTs)

export type ArchivePage = {
  page: number
  titles: string[]
  fromSeq: number
  toSeq: number
  fromTs: number
  toTs: number
}

const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10)

const clipRequest = (text: string, seq: number): string =>
  text.length > MAX_REQUEST_CHARS
    ? `${text.slice(0, MAX_REQUEST_CHARS)}……（原文更长，用 history 读 #${seq}）`
    : text

/** A request this short ("可以", "重启了") is shown with the reply it answered. */
const SHORT_REQUEST_CHARS = 30
/** How much of that reply is shown: where it opened and where it ended, which is where the ask usually sits. */
const ANSWERED_HEAD_CHARS = 100
const ANSWERED_TAIL_CHARS = 160

const clipAnswered = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length <= ANSWERED_HEAD_CHARS + ANSWERED_TAIL_CHARS
    ? flat
    : `${flat.slice(0, ANSWERED_HEAD_CHARS)} …… ${flat.slice(flat.length - ANSWERED_TAIL_CHARS)}`
}

const clipText = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}……` : text

const newestFirst = (tasks: readonly TaskState[]): TaskState[] =>
  [...tasks].sort(
    (left, right) => right.latest.ts - left.latest.ts || right.latest.seq - left.latest.seq,
  )

const anchorLine = (task: TaskState): string => {
  const by = task.latest.superseded_by

  return typeof by === 'string' && by.trim() !== ''
    ? `- ${task.title}（已由 ${by} 取代）`
    : `- ${task.title}`
}

/**
 * The notes a task left, oldest first. A stage booked as its own entry must not
 * vanish behind the last one, so newest notes are taken until the count or the
 * text budget runs out; the latest window's come first and earlier windows fill
 * what is left, so a window that booked only once still shows the work before it.
 * The latest note always stays, even alone over budget: it is the one the model
 * reads first.
 */
const windowNotesOf = (task: TaskState, entries: readonly LedgerEntry[]): LedgerEntry[] => {
  const newest = entries
    .filter(entry => entry.task_id === task.latest.task_id)
    .sort((left, right) => right.window - left.window || right.seq - left.seq)
  const picked: LedgerEntry[] = []
  let chars = 0
  for (const entry of newest) {
    if (picked.length >= MAX_WINDOW_NOTES) break
    if (picked.length > 0 && chars + entry.text.length > WINDOW_NOTES_CHARS) break
    picked.push(entry)
    chars += entry.text.length
  }

  return picked.reverse()
}

/**
 * The home page a new window opens with: the person's own words first, then what
 * is still open. Sections 1-3 are never dropped, so the request and the open
 * tasks always survive the cap; the rest is trimmed oldest-first.
 */
export const renderHome = (
  input: {
    window: number
    entries: readonly LedgerEntry[]
    requests: readonly HistoryRecord[]
    /** The model's reply each request came after, by the request's seq. */
    answered?: ReadonlyMap<number, HistoryRecord>
    archive: readonly ArchivePage[]
  },
  config: Config,
): string => {
  const tasks = tasksOf(input.entries)
  const active = tasks.filter(task => task.status === 'in_progress' || task.status === 'blocked')
  const doneLines = newestFirst(tasks.filter(task => task.status === 'done')).map(
    task => `- ${task.title}`,
  )
  const archiveLines = input.archive.map(
    page =>
      `- 第 ${page.page} 页：${page.titles.join('、')}（#${page.fromSeq}-${page.toSeq}，${dayOf(page.fromTs)} 至 ${dayOf(page.toTs)}）`,
  )
  const superseded = newestFirst(tasks.filter(task => task.status === 'superseded'))
  const pastCap = Math.max(0, superseded.length - MAX_SUPERSEDED_SHOWN)
  const superLines = superseded.slice(0, MAX_SUPERSEDED_SHOWN).map(anchorLine)

  const head: string[] = []
  head.push(
    input.window === 1
      ? '当前是第 1 个窗口。'
      : `当前是第 ${input.window} 个窗口（上一个是第 ${input.window - 1} 个）。`,
  )
  head.push('', '## 最近的用户请求')
  if (input.requests.length === 0) head.push('无')
  for (const record of input.requests) {
    // Typed while a turn was running: it is about the work then under way, not a turn of its own.
    const midTurn = record.name === 'queued_command' ? '（回合进行中插入）' : ''
    head.push(`- [#${record.seq}] ${new Date(record.ts).toISOString()} ${midTurn}${clipRequest(record.text, record.seq)}`)
    const reply = record.text.length <= SHORT_REQUEST_CHARS ? input.answered?.get(record.seq) : undefined
    if (reply !== undefined) head.push(`  - 回复的是助手 [#${reply.seq}]：${clipAnswered(reply.text)}`)
  }
  head.push('', '## 进行中 / 受阻的任务')
  if (active.length === 0) {
    head.push('无')
  } else {
    // Newest first, so what is dropped to a summary is what was touched longest ago.
    const ordered = newestFirst(active)
    const full = ordered.slice(0, MAX_FULL_ACTIVE)
    const short = ordered.slice(MAX_FULL_ACTIVE)
    for (const task of full) {
      head.push(`- ${task.taskId}：${task.title}（${STATUS_LABEL[task.status]}）`)
      const notes = windowNotesOf(task, input.entries)
      const hasOlderWindow = notes.some(note => note.window !== task.latest.window)
      if (notes.length <= 1) {
        head.push(`  - 最新：${task.latest.text}`)
      } else {
        head.push(
          hasOlderWindow
            ? `  - 记录（最近 ${notes.length} 条，旧→新；标了窗口号的是更早的窗口写的）：`
            : `  - 记录（同一窗口写的 ${notes.length} 条，旧→新）：`,
        )
        for (const note of notes) {
          const from = note.window === task.latest.window ? '' : `（第 ${note.window} 个窗口）`
          head.push(`    - #L${note.seq}${from}：${note.text}`)
        }
      }
      const next = task.nextStep
      if (next !== undefined) {
        head.push(
          next.isInherited
            ? `  - 下一步（沿用 #L${next.seq} 的记录，可能已过时）：${next.value}`
            : `  - 下一步：${next.value}`,
        )
      }
    }
    for (const task of short) {
      head.push(`- ${task.taskId}：${task.title}（${STATUS_LABEL[task.status]}）`)
      head.push(`  - 最新 #L${task.latest.seq}：${clipText(task.latest.text, SHORT_FIELD_CHARS)}`)
      const next = task.nextStep
      if (next !== undefined) {
        const value = clipText(next.value, SHORT_FIELD_CHARS)
        head.push(
          next.isInherited
            ? `  - 下一步（沿用 #L${next.seq} 的记录，可能已过时）：${value}`
            : `  - 下一步：${value}`,
        )
      }
    }
    if (short.length > 0) {
      head.push(`（还有 ${short.length} 个较早更新的任务只显示了摘要，完整记录用 ledger_read 按 task_id 查）`)
    }
  }

  let trimmed = 0
  const build = (): string => {
    const lines = [...head]
    if (superLines.length > 0) lines.push('', '## 不要继续这些（已被取代）', ...superLines)
    if (doneLines.length > 0) lines.push('', '## 已完成', ...doneLines)
    if (archiveLines.length > 0) lines.push('', '## 归档目录', ...archiveLines)
    const omitted = trimmed + pastCap
    if (omitted > 0) lines.push('', `（已省略 ${omitted} 条，用 ledger_read 查看）`)

    return lines.join('\n')
  }

  let text = build()
  while (
    estimateTokens(text) > config.homeTokens &&
    doneLines.length + archiveLines.length + superLines.length > 0
  ) {
    if (doneLines.length > 0) doneLines.pop()
    else if (archiveLines.length > 0) archiveLines.shift()
    else superLines.pop()
    trimmed += 1
    text = build()
  }

  return text
}

/** A done task counts as closed only once its evidence was actually recorded. */
const isClosed = (task: TaskState): boolean => {
  if (task.status === 'superseded') return true
  if (task.status !== 'done') return false
  const evidence = task.latest.evidence

  return Array.isArray(evidence) && evidence.length > 0
}

/**
 * Pages the ledger over: when the current page would be too long to read back,
 * every closed task's rows move to this page's archive untouched, unless the
 * task is one the caller still wants in the window.
 */
export const turnPage = (
  entries: readonly LedgerEntry[],
  protectedTaskIds: ReadonlySet<string>,
  config: Config,
): { keep: LedgerEntry[]; moved: LedgerEntry[] } => {
  if (estimateTokens(toJsonl(entries)) <= config.pageTokens) {
    return { keep: [...entries], moved: [] }
  }

  const movable = new Set<string>()
  for (const task of tasksOf(entries)) {
    if (protectedTaskIds.has(task.taskId)) continue
    if (isClosed(task)) movable.add(task.taskId)
  }

  const keep: LedgerEntry[] = []
  const moved: LedgerEntry[] = []
  for (const entry of entries) {
    if (movable.has(entry.task_id)) moved.push(entry)
    else keep.push(entry)
  }

  return { keep, moved }
}

/** The one-line index entry an archived page leaves behind. */
export const pageOf = (page: number, moved: readonly LedgerEntry[]): ArchivePage => {
  if (moved.length === 0) {
    return { page, titles: [], fromSeq: 0, toSeq: 0, fromTs: 0, toTs: 0 }
  }

  const titles: string[] = []
  for (const task of tasksOf(moved)) {
    if (!titles.includes(task.title)) titles.push(task.title)
  }

  const first = moved[0] as LedgerEntry
  const last = moved[moved.length - 1] as LedgerEntry
  let fromTs = first.ts
  let toTs = first.ts
  for (const entry of moved) {
    if (entry.ts < fromTs) fromTs = entry.ts
    if (entry.ts > toTs) toTs = entry.ts
  }

  return { page, titles, fromSeq: first.seq, toSeq: last.seq, fromTs, toTs }
}

/** The archive file of one page: archive-001.jsonl, zero-padded to three. */
export const archiveName = (page: number): string =>
  `archive-${String(page).padStart(3, '0')}.jsonl`
