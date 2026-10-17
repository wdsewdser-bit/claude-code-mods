# ctx-mod 开发记录

计划见 `proactive-context-plan-v2.md`。本文件是唯一台账：先是当前进度，后面是第 0 阶段各项的结论和证据。

## 台账（2026-10-13 更新）

**目标与授权**：按计划实现 ctx-mod。用户要求：2026-10-13 前执行工作派给第三方模型（`delegate_flash` / `delegate_pro`），因为那份订阅到期前额度用不完；到期后恢复 CLAUDE.md 的默认做法（Haiku 子代理）；真实会话测试只用 Haiku 5.5；不擅自提交；cache-keeper 可以改（已升 0.4.1）。

**结构**：纯逻辑放 `hooks/lib/*.ts`，测试放 `tests/*.test.ts`，引擎接线在 `hooks/register.ts`（目前还是第 0 阶段的探针）。共享类型在 `hooks/lib/types.ts`，由主会话维护，执行者不改。

**当前步骤（2026-10-13）**：审查 12 条基本已处理（见 NOTES 第 十 至 二十 节与 REVIEW-astra-2026-10-11.md）。剩余：真实引擎验证（需要重启已开会话）；costly.json 加锁与冷缓存测试（本轮派发）；交接路径相对化（本轮派发）；数据保留（30 天，已有脚本 scripts/prune-sessions.ps1，未配置计划任务）。默认不启用，`CTX_MOD=1` 才启用。

端到端实测（2.1.296，Haiku 5.5，无头，压缩窗口压到 100k 以便触发）：
- 工具结果末尾带 `[#编号]`，历史落盘到 `history-w001.jsonl`。
- 模型写账本：第一次 `request_ref` 填错被校验拒绝，改正后记入；锚点经磁盘核对。
- 用量到 70% 时提醒在回合内送达，模型随即记账并申请换窗口，获批。
- 自动压缩（67.7k）由 mod 接管：换成约 1.2k token 的交接信息，耗时 7 ms，无摘要请求。
- 新窗口里模型没有等指示，用 `history` 读回编号、带偏移只读了 2 行，把任务接着做完。
- 交接信息存成 `handoff-w002.md`，内容含两条用户请求原文、进行中任务和下一步、从磁盘现读的带行号片段、最近的动作。

实测中发现并已修的问题：
1. 同一模块里同一事件只能有一个不带 matcher 的钩子，`validate` 是静态检查，分支里二选一也不行。探针因此从模块里移出，存为 `phase0/probe.ts.txt` 和 `phase0/probe.test.ts.txt`，不再加载。
2. 自有工具的 matcher 在类型里不存在，要写成字面量加断言：`{ tool: 'mcp__ctx-mod__context' as never }`。
3. 工具参数和信封字段混在 `e` 上，`tool`、`tool_use_id`、`agentId` 等会被当成参数。接线层现在先剥掉信封字段；`history` 工具的过滤参数从 `tool` 改名为 `tool_name`。
4. `session.append` 里无头会话的用户消息来源是 `unclassified`（`prompt.submit` 里才是 `sdk`）。现在在提交时认人，落盘时按文本对上。
5. 模型获批换窗口后、回合结束前被自动压缩抢先：窗口已换但没人发"继续"。现在回合结束时会补发。

第二轮审查与测试（2026-10-10 深夜，都由第三方模型前台完成）：
- `tests/register.test.ts`：13 个测试。现在共 169 个测试通过，`tsc` 0 错误，`validate --strict` 通过。
- `session.ts` 和 `register.ts` 的只读审查报了 12 条，说明在 `SPEC-review2.md`，修复说明在 `SPEC-fix2.md`，全部已修：子代理守卫失效（确认，是主会话加 `argsOf` 时引入的）；压缩失败后 pending 不清、此后 120 秒工具全被拒（确认）；重载后交接信息丢掉最近的用户请求（确认）；同步读取在加载前返回默认值（新增 `ready()`，`sessionOf` 里已接上）；模块级状态跨会话残留；`events.jsonl` 丢行；冷缓存重新提交失败时消息静默丢失；重复申请顺延 pending 等。
- 修复后重跑端到端（Haiku 5.5）：用户手动 `/compact` 走"核心摘要加交接"那条路，46,396 → 3,964 token；之后模型按账本直接 Edit、没有先 Read，改对了；标 done 时 evidence 填 Edit 结果的编号，校验通过。

还没做的：
- 模型主动申请换窗口后正常走到回合结束的那条路（不被自动压缩抢先）只在假引擎和套件里验证过；冷缓存规则和翻页没有在真实引擎上跑过。
- 第二轮修复里，冷缓存路径的两处（A4、A5）只改了代码，没有测试。
- 交接信息里的路径是绝对路径，很长，可以改成相对工作目录。
- 桌面应用和终端交互会话没测。
- 数据保留：会话目录保留 30 天，由 `scripts/prune-sessions.ps1` 手动执行（默认 dry run，`-Apply` 才删），mod 本身不删文件。

delegate 的经验：后台模式（`background: true`）在这一晚后半段连续失败（报 `unrecognized_model`），前台模式一直正常；长任务前台会在约 9 分钟超时，用 `resume` 续。

下面是之前的模块分工记录。

| 模块 | 档位 | agent（可 resume） | 状态 |
|---|---|---|---|
| `usage.ts` 阈值、切换判断、冷热、放行 | flash | 91b4f517-5221-485a-873d-46cf83105f5a | 完成，15 个测试 |
| `history.ts` 分片、搜索、读取、串行写队列 | flash | bd8799ce-ad87-48b0-b883-512be7d96ae8 | 完成，27 个测试 |
| `ledger.ts` 校验、盖章、首页、翻页 | pro | a4e33138-7d86-472c-a7c4-887affed9a60 | 完成，25 个测试 |
| `workset.ts` 文件活动、锚点定位、片段 | pro | 70e23feb-04e1-494b-9db1-39831c6a979e | 完成，38 个测试 |
| `handoff.ts` 拼交接信息 | 主会话 | — | 完成，3 个测试 |
| 四个库模块的只读审查 | pro | f4c2a68d-9539-4235-a199-238f6f443dfb | 完成，9 条发现（3 条确认的真缺陷），报告在 `~/.claude/delegate/results/bg-mv2l9l2a.md` |
| `session.ts` 每会话状态 | pro | 无（见下） | 文件完整，17 个测试通过；代理收尾时报错，没有交报告 |
| 审查后的修复：ledger / history / workset | pro / flash / pro | 后台 bg-mv2ln48u / bg-mv2lnet0 / bg-mv2lnmyv（续用原 agent） | 进行中 |
| `register.ts` 引擎接线，探针搬到 `probe.ts` | pro | 后台 bg-mv2lpvdq | 进行中 |

**已知情况**：`session.ts` 那个任务最后报 `unrecognized_model: deepseek/deepseek-v4.1-flash` 并显示"0 秒失败"，但文件已写完且全部测试通过（128 个）、`tsc` 0 错误。失败发生在收尾阶段，原因未查明；delegate 报失败时先核对文件再决定是否重派。它的实现没有独立审查过。

**下一步**：
1. 代码包（costly.json 加锁、冷缓存测试、交接路径相对化）回来后验收：`tsc`、测试全量、`validate --strict`。
2. 重启已开会话后，用无头会话加 Haiku 5.5 做端到端测试（设 `CTX_MOD=1`）：工具结果带编号、账本校验、回合内提醒、模型申请换窗口后凭片段直接改文件、自动压缩接管。
3. 在桌面应用里实测一次换窗口（需要用户在一个可丢弃的会话里做）。
4. 数据保留（已定 30 天）：`scripts/prune-sessions.ps1` 已写，默认 dry run，`-Apply` 才删；2026-10-13 dry run 结果为 0 个目录待清理。已归档：不配置计划任务，保留期只靠手动执行脚本。

正式功能默认不启用，环境变量 `CTX_MOD=1` 才启用，避免开发中的代码影响已热加载本 mod 的日常会话。

