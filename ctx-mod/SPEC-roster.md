# 任务说明：交接信息里的子代理名单要包含已经结束的子代理

M = `C:\Users\yadaz\.claude\skills\ctx-mod`

## 背景（真实引擎上验证过的事实）

- 交接信息的“子代理”一节现在只来自 `$.agent.list()`。真实引擎上它只列出换窗口那一刻还在跑的子代理；已经结束的不在里面。
- 已结束的子代理仍然可以用 SendMessage 按 id 续用，所以新窗口需要知道它们的 id、类型和任务描述。现在只能靠模型自己写进账本。
- 引擎有 `agent.spawn` 钩子：`on('agent.spawn', ($, e, next) => …)`。`e`（`AgentSpawnInput`）有 `description`、`subagentType`、`model?`、`parentAgentId?`（主循环派的没有这个字段）、`background`、`fork`；`await next(e)` 的结果（`AgentSpawnResult`）有 `agentId?`、`model`，或者是 `{ deny }`。类型在 `M\.claude-plugin\types\claude-code\index.d.ts` 第 270–440 行，只读这一段。
- `turn.complete` 钩子对子代理的回合也会触发，事件带 `agentId`。`hooks\register.ts` 里现有的 `turn.complete` 钩子开头有 `if (e.agentId !== undefined) return next(e)`。

## 共同规则

- 只改下面点名的文件。不运行 `claude -p`，不做 git 操作，不加依赖，不删除或放宽已有测试（断言的文案因本次改动而变化时可以同步更新，并在报告里列出）。
- 风格与现有文件一致：无分号、单引号、2 空格、箭头函数、`import type`；导出项和不显然的分支上方写一句英文注释说明“为什么”。
- 运行环境没有 Node 也没有 DOM，lib 里不要 import `node:*`，也不要从 `'claude-code'` 引类型进 `hooks\lib`。不改变已有导出的签名；可以新增可选字段和新导出。
- 旧数据兼容：磁盘上已有的 `meta.json` 没有新字段，读到时当作空名单。
- 钩子绝不能影响派发本身：`agent.spawn` 钩子里先 `const result = await next(e)`，记录放在 try 里，出错只记日志（照 `register.ts` 里 `logError` 的用法），最后原样返回 `result`。mod 未启用（`enabled` 为假）时直接 `return next(e)`。
- 先读齐再动手：`hooks\lib\session.ts` 第 80–90 行（`AgentNote`）、第 190–310 行（状态、默认值、从 meta 恢复）、第 390–410 行（写 meta）、第 974–1030 行（`buildHandoff`）；`hooks\lib\handoff.ts` 第 16–40 行（`renderAgents`）；`hooks\register.ts` 里 `agentsOf`（约第 157 行）、`turn.complete` 钩子（搜 `on('turn.complete'`）、`session.compact` 钩子里两处 `buildHandoff` 调用。其余按需 Grep，不通读 `session.ts` 和 `register.ts`。
- 验证（三条都要真的跑，用 PowerShell；测试输出只看末尾计数和失败用例）：
  1. `claude plugin test "C:\Users\yadaz\.claude\skills\ctx-mod"`：全部通过（现在是 213 个，只能增加）。
  2. `npx --yes -p typescript tsc -p "C:\Users\yadaz\.claude\skills\ctx-mod"`：0 错误。
  3. `claude plugin validate --strict "C:\Users\yadaz\.claude\skills\ctx-mod"`：通过。
- 返回：第一行 `TASK_TERMINAL: completed|blocked|failed`；怎么改的（文件和函数名）；没做的条目；测试通过和失败数；tsc 和 validate 的结果；同步改过文案的已有断言；遗留问题。有任何一条验证没跑或没过，就不能报 completed。

## E1. 会话里记一份派发名单

文件：`hooks\lib\session.ts`、`tests\session.test.ts`。

