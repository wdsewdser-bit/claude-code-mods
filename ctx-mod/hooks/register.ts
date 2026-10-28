// The engine wiring: the hooks of ctx-mod. Everything that decides anything
// lives under `lib/`; this file only observes the engine, hands the events to a
// Session and answers. Phase 0's probe is kept under phase0/ as text: an event
// takes one unmatched hook per module, so the two cannot be loaded together.

import type { CommandRunResult, EngineInterface, Register, SessionCompactResult, SessionMessage } from 'claude-code'

import { formatArgs, isBackgroundRow, nonTextNote } from './lib/history.ts'
import { cwdSlug, pickPastedImages } from './lib/images.ts'
import { createSession, isHandoffText, looksLikePerson, stripInjected } from './lib/session.ts'
import type { AgentNote, Env, HeldAttachment, ImportedMessage, Io, Session } from './lib/session.ts'
import { describeFill, isCold, limitOf, shouldContinue } from './lib/usage.ts'
import type { LedgerSnapshot } from './lib/types.ts'
import { DEFAULTS, OWN_TOOL_PREFIX } from './lib/types.ts'

/** The section of the system prompt, the same all session long. */
const SYSTEM_TEXT =
  '这个会话可能跨多个上下文窗口。你有一个任务账本（mcp__ctx-mod__ledger_append、mcp__ctx-mod__ledger_read）和完整历史（mcp__ctx-mod__history）。工具结果末尾形如 [#123] 的是历史编号。每完成一个阶段，就追加一条账本记录：用 task_id 标识任务，status 填 in_progress / done / superseded / blocked。标 done 时必须在 evidence 里附上证明它的工具结果的历史编号。用户提出新请求时，如果它取代了旧任务，就把旧任务标为 superseded。用户改主意、或后面的话推翻了先前的决定时，用 decision_revoke 撤销旧条（用户说明了改成什么，就用 by 指向那条新消息）。对还没做完的任务，写明 next_step，并用 anchors 记下接下来要改的位置：文件路径，加一小段能在文件里唯一定位的原文。收到收尾或交接通知时，先更新账本。上下文用量可以用 mcp__ctx-mod__context 查看；它提示可以换窗口时，先记账再调用它的 new。申请换窗口之前，先用 ledger_append 把进行中任务的进度写清楚，text 里写明后面要用到的关键事实（产物路径、已确认的结论、约定的参数），有子代理在跑时写明各自的 id、负责什么、产物放哪。改法已经确定的改动不要留给新窗口：和 new 放在同一条消息里并发做完；只有还需要判断的才写进 anchors。'

/** Submitted after a switch the model itself asked for, so the new window carries on. */
const CONTINUE_TEXT = 'ctx-mod：已换到新的上下文窗口。先用一句话复述当前请求和进度，然后继续。'

const COMMAND = 'ctx-mod'
const PREFIX = OWN_TOOL_PREFIX
const KEEPER_CACHE = { plugin: 'cache-keeper', key: 'cache' } as const
/** cache-keeper's last keepalive's answer: what was still open when the cache went cold. */
const KEEPER_SNAPSHOT = { plugin: 'cache-keeper', key: 'snapshot' } as const

/** How many main-thread tool calls are kept, to name a result's tool and input. */
const CALLS_KEPT = 200

/** A content block, structurally the engine's ApiContentBlock (which `claude-code` does not export). */
type Block = { type: string; [field: string]: unknown }

/** Whether the module acts at all: `CTX_MOD=1`, read at `session.start`. */
let enabled = false

/**
 * Why a window switch is under way, while one is: `'model'` (the model asked),
 * `'cold'` (a cold-cache prompt was held back), `'manual-switch'` (a person ran
 * `/ctx-mod switch`), null (a person's own compaction).
 */
let switchReason: string | null = null
/** Set by `session.compact` when this mod answered a compaction, so `turn.complete` sees it. */
let committed = false
/** Whether a held-prompt switch is under way: later prompts queue behind it instead of starting another. */
let isHoldingFlow = false
/** The next main-thread request is the first of a new window: note its prefix. */
let awaitingPrefix = false
// The main-loop step last counted as a request, so the same step seen twice counts once.
let lastStep: { turnId: string; index: number } | null = null

/** One Session per session id, over the files under that session's own directory. */
const sessions = new Map<string, Session>()
/** The compaction limit per session, computed once; a key present means it was asked for. */
const limits = new Map<string, number | undefined>()
/** The main thread's recent tool calls, by tool_use_id, to name a result's tool and input. */
// Prompts a person submitted and the conversation has not stored yet. The row
// the engine then appends does not always say who sent it (a headless
// session's own prompt arrives there as `unclassified`), so the submission,
// which does, is matched to its row by text.
const personTexts: string[] = []
// The last background row filed per door/name, so an unchanged repeat in the same window is not filed again.
const lastBackground = new Map<string, { window: number; text: string }>()
// An automatic compaction overtook a switch the model had been granted: the
// window is switched already, and the turn's end still owes the prompt to go on.
let continueAfterTurn = false
const calls = new Map<string, { tool: string; input: Record<string, unknown> }>()

const messageOf = (problem: unknown): string =>
  problem instanceof Error ? problem.message : String(problem)

const attempt = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await run()
  } catch {
    return fallback
  }
}

/** A failing hook logs and then walks the engine's own path, never the model's. */
const logError = ($: EngineInterface, where: string, problem: unknown): void => {
  try {
    $.ui.log(`ctx-mod: ${where}: ${messageOf(problem)}`, { to: 'debug' })
  } catch {
    // A log that fails must not become the failure.
  }
}

const idOf = async ($: EngineInterface): Promise<string | undefined> =>
  attempt(async () => await $.session.id(), undefined)

/** The longest input summary one history row carries, in characters. */
const MAX_BRIEF_CHARS = 300

/** How much of a SendMessage body a summary falls back to. */
const MESSAGE_HEAD = 120

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * A one-line summary of what a tool call was asked to do, so a later window can
 * find the call by its command or pattern instead of running the same probe
 * again. Only the tools whose result text never spells the call out are covered:
 * Read, Edit and Write already carry their path on the row.
 */
export const briefOf = (tool: string, input: Readonly<Record<string, unknown>>): string | undefined => {
  const str = (key: string): string | undefined => {
    const value = input[key]

    return typeof value === 'string' ? value : undefined
  }
  const clip = (text: string): string => {
    const flat = oneLine(text)

    return flat.length > MAX_BRIEF_CHARS ? flat.slice(0, MAX_BRIEF_CHARS) : flat
  }

  switch (tool) {
    case 'Bash':
    case 'PowerShell': {
      const command = str('command')

      return command === undefined ? undefined : clip(command)
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str('pattern')
      if (pattern === undefined) return undefined
      const path = str('path')

      return clip(path === undefined ? pattern : `${pattern} in ${path}`)
    }
    case 'Agent': {
      const type = str('subagent_type')
      const description = str('description')
      if (type === undefined || description === undefined) return undefined

      return clip(`${type}: ${description}`)
    }
    case 'SendMessage': {
      const to = str('to')
      if (to === undefined) return undefined
      const body = str('summary') ?? str('message')

      return clip(body === undefined ? `to ${to}` : `to ${to}: ${body.slice(0, MESSAGE_HEAD)}`)
    }
    case 'ToolSearch':
    case 'WebSearch': {
      const query = str('query')

      return query === undefined ? undefined : clip(query)
    }
    case 'WebFetch': {
      const url = str('url')

      return url === undefined ? undefined : clip(url)
    }
    default:
      return undefined
  }
}

/**
 * The session's live agents as the handoff lists them. A listing that throws is
 * an empty one: a handoff without the subagents still beats no handoff at all.
 */
const agentsOf = async ($: EngineInterface): Promise<AgentNote[]> =>
  attempt(
    async () =>
      (await $.agent.list()).map(info => ({
        id: info.id,
        type: info.type,
        description: info.description,
        state: info.status,
      })),
    [],
  )

/** A tool use's arguments as a plain record, whatever shape the engine stored. */
const argsOfUse = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** One engine row as the lib's own shape; the tool name is `tool` there, not `name`. */
const importedOf = (message: SessionMessage): ImportedMessage => ({
  role: message.role,
  text: message.text,
  toolUses: message.toolUses.map(use => {
    const brief = briefOf(use.tool, argsOfUse(use.input))
    const args = formatArgs(argsOfUse(use.input))

    return {
      tool: use.tool,
      input: use.input,
      ...(typeof use.tool_use_id === 'string' && use.tool_use_id !== '' ? { callId: use.tool_use_id } : {}),
      ...(args === '' ? {} : { args }),
      ...(brief === undefined ? {} : { brief }),
      ...(use.text === undefined ? {} : { text: use.text }),
      ...(use.isError === true ? { isError: true as const } : {}),
    }
  }),
})

