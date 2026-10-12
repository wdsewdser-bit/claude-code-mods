// The engine wiring: the hooks of ctx-mod. Everything that decides anything
// lives under `lib/`; this file only observes the engine, hands the events to a
// Session and answers. Phase 0's probe is kept under phase0/ as text: an event
// takes one unmatched hook per module, so the two cannot be loaded together.

import type { CommandRunResult, EngineInterface, Register, SessionCompactResult, SessionMessage } from 'claude-code'

import { formatArgs, isBackgroundRow, nonTextNote } from './lib/history.ts'
import { createSession, isHandoffText, looksLikePerson, stripInjected } from './lib/session.ts'
import type { AgentNote, Env, ImportedMessage, Io, Session } from './lib/session.ts'
import { describeFill, isCold, limitOf, shouldContinue } from './lib/usage.ts'
import { DEFAULTS, OWN_TOOL_PREFIX } from './lib/types.ts'

/** The section of the system prompt, the same all session long. */
const SYSTEM_TEXT =
  '这个会话可能跨多个上下文窗口。你有一个任务账本（mcp__ctx-mod__ledger_append、mcp__ctx-mod__ledger_read）和完整历史（mcp__ctx-mod__history）。工具结果末尾形如 [#123] 的是历史编号。每完成一个阶段，就追加一条账本记录：用 task_id 标识任务，status 填 in_progress / done / superseded / blocked。标 done 时必须在 evidence 里附上证明它的工具结果的历史编号。用户提出新请求时，如果它取代了旧任务，就把旧任务标为 superseded。对还没做完的任务，写明 next_step，并用 anchors 记下接下来要改的位置：文件路径，加一小段能在文件里唯一定位的原文。收到收尾或交接通知时，先更新账本。上下文用量可以用 mcp__ctx-mod__context 查看；它提示可以换窗口时，先记账再调用它的 new。申请换窗口之前，先用 ledger_append 把进行中任务的进度写清楚，text 里写明后面要用到的关键事实（产物路径、已确认的结论、约定的参数），有子代理在跑时写明各自的 id、负责什么、产物放哪。'

/** Submitted after a switch the model itself asked for, so the new window carries on. */
const CONTINUE_TEXT = 'ctx-mod：已换到新的上下文窗口。先用一句话复述当前请求和进度，然后继续。'

const COMMAND = 'ctx-mod'
const PREFIX = OWN_TOOL_PREFIX
const KEEPER_CACHE = { plugin: 'cache-keeper', key: 'cache' } as const

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
    let isDelivered = false
    try {
      const entered = await $.prompt.submit({ text: item.text, asUser: true })
      isDelivered = !(typeof entered === 'object' && entered !== null && 'drop' in entered)
      if (!isDelivered) logError($, 'prompt.submit resubmit', 'the re-submitted prompt was dropped')
    } catch (error) {
      logError($, 'prompt.submit resubmit', error)
    }
    // The person's words are gone unless the session says so.
    if (!isDelivered && !(await tellPerson($, unsentNotice(RESUBMIT_LEAD, item.text)))) return
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
    now: () => Date.now(),
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
  if (session.latestPersonSeq() === null) {
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
      '查看上下文用量，或申请换到新的上下文窗口。action 为 "new" 时申请换窗口；引擎批准后必须立即结束本回合，不要再调用任何工具。',
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
          description: '这条记录回应的真人请求的历史编号；省略时用最近一条。',
        },
      },
      required: ['task_id', 'title', 'status', 'text'],
    },
  },
  {
    name: 'ledger_read',
    description:
      '读取任务账本。view 可以是 home（默认，首页概览）、current（当前窗口的全部条目）或 archive:N（第 N 页归档）；给了 query 就在全部条目里搜索。',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', description: 'home、current 或 archive:N，默认 home。' },
        query: { type: 'string', description: '在 task_id、标题、正文和下一步里搜索的词。' },
      },
    },
  },
  {
    name: 'history',
    description:
      '检索或读取完整历史。action 为 "search" 时按条件查历史编号，为 "read" 时按编号读原文。工具结果末尾形的 [#123] 就是历史编号。读原文时 field 填 "input" 可以看到那次工具调用的完整参数（子代理的任务原文、发出的消息、完整的命令）。搜索默认不显示引擎自己塞进来的背景信息（附件、钩子上下文、备注）；要找它们就用 door 指定，如 "attachment"、"hook-context"、"note"。搜索不指定 window 时默认搜最近 3 个窗口；这几个窗口里没有命中会自动往更早的窗口找，找到有命中的窗口就停，结果末尾会写明实际搜了哪些窗口，没搜的窗口用 window 指定。',
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

export const register: Register = (on, options) => {

  on('session.start', async ($, e, next) => {
    try {
      enabled = (await $.env.get('CTX_MOD')) === '1'
      if (enabled) {
        for (const tool of TOOLS) {
          await $.tool.register({ ...tool, isDeferred: false })
        }
        await $.command.register({
          name: COMMAND,
          description: '显示 ctx-mod 的状态；/ctx-mod switch 立即换到新窗口（不调用模型）',
        })
        await sessionOf($)
      }
    } catch (error) {
      logError($, 'session.start', error)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    if (!enabled) return next(e)
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
      return {
        ...result,
        sections: [
          ...result.sections,
          { id: 'ctx-mod:context', text: SYSTEM_TEXT, scope: 'session' as const },
        ],
      }
    } catch (error) {
      logError($, 'prompt.compose', error)

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
        : { result: session.status(env) }
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
      if (session !== undefined && session.pending() !== null) {
        return { deny: '正在换窗口：请立即结束本回合，不要再调用工具。' }
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
        const at = personTexts.indexOf(said.trim())
        if (at !== -1) personTexts.splice(at, 1)
        // The engine's own session-start hook lands in this door too, wrapped in
        // a `<system-reminder>` block: a person's row must survive stripping it
        // and still not look like an injected notice.
        const stripped = stripInjected(said)
        // With the source confirmed, only the engine's own envelopes are ruled out by their opening; any other `<` is the person's words.
        const isConfirmed = at !== -1 || isPersonOrigin(e.origin) || isOurUser(e.origin)
        const isPerson = isConfirmed && stripped !== '' && looksLikePerson(stripped, true)
        await session.record({
          uuid: e.uuid,
          role: 'user',
          ...(isPerson ? { isPerson: true as const } : {}),
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
        await session?.noteAgent({ id, type: e.subagentType, description: e.description, model: result.model })
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
      if (e.agentId === undefined) {
        const session = await sessionOf($)
        // One step is one model request, whether or not it called a tool; a retried
        // or replayed step carries the same turn and index and is not a second one.
        if (session !== undefined && (lastStep === null || lastStep.turnId !== e.turnId || lastStep.index !== e.index)) {
          lastStep = { turnId: e.turnId, index: e.index }
          session.noteRequest()
        }
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
      if (
        session !== undefined &&
        id !== undefined &&
        isPersonOrigin(e.origin) &&
        (e.attachments?.length ?? 0) === 0
      ) {
        // During a switch every such message waits its turn; otherwise only a cold cache holds one.
        let wants = isHoldingFlow
        if (!wants) {
          const env = await envOf($, id)
          wants =
            env.tokens !== undefined &&
            env.tokens >= DEFAULTS.coldMinTokens &&
            isCold({ now: Date.now(), cache: env.cache, lastRequestAt: session.lastRequestAt() }, DEFAULTS)
          isExpired = wants
        }
        // Held only once it is on disk: a message that could not be saved goes in as usual.
        const heldId = wants ? await session.hold(e.text) : null
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
