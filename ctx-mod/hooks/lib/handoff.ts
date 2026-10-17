import { estimateTokens } from './types.ts'
import type { Config } from './types.ts'
import type { AgentNote } from './session.ts'

/** One recent tool call, as the handoff lists it. */
export type HandoffAction = {
  seq: number
  tool: string
  path?: string
  /** The call's input summary, when the row carries one. */
  input?: string
  isError: boolean
  head: string
}

/** How many agents the handoff lists before it stops naming them. */
const MAX_AGENTS = 12

/**
 * The state a noted subagent shows once the engine no longer lists it. It is a
 * state of its own, not one the engine uses, so the handoff sorts it last.
 */
export const ENDED_STATE = '已结束'

/** The closing line of the agent section: how to reach one again from a new window. */
const AGENT_FOOTER =
  '要继续某个子代理（已结束的也可以），用 SendMessage 发给它的 id；它的任务原文可用 history 搜索 Agent 或 SendMessage，再按编号读，read 时加 field: "input" 就是完整的任务原文。'

/** Where an agent's state sorts: running first, the ones that already ended last, the rest between. */
const rankOf = (state: string): number => {
  if (state === 'running') return 0
  if (state === ENDED_STATE) return 2

  return 1
}

/**
 * The subagents the handoff names, one line each. Running ones come first, so the
 * ones that still need a decision survive the cap; ended ones come last, in the
 * order the caller gave them. Past the cap a single line says how many were left out.
 */
export const renderAgents = (agents: readonly AgentNote[]): string => {
  if (agents.length === 0) return ''
  const ranked = [...agents].sort((left, right) => rankOf(left.state) - rankOf(right.state))
  const lines = ranked
    .slice(0, MAX_AGENTS)
    .map(agent => `- ${agent.id}（${agent.type}，${agent.state}${agent.cache === undefined ? '' : `；${agent.cache}`}）：${agent.description}`)
  const rest = ranked.length - lines.length
  if (rest > 0) lines.push(`另有 ${rest} 个未列出，用 ListAgents 查看`)

  return ['## 子代理', ...lines, AGENT_FOOTER].join('\n')
}

/** A deferred tool the window used whose first load rebuilt the cache, with the tokens that rebuild rewrote. */
export type RebuiltTool = { name: string; calls: number; rebuilt: number }

/**
 * A rewrite count as the handoff spells it: a plain count under ten thousand, and from
 * ten thousand on in tenths of 万. The rounding is done on whole tokens, so no float
 * error can move a half up or down.
 */
export const rewriteOf = (tokens: number): string => {
  if (tokens < 10_000) return `约 ${Math.round(tokens)}`
  const tenths = Math.round(tokens / 1_000)

  return `约 ${Math.floor(tenths / 10)}.${tenths % 10} 万`
}

/**
 * The deferred tools whose first load rebuilt the cached prefix, one line each, with
 * what the rebuild rewrote. Only these are advised: a load that rebuilt nothing costs
 * little, so the handoff says nothing of it.
 */
export const renderTools = (tools: readonly RebuiltTool[]): string => {
  if (tools.length === 0) return ''

  return [
    '## 加载时会重建缓存的延迟工具',
    ...tools.map(tool => `- ${tool.name}（上个窗口调用 ${tool.calls} 次；上次加载后重写了${rewriteOf(tool.rebuilt)} token）`),
    '这些工具组第一次加载时，整段对话的缓存会重建，上下文越大重写越多。账本的下一步明确要用到其中某组时，在第一步就用一次 ToolSearch 加载它；不确定会不会用到就先不加载，因为加载后每个请求都要多带它的定义。其他延迟工具随用随加载，不必提前。',
  ].join('\n')
}

/**
 * The section that says why this window was switched when the gate held a load back: the
 * switch is for those groups, and the first step of the new window is to load them.
 */
export const renderLoadReason = (groups: readonly string[]): string =>
  groups.length === 0
    ? ''
    : [
        '## 这次换窗口的原因',
        `换窗口是为了加载 ${groups.join('、')}：第一步先用一次 ToolSearch 加载${groups.length === 1 ? '它' : '它们'}，再继续账本里的下一步。`,
      ].join('\n')

export type HandoffInput = {
  window: number
  /** The home page the ledger rendered: requests and open tasks. Never cut. */
  home: string
  /** Why the window was switched, when the gate held a load back, already rendered; never cut. */
  loadReason?: string
  /**
   * What the model last answered, when no task is running: without it a new
   * window sees the request and the actions but not the conclusion. Never cut.
   */
  lastReply?: string
  /** The subagents of the session, already rendered; never cut. */
  agents?: string
  /** The deferred tools whose load rebuilt the cache, already rendered; never cut. */
  tools?: string
  /** What the ledger does not cover, already rendered; never cut, because the actions that would show it can be. */
  coverage?: string
  /** The file working set and the snippets taken from disk at the switch. */
  workset: string
  actions: readonly HandoffAction[]
  /**
   * The switch cut a running turn (an automatic compaction): the model must
   * go on with what it was doing, not wait to be asked.
   */
  isMidTurn: boolean
}

