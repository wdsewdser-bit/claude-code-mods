# 任务说明：让换窗口后的模型不必重新摸底

M = `C:\Users\yadaz\.claude\skills\ctx-mod`（注意：mod 已从 dev-mods 移到这里，旧路径不存在了）

## 背景（真实会话里观察到的）

一个真实会话在 266k 时换了窗口。换完后模型没有直接接着干，而是先跑了十来条命令重新摸情况，80 秒内又写了约 4.5 万 token 缓存。原因有四个，对应下面四条：

1. 交接信息的"最近的用户请求"第一条是一段 `<system-reminder>…` 的会话启动钩子文本（约 2000 字符），被当成了真人请求。
2. 历史里 Bash、Grep 这类工具行只存了结果，没存命令。模型在"最近的动作"里看不出哪条编号是什么，也没法按命令搜，于是把以前跑过的探测命令又跑了一遍。
3. 当时有三个子代理在跑，交接信息里完全没提，模型只能调 `ListAgents` 再去翻目录。
4. 提示语没有引导模型"先查历史，不要重跑"，也没有要求换窗口前把子代理和关键事实写进账本。

## 共同规则

- 只改下面点名的文件。不运行 `claude -p`，不做 git 操作，不加依赖，不删除或放宽已有测试（断言的文案因本次改动而变化时可以同步更新，并在报告里列出）。
- 风格与现有文件一致：无分号、单引号、2 空格、箭头函数、`import type`；导出项和不显然的分支上方写一句英文注释说明"为什么"。
- 运行环境没有 Node 也没有 DOM。不改变已有导出的签名；可以新增可选字段和新导出。
- 旧数据兼容：磁盘上已有的 history 行没有新字段，读到时必须正常工作。
- 验证（必须真的跑）：
  1. `claude plugin test "C:\Users\yadaz\.claude\skills\ctx-mod"`：全部通过（现在是 185 个）。
  2. `npx --yes -p typescript tsc -p "C:\Users\yadaz\.claude\skills\ctx-mod"`：0 错误。
  3. `claude plugin validate --strict "C:\Users\yadaz\.claude\skills\ctx-mod"`：通过。
- 时间约 9 分钟。按 D1 到 D4 的顺序做，每做完一条就落盘并跑一次测试。到第 7 分钟左右无论做到哪都停下来汇报。
- 返回：第一行 `TASK_TERMINAL: completed|blocked|failed`；每条怎么改的；没做的条目；测试通过和失败数；tsc 和 validate 结果；遗留问题。

## D1. 真人请求的识别

文件：`hooks\lib\session.ts`、`hooks\register.ts`、`tests\session.test.ts`、`tests\register.test.ts`。

- `session.ts` 新增导出纯函数 `stripInjected(text): string`：反复去掉文本开头的 `<system-reminder>…</system-reminder>` 块（及其后的空白），返回剩余部分的 trim 结果。没有闭合标签时原样返回。
- `register.ts` 的 `session.append`（door 为 `prompt`）：判定真人时，在现有条件之外再要求 `looksLikePerson(stripInjected(text))` 为真且剥离后非空。记录的 `text` 仍存原文（历史要完整）。
- `session.ts` 里渲染"最近的用户请求"用到的文本（`personRequests` 的结果进入 `renderHome` 之前）先过一遍 `stripInjected`，这样旧数据里带前缀的请求也只显示真人写的部分。
- `importMessages` 里判断真人同样先 `stripInjected`。
- 测试：纯 `<system-reminder>` 文本不算真人；`<system-reminder>x</system-reminder>\n\n帮我改文件` 算真人，交接信息里只出现"帮我改文件"；`stripInjected` 的正反例（多个块、无闭合）。

## D2. 历史行记下工具的输入摘要

文件：`hooks\lib\types.ts`、`hooks\lib\history.ts`、`hooks\lib\session.ts`、`hooks\lib\handoff.ts`、`hooks\register.ts`，以及对应测试文件。