**验证命令**：
- `claude plugin test <mod 目录>`、`claude plugin validate --strict <mod 目录>`、`npx -p typescript tsc -p <mod 目录>`
- 无头驱动脚本在本会话的临时目录里（`drive.mjs`），会话结束即丢；需要时按本文件"证据来源"一节的命令行重写。

## 证据来源

2026-10-10，Claude Code 2.1.296，模型 Haiku 5.5，**无头会话**（`claude -p --input-format stream-json`，一个进程里连发多条消息），同时加载 ctx-mod 探针和 cache-keeper 0.4.1。每条结论都来自 `/ctx-probe` 的日志（`~/.claude/ctx-mod/probe-<会话id>.jsonl`）或会话输出。

没有覆盖的环境：终端交互会话、桌面应用会话、Opus、真正到 400k 的上下文。下面凡是和宿主类型有关的结论，换环境后要复核。

## 结论

| # | 结论 |
|---|---|
| T1 | mod 自己调 `$.session.compact()`，自己的 `session.compact` 钩子不跑（测试套件）。而且这个调用在无头会话里直接被拒："not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt)" |
| **换窗口的做法** | **mod 调 `$.command.run({ command: 'compact' })`**。压缩以 `trigger: "manual"` 进来，**自己的钩子会跑**，返回一条交接消息即可。实测 43,696 → 39 token，耗时 4 ms，没有摘要请求。不需要伴生 mod |
| T2 | `$.command.run` 和 `$.prompt.submit` 在 `turn.complete` 钩子里（`next` 之后）可以直接调；在 `command.run`、`prompt.submit` 钩子里调会被拒（引擎提示改到 `turn.complete`），从 `$.clock.after` 定时器里调可以 |
| 全流程 | 回合结束 → `/compact`（mod 回答）→ `$.prompt.submit` 续跑 → 模型在新窗口里回复。跑通。切换后第一次请求：读 29,946，写 3,070 |
| T3 | 在 `prompt.submit` 里不能直接压缩。可行的做法：钩子返回 `{ drop }` 扣下这条提示，定时器里压缩，再用 `$.prompt.submit({ text, asUser: true })` 重新提交。跑通。副作用：界面上会出现一行 "Prompt dropped by a hook" |
| T4 | mod 回答压缩后，引擎**不会**自动补最近读过的文件。新窗口里只有第一条消息的上下文块（CLAUDE.md 等）和交接消息 |
| T5 | 换窗口后，对新窗口里没读过的文件直接 Edit 成功（工作目录内）。工作目录外没测 |
| T6 | `CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000`：`rawMaxTokens` 400,000，`autocompactSource` `env`，`autoCompactThreshold` **367,000**（窗口减 33,000）。设 60000 会被抬到 100,000。`context.percent` 按模型窗口（Haiku 5.5 是 1,000,000）算，44k 时显示 4% |
| T7 | `context.tokens` 在一个回合内随每次响应更新（41,674 → 43,882 → 44,434） |
| T8 | 回合中 `$.session.append` 的用户行进入本回合的下一次请求，模型当回合就看到了 |
| T9 | **子代理看得到并能调用 mod 注册的工具**，调用时带 `agentId`。账本工具必须拒绝带 `agentId` 的调用 |
| T10 | `/clear`：`session.end`（`reason: "clear"`）→ 新会话 id → `classic.SessionStart`（`source: "clear"`）。每次压缩后也会触发 `classic.SessionStart`（`source: "compact"`）。`/resume`、`/branch` 没测 |
| T11 | `$.fs` **不展开 `~`**，会在当前目录下建一个名叫 `~` 的文件夹。数据目录用 `USERPROFILE` / `HOME` 拼 |
| T12 | 默认外框是 "The ctx-mod plugin sent a message:\n<正文>\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns…"。`asUser: true` 时只有正文。两种都会起一个回合 |
| T13 | `claude plugin validate --strict` 存在，把警告当错误 |
| T15 | 别的 mod 能钩到 cache-keeper 的 `model.fork`。保活不改变 `context.tokens` |
| T16 | `$.state` 跨 mod 可读：读到了 cache-keeper 0.4.1 发布的 `lastActivityAt`、`ttl`、`expiresAt`、`cachedPrefixTokens` 等 |
| T17–T19 | 换窗口后 cache-keeper 按新窗口重新记前缀（34k，低于它 4 万的下限，显示 `prefix-too-small`）；之后的 fork 读的是新窗口（34,225），不是旧的大前缀；上下文涨回 4 万以上后恢复排程 |
| 自动压缩 | 内置自动压缩（`trigger: "auto"`）触发时 mod 的钩子能回答：72,787 → 39 token，5 ms。**它发生在回合中间**，模型随后只看到交接消息 |
| 来源口径 | 无头会话里用户消息的 `origin.kind` 是 `sdk`，不是 `composer` |

## 对设计的影响

1. 换窗口统一走 `$.command.run({ command: 'compact' })`，由 ctx-mod 的 `session.compact` 钩子回答。主动切换、冷缓存切换、自动压缩接管是同一个钩子，按 `trigger` 区分。
2. 自动压缩发生在回合中间，所以交接信息必须自带"当前请求原文、正在做的步骤、下一步"，否则模型会丢下手头的任务。探针里的测试就是这样：模型读到一半被压缩，之后只回了一句 HANDOFF-SEEN。
3. 计划里"`isInteractive` 为 false 就不主动切换"要删掉。无头会话里整套流程都能跑；桌面应用按文档也属于这类宿主。
4. "真人请求"的口径是 `composer`、`bridge`、`sdk`。
5. 账本工具要拒绝子代理调用。
6. 阈值分母用 `autoCompactThreshold`（400k 窗口下是 367k），不用 `context.percent`。

## 还没验证的

- 终端交互会话和桌面应用里 `$.command.run({ command: 'compact' })` 的行为。预期一致，没跑过。
- `/resume`、`/branch` 后的会话 id 和状态。
- 工作目录外的文件在换窗口后能否直接 Edit。
- Opus 加几十万 token 上下文下的表现（只在 Haiku 4 万到 7 万 token 上跑过）。
- T14 前缀保留实验。

## 2026-10-11 全局启用 + 旧会话支持

- 位置变更：mod 已从 dev-mods 移到 `~/.claude/skills/ctx-mod`（唯一一份）。`~/.claude/settings.json` 的 env 加了 `CTX_MOD=1`，备份在 `settings.json.bak-ctxmod`。关闭：把该值改成 0 或删掉。
- 新增（SPEC-bootstrap.md，delegate pro agent 208c73bb-ac00-46a5-8dcc-c9202195f9b9）：C1 首次加载时用 `$.session.messages()` 导入旧对话；C2 交接信息带"上一次助手的最后回复"（无进行中任务时）；C3 `/ctx-mod switch` 手动零摘要换窗口。
- 已验证：184 测试、tsc 0、validate --strict；真实引擎（Haiku 5.5）：不带 mod 建会话 f4370f6e → 带 mod 恢复 → `/ctx-mod switch`：45,193 → 589 token，26ms，无模型调用；新窗口不读文件答出上次的请求、方案和文件原文。从 skills 目录加载、settings 的 CTX_MOD 生效也已确认。
- 未覆盖：`mine` 零摘要分支在测试套件里测不了（套件拒绝 `$.session.compact`），只有上面这次真实运行。大会话（数百 k、上千条消息）的导入耗时和 4096 条上限没实测。旧会话恢复后的冷缓存自动路径不会触发（导入的消息没有时间），需要手动 `/ctx-mod switch`。
- 下一步：用户在真实桌面会话试用；phase 9 评估未做。

## 2026-10-11（二）真实会话反馈后的修复