/**
 * Copies the conversation the engine already holds into a session the mod is
 * seeing for the first time: without it a session that predates the mod has
 * nothing on disk to hand over.
 */
const importOldConversation = async ($: EngineInterface, session: Session): Promise<void> => {
  try {
    const imported = await session.importMessages((await $.session.messages()).map(importedOf))
    if (imported > 0) $.ui.log(`ctx-mod: 补录了 ${imported} 条引擎对话里还没记录的行`, { to: 'debug' })
  } catch (error) {
    logError($, 'session.start messages', error)
  }
}

/** The most characters of a held message a notice quotes. */
const MAX_NOTICE_CHARS = 20_000

/** How the person is told a held message never entered: the lead line, then their own words. */
const unsentNotice = (lead: string, text: string): string =>
  text.length <= MAX_NOTICE_CHARS
    ? `${lead}${text}`
    : `${lead}${text.slice(0, MAX_NOTICE_CHARS)}（后面还有 ${text.length - MAX_NOTICE_CHARS} 个字符没有显示）`

const RESUBMIT_LEAD = 'ctx-mod：换窗口后没能重新提交你的消息，请重发：'
const LEFTOVER_LEAD = 'ctx-mod：上次换窗口时扣下的一条消息没有送达，请重发：'

/** How an attachment kind reads in a sentence; anything the engine adds stays as it spells it. */
const ATTACHMENT_NAMES: Readonly<Record<string, string>> = {
  image: '图片',
  audio: '音频',
  document: '文档',
}

/** What the person is told once a held message's text has gone in without its attachments. */
const lostAttachmentsNotice = (count: number): string =>
  `ctx-mod：这条消息带了 ${count} 个图片/附件，换窗后只补发了文字，请重新粘贴附件`

/**
 * What the person is told after the re-submission: images handed over by path
 * need no re-pasting, anything else does.
 */
const attachmentNotice = (item: {
  images: readonly string[]
  attachments: readonly HeldAttachment[]
}): string => {
  const images = item.images.length
  if (images === 0) return lostAttachmentsNotice(item.attachments.length)
  const rest = item.attachments.filter(
    attachment => !(images > 0 && attachment.type === 'image'),
  ).length

  return rest === 0
    ? `ctx-mod：图片已按路径转交（${images} 张），不用重新粘贴`
    : `ctx-mod：图片已按路径转交（${images} 张），另有 ${rest} 个附件无法保留，请重新粘贴附件`
}

/**
 * What the model reads under such a message: the attachments are gone, and
 * guessing at them is worse than waiting for the person to send them again.
 */
const lostAttachmentsNote = (attachments: readonly HeldAttachment[]): string => {
  const kinds = [...new Set(attachments.map(item => ATTACHMENT_NAMES[item.type] ?? item.type))].join('、')

  return `（附件提示：这条消息原本带了 ${attachments.length} 个附件（${kinds}），换窗口时无法保留，只补发了文字。请不要猜测附件里是什么，等用户重新粘贴。）`
}

/** Puts a system line in the conversation; false when it could not be shown. */
const tellPerson = async ($: EngineInterface, text: string): Promise<boolean> => {
  try {
    const stored = await $.session.append({
      message: { type: 'system', content: [{ type: 'text', text }] },
    })

    return stored.deny === undefined
  } catch (error) {
    logError($, 'prompt.submit notice', error)

    return false
  }
}

/**
 * Messages a earlier run held back and never got to submit again (a reload cancelled the
 * timer, or the process ended): told to the person, not re-sent, since how long ago they
 * were typed is unknown.
 */
const announceLeftovers = async ($: EngineInterface, session: Session): Promise<void> => {
  try {
    for (const item of session.heldItems()) {
      if (!(await tellPerson($, unsentNotice(LEFTOVER_LEAD, item.text)))) break
      await session.release(item.id)
    }
  } catch (error) {
    logError($, 'session.start held', error)
  }
}

/**
 * Submits the held messages again as the person's own, oldest first, until none is left (ones
 * held during the switch are in the same run). A message that did not enter is shown to the
 * person; when even that fails it stays on disk and the run stops, so it is not retried forever.
 */
const deliverHeld = async ($: EngineInterface, session: Session): Promise<void> => {
  for (;;) {
    const item = session.heldItems()[0]
    if (item === undefined) return
    // The engine hands over an attachment's kind, never its bytes. The images Claude
    // saved are handed over by path; anything else is gone, and both sides are told so.
    const notes: string[] = []
    if (item.images.length > 0) {
      notes.push(`（用户原消息附了图片，已保存在：${item.images.join('、')}，请用 Read 查看。）`)
    }
    const lost = item.attachments.filter(
      attachment => !(item.images.length > 0 && attachment.type === 'image'),
    )
    if (lost.length > 0) notes.push(lostAttachmentsNote(lost))
    const text = notes.length === 0 ? item.text : `${item.text}\n\n${notes.join('\n')}`
    let isDelivered = false
    try {
      const entered = await $.prompt.submit({ text, asUser: true })
      isDelivered = !(typeof entered === 'object' && entered !== null && 'drop' in entered)
      if (!isDelivered) logError($, 'prompt.submit resubmit', 'the re-submitted prompt was dropped')
    } catch (error) {
      logError($, 'prompt.submit resubmit', error)
    }
    // The person's words are gone unless the session says so.
    if (!isDelivered && !(await tellPerson($, unsentNotice(RESUBMIT_LEAD, item.text)))) return
    if (isDelivered && notes.length > 0) await tellPerson($, attachmentNotice(item))
    await session.release(item.id)
  }
}

/** The one session of this conversation, opened on first use. */
const sessionOf = async ($: EngineInterface): Promise<Session | undefined> => {
  const id = await idOf($)
  if (id === undefined) return undefined
  const held = sessions.get(id)
  if (held !== undefined) {
    await held.ready().catch(() => undefined)

    return held
  }

  const profile = await attempt(async () => await $.env.get('USERPROFILE'), undefined)
  const raw =
    typeof profile === 'string' && profile !== ''
      ? profile
      : await attempt(async () => await $.env.get('HOME'), undefined)
  const home = typeof raw === 'string' ? raw.replace(/[\\/]+$/, '') : ''
  // `$.fs` does not expand `~`: the data directory is built from the home path.
  const dir = home === '' ? `.claude/ctx-mod/${id}` : `${home}/.claude/ctx-mod/${id}`
  const io: Io = {
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    cwd: () => $.session.cwd(),
    now: () => Date.now(),
    // The names in a directory, for the cross-session measures: each session's own file is one of them.
    list: async path => (await $.fs.list(path)).filter(entry => entry.kind === 'file').map(entry => entry.name),
    onWriteError: (path, error) => logError($, `write ${path}`, error),
  }
  const session = createSession(dir, io, DEFAULTS)
  sessions.set(id, session)
  // The window, the ledger's freshness and the pending switch are read
  // synchronously: nobody gets the session before its state is off the disk.
  await session.ready().catch(() => undefined)
  // Only a session that has just been opened can be behind: a cached one has
  // seen every row through `session.append` already.
  await importOldConversation($, session)
  // Only on opening: a cached session's held messages belong to a switch still running.
  await announceLeftovers($, session)

  return session
}

/** The compaction threshold the engine reports, computed once per session. */
const limitFor = async ($: EngineInterface, id: string): Promise<number | undefined> => {
  if (!limits.has(id)) {
    limits.set(
      id,
      await attempt(async () => {
        const usage = await $.session.usage({ breakdown: 'summary' })

        return limitOf(usage.context.breakdown?.autoCompactThreshold, DEFAULTS)
      }, undefined),
    )
  }

  return limits.get(id)
}

/** The figures a decision reads, each one degrading to nothing rather than throwing. */
const envOf = async ($: EngineInterface, id: string): Promise<Env> => {
  const tokens = await attempt(async () => (await $.session.usage()).context.tokens, undefined)
  const fiveHourPercent = await attempt(
    async () => (await $.session.usage()).rateLimits.find(limit => limit.kind === 'five_hour')?.percentUsed,
    undefined,
  )
  const cache = await attempt(
    async () => (await $.state.get(KEEPER_CACHE)).value ?? null,
    null,
  )

  return {
    tokens,
    limit: (await limitFor($, id)) ?? limitOf(undefined, DEFAULTS),
    cache,
    fiveHourPercent,
  }
}


/**
 * cache-keeper's snapshot of the tasks still open, as that mod publishes it; none
 * when the mod is not loaded or its last keepalive read no array out of the answer.
 */
const snapshotOf = async ($: EngineInterface): Promise<LedgerSnapshot | null> =>
  attempt(async () => (await $.state.get(KEEPER_SNAPSHOT)).value ?? null, null)

/**
 * The temp tree Claude writes pasted images into: one directory per working
 * directory, then one per session, then `images/<n>.<ext>`.
 */