- 新增导出类型 `AgentSeen = { id: string; type: string; description: string; model?: string; window: number; ts: number; ended?: boolean }`。
- 会话状态新增 `roster: AgentSeen[]`，随 `meta.json` 落盘和恢复（照 `activities` 的写法；恢复时逐项做类型检查，不合格的项丢掉；缺字段当作 `[]`）。最多保留最近 50 个，超出丢最旧的。
- `Session` 新增两个方法（名字可按现有命名习惯调整）：
  - `noteAgent(input: { id: string; type: string; description: string; model?: string }): Promise<void>`：按 id 新增或更新，`window` 取当前窗口，`ts` 取当前时间（用文件里已有的取时间方式）；已存在时只更新 `type`、`description`、`model`，并清掉 `ended`。写 meta。
  - `agentEnded(id: string): Promise<void>`：名单里有这个 id 且还没标 `ended` 时标上并写 meta；没有这个 id 时什么也不做。
- 测试：记两个 → 重新打开会话后名单还在；同 id 再记一次不产生重复；`agentEnded` 生效且对未知 id 无副作用；旧 meta（没有 `roster` 字段）能正常打开。

## E2. 钩子接入

文件：`hooks\register.ts`、`tests\register.test.ts`。

- 新增 `on('agent.spawn', …)`：`next(e)` 的结果里 `agentId` 是非空字符串、且 `e.parentAgentId === undefined`（只记主循环派的，嵌套的主循环续不了）、且 `e.fork !== true` 时，调用 `session.noteAgent({ id, type: e.subagentType, description: e.description, model: result.model })`。
- 现有 `turn.complete` 钩子：在 `if (e.agentId !== undefined) return next(e)` 这个提前返回里，先尽力调用 `session.agentEnded(e.agentId)`（放在 try 里，失败只记日志），再照旧 `return next(e)`。不要改变这个钩子对主循环回合的任何行为。
- 测试：看 `tests\register.test.ts` 现有底座怎么触发钩子。能触发 `agent.spawn` 就写：派一个（`next` 返回 `{ model: 'haiku', agentId: 'a1' }`）→ 子代理的 `turn.complete`（带 `agentId: 'a1'`）→ 自动压缩得到的交接信息里有 `a1` 且标着已结束；`parentAgentId` 有值的派发不进名单；`next` 返回 `{ deny }` 时不进名单且返回值原样。底座确实触发不了某个钩子时，在报告里写明哪个触发不了、试了什么，并保证 E1 和 E3 的测试覆盖到逻辑。

## E3. 交接信息合并两份名单

文件：`hooks\lib\session.ts`、`hooks\lib\handoff.ts`、`tests\handoff.test.ts`、`tests\session.test.ts`。

- `buildHandoff` 里把 `opts.agents`（引擎当前列出的）和 `state.roster` 合并后再交给 `renderAgents`：
  - 引擎列出的照旧，状态用引擎给的。
  - 名单里有、引擎没列出的：加进去，`state` 写 `已结束`。
  - 同一个 id 两边都有：以引擎的为准，只出现一次。
- `renderAgents` 的排序改为：`running` 的最前，其次引擎列出的其他状态，最后是 `已结束` 的；`已结束` 的之间按名单里的 `ts` 从新到旧。排序所需的信息怎么传由你定（例如先在 `session.ts` 里排好再传，`renderAgents` 只保证 `running` 在前且其余保持传入顺序，这样已有测试不用改）。上限仍是 12 个，超出仍是那一行“另有 N 个未列出，用 ListAgents 查看”。
- 一行的格式不变：`- <id>（<type>，<state>）：<description>`。节末那句续用说明改为：`要继续某个子代理（已结束的也可以），用 SendMessage 发给它的 id；它的任务原文可用 history 搜索 Agent 或 SendMessage。` 同步更新断言了旧句子的已有测试，并在报告里列出。
- 测试：引擎列表为空、名单有两个 → 交接信息有“子代理”一节，两行都标 `已结束`，新的在前；引擎列出一个 running、名单里有同 id 和另一个已结束的 → 共两行，running 在前、同 id 不重复；两边都空 → 没有这一节。