- 400 错误：给 ToolSearch 结果（tool_reference 块）追加编号导致 API 拒绝。已改为只给纯文本结果编号。
- 真实会话 089d6739 换窗口（266k→5k）核查：缓存命中（读 50,621，写 13,666）；额度上涨来自三个 Sonnet 子代理和换窗口前的 4 万 token 输出。但换窗口后模型重新摸底，80 秒写了约 4.5 万。
- SPEC-handoff2.md（delegate pro agent 69d6a524-11ca-4d0d-af05-3764a00139eb）：D1 system-reminder 不再算真人请求；D2 历史行记工具输入摘要（可按命令搜、动作里显示）；D3 交接信息带子代理一节（$.agent.list()）；D4 提示语引导先查历史、换窗口前把关键事实和子代理写进账本。
- 已验证：197 测试、tsc 0、validate --strict；真实引擎（Haiku 5.5，会话 7a55a913）换窗口后不重跑 Grep 直接答对，交接信息含命令摘要。
- 未验证：子代理一节在真实引擎里的表现（测试会话没有子代理）；真实大任务换窗口后重新摸底的量是否下降，需要用户下次换窗口后看数据。

## 2026-10-11（三）真实会话 089d6739 评估

- 三次换窗口：15:07（旧代码）换后前 7 个请求重新摸底；15:50、16:18（新代码）换后 0–1 步接着干，无重复探测。交接信息 4958→4221→2394 token，换窗口 20–51ms，换后基础前缀缓存命中。
- history 用了 9 次并命中（例：16:01 四次调用找回 render_mix.py / render_mv.py 的命令行）。
- 问题 1（引擎行为）：ToolSearch 加载 computer-use 工具后整段消息缓存重建，15:49:47 写 202.7k、16:27:28 写 117.4k，占第 2–4 窗口写入 35%。其他 ToolSearch 加载没有这个现象。
- 问题 2：交接信息每个任务只显示最新一条账本，但超 1500 字又要求拆条，16:18 换后模型先读了两次账本。
- 问题 3：ctx-mod 自己的工具调用进了“最近的动作”（w004 里 10 条占 5 条）和 history 搜索结果。
- 问题 4：w003/w004 没有“子代理”一节；当时三个子代理已结束，原因无法区分，仍未在真实引擎验证。
- 待用户确认的修改：A 多条账本、B 排除自身工具行、C 交接信息列出上个窗口用过的延迟工具族、D 真实验证子代理一节。
- 分析脚本：scratchpad 的 after.mjs（每次换窗口后的调用与缓存）、probe.mjs（边界、ctx-mod 工具调用、平均上下文）。

## 2026-10-11（四）SPEC-handoff3：A/B/C 已实现并真实验证

- 实现：worker 子代理 a4422c4c2046e09a0（Haiku）。A `ledger.ts` 的 `windowNotesOf` + `renderHome`；B `types.ts` 的 `OWN_TOOL_PREFIX`、`history.ts` 的 `isOwnRow`（`recentActions`、`search`）；C `loaded` 字段、`history.ts` 的 `loadedTools`、`handoff.ts` 的 `renderTools`、`register.ts` 的 `toolReferencesOf`。
- 验收（主会话复跑）：`claude plugin test` 213 过 0 败（原 197），tsc 0，validate --strict 通过。
- 真实引擎（Haiku 会话 18fa2edd-3433-467b-b101-3bd36d9d3de9，步骤文件 scratchpad\d1.json）：换窗口 48587→377。交接信息含两条 demo 账本（#L1、#L2）、“子代理”一节、“上个窗口加载并用过的延迟工具”一节（CronList 调用 1 次）；“最近的动作”里没有 ledger_append 行。
- 子代理一节的结论：`$.agent.list()` 只列出换窗口时还在跑的子代理（后台那个列出，状态 running）；已经结束的前台子代理不在列表里。089d6739 的 w003/w004 没有这一节就是这个原因，不是缺陷。
- 未做：已结束但仍可用 SendMessage 续用的子代理不会出现在交接信息里，目前靠模型写进账本。可选改进是从历史里的 Agent 行自己整理一份名单。
- 未测：真实大会话里“延迟工具”一节是否真能让模型在第一步加载、避免中途整段缓存重建。

## 2026-10-11（五）派发名单（SPEC-roster）已实现并真实验证；重建检测（SPEC-costly）进行中

- 派发名单：worker a874f8a96060dd199（Haiku）。`agent.spawn` 钩子把主循环派的子代理记进 `meta.json` 的 `roster`，子代理的 `turn.complete` 标 ended；`buildHandoff` 用 `agentsForHandoff` 把引擎列表和名单合并，已结束的标“已结束”。验收：225 过 0 败、tsc 0、validate --strict 通过。真实引擎会话 40f9fdad-c435-4ad6-832b-09ff37fcbb1d：交接信息同时列出 running 的后台子代理和已结束的前台子代理。
- 缓存重建的结论（089d6739 实测）：11 次 ToolSearch 加载，8 次（WebFetch、WebSearch、SendMessage、Chrome 的 MCP 工具，最大在 22.1 万上下文）下一个请求完整命中；3 次加载 `mcp__computer-use__*` 后消息缓存整段重建（6.3 万时重写 2.9 万、15 万时 11.7 万、23.4 万时 20.3 万），系统提示词加工具定义的前缀（5.06 万 / 5.07 万）每次都命中。所以原因不是“按需加载”本身，也不是系统提示词被改；具体机制从会话记录里看不出。每个窗口只在第一次加载时发生。
- 用户意见：桌面控制不一定每次都用，固定提前加载会浪费。粗算白加载一次（约 1.8 万定义 × 约 70 个请求的读取）约为晚加载一次重建代价的三成到九成。
- 进行中：SPEC-costly（F1/F2/F3）。用 `turn.step` 钩子的 usage 量出哪些工具组加载后缓存被重建（`costlyLoads`），交接信息只对这些组给提示，并写明代价和“账本下一步明确要用才提前加载”。

## 2026-10-11（六）重建检测（SPEC-costly）已实现，真实引擎只验证了“不破坏”
- worker ae20c12a815ab8b99（Haiku，30 轮上限停过一次，SendMessage 续跑完成）。`turn.step` 是流式事件，钩子是 `async function*` + `yield* next(e)`；只量主循环（`agentId === undefined`）。`record()` 把 ToolSearch 加载的组记进 `pendingLoads`，下一步 `noteStep` 判定：read < 上一请求上下文×0.9、差值 > 5000、write > 0 → 记进 `meta.json` 的 `costlyLoads`（同组以最近一次重建覆盖）。换窗口时清 `lastContext`/`pendingLoads`。交接信息一节改名“加载时会重建缓存的延迟工具”，只列用过且在 `costlyLoads` 里的组。
- 验收：239 过 0 败、tsc 0、validate --strict 通过。
- 真实引擎会话 b806dd07：请求正常、换窗口正常、CronList 没量到重建所以交接信息没有这一节、`meta.json` 有 `"costlyLoads":{}`。
- 没验证的：真实引擎上的正向路径（加载 computer-use → `costlyLoads` 出现 `mcp__computer-use__*`）。空表既可能是“钩子触发了但没重建”，也可能是“钩子没触发”，这次冒烟分不开。下次重启后的长会话里加载 computer-use，再看该会话的 `meta.json` 才算数。
- 已知误判：加载后的下一个请求恰好碰上缓存过期（1h TTL），会把无辜的组记成重建。
- 测试底座里 `$.turn.step(...)` 的 `stream.result` 是 undefined，测试辅助 `step` 改用 `stream.next()` 读到 done，原因未查。