const envPath = (value: string | undefined): string | undefined =>
  typeof value === 'string' && value !== ''
    ? value.replaceAll('\\', '/').replace(/\/+$/, '')
    : undefined

const tempRoot = async ($: EngineInterface): Promise<string | undefined> => {
  const temp = envPath(await attempt(async () => await $.env.get('TEMP'), undefined))
  if (temp !== undefined) return temp
  const local = envPath(await attempt(async () => await $.env.get('LOCALAPPDATA'), undefined))

  return local === undefined ? undefined : `${local}/Temp`
}

/** A directory's entries, or none when it is not there or cannot be listed. */
const entriesAt = async (
  $: EngineInterface,
  path: string,
): Promise<{ name: string; kind: string; mtimeMs: number }[] | undefined> =>
  attempt(async () => await $.fs.list(path), undefined)

/**
 * This session's `images` directory, by the path its slug implies or, when that
 * one is not there, by looking through the temp root for the session's own.
 */
const pastedImageDir = async (
  $: EngineInterface,
  cwd: string | undefined,
  id: string,
): Promise<string | undefined> => {
  if (cwd === undefined || cwd === '') return undefined
  const temp = await tempRoot($)
  if (temp === undefined) return undefined
  const root = `${temp}/claude`
  const direct = `${root}/${cwdSlug(cwd)}/${id}/images`
  if ((await entriesAt($, direct)) !== undefined) return direct
  // The slug is this build's convention, not a promise: any directory under the
  // temp root holding this session's images is the right one.
  for (const entry of (await entriesAt($, root)) ?? []) {
    const candidate = `${root}/${entry.name}/${id}/images`
    if ((await entriesAt($, candidate)) !== undefined) return candidate
  }

  return undefined
}

/**
 * The paths of the images Claude saved for a submission: only when it saved as
 * many as the submission attached, all written just now. Empty means the new
 * window cannot be pointed at them, and the person is asked to paste again.
 */
const pastedImages = async (
  $: EngineInterface,
  attachments: readonly HeldAttachment[],
  id: string,
): Promise<string[]> => {
  const count = attachments.filter(item => item.type === 'image').length
  if (count === 0) return []
  try {
    // Awaited: the engine answers it directly, a test harness may answer a promise.
    const cwd: string | undefined = await attempt(async () => await $.session.cwd(), undefined)
    const dir = await pastedImageDir($, cwd, id)
    if (dir === undefined) return []
    const entries = await entriesAt($, dir)

    return pickPastedImages(entries ?? [], count, Date.now()).map(name => `${dir}/${name}`)
  } catch (error) {
    logError($, 'prompt.submit images', error)

    return []
  }
}

/**
 * Books cache-keeper's snapshot of the still-open tasks before a cold switch,
 * so the handoff that replaces the history carries them. Whatever goes wrong
 * here is logged and the switch goes on: the ledger is a help, not a gate.
 */
const bookSnapshot = async ($: EngineInterface, session: Session): Promise<void> => {
  try {
    const snapshot = await snapshotOf($)
    if (snapshot === null) return
    const id = await idOf($)
    if (id === undefined) return
    const booked = await session.ledgerSnapshot(snapshot, await envOf($, id))
    if (booked > 0) $.ui.log(`ctx-mod: 保活快照记账 ${booked} 条`, { to: 'debug' })
  } catch (error) {
    logError($, 'cold switch snapshot', error)
  }
}

/** A person's own prompt: typed, bridged or an SDK host's, never a notification. */
// A tool call's arguments ride on `e` beside the engine's own keys: an argument
// named like one of those would be read as the envelope's, so they are taken off.
const ENVELOPE = ['tool', 'tool_use_id', 'consent', 'agentId', 'agent', 'requestMeta'] as const
const argsOf = (e: unknown): Readonly<Record<string, unknown>> => {
  const args: Record<string, unknown> = { ...(e as Record<string, unknown>) }
  for (const key of ENVELOPE) delete args[key]

  return args
}

const isPersonOrigin = (origin: { kind: string }): boolean =>
  origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'

/** A prompt this mod itself re-submitted as the person's own words. */
const isOurUser = (origin: { kind: string }): boolean => {
  const plugin = origin as { kind: string; name?: unknown; asUser?: unknown }

  return plugin.kind === 'plugin' && plugin.name === COMMAND && plugin.asUser === true
}

const textOf = (content: readonly Block[]): string =>
  content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => String(block.text))
    .join('')

/** A tool_result block's text: the string itself, or its text blocks joined. */
const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'object' && part !== null && typeof (part as Block).text === 'string') {
      parts.push(String((part as Block).text))
    }
  }

  return parts.join('')
}

/**
 * The tools a ToolSearch result loaded: each tool_reference part names one. A part
 * whose name is not a string is skipped rather than guessed at.
 */
const toolReferencesOf = (content: unknown): string[] => {
  if (!Array.isArray(content)) return []
  const names: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const ref = part as { type?: unknown; tool_name?: unknown }
    if (ref.type === 'tool_reference' && typeof ref.tool_name === 'string') names.push(ref.tool_name)
  }

  return names
}

const firstString = (
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    if (typeof input[key] === 'string') return input[key] as string
  }

  return undefined
}

/** The last 200 calls, so a result can name the tool and input it answers. */
const remember = (id: string, tool: string, input: Record<string, unknown>): void => {
  calls.set(id, { tool, input })
  while (calls.size > CALLS_KEPT) {
    const oldest = calls.keys().next()
    if (oldest.done === true) break
    calls.delete(oldest.value)
  }
}

/**
 * A `tool.call` matcher for one of this mod's own tools. The engine's tool-name
 * union is built from the tools connected when the types were generated, so a
 * name this mod registers itself does not appear there: the cast is the fix.
 */
const toolMatcher = (name: string): { tool: never } => ({ tool: name as never })

/** Refused on every one of this mod's tools: only the main conversation may call them. */
const AGENT_ONLY = { result: '这个工具只能由主会话调用。', isError: true as const }

/**
 * `/ctx-mod switch`: a window change a person asked for, with no model in the
 * loop. The compaction is asked for on a timer, as a held cold-cache prompt
 * asks for one, because a command hook may not run a command itself; nothing is
 * submitted after the switch, so the next thing the window carries is whatever
 * the person types.
 */
const manualSwitch = ($: EngineInterface, session: Session): CommandRunResult => {
  // A session a coordinator started has work to hand over before any person has spoken in it.
  if (session.latestPersonSeq() === null && session.latestRelaySeq() === null) {
    return { text: 'ctx-mod：还没有可交接的内容，不换窗口。' }
  }
  $.clock.after(300, () => {
    void (async () => {
      switchReason = 'manual-switch'
      try {
        await $.command.run({ command: 'compact' })
      } catch (error) {
        logError($, 'command.run switch', error)
        try {
          await $.session.append({
            message: {
              type: 'system',
              content: [{ type: 'text', text: 'ctx-mod：换窗口没有成功，上下文保持原样。' }],
            },
          })
        } catch (notice) {
          logError($, 'command.run notice', notice)
        }
      } finally {
        switchReason = null
      }
    })()
  })

  return { text: 'ctx-mod：正在换到新窗口（不调用模型）。' }
}

/**
 * Whether the call comes from a subagent. Read off the event itself: `argsOf`
 * takes the envelope's keys — `agentId` among them — off the arguments.
 */
const isSubagentCall = (e: unknown): boolean => (e as { agentId?: unknown }).agentId !== undefined