/** What the model reads first in a new window. */
export const openingOf = (window: number, isMidTurn: boolean): string =>
  [
    `这是第 ${window} 个窗口，上一个窗口的对话不在上下文里。下面是代码生成的交接信息。`,
    '「待改位置」里的文件片段是刚刚从磁盘读出的最新内容，带行号，可以直接据此修改，不需要重新读取整个文件。标了“需重读”的位置，或片段不够用时，用带偏移和长度的读取，只读需要的部分。',
    '不要重做账本里已完成的任务。需要之前的工具输出原文时用 history 工具按 #编号 读取。',
    '之前跑过的命令和读过的文件，输出都在历史里：需要时先用 history 按命令或文件名搜索，再按 #编号 读取（命令的完整原文加 field: "input"），不要重跑同样的探测命令。',
    isMidTurn
      ? '上一个窗口是在任务进行中被切走的：不要等待新的指示，按「进行中的任务」里的下一步和「最近的动作」接着做。'
      : '先用一句话复述当前请求和现在的进度，然后继续。',
  ].join('\n')

/** The stretch of work after the latest ledger entry, as the handoff owns up to it; empty when nothing is uncovered. */
export const renderCoverage = (tail: { steps: number; from: number | null; to: number | null; entrySeq: number | null }): string => {
  if (tail.steps <= 0) return ''
  const range = tail.from === null || tail.to === null ? '' : `（#${tail.from}–#${tail.to}）`
  const body =
    tail.entrySeq === null
      ? `上个窗口里没有记过账，有 ${tail.steps} 个工具结果${range}只在历史里。开工前先用 history 读最近的用户请求和这些结果，不要凭印象继续。`
      : `最近一次记账（#L${tail.entrySeq}）之后还有 ${tail.steps} 个工具结果没有记进账本${range}。它们的结论账本里没有：最近的那些列在“最近的动作”里，需要细节时用 history 按编号读原文，不要凭印象继续。`

  return ['## 账本没覆盖到的部分', body].join('\n')
}

/** The last tool calls, oldest first, one line each. */
export const renderActions = (actions: readonly HandoffAction[]): string =>
  actions.length === 0
    ? ''
    : [
        '## 最近的动作',
        ...actions.map(
          action =>
            `- #${action.seq} ${action.tool}${action.input === undefined ? '' : ` ${action.input}`}${action.path === undefined ? '' : ` ${action.path}`}${action.isError ? '（失败）' : ''}：${action.head}`,
        ),
      ].join('\n')

/**
 * The one message a new window opens with. `handoffTokens` is a target, not a
 * ceiling: the recent actions go first, then the working set is cut from its end,
 * but the opening, the home page, the last reply, the subagents and the loaded
 * tools always stay, since they carry the request, the open tasks, the conclusion
 * and how to pick them up — so the total can run past it. What the open tasks add
 * is bounded by the home page (`MAX_FULL_ACTIVE` in ledger.ts), not by this cap.
 */
export const assemble = (input: HandoffInput, config: Config): string => {
  const opening = openingOf(input.window, input.isMidTurn)
  const reply =
    input.lastReply === undefined || input.lastReply.trim() === ''
      ? ''
      : `## 上一次助手的最后回复\n${input.lastReply}`
  // The agents list and the loaded tools ride beside the home page and the last
  // reply: they are what the model needs to pick work back up, so like them they
  // are never cut.
  const agents = input.agents ?? ''
  const tools = input.tools ?? ''
  const loadReason = input.loadReason ?? ''
  const coverage = input.coverage ?? ''
  const join = (workset: string, actions: string): string =>
    [opening, input.home, reply, agents, loadReason, tools, coverage, workset, actions].filter(part => part !== '').join('\n\n')
  const actions = renderActions(input.actions)
  const whole = join(input.workset, actions)
  if (estimateTokens(whole) <= config.handoffTokens) return whole
  const withoutActions = join(input.workset, '')
  if (estimateTokens(withoutActions) <= config.handoffTokens) return withoutActions
  const fixed = estimateTokens(join('', ''))
  const note = '\n（交接信息超出上限，其余片段已省略：用带偏移的读取查看）'
  let room = Math.max(0, config.handoffTokens - fixed - estimateTokens(note))
  const kept: string[] = []
  for (const line of input.workset.split('\n')) {
    const cost = estimateTokens(line) + 1
    if (cost > room) break
    room -= cost
    kept.push(line)
  }
  // A fence left open would swallow whatever the model reads next.
  const open = kept.filter(line => line.startsWith('```')).length % 2 === 1
  const cut = kept.length === 0 ? '' : `${kept.join('\n')}${open ? '\n```' : ''}${note}`

  return join(cut, '')
}