## 2026-10-11（七）换窗提醒推后
- 起因：用户嫌换窗太频繁，240k 就被提示换。真实上限是 367k（引擎在 40 万窗口下留 3.3 万），不是 40 万。
- 改动：`types.ts` 的 `boundaryMinTokens: 150_000` 换成 `boundaryPct: 80`（约 294k），`softPct` 70→86（约 316k），`urgentPct` 85→92（约 338k，离上限 2.9 万）。`usage.ts` 的 `levelOf` 和 `session.ts` 里 `ledgerAppend` 的“没有进行中的任务，建议换窗口”都按百分比判断。
- 没动：缓存过期时上下文超过 10 万就换（`coldMinTokens`）；模型自己调用 `context new` 仍由成本判断决定批不批，只是不再被提前提示。
- 验收：239 过 0 败、tsc 0、validate --strict 通过。同步改的断言：`usage.test.ts` 的 levelOf 边界；`session.test.ts` 的 reminder（72k/90k → 87k/93k，并加了 85k 不提醒）和任务结束提示（加了 79k 不提示、80k 提示）。真实引擎未验证。
- 待做（switch-before-load）：超过 8 万加载会重建缓存的工具组前先换窗。拦截点已在类型里确认：`tool.call` 钩子在 `next` 之后返回 `{ deny }`，引擎扣下结果。等 codex（gpt-6-astra）审查意见回来再写说明。
- （七）补充：用户要求把压缩窗口调大，让上限真的是 40 万。`C:\Users\yadaz\.claude\settings.json` 的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 400000 → 433000（引擎留 3.3 万，上限应为 40 万；没用 45 万是因为那样上限是 41.7 万）。门槛随之改回用户原话的 30/33/35 万：`boundaryPct` 75、`softPct` 83、`urgentPct` 88（40 万上限下是 300k/332k/352k；旧会话 367k 上限下是 275k/305k/323k）。验收：239 过 0 败、tsc 0、validate 通过。未验证：新会话里上限是否真的变成 400k（要重启后看 context status；如果模型窗口不允许，引擎可能把它压回去）。mod 的兜底 `compactWindow` 仍是 400_000，没动。

## （八）恢复正确性：分片读取与编号恢复（astra 审查 P1 第 2、3 条）

- 起因：gpt-6-astra 审查（`REVIEW-astra-2026-10-11.md`）报两条，先各写失败测试，5 个全部按预期失败，属实。
- 缺陷一：`loadWindow` 读旧窗口时“分片小于 2MiB 就停”，而 `appendRecord` 是“再加一条会超才旋转”，被旋转掉的分片必然小于 2MiB，所以旧窗口的 `-b` 及以后分片在重载后永远读不到。改为一直读到第一个不存在的分片（`readWindow`）。
- 缺陷二：`load` 只信 `meta.json`。meta 损坏时编号从 0 重来（旧测试还断言了新记录应为 #1），meta 只是落后时同样会重发编号；当前窗口也只读到 meta 记的分片号。改为以磁盘文件为准：
  - 窗口：`handoff-wNNN.md` 或 `history-wNNN.jsonl` 存在就说明该窗口已开，向后探到头。
  - 分片号：当前窗口读到第一个不存在的分片，`part` 取磁盘上最后一个。
  - 编号：取 meta 与磁盘行最大编号中较大者；当前窗口没有行（刚换窗）就往前一个窗口找。
  - 归档页：从 meta 记的页数往后探 `archive-NNN.jsonl`，补回页表和 `ledgerSeq`，否则下一次换窗会把 `archive-001` 覆盖掉。
- 代价：每次载入会多 4 次“读不存在的文件”（下一窗口的交接和分片、下一个分片、下一归档页），每个进程每个会话只发生一次。
- 恢复不了的：meta 里的 `activities`、`roster`、`costlyLoads`、`switchTimes`、`lastPrefix`，损坏后就是空的。
- 没改：`readText` 仍把“不存在 / 读失败 / 过大”都当成不存在，读失败的窗口仍会被标成已加载；写入失败仍被当成功（astra P1 第 1 条，需要单独设计）。
- 现状：27 个真实会话里最大的分片 807KB，还没有任何会话出现过旋转，所以缺陷一此前没有实际造成丢失。
- 验收：243 过 0 败（新增 4 个、改 1 个断言）、tsc 0、validate --strict 通过。真实引擎未验证；已开会话要重启才生效。

## （九）换窗门：加载会重建缓存的工具组之前，上下文过大就先换窗口（SPEC-gate.md）

- 做法：通用 `tool.call` 钩子里，ToolSearch **执行之前**调用 `session.gateLoad(query, tokens)`，返回文案就 `{ deny }`。没有采用“执行后扣下结果”：引擎是否因此不加载工具没验证过，执行前拒绝则工具根本没跑。
- 预判：`history.ts` 的 `groupsWanted`。`select:` 查询按名字归组；关键词查询按“服务器名是查询的子串”（`-`、`_` 当空格再比一次）。`computer` 这样的半截词不命中，结果只是不拦，不会误拦。
- 门槛：`types.ts` 的 `gateMinTokens`，现为 120_000。用户原定 8 万，依据的是“新窗口里加载只重写几千”，那句话是错的：实测重写量约为“上下文 − 5 万 + 1.7 万工具定义”，8 万时换窗基本不省，12 万省约 4 万，15 万省约 7 万。已向用户说明，等用户定。
- 防卡死：每组每个窗口只拦一次（`gateAsked`），第二次放行；本窗口已加载过的组不拦。
- 换窗放行：被拦后（`gateWanted` 非空）`requestSwitch` 给 `gateSwitch` 传 `isForLoad`，越过 30 次请求冷却和划算判断；每小时 4 次上限和“账本要新”照旧。模型不换窗直接加载了该组，`record()` 会把它从 `gateWanted` 去掉。
- 交接：`gateWanted` 非空时多一节“这次换窗口的原因”，放在“加载时会重建缓存的延迟工具”之前，不参与裁剪。
- 跨会话表：`<数据根>/costly.json`（`C:\Users\yadaz\.claude\ctx-mod\costly.json`），格式 `{"version":1,"groups":{组:{write,context,at}}}`，30 天过期。`noteStep` 量到重建时重新读文件、合并、写回。归因修正：同一步加载多个组时不记。
- 已知弱点：跨会话表是读-改-写，没有锁，两个会话几乎同时写会丢其中一个组；读文件临时失败会被当成空表覆盖。丢的只是一条可以重新量出来的记录。
- 现状：27 个真实会话的 meta 里都还没有 `costlyLoads` 记录，`costly.json` 也不存在。所以重启后门不会立刻起作用，要等第一次真实的重建被量到并写进表里。
- 实施：worker（Haiku high）分两轮完成，第一轮在 30 轮上限处停下只做完 G1；主会话逐轮验收。
- 验收：266 过 0 败（基线 243）、tsc 0、validate --strict 通过。测试底座改动：`register.test.ts` 的 `world()` 加了 `readable` 表。真实引擎未验证：`{ deny }` 的呈现、`turn.step` 的正向检测、`context new` 到交接的完整链路；已开会话要重启才生效。

## （十）写盘失败看得见，没写进磁盘就不做零摘要换窗（SPEC-durable.md，astra 审查 P1 第 1 条）

- 起因：写入抛错时队列照常 resolve、没有日志，`ledgerAppend` 写盘前就回“已记录”，`flush` 只等排空，归档页写失败时条目仍被移出账本。全部写入失败时窗口照样推进，磁盘上什么都没有。
- 改动：
  - `history.ts`：`Queue.push` 返回 `Promise<boolean>`（成功 `true`、抛错 `false`，仍不 reject）。
  - `session.ts`：`failedWrites` 记住失败的内容；`Io.onWriteError` 可选回调；`flush()` 在队列排空后把失败的写入重推一次；`unsaved()` 列出本会话目录下没写成功的文件；`ledgerAppend` 等账本写入结果，失败时在“已记录”后加一行说明（不标错误，避免重复记账）；`commitSwitch` 等归档页写成功才把条目移出账本，失败则这次不归档；`status` 行带“有 N 个文件没写进磁盘”。
  - `register.ts`：`io` 接上 `onWriteError`（走 `logError`）；`session.compact` 进零摘要分支前先 `flush()` 再看 `unsaved()`，非空就退回引擎自己的摘要，再照旧追加交接信息；本 mod 发起的换窗退回后 `committed` 仍置真。