- `HistoryRecord` 和 `RecordInput` 新增可选字段 `input?: string`：工具调用输入的一行摘要，最多 300 个字符。
- `register.ts` 新增函数 `briefOf(tool, input): string | undefined`，在 `session.append` 的 `tool-result` 分支和导入旧对话的映射里都用它：
  - `Bash`、`PowerShell`：`command`（把连续空白压成一个空格）。
  - `Grep`、`Glob`：`pattern`，有 `path` 时后面加 ` in <path>`。
  - `Agent`：`<subagent_type>: <description>`。
  - `SendMessage`：`to <to>: <summary 或 message 的前 120 字符>`。
  - `ToolSearch`、`WebSearch`、`WebFetch`：`query` 或 `url`。
  - 其他工具：返回 undefined（Read、Edit、Write 已有 `path`）。
  - 统一截到 300 字符。取字段时都做 `typeof === 'string'` 检查。
- `history.ts` 的 `search`：`query` 匹配时把 `input` 也算进去；搜索结果每条的展示行里带上 `input`（放在工具名之后）。
- "最近的动作"（`recentActions` 和 `handoff.ts` 的 `renderActions`）：有 `input` 时显示它。先读现有的 `HandoffAction` 结构再决定怎么加，保持一行一条。
- 测试：带 `input` 的工具行能被 `history` 按命令里的词搜到；`renderActions` 输出含命令摘要；没有 `input` 的旧行照常工作；`briefOf` 的几种工具各一个例子（`briefOf` 需导出以便测试，或通过 register 测试间接断言）。

## D3. 交接信息带上子代理

文件：`hooks\lib\handoff.ts`、`hooks\lib\session.ts`、`hooks\register.ts`，以及对应测试文件。

- 引擎有 `$.agent.list()`，返回 `AgentInfo[]`。类型在 `M\.claude-plugin\types\claude-code\index.d.ts`，搜 `export type AgentInfo` 读完整字段（id、description、agent 类型、状态等），按实际字段写。
- `session.ts` 声明最小结构（不要从 `'claude-code'` 引类型进 lib），例如 `export type AgentNote = { id: string; type: string; description: string; state: string }`，字段按 AgentInfo 实际能提供的来定。`buildHandoff` 的参数新增可选 `agents?: readonly AgentNote[]`。
- `HandoffInput` 新增可选 `agents?: string`（已渲染的文本）。`assemble` 把它放在 `home`（及 `lastReply`）之后、`workset` 之前，标题 `## 子代理`，为空不出。与 `home` 一样不参与裁剪。
- 渲染：每个子代理一行 `- <id>（<type>，<state>）：<description>`；最多 12 个，运行中的排前面，超出的写一行 `另有 N 个未列出，用 ListAgents 查看`。节末固定加一行：`要继续某个子代理，用 SendMessage 发给它的 id；它的任务原文可用 history 搜索 Agent 或 SendMessage。`
- `register.ts`：`session.compact` 钩子里两处调用 `buildHandoff` 之前，取一次 `$.agent.list()`（包在 try 里，失败当作空列表），映射后传入。
- 测试：有子代理时交接信息含这一节且位置正确；没有时不含；超过 12 个时有"另有"行；register 测试里底座的 `agent.list` 返回一个代理，自动压缩（账本新鲜）得到的交接信息含它的 id。

## D4. 提示语

文件：`hooks\lib\handoff.ts`、`hooks\register.ts`，以及因文案变化需要同步的测试。

- `openingOf` 的开头说明里加一句（两种开头都加）：`之前跑过的命令和读过的文件，输出都在历史里：需要时先用 history 按命令或文件名搜索，再按 #编号 读取，不要重跑同样的探测命令。`
- `prompt.compose` 钩子里固定的那段系统提示，加上换窗口前的要求（并入现有文字，保持简短）：申请换窗口之前，先用 ledger_append 把进行中任务的进度写清楚，`text` 里写明后面要用到的关键事实（产物路径、已确认的结论、约定的参数），有子代理在跑时写明各自的 id、负责什么、产物放哪。
- `context` 工具在 `action: 'new'` 被批准时返回的文字不用改。