const TOOLS = [
  {
    name: 'context',
    description:
      '查看上下文用量，或申请换到新的上下文窗口。action 为 "new" 时申请换窗口；改法已经完全确定的改动，和 new 放在同一条消息里并发调用（如 ptc），让程序打印一行成败摘要，这些调用照常执行，摘要会完整带进交接；引擎批准后必须立即结束本回合，不要再发起新的工具调用。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'new'],
          description: '要做的事：status（默认）只报告用量；new 申请换窗口。',
        },
        reason: { type: 'string', description: '申请换窗口的原因（可选）。' },
        expect_more_work: {
          type: 'boolean',
          description: '换窗口后是否还有更多工作（可选，默认 true）。',
        },
      },
    },
  },
  {
    name: 'ledger_append',
    description:
      '向任务账本追加一条记录。每完成一个阶段就写一条：task_id 标识任务，status 取 in_progress / done / superseded / blocked，text 用一句话说明这一步（不能为空）。标 done 时必须在 evidence 里给出证明它的工具结果历史编号。对 in_progress 的任务必须写 next_step，并用 anchors 记下接下来要改的位置。next_step 和 anchors 省略表示沿用上一条（交接里会标明沿用自哪条），传空字符串或空数组表示清空。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务标识；同一个任务的多条记录用同一个 id。' },
        title: { type: 'string', description: '任务的一句话标题。' },
        status: {
          type: 'string',
          enum: ['in_progress', 'done', 'superseded', 'blocked'],
          description: '任务状态。',
        },
        text: { type: 'string', description: '这一步的要点，一句话。' },
        next_step: { type: 'string', description: '下一步要做什么（任务未完成时填写）。' },
        anchors: {
          type: 'array',
          description: '接下来要改的位置列表。',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径。' },
              match: { type: 'string', description: '文件里能唯一定位的一小段原文。' },
              note: { type: 'string', description: '这个位置的说明。' },
            },
            required: ['path', 'match', 'note'],
          },
        },
        evidence: {
          type: 'array',
          items: { type: 'number' },
          description: '证明 done 的工具结果历史编号（形如 [#123] 里的数字）。',
        },
        superseded_by: { type: 'string', description: '取代它的任务 id（status 为 superseded 时填写）。' },
        request_ref: {
          type: 'number',
          description:
            '这条记录回应的请求的历史编号：用户亲口提的那条消息，或派发这个任务的那条转交（协调者、定时任务）。省略时用这两类里最近的一条，回执会写明对应到了哪一条。',
        },
      },
      required: ['task_id', 'title', 'status', 'text'],
    },
  },
  {
    name: 'decision_revoke',
    description:
      '撤销一条用户已定决策：seq 填交接「用户已定决策」里 [#123] 的数字。用户改主意、或后面的话推翻了先前那条时调用；被撤销的那条不再出现在新窗口的交接里，history 仍可查到原文。如果用户说明了改成什么，用 by 指向那条新消息的历史编号，交接里就记为被它取代。',
    inputSchema: {
      type: 'object',
      properties: {
        seq: { type: 'number', description: '要撤销的那条决策所在消息的历史编号。' },
        by: { type: 'number', description: '取代它的那条消息的历史编号（可选）。' },
        reason: { type: 'string', description: '为什么撤销（可选，一句话）。' },
      },
      required: ['seq'],
    },
  },
  {
    name: 'ledger_read',
    description:
      '读取任务账本。view 可以是 home（默认，首页概览）、current（当前窗口的全部条目）或 archive:N（第 N 页归档）；给了 query 就在全部条目里搜索。命中超过 3 条时按新到旧每条只列一行索引（#L编号 · task_id · 状态 · 标题 · 正文前 60 字），不再逐条给全文；query 填精确的 task_id 返回该任务全部条目全文，填 #L337 或 L337 只返回那一条。limit 限制返回条数（默认 20，范围 1-100）。',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', description: 'home、current 或 archive:N，默认 home。' },
        query: {
          type: 'string',
          description: '在 task_id、标题、正文和下一步里搜索的词；也可以填精确的 task_id 或 #L编号 直接看全文。',
        },
        limit: {
          type: 'number',
          description: 'query 最多返回多少条（默认 20，范围 1-100）；view 视图不受影响。',
        },
      },
    },
  },
  {
    name: 'history',
    description:
      '检索或读取完整历史。action 为 "search" 时按条件查历史编号，为 "read" 时按编号读原文。工具结果末尾形的 [#123] 就是历史编号。读原文时 field 填 "input" 可以看到那次工具调用的完整参数（子代理的任务原文、发出的消息、完整的命令）。搜索默认不显示引擎自己塞进来的背景信息（附件、钩子上下文、备注）；要找它们就用 door 指定，如 "attachment"、"hook-context"、"note"。搜索不指定 window 时默认搜最近 3 个窗口；这几个窗口里没有命中会自动往更早的窗口找，找到有命中的窗口就停，结果末尾会写明实际搜了哪些窗口，没搜的窗口用 window 指定。命中只存在于被截断字段的原文时，结果会标出 [overflow text offset=N]（调用参数则标为 input），用 read 的 offset 从那里读全文。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'read'], description: 'search 或 read。' },
        query: { type: 'string', description: '搜索的词（search）。' },
        window: { type: 'number', description: '只看某个窗口（search）。' },
        role: { type: 'string', enum: ['user', 'assistant', 'tool'], description: '只看某种角色（search）。' },
        tool_name: { type: 'string', description: '只看某个工具的结果，填工具名如 Read（search）。' },
        path: { type: 'string', description: '只看某个文件（search）。' },
        door: {
          type: 'string',
          description: '只看从某个入口进来的行，如 delivery、attachment、hook-context、note、compaction、command；给了它，背景信息也会被搜到（search）。',
        },
        limit: { type: 'number', description: '最多返回多少条（search）。' },
        seq: { type: 'number', description: '要读的历史编号（read）。' },
        field: {
          type: 'string',
          enum: ['text', 'input'],
          description: 'text（默认）读结果正文；input 读那次工具调用的完整参数（read）。',
        },
        offset: { type: 'number', description: '从第几个字符开始读（read）。' },
        length: { type: 'number', description: '读多少个字符（read）。' },
      },
      required: ['action'],
    },
  },
] as const

// The instruction files (CLAUDE.md, AGENTS.md, memory) ride in the first user
// message, which has no cache mark, so every window writes them again. At the
// end of the system prompt they read from cache. The main system prompt is
// composed once per process and before the context is, so it carries the files
// as the previous process rendered them, kept on disk per working directory;
// the message drops its copy only when that text is the files as they are now.

/** The files as the previous process rendered them, read at session start. */
let storedClaudeMd: string | undefined
/** Where `storedClaudeMd` lives; empty when the mod is off for this session. */
let claudeMdPath = ''
/** The main system prompt carries `storedClaudeMd`. */
let claudeMdInSystem = false

/** Only the main conversation's prompt carries the files; a side analysis does not. */
const isMainCompose = (traits: readonly string[]): boolean => !traits.includes('analysis')

/** A file name for a working directory: a short hash, the same on every run. */
const cwdKey = (cwd: string): string => {
  let hash = 5381
  for (const char of cwd.replaceAll('\\', '/').toLowerCase()) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0

  return hash.toString(16).padStart(8, '0')
}

/** The home directory from the environment; empty when neither variable names one. */
const homeOf = async ($: EngineInterface): Promise<string> => {
  const profile = await attempt(async () => await $.env.get('USERPROFILE'), undefined)
  const raw =
    typeof profile === 'string' && profile !== ''
      ? profile
      : await attempt(async () => await $.env.get('HOME'), undefined)

  return typeof raw === 'string' ? raw.replace(/[\\/]+$/, '') : ''
}

/** Reads the stored text at session start; off, or nothing stored, leaves it absent. */
const loadClaudeMd = async ($: EngineInterface, cwd: string): Promise<void> => {
  storedClaudeMd = undefined
  claudeMdInSystem = false
  claudeMdPath = ''
  if ((await $.env.get('CTX_MOD_CLAUDEMD_TO_SYSTEM')) === '0') return
  const home = await homeOf($)
  if (home === '') return
  claudeMdPath = `${home}/.claude/ctx-mod/claude-md/${cwdKey(cwd)}.txt`
  const text = await attempt(async () => await $.fs.read(claudeMdPath), undefined)
  storedClaudeMd = typeof text === 'string' && text.trim() !== '' ? text : undefined
}

// The process-stable attachments (the environment, the model, the listings) are
// asked again for the first request of every window, so every window writes
// them into the message again. Only the types every session in one directory
// can share (the listings and the whole texts) move to the end of the system
// prompt, where they read from cache; the session's own types (the environment
// with its scratchpad path, the model, the session context) stay in the
// message, so every session's prompt ends the same and another session's cache
// can be read. The main prompt is composed before they are asked: the texts
// seen are kept on disk under the session id, so a restart or resume of this
// session carries them from its first prompt. The shared types are also kept
// per entrypoint and working directory, so a new session there starts with the
// same prefix; the session archive, when there is one, wins. This process
// carries the texts it saw after a window switch.

/** The attachment types that stay the same for the process, so may move. */
const ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  'environment',
  'model',
  'output_style_instructions',
  'language',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'skill_listing',
  'remote_session_change',
  'auto_mode',
  'session_context',
])

/** One process-stable attachment: its type and the text as the engine rendered it. */
type SeenAttachment = { type: string; text: string }

/** A stored entry's shape; anything else is a damaged archive. */
const isSeenAttachment = (item: unknown): item is SeenAttachment =>
  typeof item === 'object' &&
  item !== null &&
  typeof (item as { type?: unknown }).type === 'string' &&
  typeof (item as { text?: unknown }).text === 'string'

/** A type that may appear more than once: each delta and the listing is its own text. */
const isIncremental = (type: string): boolean => type === 'skill_listing' || type.endsWith('_delta')

/** The types every session in one directory may share: the listings and the whole texts. */
const SHARED_TYPES = [
  'skill_listing',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'output_style_instructions',
  'language',
] as const