- 主会话验收时补的一处：`unsaved()` 只算会话目录里的文件。跨会话表 `costly.json` 在目录之外，它写失败不该挡住换窗（原实现还会把文件名截错）。
- 没采纳：审查建议的分代快照和提交清单。载入已经以磁盘文件为准（见（八）），meta 与分片不同步不再造成编号重用，那套机制的收益不值它的复杂度。
- 已知不足：`record` 和 `saveMeta` 仍不等写入结果，靠每轮结束的 `flush` 重试和换窗前的检查兜底；进程在两次 `flush` 之间死掉仍会丢最后几条。退回引擎摘要时，自动压缩且有待批准换窗的情况不会自动续跑（和“账本不新鲜的自动压缩”一致）。
- 实施：worker（Sonnet high）一轮完成。底座触发不了的路径：本 mod 发起的换窗退回引擎摘要（只在代码里核对过）。
- 验收：277 过 0 败（基线 266）、tsc 0、validate --strict 通过。同步改过的已有断言：`session.test.ts` “an archive page that failed to write says so when it is read”，归档页写失败现在不登记页，断言由“归档页文件缺失”改为“没有找到归档页”，并加了条目仍在当前账本里的断言。真实引擎未验证；已开会话要重启才生效。

## 其他记录

- 门槛与预置：用户把换窗门的两个决定交给主会话。`gateMinTokens` 保持 120_000；已把真实量到的一条写进 `C:\Users\yadaz\.claude\ctx-mod\costly.json`（`mcp__computer-use__*`，15 万上下文重写 117386），新会话或重启后生效，30 天过期。
- 子代理撞到上下文上限：走引擎的正常压缩。`session.compact` 钩子对 `e.agentId !== undefined` 直接放行，其他钩子也都跳过子代理；这是有意的，子代理没有账本，零摘要换窗对它等于清空。
- 重启后的真实验收（2026-10-11）：`context status` 显示 195k/400k，`CLAUDE_CODE_AUTO_COMPACT_WINDOW=433000` 生效；本会话载入后窗口 4、编号 1..592 连续、归档 1 页；读旧窗口记录和搜索正常；ToolSearch 钩子放行正常。
- 可优化点：本会话 `meta.json` 已 56KB，每条记录都整文件重写一次。

## （十一）账本要真的跟得上，才允许不写摘要就换窗口（SPEC-fresh.md，astra 审查 P1 第 5 条、P2 第 7 条）

- 起因：“账本够新”只看本窗口有没有一条不早于最近用户请求的账本。写一条空账本再做 20 步，照样批准换窗，那 20 步的结论不进交接。
- 改动：
  - 账本条目新增 `through`（记账时历史里最后一条的编号）。旧条目没有它，按时间比较。
  - `validate`：`text` 不能为空；`in_progress` 必须有下一步（这次给了，或省略而该任务上一条有）。`ledgerAppend` 对 `in_progress` / `blocked` 省略的 `next_step`、`anchors` 沿用该任务上一条；`anchors: []` 表示清空。
  - `session.ts` 的 `tailOf`：本窗口最新账本之后、没记进账本的工具结果数（本 mod 自己的工具不算）和首尾编号。
  - 模型申请换窗（`requestSwitch`）：没记的步数超过 `freshTailSteps`（5）就拒绝，文案指出是哪条账本之后的哪一段。`gateSwitch` 新增可选 `staleReason`。
  - 自动压缩：`canSkipSummary()`，没记的步数超过 `autoTailSteps`（25）就退回引擎摘要再追加交接。缓存过期的换窗和模型已获批准的换窗不变。
  - 交接信息新增不参与裁剪的“账本没覆盖到的部分”一节；“最近的动作”条数随没记的步数扩到最多 25。
- 两个数是主会话定的：5 给“记账后跑一两条验证再申请换窗”留余量；25 是交接里能列全的上限。用一段时间后按实际情况调。
- 实施：续用上一项的 worker（Sonnet high），一轮完成。
- 验收：295 过 0 败（基线 277）、tsc 0、validate --strict 通过。改过的已有测试：`ledger.test.ts` 的 `input()` 默认值补了 `next_step`，“text and every optional field must be the type it claims”里空 `text` 由通过改为被拒（规则本身变了）；`session.test.ts` 9 处、`register.test.ts` 5 处 `in_progress` 输入补了 `next_step`。没有删断言。真实引擎未验证；已开会话要重启才生效。

## （十二）缓存过期时扣下的用户消息不能丢（SPEC-held.md，astra 审查 P1 第 6 条）

- 起因（对着引擎类型核实过）：`$.prompt.submit` 可以正常返回 `{ drop }` 而不抛错，原代码只接了抛错；扣下的原话只在定时器闭包里，热重载会取消定时器；连续两条消息会排两个压缩。
- 改动：
  - `session.ts`：`hold` / `heldItems` / `release`，扣下的消息写进会话目录的 `held.json`；`hold` 等写入结果，写失败返回 `null`。
  - `register.ts` 的 `prompt.submit`：先 `hold` 再扣，没落盘就不扣。模块级标志 `isHoldingFlow` 保证同一时间只跑一个流程；流程进行中到的用户消息也落盘并排在后面（带附件的照常放行）。只有因为缓存过期扣下的才执行压缩。
  - `deliverHeld`：按先后顺序重新提交；返回值里有 `drop` 或抛错都算没送达，发一条带原文的系统消息（最多 20000 个字符，超出写明还有多少没显示）。提示也发不出去时留在磁盘上并停止循环。
  - `sessionOf` 新建会话对象时调用 `announceLeftovers`：`held.json` 有残留就提示用户重发，不自动重发。
- 原则：这条路径上任何一步出错，宁可让消息照常进入（多重写一次缓存），也不让它消失。
- 实施：续用同一个 worker（Sonnet high），两轮：第一轮在 30 轮上限处停下，产品代码写完但 5 条新端到端测试失败（底座对 `state.get` 的应答要包两层，它只包了一层，缓存过期的判断没成立）；主会话审过产品代码后让它续跑收尾。主会话另改了一处：因排队被扣下而自己起流程的消息，提示文案不再说“缓存已过期”。
- 底座触发不了的路径：`hold` 写盘期间流程恰好结束的交错（只在代码里核对过：它会自己起一个不压缩的流程把消息送出）；靠 `lastRequestAt` 判断缓存过期（测试里用缓存状态的 `expiresAt` 代替）。
- 已知不足：`hold` 写盘失败而同时另一条写成功时，磁盘上可能多出那条失败的消息，下次重开会提示一次。
- 验收：305 过 0 败（基线 295）、tsc 0、validate --strict 通过；没有跳过的测试和残留的调试断言。真实引擎未验证；已开会话要重启才生效。


## （十三）落盘的历史要真的完整（SPEC-complete.md，astra 审查 P1 第 4 条）

- A 其余入口：`session.append` 的通用分支，`message.role` 有值就记（`door` / `name` 写在行上），没有 role 的（notice 等）不记；非文本块在正文末尾补 `[非文本内容：image×2]`，tool-result 同样。`queued_command` 附件的正文只要包含 `personTexts` 里某条没消费的原话，就按人的消息记（正文记那条原话，`isPerson`）；否则按普通行。搜索默认跳过背景行（`isBackgroundRow`：attachment 除 queued_command、hook-context、note），`history` search 的 `door` 参数可以取消跳过。`latestAssistantRow`、`tailOf` 跳过有 `door` 的行；`personRequests` 仍只看 `isPerson`。
- B 参数全文：tool 行写 `args`（`formatArgs`，`argsOf` 去掉信封后的参数）和 `callId`；`input` 摘要不变。search 顺序：正文、args、input。`history` read 的 `field: "input"` 读参数全文，旧行只有摘要时会说明。
- C 超长原文：行内仍是开头（正文 20 万、参数 5 万字符，截断提示 ≤ 40 字符），整段另存为 `big-<seq>-<field>-<n>.txt`（每个最多 100 万字符）。分片先入队、行后入队；失败走 `failedWrites`，`flush` 重写，`unsaved()` 会列出。**偏离 SPEC**：`overflow` 多了可选的 `cuts`——为了不切开代理对，分片可能短 1 个字符，此时记下每片起点；没有这种情况就不写。读不到分片时退回行内开头并明说。分片不会被当成历史分片：加载靠文件名探测，不列目录。
- D 补录：`importMessages` 在已有历史时只导入“最后一条已知消息”之后的部分。已知 = 工具调用 id 对上某 tool 行的 `callId`，或结果以本 mod 的 `[#n]` 结尾（n ≤ 当前编号），或去空白后的正文相等/较短一方 ≥ 12 字符且被包含（只跟锚点之后的行比，从后往前找第一条）。**已知限制**：只能补尾部；mod 停用期间如果引擎自己压缩过，压缩前的内容补不回来；同一条消息里并行的其他工具调用不会单独补。
- 顺带修了一处：本 mod 交接信息开头（“这是第 N 个窗口，上一个窗口的对话不在上下文里”）原来会被 `looksLikePerson` 判成人的话，补录时会被当成请求，现在判为否。

## （十四）补记不丢下一步、搜索说明范围、确认来源的人话不被误删（SPEC-p2a.md，astra 审查 P2 第 7、11、12 条）

- 一 起因：补记没带 next_step / anchors 时，原来在写入时把上一条的值复制进新记录，交接里看不出是沿用的，也没法区分“没传”和“清空”。改动：不再复制，存盘就是“没传”；`tasksOf` 给每个任务算出 `nextStep` / `anchors`（`Resolved`：值、来源 seq、是否沿用），最新一条带了就用它的，否则取同一任务最近一条带了的；空字符串 / 空数组清空并停止往前找，`done` / `superseded` 不沿用，往前找遇到已结束的记录也停。首页和交接标 `下一步（沿用 #L32 的记录，可能已过时）`，待改位置在任务行上标一次（`renderWorkset` 多一个可选参数）。`windowNotesOf` 改为最新窗口优先，不够再用更早窗口从新到旧补，条数 3、字数 3000 不变，更早窗口的带 `（第 N 个窗口）`。`validate` 判断 in_progress 要不要 next_step 也改用解析后的值。
- 二：`historySearch` 没指定 window 时先搜最近 3 个，没命中一次加一个更早的窗口直到命中或到第 1 个；范围不是全部窗口时末尾写 `（搜了第 a–b 个窗口；第 1–c 个窗口没搜…）`；全部没中写 `第 1–N 个窗口里都没有匹配。`（只有第 1 个窗口时仍是 `没有匹配。`）；指定 window 没中写明只搜了那个窗口。
- 三：`looksLikePerson(text, isConfirmed)`，来源已确认时只按信封名单（command-*、local-command-*、task-notification、system-reminder）加原有四条排除，其余 `<` 开头算人话；`prompt` 分支用现有三个条件，`queued_command` 匹配到原话也算已确认。导入旧对话（`importMessages`）仍用旧规则。
- 没验证到：真实引擎里的斜杠命令、`<task>` 提示的 origin 实际值；旧账本里写入时已复制过的值会当作该条自己带的，不带“沿用”标注。找到第 1 个窗口才命中时，按 SPEC 第 2 条不加范围说明（已搜全部窗口）。
- 背景行去重：`session.append` 通用分支里，背景行（`isBackgroundRow` 那几种）同一窗口内入口和名字相同、正文与上一次记录的那条一样就不再记；正文变了、换了窗口都照记。`delivery`、`command`、`queued_command` 等不去重。状态是 `register.ts` 模块级的 `lastBackground`，`session.end` 清掉，不落盘（重载后多记一条可接受）。

## （十五）请求数按真实的模型请求计（SPEC-p2b.md，astra 审查 P2 第 8 条）

- 起因：`noteRequest` 挂在 `tool.call` 之后，并行 3 个工具记 3 次，纯文本请求不计，`lastRequestAt` 因此会落后、把还热的缓存判成冷；换窗后的前缀采样也要等第一次普通工具调用。
- 改动：`register.ts` 的 `turn.step` 里，主循环（无 `agentId`）的一步返回就 `noteRequest()` 一次，不管有没有工具、`usage` 是不是 null；用模块级 `lastStep`（`turnId` + `index`）去重，`session.end` 清掉。前缀采样也移到这里：`awaitingPrefix` 时取这一步 `input + read + write` 传给 `notePrefix`。`tool.call` 后半段只留上下文提醒。`cooldownRequests` 数值不变，注释写明单位。
- 没验证到：真实引擎里 `turn.step` 的 `turnId`/`index` 在重试时是否真的重复；`lastRequestAt` 没落盘，只在 session 层测试里直接验过，register 层只验了 `requestsSinceSwitch`。旧会话磁盘上的 `requestsSinceSwitch` 按旧口径累计，不迁移。

## （十六）交接信息里进行中任务的体积要有边界（SPEC-p2c.md，astra 审查 P2 第 9 条的一部分）

- 起因：`handoffTokens`（15,000）不是硬上限，首页进行中的任务、最后回复、子代理名单都不裁剪；其中真正没有上界的是进行中任务，挂得越多交接越长。
- 改动：`renderHome` 把进行中 / 受阻的任务按最近一条记录的时间从新到旧排（`newestFirst`），最近的 `MAX_FULL_ACTIVE = 5` 个完整显示，其余压成短格式（任务行、`最新 #L<seq>`、下一步，各取前 200 字符，截断加 `……`，沿用的下一步仍标来源），末尾一行写有几个只显示了摘要。显示顺序因此从“首次出现顺序”改为“更新时间从新到旧”。`buildHandoff` 取待改位置的逻辑没动。`assemble` 和 `handoffTokens` 的注释改成如实说明：这是目标值，开头、首页、最后回复、子代理、工具说明不裁剪。
- 取舍：不做硬上限——超出一两成不造成问题，这个数是成本目标不是安全线，真正的风险只是进行中任务没有上界，所以只约束这一块。不做账本分片——4 MiB 相当于几千条记录，已结束的任务会被 `turnPage` 归档，真写不进去时“写失败看得见”会报出来。
- 没验证到：真实会话里挂着很多个进行中任务时交接的实际体积。

## （十七）交接行按 compaction 入口能搜到（第 6 窗口真实核对时发现）

- 起因：`history` 工具说明把 `compaction` 列为可搜的入口，但真实会话里 `door: "compaction"` 在 6 个窗口里一行都搜不到。交接行（`session.compact` 返回的那条 user 消息）有真实 uuid、落盘没有 `door`，说明它是从 `prompt` 入口回来的，而 `session.append` 的 `prompt` 分支不写 `door`。
- 改动：`session.ts` 导出 `isHandoffText`（就是 `HANDOFF_OPENING`）；`register.ts` 的 `prompt` 分支里，文本是本模块的交接开头时落盘带 `door: 'compaction'`。它不是背景行，默认搜索照常列出。
- 没验证到：引擎自己做摘要的那条路（auto-summary）里，摘要和追加的交接各从哪个入口回来；已落盘的旧交接行不回填，按入口搜不到第 6 窗口及以前的。

## （十八）回合中途消息走的是 delivery 入口（第 7 窗口用 headless Haiku 会话实测发现）

- 起因：`session.append` 里只在 `door === 'attachment' && name === 'queued_command'` 时把行认作用户原话。真实引擎（2.1.296）里，人在回合中途发的消息 `name` 仍是 `queued_command`，但 `door` 是 `delivery`。结果这行落盘时没有 `isPerson`，正文是引擎的包装（`<system-reminder> The user sent a new message while you were working: …`），不会进“最近的用户请求”。单元测试一直用 `attachment` 入口造事件，所以没测出来。
- 改动：判断改成 `(door === 'attachment' || door === 'delivery') && name === 'queued_command'`，仍然靠 `personTexts` 里提交过的原话来确认，不信包装文字。落盘的 `door` 照引擎给的写（`delivery`）。
- 测试：`register.test.ts` 加一条，用真实会话里的包装原文、`delivery` 入口、`sdk` 来源。
- 实测方法：`claude -p --model haiku --input-format stream-json --output-format stream-json --verbose`，第一条消息让它跑工具，见到 `tool_use` 后 2 秒往 stdin 写第二条。修复前落盘 `door=delivery name=queued_command`、无 `isPerson`、正文 347 字（包装）；修复后同一行 `isPerson=true`、正文是 28 字原话，且没有另一条相同文字的 prompt 行。
- 注意：从桌面应用的会话里起 headless 子进程时，要先把桌面注入的 `CLAUDE*` / `ANTHROPIC*` 环境变量去掉（只留用户级/系统级自己设的），否则子进程带着 `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` 等变量，认证会失败。