const SHARED_TYPE_SET: ReadonlySet<string> = new Set(SHARED_TYPES)
/** Types whose texts are lists of lines, so a change is compared line by line. */
const LIST_TYPE_SET: ReadonlySet<string> = new Set(['skill_listing', 'agent_listing_delta', 'mcp_instructions_delta'])
const SHARED_ORDER = new Map<string, number>(SHARED_TYPES.map((type, index): [string, number] => [type, index]))

/** The shared types first in their fixed order, then the rest in arrival order; the sort is stable. */
const orderedAttachments = (list: readonly SeenAttachment[]): SeenAttachment[] =>
  [...list].sort((a, b) => (SHARED_ORDER.get(a.type) ?? SHARED_TYPES.length) - (SHARED_ORDER.get(b.type) ?? SHARED_TYPES.length))

/** A listing's lines, without the empty ones and the trailing whitespace. */
const listingLines = (text: string): string[] =>
  text.split('\n').map(line => line.trimEnd()).filter(line => line !== '')

/**
 * What the message says for a listing the prompt already partly carries: the
 * new lines, and for a skill listing the lines this session lacks. Undefined
 * keeps the text as it came; null leaves it out of the message.
 */
const listingMessage = (type: string, text: string, inSystem: readonly SeenAttachment[]): string | null | undefined => {
  const same = inSystem.filter(seen => seen.type === type)
  if (same.length === 0) return undefined
  const lines = listingLines(text)
  const known = new Set(same.flatMap(seen => listingLines(seen.text)))
  const added = lines.filter(line => !known.has(line))
  // Almost no overlap: the whole text is new, so it reads better as it came.
  if (lines.length > 0 && added.length === lines.length) return undefined
  // Only a skill listing is a whole set; a delta is new lines by nature.
  const missing = type === 'skill_listing' ? [...known].filter(line => !lines.includes(line)) : []
  if (added.length === 0 && missing.length === 0) return null
  const parts: string[] = []
  if (added.length > 0) parts.push('In addition to what the system prompt lists:\n' + added.join('\n'))
  if (missing.length > 0) parts.push('These are no longer available in this session; ignore them:\n' + missing.join('\n'))

  return parts.join('\n\n')
}

/** Records one attachment; incremental types accumulate, the others keep only the newest per type. */
const recordAttachment = (type: string, text: string): boolean => {
  if (isIncremental(type)) {
    if (seenAttachments.some(seen => seen.type === type && seen.text === text)) return false
    seenAttachments.push({ type, text })

    return true
  }
  const index = seenAttachments.findIndex(seen => seen.type === type)
  if (index < 0) {
    seenAttachments.push({ type, text })

    return true
  }
  // A changed non-incremental text replaces the old one in place.
  if (seenAttachments[index]?.text === text) return false
  seenAttachments[index] = { type, text }

  return true
}

/** `CTX_MOD_ATTACH_TO_SYSTEM` is not 0: the whitelisted attachments may move. */
let attachToSystem = false
/** The whitelisted attachments the model read this process, in arrival order. */
let seenAttachments: SeenAttachment[] = []
/** The attachments the first window carries: this session's archive, else the shared one. */
let storedAttachments: SeenAttachment[] | undefined
/** Where the session archive lives; empty when the mod is off or the session has no id. */
let attachmentsPath = ''
/** The JSON last read or written for the session, so an unchanged list is not written again. */
let attachmentsSaved = ''
/** Where the working directory's shared archive lives; empty when the mod is off or home is unknown. */
let attachmentsSharedPath = ''
/** The shared archive's JSON last read or written; an empty list when there is none. */
let attachmentsSharedSaved = '[]'
/** The write in flight, so the next one starts after it. */
let attachmentsSaving: Promise<void> = Promise.resolve()
/** The entries the current main system prompt carries, so the message can leave them out or trim them. */
let attachmentsInSystem: SeenAttachment[] = []
/** A compaction happened: every main compose from now on carries the section. */
let attachmentsArmed = false

/** The entries in one archive; a damaged, empty or old string-array file is no archive. */
const readArchive = async ($: EngineInterface, path: string): Promise<SeenAttachment[] | undefined> => {
  const text = await attempt(async () => await $.fs.read(path), undefined)
  if (typeof text !== 'string') return undefined
  const parsed = await attempt(async () => JSON.parse(text) as unknown, undefined)
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isSeenAttachment)) return undefined

  return parsed as SeenAttachment[]
}

/** Reads the switch, this session's archive and the shared one at session start; a new process starts with nothing seen. */
const loadAttachments = async ($: EngineInterface, cwd: string): Promise<void> => {
  attachToSystem = (await $.env.get('CTX_MOD_ATTACH_TO_SYSTEM')) !== '0'
  seenAttachments = []
  storedAttachments = undefined
  attachmentsPath = ''
  attachmentsSaved = ''
  attachmentsSharedPath = ''
  attachmentsSharedSaved = '[]'
  attachmentsInSystem = []
  attachmentsArmed = false
  if (!attachToSystem) return
  const home = await homeOf($)
  if (home === '') return
  // The shared archive belongs to the working directory and the entrypoint: a
  // new session starts with the listings and whole texts another session there
  // already saw. The desktop app and the CLI list different skills, so each
  // keeps its own rather than overwriting the other's.
  const raw = await attempt(async () => await $.env.get('CLAUDE_CODE_ENTRYPOINT'), undefined)
  const entry = typeof raw === 'string' && /^[\w-]+$/.test(raw) ? raw : 'unknown'
  attachmentsSharedPath = home + '/.claude/ctx-mod/attachments/shared/' + entry + '-' + cwdKey(cwd) + '.json'
  const shared = await readArchive($, attachmentsSharedPath)
  const sharedEntries = shared?.filter(seen => SHARED_TYPE_SET.has(seen.type)) ?? []
  if (sharedEntries.length > 0) attachmentsSharedSaved = JSON.stringify(orderedAttachments(sharedEntries))
  // The session archive is this same conversation restarted, so it wins.
  const id = await idOf($)
  // The id names a file, so one that could leave the directory is not used.
  if (id !== undefined && /^[\w-]+$/.test(id)) {
    attachmentsPath = home + '/.claude/ctx-mod/attachments/' + id + '.json'
    const stored = await readArchive($, attachmentsPath)
    if (stored !== undefined) {
      storedAttachments = stored
      attachmentsSaved = JSON.stringify(stored)
    }
  }
  if (storedAttachments === undefined && sharedEntries.length > 0) storedAttachments = sharedEntries
}

/** Writes the texts seen so far back for the next process; an unchanged list is not written again. */
const saveAttachments = async ($: EngineInterface): Promise<void> => {
  // Attachments arrive in parallel: overlapping writes to one file leave it
  // padded with NULs, so each write waits for the one before and takes the
  // list as it is then.
  attachmentsSaving = attachmentsSaving.then(async () => {
    if (attachmentsPath !== '') {
      const text = JSON.stringify(seenAttachments)
      if (text !== attachmentsSaved) {
        try {
          await $.fs.write(attachmentsPath, text)
          attachmentsSaved = text
        } catch (error) {
          logError($, 'attachments', error)
        }
      }
    }
    if (attachmentsSharedPath !== '') {
      const shared = orderedAttachments(seenAttachments.filter(seen => SHARED_TYPE_SET.has(seen.type)))
      const text = JSON.stringify(shared)
      if (text !== attachmentsSharedSaved) {
        try {
          await $.fs.write(attachmentsSharedPath, text)
          attachmentsSharedSaved = text
        } catch (error) {
          logError($, 'attachments', error)
        }
      }
    }
  })
  await attachmentsSaving
}

/** After a window switch: the next main compose carries the attachments, so it is composed again. */
const armAttachments = ($: EngineInterface): void => {
  if (!attachToSystem) return
  attachmentsArmed = true
  attachmentsInSystem = []
  $.ui.invalidate('prompt.section')
}