## （十九）短的用户请求带上它回复的那条助手消息（用户在第 7 窗口提出）

- 起因：交接里“最近的用户请求”只列用户原话。像“可以”“重启了”“登录了”这类回复，新窗口看不出是在答什么。
- 改动：`history.ts` 加 `repliesAnswered(rows, requests)`，给每条请求找它之前最近的一条助手正文（`role=assistant`、没有 `door`、正文非空）。`renderHome` 多收一个可选的 `answered`，请求正文不超过 30 字（`SHORT_REQUEST_CHARS`）时在下面加一行 `  - 回复的是助手 [#编号]：摘录`；摘录压成一行，超过 260 字取开头 100 字加结尾 160 字。超过 30 字的请求不加这一行。
- 为什么只给短请求：长请求通常自己说得清，再附一段旧回复只会把新窗口的注意力引到已经过去的话题上。门槛和摘录长度都是常量，要改只动 `ledger.ts` 顶部。
- 跨窗口：那条助手消息可能在请求所在窗口的前一个窗口（重启后内存里只有当前窗口）。`session.ts` 加 `ensureAnswered`，最多往前多读到请求所在窗口的前一个，不会因为会话第一条请求没有上文就把所有窗口都读进来。
- 账本首页（`ledger_read` 的 home）和换窗交接用的是同一个 `renderHome`，两处都会显示。
- 测试：`ledger.test.ts` 一条（短的有、长的没有、摘录取头尾）、`session.test.ts` 一条（跳过中间的 delivery 行，首页也显示）。
- 重启后在真实数据上看了一次首页（第 7 窗口），据此又改了三处：
  - 门槛 60 → 30 字：一条 55 字、自己说得清的提议被附了 260 字无关的旧回复。
  - `repliesAnswered` 只认“上一条用户消息之后”的助手回复，中间没有就不附。原先连着两条用户消息会指向同一条回复，重复贴两遍；中途消息会被指到上一回合的回复，是错的。
  - 中途消息（`name=queued_command`）在请求行上标“（回合进行中插入）”。
- 一个要知道的限制：助手在回合中间、工具调用前说的话，有一部分在引擎转录里是 thinking 块而不是 text 块（转录里看得到块序号，正文是空的）。`response` 入口只记 text 块，所以这些话不在历史里，也搜不到；中途消息真正回应的往往就是这种话，所以它经常没有可附的回复。每回合最后的正式回复总是 text 块，不受影响。
## （二十）协调者派发的会话里记不了账（第 8 窗口，用户转来另一个会话的报告）

- 起因：项目线程的会话第一条输入是协调者的转交（`<relay from="coordinator" … reason="spawn">`，`prompt` 入口，`origin.kind` 是 `coordinator` 或 `projects-relay`），真人消息要等协调者把它以 `<wake reason="mention">` 送进来才有。这之前 `ledger_append` 全被拒：省略 `request_ref` 报“还没有真人请求”，指向转交行报“不是真人请求”。真实数据在 `~/.claude/ctx-mod/63a0f57f-1132-4b78-a3ba-5fae7eccc8fb`：#1 是转交，#47 才是第一条真人消息。
- 定的规则：
  - 转交不算真人请求（`isPerson` 不变），但算任务的出处，可以当 `request_ref`。
  - 省略 `request_ref` 时取真人消息和转交里最近的一条（`defaultRequestSeq`），两类都没有记 0。省略永远不拒，会话里什么请求都没有也照记。
    - 第一版是“真人优先，没有真人才用转交”。那个会话验收后提出反对：转交才是任务出处，后来的真人消息可能是另一件事，建议转交优先。两种固定优先级各有一个明显绑错的情形：真人优先时，协调者后来派的新活会被绑到更早的真人消息上；转交优先时，用户后来在线程里下的指令（那个会话里 5 条真人消息全是这种）会被绑回最初的转交。所以改成不分优先级、谁最近用谁。
    - 默认值终究是猜的，所以回执写明绑到了哪一行：`已记录 #L2。对应请求 #47（用户消息，省略 request_ref 时取最近一条）。`；显式给的不带后半句；记 0 时写 `没有可对应的请求（request_ref 记为 0）。`
    - 任务的第一条记录就是 `done` 时，证据的时间下限取自绑定的请求，绑错会误拒合法证据。报错现在带上起点：`早于这个任务的起点（省略 request_ref 时默认对应的请求 #47；任务其实来自更早的请求，就用 request_ref 指明）`，或 `（request_ref 指向的 #N）`，或 `（这个任务的第一条记录 #L3）`。任务已有记录时起点是第一条记录的时间，和绑定无关。
  - 显式给的 `request_ref` 仍然要查：只能指向真人行或转交行，工具结果、通知、别的行照旧拒绝。
  - 没做“第一条真人消息到了以后自动补绑”：那条消息不一定是这个任务的来源，补绑会让出处失真。
- 改动：
  - `types.ts`：`HistoryRecord` 加可选的 `origin`（引擎给的来源种类，原样落盘）；`isRelay(row)` 判转交。第一、二版只看 `origin`，第三版加了按开头标签认的一路（见下面“第三版”）。按 `origin` 算转交的来源：`coordinator`、`projects-relay`、`scheduled-trigger`、`channel`、`slack-ping`。`peer` 没算：真实数据里它是子代理交回的报告（`[Subagent hand-back]`），不是派活。
  - `register.ts`：`prompt` 入口的行都写 `origin: e.origin.kind`（真人行也写，便于以后排查）。`/ctx-mod switch` 的“还没有可交接的内容”改成真人和转交都没有时才拒。`ledger_append` 的 `request_ref` 说明同步改了。
  - `ledger.ts`：`validate` 去掉“还没有真人请求”那条；`stamp` 和 `taskStartTs` 加转交这一级回落；`renderHome` 多收一个可选的 `relay`，在“最近的用户请求”下面单列一节“派发来的任务（协调者等转交的，不是用户亲口说的）”。
  - `session.ts`：`latestRelayRow` / `latestRelaySeq`；`relayForHome` 决定首页带哪条转交：进行中或受阻任务的 `request_ref` 指向的那条（取最新），都没有且会话里没有真人消息时取最近一条。任务都结了、又有真人消息时不显示。账本首页和换窗交接都走它。
- 顺带改的一处判定：`<wake>` 行以前只要来源是真人就认作真人请求。现在 `looksLikePerson` 多看一眼触发它的那条 `<message trigger="true" …>`，`from` 不是 `human` 就不算。真实数据里 5 条 wake 都是 `from="human"`，判定结果没变；`from` 不是 human 的 wake 长什么样没见过真实样本，格式是按这 5 条推的。
- 后台任务通知：真实数据里 #90 是不带 `delivery/queued_command` 标记、直接走 `prompt` 入口的 `<task-notification>`，落盘没有 `isPerson`，没被误认。加了一条测试固定这个行为（来源 `task-notification`，不是真人也不是转交）。
- 旧行：第一、二版里，这次之前落盘的行没有 `origin`，旧会话里的转交行不能当 `request_ref`。第三版起能认了。
- 测试：`ledger.test.ts` 4 条、`session.test.ts` 5 条、`register.test.ts` 5 条；原来拿“记账被拒”当“这行不是真人”判据的 4 处断言改成看 `request_ref` 是不是 0。共 385 过 0 败，`tsc` 0，`validate --strict` 通过。
- 真实引擎里已验证（第一版，那个旧会话 63a0f57f，重启后）：显式指向后台通知 #90 被拒；显式指向没有 `origin` 的旧转交行 #1 被拒且是新文案；省略 `request_ref` 记账成功。
- 真实引擎里已验证（第二版，同一个旧会话，再次重启后）：省略时回执是 `已记录 #L3。对应请求 #148（用户消息，省略 request_ref 时取最近一条）。`；首条记录即 `done`、证据过早时报错写明“省略 request_ref 时默认对应的请求 #148”；任务已有记录时写明“这个任务的第一条记录 #L2”；显式指向旧转交行 #1 仍被拒。
- 落盘的 `origin` 顺带确认了一件事：项目线程里真人的 `<wake>` 消息来源种类是 `composer`（那个会话重启后的三条都是）。也就是说 wake 走的是和手敲一样的来源，谁写的只能从触发消息的 `from` 看，`looksLikePerson` 里那道判断不是多余的。
- 第二版在新派发的线程里没过（会话 fb0c45ae-1b1e-4dc0-b641-19c80cc8c9cd，2.1.296，线程跑在用户本机）：回执是 `已记录 #L1。没有可对应的请求（request_ref 记为 0）。`。原因：转交行的 `origin` 是 `unclassified`，不是类型定义里的 `coordinator` 或 `projects-relay`。引擎说不出这条输入的来路，所以只看 `origin` 认不出它。省略不拒是生效的，账记上了，只是没绑到转交。
- 第三版：`isRelay` 多一路。`prompt` 入口（没有 `door`）、不是真人、`origin` 是 `unclassified` 或根本没有，且正文开头是 `<relay … from="coordinator"`（前面允许有 `<system-reminder>` 块）时算转交。
  - 这推翻了前两版“不靠正文”的取舍。那个取舍的前提是 `origin` 能认出转交，实测不能。
  - 没有 `origin` 的行也认，不只 `unclassified`：导入的历史（`importMessages`）永远不带 `origin`，mod 中途启用或恢复会话时转交行就在导入的那批里。`unclassified` 本身的意思就是“来路不明”，它比“没有 `origin`”多出来的证据很少。
  - 别的来源担保过的行不认：`peer`、`task-notification`、`plugin` 等来源的行即使引用了这个标签也不算；`composer` 来源的会被认作真人行，本来就不算转交。别的入口（attachment、delivery）的行也不认。
  - 被认成转交能得到的只有：可以当 `request_ref`、省略时可能被选作默认、在交接里以“不是用户亲口说的”列出、允许 `/ctx-mod switch`。没有任何一处把它当授权，所以本机进程伪造一条这样的输入也拿不到什么。
  - 回放：用同样的规则扫了 `~/.claude/ctx-mod` 下全部 55 个历史文件，命中的只有两条，正是两个派发会话的 #1（63a0f57f 无 `origin`，fb0c45ae 是 `unclassified`），没有误认。
  - 测试断言跟着改了，条数没变：385 过 0 败，`tsc` 0，`validate --strict` 通过。
- 没验证到：第三版要重启后才生效，届时在 fb0c45ae 那个线程里省略 `request_ref` 记一条，回执应是“对应请求 …”（那里已有真人消息，会绑到最近的真人消息）；显式给 `request_ref: 1` 应通过，回执是“对应请求 #1（转交）”。云端容器里派发的线程，转交行的 `origin` 是什么没有样本，可能是 `coordinator` / `projects-relay`，也可能还是 `unclassified`，三种都认了。转交在回合中途送达（走 `delivery` 入口）的情形没见过，现在不认。

## （二十一）收尾：costly.json 加锁、冷缓存测试、交接路径相对化（2026-10-13）

- A costly.json：`recordShared` 为“拿锁、读最新、合并、写临时文件、rename”。锁为 `costly.json.lock`，10 秒过期、8 次重试，拿不到就放弃本次写入。读失败（抛错、JSON 坏、缺 groups）一律不写，文件保持原样；只有文件确实不存在才当空表。
- B 冷缓存测试：补了扣留后先压缩再按序重投、两条冷提示只排一个压缩、`{drop}` 时每条各发一条带原文的系统消息。
- C 交接路径：`renderWorkset` 接受可选 `base`，只在渲染文本里转相对路径；磁盘和 meta 保持绝对。
- 接线：`register.ts` 的 `io` 补了 `exists`（`$.fs.exists`）和 `cwd`（`$.session.cwd()`）。`claim`、`rename`、`remove` 引擎无对应原语，仍走回退：锁退化为“写后读回”的弱校验，表直接原地写。
- 验收：tsc 0；`claude plugin test .` 400 过 0 败（基线 385）；`validate --strict` 通过。
- 未验证：真实引擎中 `$.fs.exists` 与 `$.session.cwd()` 的实际返回；读失败与缺文件在引擎里的报错文本区分（现在依赖 exists）；已开会话需重启才生效。

## （二十二）子代理冷续用拦截（用户提出）

- 起因：主会话隔几天用 SendMessage 续用已结束的子代理，它 1h 的提示缓存早已过期，第一轮要重写约 19 万 token；新建同类型代理加短交接只要约 3–4 万。
- 名单（roster）每行新增：`name`（Agent 调用的 name，SendMessage 也认它）、`lastActiveAt`（派发、续用、子代理每个回合结束时更新）、`contextTokens`（该子代理最近一次请求的 input+cache_read+cache_creation）。来源：子代理自己的 `turn.step` 事件带 `agentId` 和 `result.usage`，是 API 报的真实值，不是估计；只在内存更新，回合结束（`turn.complete`）时一并落盘。没有这个字段的旧行（升级前写的）不会被拦，因为不知道它多大。
- 拦截（`register.ts` 主会话 `tool.call`，tool 为 SendMessage）：`to` 按 id 或 name 匹配名单（去掉末尾的 ` [ref]`）；已结束、闲置超过 `agentColdMinutes`（60）、`contextTokens` 超过 `agentColdMinTokens`（60000）时第一次 deny，文案写明闲置多久、约重写多少 token、建议新建同类型代理加最后报告和文件路径做交接、仍要续用就原样再发一次。同一目标同一消息体，或 `agentResendMinutes`（10）分钟内对同一目标再发，放行（判断后清掉记录）。放行时 `agentResumed` 把行的 `lastActiveAt` 改成现在并去掉 `ended`。名单里没有的目标、仍在跑的、热的、小的都不拦。
- 配置：三个阈值在 `types.ts` 的 `Config`/`DEFAULTS`，与其他阈值同一处；ctx-mod 目前没有用户级配置文件，改默认值即可。
- 交接：已结束且有 `contextTokens` 的代理，行内加“；闲置 X 小时，缓存已冷，约 N 万 token”或“缓存可能仍热”。
- 测试：`session.test.ts` 加 9 条、`register.test.ts` 加 6 条（Date.now 在测试沙箱里只读，注册层测试用“改 meta.json 里的 lastActiveAt 再换会话 id 重开”来模拟闲置，与真实引擎验证做法一致）。验收：`npx tsc --noEmit -p .` 0 错；`claude plugin test .` 417 过（基线 400）；`claude plugin validate --strict .` 通过。
- 调查（只调查未实现）：类型里 `SessionCompactTrigger = 'manual' | 'auto' | 'plugin' | 'precompute'`；`session.compact` 的钩子输入有 `agentId`（子代理或 fork 自己的 transcript 压缩时带），`$.session.messages({agentId})` 能读子代理对话；但插件主动调用的 `$.session.compact(args)` 只收 `instructions`，没有 agentId，只能压主会话，且回合中会 reject。已结束子代理被 SendMessage 续用时，引擎是从保存的 transcript 恢复，`session.messages({agentId})` 对已结束且没有保存的 transcript 会返回 deny。结论：没有 API 能对已停止的子代理主动压缩，也没有在续用时替换为压缩后历史的接口；只能等它续用后在它自己的回合里碰上 `session.compact`（auto）时用钩子改 `messages`，对冷缓存没有帮助。
- 未做：真实引擎验证（起 Haiku 子代理、改早 lastActiveAt 后 SendMessage）没有做。