export const register: Register = (on, options) => {
  // The context fires once per conversation and again after a compaction.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    if (!enabled || claudeMdPath === '') return result
    try {
      const block = result.blocks.find(b => b.name === 'claudeMd')
      const files = (result.instructionFiles ?? e.instructionFiles ?? []).filter(f => f.content.trim() !== '')
      if (block === undefined || files.length === 0) return result
      // The block is the files' whole rendering: the announcement and each file's contents.
      const current = block.text
      if (current !== storedClaudeMd) {
        // The next process composes with these; this one keeps its copy in the message.
        await $.fs.write(claudeMdPath, current)

        return result
      }
      // Only a main prompt already composed with this text lets the message drop its copy.
      if (!claudeMdInSystem) return result

      return { ...result, blocks: result.blocks.filter(b => b !== block) }
    } catch (error) {
      logError($, 'prompt.context', error)

      return result
    }
  })

  on('session.start', async ($, e, next) => {
    try {
      enabled = (await $.env.get('CTX_MOD')) === '1'
      if (enabled) {
        await loadAttachments($, e.cwd).catch(error => logError($, 'attachments', error))
        await loadClaudeMd($, e.cwd).catch(error => logError($, 'claude-md', error))
      }
      // The command is always there, so a person who installed the mod and
      // typed /ctx-mod is told how to turn it on instead of meeting an unknown command.
      await $.command.register({
        name: COMMAND,
        description: '显示 ctx-mod 的状态；/ctx-mod switch 立即换到新窗口（不调用模型）',
      })
      if (enabled) {
        for (const tool of TOOLS) {
          await $.tool.register({ ...tool, isDeferred: false })
        }
        await sessionOf($)
      }
    } catch (error) {
      logError($, 'session.start', error)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    if (!enabled) {
      return { text: 'ctx-mod 未启用：用环境变量 CTX_MOD=1 启动 Claude Code 后生效（例如 `CTX_MOD=1 claude`）。' }
    }
    try {
      const session = await sessionOf($)
      if (session === undefined) return { text: 'ctx-mod：拿不到会话。' }
      // `args` is absent on a bare `/ctx-mod`, and on a run whose arguments the
      // surface never carried.
      if (typeof e.args === 'string' && e.args.trim() === 'switch') return manualSwitch($, session)
      const id = await idOf($)
      const env = id === undefined ? undefined : await envOf($, id)
      const head = 'ctx-mod 已启用（CTX_MOD=1）。'

      return { text: env === undefined ? head : `${head}\n${session.status(env)}` }
    } catch (error) {
      logError($, 'command.run', error)

      return { text: `ctx-mod: ${messageOf(error)}` }
    }
  })

  on('prompt.compose', async ($, e, next) => {
    if (!enabled) return next(e)
    const result = await next(e)
    try {
      const main = isMainCompose(e.traits)
      const claudeMd = main && storedClaudeMd !== undefined
        ? [{ id: 'ctx-mod:claude-md', text: storedClaudeMd, scope: 'session' as const }]
        : []
      if (claudeMd.length > 0) claudeMdInSystem = true
      // The attachments ride after the files and before the mod's own section,
      // so the prompt's tail stays the same all window long. The order is fixed:
      // the shared types first, so every session in this directory starts with
      // the same prefix, then the rest as they arrived. Until a switch the
      // previous process's texts are used, so the first window hits the cache;
      // after one, this process's own texts replace them, dropping stale ones.
      // Only the shared types move: a session's own texts (its scratchpad path,
      // model, git status) would make every session's prompt differ, so the
      // prompt's tail could never be read from another session's cache.
      const attachmentsSource = orderedAttachments(attachmentsArmed ? seenAttachments : storedAttachments ?? [])
        .filter(seen => SHARED_TYPE_SET.has(seen.type))
      const attachments = main && attachToSystem && attachmentsSource.length > 0
        ? [{ id: 'ctx-mod:attachments', text: attachmentsSource.map(seen => seen.text).join('\n\n'), scope: 'session' as const }]
        : []
      // Only a main prompt carries them; a side analysis leaves the set alone.
      if (main) attachmentsInSystem = attachments.length > 0 ? attachmentsSource : []

      return {
        ...result,
        sections: [
          ...result.sections,
          ...claudeMd,
          ...attachments,
          { id: 'ctx-mod:context', text: SYSTEM_TEXT, scope: 'session' as const },
        ],
      }
    } catch (error) {
      logError($, 'prompt.compose', error)

      return result
    }
  })

  // The engine asks the process-stable attachments again for every window; once
  // the system prompt carries a text, the message leaves it out. A subagent's
  // attachments are its own and pass through.
  on('prompt.attachment', async ($, e, next) => {
    if (!enabled || !attachToSystem) return next(e)
    if (isSubagentCall(e)) return next(e)
    const result = await next(e)
    try {
      if (!ATTACHMENT_TYPES.has(e.type) || result.text === null) return result
      const text = result.text
      // Record first, with the whole text: a text the prompt carries, or that the
      // message only partly carries, must survive the next switch unchanged.
      if (recordAttachment(e.type, text)) await saveAttachments($)
      if (attachmentsInSystem.some(seen => seen.text === text)) return { text: null }
      // A listing the prompt partly carries: the message says only what is new,
      // and for a skill listing what the prompt lists but this session lacks.
      if (SHARED_TYPE_SET.has(e.type) && LIST_TYPE_SET.has(e.type)) {
        const message = listingMessage(e.type, text, attachmentsInSystem)
        if (message === null) return { text: null }
        if (message !== undefined) return { text: message }
      }

      return result
    } catch (error) {
      logError($, 'prompt.attachment', error)

      return result
    }
  })

  on('tool.call', { tool: 'mcp__ctx-mod__context' as never }, async ($, e, next) => {
    if (!enabled) return next(e)
    if (isSubagentCall(e)) return AGENT_ONLY
    const input = argsOf(e)
    try {
      const session = await sessionOf($)
      const id = await idOf($)
      if (session === undefined || id === undefined) return next(e)
      const env = await envOf($, id)

      return input.action === 'new'
        ? session.requestSwitch(input, env)
        : { result: `${session.status(env)}\n${session.historyWriteStats()}` }
    } catch (error) {
      logError($, 'tool.call context', error)

      return next(e)
    }
  })

  on('tool.call', { tool: 'mcp__ctx-mod__ledger_append' as never }, async ($, e, next) => {
    if (!enabled) return next(e)
    if (isSubagentCall(e)) return AGENT_ONLY
    const input = argsOf(e)
    try {
      const session = await sessionOf($)
      const id = await idOf($)
      if (session === undefined || id === undefined) return next(e)

      return await session.ledgerAppend(input, await envOf($, id))
    } catch (error) {
      logError($, 'tool.call ledger_append', error)

      return next(e)
    }
  })

  on('tool.call', { tool: 'mcp__ctx-mod__ledger_read' as never }, async ($, e, next) => {
    if (!enabled) return next(e)
    if (isSubagentCall(e)) return AGENT_ONLY
    const input = argsOf(e)
    try {
      const session = await sessionOf($)
      if (session === undefined) return next(e)

      return await session.ledgerRead(input)
    } catch (error) {
      logError($, 'tool.call ledger_read', error)

      return next(e)
    }
  })

  on('tool.call', { tool: 'mcp__ctx-mod__decision_revoke' as never }, async ($, e, next) => {
    if (!enabled) return next(e)
    if (isSubagentCall(e)) return AGENT_ONLY
    const input = argsOf(e)
    try {
      const session = await sessionOf($)
      if (session === undefined) return next(e)

      return await session.decisionRevoke(input)
    } catch (error) {
      logError($, 'tool.call decision_revoke', error)

      return next(e)
    }
  })

  on('tool.call', { tool: 'mcp__ctx-mod__history' as never }, async ($, e, next) => {
    if (!enabled) return next(e)
    if (isSubagentCall(e)) return AGENT_ONLY
    const input = argsOf(e)
    try {
      const session = await sessionOf($)
      if (session === undefined) return next(e)

      return await session.historyTool(input)
    } catch (error) {
      logError($, 'tool.call history', error)

      return next(e)
    }
  })

  on('tool.call', async ($, e, next) => {
    if (!enabled) return next(e)
    if (e.agentId !== undefined) return next(e)
    // A tool of this mod's own is answered by its matcher above; this hook is
    // for everything else, and it runs after that one.
    if (String(e.tool).startsWith(PREFIX)) return next(e)
    try {
      remember(String(e.tool_use_id), String(e.tool), e as unknown as Record<string, unknown>)
      const session = await sessionOf($)
      if (session !== undefined && session.blocksCalls()) {
        return { deny: '正在换窗口：请立即结束本回合，不要再调用工具。' }
      }
      // A resume of an ended subagent whose cache has gone cold is held back once, with its cost.
      if (session !== undefined && String(e.tool) === 'SendMessage') {
        const args = argsOf(e)
        const to = typeof args.to === 'string' ? args.to : ''
        const message = typeof args.message === 'string' ? args.message : ''
        const notice = await session.coldResend(to, message)
        if (notice !== null) return { deny: notice }
        await session.agentResumed(to)
      }
      // A load that would rebuild the cache waits for a window switch while the context is large.
      if (session !== undefined && String(e.tool) === 'ToolSearch') {
        const id = await idOf($)
        const tokens = id === undefined ? undefined : (await envOf($, id)).tokens
        const refusal = session.gateLoad(argsOf(e).query, tokens)
        if (refusal !== null) return { deny: refusal }
      }
    } catch (error) {
      logError($, 'tool.call before', error)
    }

    const result = await next(e)
    try {
      const session = await sessionOf($)
      const id = await idOf($)
      if (session !== undefined && id !== undefined) {
        const env = await envOf($, id)
        const text = session.reminder(env)
        if (text !== null) {
          await $.session.append({
            message: { type: 'user', content: [{ type: 'text', text }] },
          })
        }
      }
    } catch (error) {
      logError($, 'tool.call after', error)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    if (!enabled) return next(e)
    if (e.agentId !== undefined) return next(e)
    try {
      const session = await sessionOf($)
      if (session === undefined) return next(e)

      if (e.door === 'prompt') {
        const said = textOf(e.message.content)
        // The engine's own session-start hook lands in this door too, wrapped in
        // a `<system-reminder>` block: a person's row must survive stripping it
        // and still not look like an injected notice. The text held in
        // `personTexts` came from `prompt.submit`, which never sees that block,
        // so the match is made on the stripped text as well.
        const stripped = stripInjected(said)
        let at = personTexts.indexOf(said.trim())
        if (at === -1 && stripped !== '') at = personTexts.indexOf(stripped)
        if (at !== -1) personTexts.splice(at, 1)
        // With the source confirmed, only the engine's own envelopes are ruled out by their opening; any other `<` is the person's words.
        const isConfirmed = at !== -1 || isPersonOrigin(e.origin) || isOurUser(e.origin)
        const isPerson = isConfirmed && stripped !== '' && looksLikePerson(stripped, true)
        await session.record({
          uuid: e.uuid,
          role: 'user',
          ...(isPerson ? { isPerson: true as const } : {}),
          // Kept as the engine stamped it: a coordinator's hand-off is told by this, not by its words.
          origin: e.origin.kind,
          // The handoff a switch answers with comes back through this door, not `compaction`;
          // naming it lets a search by that door find what each window opened with.
          ...(isHandoffText(said) ? { door: 'compaction' } : {}),
          text: textOf(e.message.content),
        })

        return next(e)
      }

      if (e.door === 'response') {
        const text = textOf(e.message.content)
        if (text !== '') await session.record({ uuid: e.uuid, role: 'assistant', text })

        return next(e)
      }

      if (e.door === 'tool-result') {
        const out: Block[] = []
        for (const block of e.message.content) {
          if (block.type !== 'tool_result') {
            out.push(block)
            continue
          }
          const callId = String(block.tool_use_id ?? '')
          const found = calls.get(callId)
          const tool = found?.tool ?? (e.origin.kind === 'tool' ? e.origin.tool : 'unknown')
          const input = found?.input ?? {}
          const isError = block.is_error === true
          const path = firstString(input, ['file_path', 'notebook_path', 'path'])
          const brief = briefOf(tool, input)
          // `input` is the whole call event; the arguments are what is left once the envelope is off.
          const args = found === undefined ? '' : formatArgs(argsOf(found.input))
          // A ToolSearch result names the deferred tools it loaded; the next window
          // is told which of them were used, so it can load them in its first step.
          const loaded = tool === 'ToolSearch' ? toolReferencesOf(block.content) : []
          const text = resultText(block.content)
          // Whatever is not text (an image, a document) must not vanish without a trace.
          const note = nonTextNote(Array.isArray(block.content) ? block.content : [], loaded.length > 0 ? ['tool_reference'] : [])
          // A reference-only result has no text; name what it loaded so the row is not blank.
          const body = text === '' && loaded.length > 0 ? `已加载：${loaded.join('、')}` : text
          const record = await session.record({
            uuid: e.uuid,
            role: 'tool',
            tool,
            ...(path === undefined ? {} : { path }),
            ...(brief === undefined ? {} : { input: brief }),
            ...(args === '' ? {} : { args }),
            ...(callId === '' ? {} : { callId }),
            ...(isError ? { isError: true as const } : {}),
            ...(loaded.length === 0 ? {} : { loaded }),
            text: note === '' ? body : body === '' ? note : `${body}\n${note}`,
          })
          session.activity(tool, input, record.seq, isError)

          // This mod's own results are recorded, never numbered.
          // A result that carries anything but text (ToolSearch's tool
          // references, images) is refused by the API once text is mixed in.
          const isPlain =
            typeof block.content === 'string' ||
            (Array.isArray(block.content) &&
              block.content.every(part => (part as { type?: unknown }).type === 'text'))
          if (tool.startsWith(PREFIX) || !isPlain) {
            out.push(block)
            continue
          }
          const suffix = `[#${record.seq}]`
          out.push(
            typeof block.content === 'string'
              ? { ...block, content: `${block.content}\n${suffix}` }
              : {
                  ...block,
                  content: [...(Array.isArray(block.content) ? block.content : []), { type: 'text', text: suffix }],
                },
          )
        }

        return next({ ...e, message: { ...e.message, content: out } })
      }

      // Every other door: the row is kept when a request carries it, which is what `role` says.
      // A notice and the like have none and never reach the model, so they stay out.
      const role = e.message.role
      if (role !== undefined) {
        const body = textOf(e.message.content)
        const note = nonTextNote(e.message.content)
        const text = note === '' ? body : body === '' ? note : `${body}\n${note}`
        if (text !== '') {
          const name = e.message.name
          // A message the person typed mid-turn comes back as a queued_command attachment, wrapped in
          // text nobody has seen; the origin says `engine`, so it is told by the words they submitted.
          // The engine files it under `delivery`, not `attachment`: the name is what tells it.
          let said: string | undefined
          if ((e.door === 'attachment' || e.door === 'delivery') && name === 'queued_command') {
            const at = personTexts.findIndex(typed => typed !== '' && body.includes(typed))
            if (at !== -1) {
              const typed = personTexts.splice(at, 1)[0] ?? ''
              const stripped = stripInjected(typed)
              if (stripped !== '' && looksLikePerson(stripped, true)) said = typed
            }
          }
          // The engine injects the same background attachment on every request; one copy per window
          // shows what was injected then, and a repeat only burns a number and a shard rewrite.
          const isBackground = isBackgroundRow({ door: e.door, ...(name === undefined ? {} : { name }) })
          const backgroundKey = `${e.door}/${name ?? ''}`
          const window = session.window()
          const previous = lastBackground.get(backgroundKey)
          if (isBackground && previous !== undefined && previous.window === window && previous.text === text) {
            return next(e)
          }
          await session.record({
            uuid: e.uuid,
            role,
            ...(said === undefined ? {} : { isPerson: true as const }),
            door: e.door,
            ...(name === undefined ? {} : { name }),
            text: said ?? text,
          })
          if (isBackground) lastBackground.set(backgroundKey, { window, text })
        }
      }
    } catch (error) {
      logError($, 'session.append', error)
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (!enabled) return next(e)
    const result = await next(e)
    try {
      const id = result.agentId
      // Only the main loop's own spawns are noted: a spawn from inside a subagent is
      // not one a new window can resume, and a fork carries the parent's conversation
      // rather than a task of its own.
      if (typeof id === 'string' && id !== '' && e.parentAgentId === undefined && e.fork !== true) {
        const session = await sessionOf($)
        await session?.noteAgent({
          id,
          type: e.subagentType,
          description: e.description,
          model: result.model,
          ...(typeof e.name === 'string' ? { name: e.name } : {}),
        })
      }
    } catch (error) {
      logError($, 'agent.spawn', error)
    }

    return result
  })

  // `turn.step` streams, so its hook is the generator the engine reads: every chunk
  // passes through untouched, and the recording reads only the result that comes back.
  on('turn.step', async function* ($, e, next) {
    if (!enabled) return yield* next(e)
    const result = yield* next(e)
    try {
      // Only the main loop's requests are measured: a subagent has a cache of its own.
      const usage = result.usage
      if (e.agentId !== undefined) {
        // A subagent's request size is the size a later resume would have to rewrite once its cache is gone.
        if (usage !== null) {
          const size =
            (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) +
            (typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0) +
            (typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0)
          await (await sessionOf($))?.agentStep(e.agentId, size)
        }
      } else {
        const session = await sessionOf($)
        // One step is one model request, whether or not it called a tool; a retried
        // or replayed step carries the same turn and index and is not a second one.
        const isNewStep = session !== undefined && (lastStep === null || lastStep.turnId !== e.turnId || lastStep.index !== e.index)
        if (usage !== null) {
          const measured = {
            input: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
            read: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0,
            write: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0,
          }
          await session?.noteStep(measured)
          // The first step after a switch carries the new window's whole prefix.
          if (session !== undefined && awaitingPrefix) {
            session.notePrefix(measured.input + measured.read + measured.write)
            awaitingPrefix = false
          }
        }
        // Refreshed only after noteStep, which judges the previous request's age and must still see it.
        if (session !== undefined && isNewStep) {
          lastStep = { turnId: e.turnId, index: e.index }
          session.noteRequest()
        }
      }
    } catch (error) {
      logError($, 'turn.step', error)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!enabled) return next(e)
    if (e.agentId !== undefined) {
      // A subagent's own turn: its noted row is tagged as ended, which the handoff reads.
      try {
        const session = await sessionOf($)
        await session?.agentEnded(e.agentId)
      } catch (error) {
        logError($, 'turn.complete agent', error)
      }

      return next(e)
    }
    const result = await next(e)
    let session: Session | undefined
    try {
      session = await sessionOf($)
      const id = await idOf($)
      if (continueAfterTurn) {
        continueAfterTurn = false
        if (e.reason === 'answer' && id !== undefined) {
          const env = await envOf($, id)
          if (shouldContinue(env.fiveHourPercent, env.cache, DEFAULTS)) {
            await $.prompt.submit({ text: CONTINUE_TEXT })
          }
        }
      } else if (session !== undefined && session.pending() !== null) {
        if (e.reason !== 'answer') {
          session.clearPending()
        } else {
          switchReason = 'model'
          committed = false
          try {
            await $.command.run({ command: 'compact' })
          } catch (error) {
            // A compaction that threw committed nothing; the pending the model
            // was granted must still be cleared, or every call is refused.
            logError($, 'turn.complete compact', error)
          } finally {
            switchReason = null
          }
          if (!committed) {
            session.clearPending()
          } else if (id !== undefined) {
            const env = await envOf($, id)
            if (shouldContinue(env.fiveHourPercent, env.cache, DEFAULTS)) {
              await $.prompt.submit({ text: CONTINUE_TEXT })
            }
          }
        }
      }
    } catch (error) {
      logError($, 'turn.complete', error)
    } finally {
      // Every main turn ends by flushing, however the switch it may have started went.
      if (session !== undefined) {
        try {
          await session.flush()
        } catch (error) {
          logError($, 'turn.complete flush', error)
        }
      }
    }

    return result
  })

  on('session.compact', async ($, e, next) => {
    if (!enabled) return next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const mine = switchReason !== null && e.trigger === 'manual'
    let session: Session | undefined
    let env: Env | undefined
    let id: string | undefined
    try {
      id = await idOf($)
      session = await sessionOf($)
      if (id === undefined || session === undefined) return next(e)
      env = await envOf($, id)
      let isZeroSummary = mine || (e.trigger === 'auto' && session.canSkipSummary())
      if (isZeroSummary) {
        // A zero-summary switch drops the conversation on the promise that the files hold it, so that must be true.
        await session.flush()
        const unsaved = session.unsaved()
        if (unsaved.length > 0) {
          logError($, 'session.compact', `not on disk, so core summarizes instead: ${unsaved.join(', ')}`)
          isZeroSummary = false
        }
      }
      if (isZeroSummary) {
        // A zero-summary switch: this mod answers in place of core.
        if (!mine && session.pending() !== null) continueAfterTurn = true
        const text = await session.buildHandoff({
          isMidTurn: e.trigger === 'auto',
          agents: await agentsOf($),
        })
        await session.commitSwitch({
          trigger: mine ? switchReason ?? 'manual' : 'auto',
          tokensBefore: env.tokens,
          handoffText: text,
        })
        committed = true
        awaitingPrefix = true
        armAttachments($)

        return { messages: [{ role: 'user', text, toolUses: [] }] }
      }
    } catch (error) {
      logError($, 'session.compact before', error)

      return next(e)
    }

    const result: SessionCompactResult = await next(e)
    try {
      if (result.messages !== undefined && session !== undefined && env !== undefined) {
        // Core made a summary: keep it and append this mod's own handoff after.
        const text = await session.buildHandoff({
          isMidTurn: e.trigger === 'auto',
          agents: await agentsOf($),
        })
        await session.commitSwitch({
          trigger: e.trigger === 'auto' ? 'auto-summary' : 'manual',
          tokensBefore: env.tokens,
          handoffText: text,
        })
        // When the disk check sent a switch the model asked for down this path, `turn.complete` still has to see it happened.
        if (mine) committed = true
        awaitingPrefix = true
        armAttachments($)

        return { ...result, messages: [...result.messages, { role: 'user', text, toolUses: [] }] }
      }
    } catch (error) {
      logError($, 'session.compact after', error)
    }

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (!enabled) return next(e)
    let holds = false
    let starts = false
    let isExpired = false
    let heldSession: Session | undefined
    let heldIdOf = 0
    try {
      const session = await sessionOf($)
      const id = await idOf($)
      if (session !== undefined && id !== undefined && isPersonOrigin(e.origin)) {
        // During a switch every such message waits its turn; otherwise only a cold cache holds one.
        let wants = isHoldingFlow
        if (!wants) {
          const env = await envOf($, id)
          // A restarted process has no fill of its own before its first request, so the
          // keeper's cached prefix — kept across restarts — stands in for it: the cache
          // that went cold is at least as large as the prefix it last served.
          const size = env.tokens ?? env.cache?.cachedPrefixTokens
          wants =
            size !== undefined &&
            size >= DEFAULTS.coldMinTokens &&
            isCold({ now: Date.now(), cache: env.cache, lastRequestAt: session.lastRequestAt() }, DEFAULTS)
          isExpired = wants
        }
        // A message is held whether or not it carries attachments: the engine names an
        // attachment's kind, never its bytes, so only the text comes back — plus the
        // paths of the images Claude saved, when it saved them. Held only once it is on
        // disk: a message that could not be saved goes in as usual.
        const attachments = e.attachments ?? []
        const images =
          wants && attachments.length > 0 ? await pastedImages($, attachments, id) : []
        const heldId = wants ? await session.hold(e.text, attachments, images) : null
        if (heldId !== null) {
          holds = true
          heldSession = session
          heldIdOf = heldId
          // Decided after the awaits, with no gap before the timer: only one run may own the switch.
          starts = !isHoldingFlow
          if (starts) isHoldingFlow = true
        }
      }
    } catch (error) {
      logError($, 'prompt.submit before', error)
    }

    // Only a submission that goes on to be stored is worth matching by its text:
    // a held prompt is dropped, never reaches `session.append`, and its row is
    // then matched by some later prompt that happens to say the same words.
    if ((isPersonOrigin(e.origin) || isOurUser(e.origin)) && !holds) {
      personTexts.push(e.text.trim())
      if (personTexts.length > 20) personTexts.shift()
    }
    if (!holds) return next(e)

    // A compaction cannot be asked for from inside this hook: a timer asks once
    // it returned, then the held prompt is submitted again as the person's own.
    if (!starts && heldSession !== undefined) {
      return { drop: 'ctx-mod：正在换窗口，这条消息排在后面，换完后按顺序处理' }
    }
    if (heldSession === undefined) return next(e)
    const session = heldSession
    try {
      $.clock.after(300, () => {
        void (async () => {
          try {
            // Only a message held for the expired cache calls for a switch: one that queued behind a switch which has since ended just goes in.
            if (isExpired) {
              // The last keepalive saw the conversation while the cache was still warm: book
              // what it found still open before the history is replaced.
              await bookSnapshot($, session)
              switchReason = 'cold'
              try {
                await $.command.run({ command: 'compact' })
              } catch (error) {
                logError($, 'prompt.submit timer', error)
              } finally {
                switchReason = null
              }
            }
            await deliverHeld($, session)
          } catch (error) {
            logError($, 'prompt.submit deliver', error)
          } finally {
            isHoldingFlow = false
          }
        })()
      })
    } catch (error) {
      // No timer will ever deliver it: take the message back off the shelf and let it in.
      logError($, 'prompt.submit timer', error)
      isHoldingFlow = false
      await session.release(heldIdOf).catch(() => undefined)

      return next(e)
    }

    return {
      drop: isExpired
        ? 'ctx-mod：缓存已过期，先换窗口再处理这条消息'
        : 'ctx-mod：正在换窗口，这条消息排在后面，换完后按顺序处理',
    }
  })

  on('session.measure', async ($, e, next) => {
    if (!enabled) return next(e)
    try {
      const session = await sessionOf($)
      const id = await idOf($)
      if (session !== undefined && id !== undefined) {
        const limit = await limitFor($, id)
        if (limit !== undefined) {
          $.ui.status(describeFill(e.context.tokens, limit, session.window()))
        }
      }
    } catch (error) {
      logError($, 'session.measure', error)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      const session = sessions.get(e.sessionId)
      if (session !== undefined) {
        try {
          await session.flush()
        } catch {
          // A last write that fails is dropped; the session is going anyway.
        }
        sessions.delete(e.sessionId)
        limits.delete(e.sessionId)
      }
    } catch (error) {
      logError($, 'session.end', error)
    }
    // Nothing a finished session left behind may shape the next one: the wiring
    // is module-wide, and a new session id is all that separates them.
    switchReason = null
    committed = false
    isHoldingFlow = false
    awaitingPrefix = false
    lastStep = null
    continueAfterTurn = false
    personTexts.length = 0
    lastBackground.clear()
    calls.clear()

    return next(e)
  })
}
