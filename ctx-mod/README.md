# ctx-mod

Claude Code mod（function hooks 插件）：让长会话跨多个上下文窗口继续干活，而不靠模型写摘要。它给模型一本任务账本和一份可检索的完整历史，换窗口时由代码拼出交接信息，不调用模型。

状态：实验性，0.2.0。针对 Claude Code 2.1.29x 的 Mods API 开发和测试。给模型看的工具说明和交接文字目前是中文。

## 它做什么

- **任务账本**：模型每完成一个阶段记一条（任务、状态、下一步、接下来要改的位置）。标 `done` 必须附上能证明它的工具结果编号；`in_progress` 必须写 `next_step`（省略时沿用该任务上一条）。协调者派来的任务可以用 `request_ref` 指向那条转交，它在交接首页单列为“派发来的任务”，和用户亲口提的请求分开。
- **完整历史**：用户消息、助手回复、工具结果都按编号落盘。工具结果末尾会带上 `[#123]` 这样的编号，模型之后可以按编号读原文，或按关键词、工具名、文件、窗口搜索，不用重跑同样的命令。工具参数全文存在历史行的 `args` 字段；超长的正文或参数另存为 `big-*.txt`，历史行里只留开头。
- **零摘要换窗**：上下文快满时，用账本和磁盘上的最新文件内容生成交接信息，直接开新窗口。交接里有最近的用户请求、用户已定决策（本会话所有窗口里用户定过的规则和答复，原文照搬）、派发来的任务、进行中的任务和下一步、待改位置的文件片段、文件工作集、最近的动作、子代理名单。
- **换窗的门槛**：账本不新、写盘失败、刚换过窗口时不换，或者退回引擎自己的摘要，并把原因告诉模型。
- **旧会话**：启用时如果会话已有历史，只补录引擎对话里还没记录的尾部；没有历史的旧会话整段导入。

## 安装与启用

依赖 [cache-keeper](../cache-keeper)（读它记录的缓存状态），两个都要装：

```
/plugin install cache-keeper --marketplace wdsewdser-bit/claude-code-mods
/plugin install ctx-mod --marketplace wdsewdser-bit/claude-code-mods
```

装好后默认什么都不做。启动 Claude Code 时带着环境变量 `CTX_MOD=1`，或在插件配置里把 `enabled` 设为 `true`，它才会注册工具并接管换窗：

```
# macOS / Linux
CTX_MOD=1 claude

# Windows PowerShell
$env:CTX_MOD = '1'; claude
```

也可以不设环境变量，在插件配置里把 `enabled` 设为 `true`（插件配置界面，或 settings 里的 `pluginConfigs`）。环境变量优先：`CTX_MOD=1` 开、`CTX_MOD=0` 关，未设时才看 `enabled`。`enabled` 默认 `false`，所以不配置时行为与只认 `CTX_MOD=1` 时完全相同。

## 模型得到的工具

| 工具 | 作用 |
| --- | --- |
| `context` | `status` 报告上下文用量、距上次换窗的请求数、本小时换窗次数、进行中任务数；`new` 申请换窗口 |
| `ledger_append` | 追加一条账本记录：`task_id`、`title`、`status`（`in_progress` / `done` / `superseded` / `blocked`）、`text`、`next_step`、`anchors`、`evidence`、`request_ref` |
| `ledger_read` | 读账本：`view` 取 `home`（首页）、`current`（当前窗口的全部条目）或 `archive:N`（归档页）；给了 `query` 就按词搜索，命中超过 3 条只按新到旧列一行索引（`#L编号 · task_id · 状态 · 标题 · 正文前 60 字`），填精确 `task_id` 或 `#L337`/`L337` 看全文；`limit` 限制条数（默认 20，范围 1–100） |
| `history` | `search` 按词、角色、工具名、文件、窗口、入口（`door`）查历史编号。默认跳过引擎的背景行（附件、钩子上下文、备注），指定 `door` 就能搜到它们；不指定窗口时先搜最近 3 个窗口，没命中再往前找，结果里写明搜了哪些窗口。`read` 按编号读原文，`field` 填 `input` 时读那次工具调用的完整参数 |

mod 还会在系统提示里加一段说明，告诉模型这些工具怎么配合使用。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/ctx-mod` | 显示是否启用和当前用量，以及被改过默认值的配置；未启用时只提示如何启用 |
| `/ctx-mod switch` | 立即换到新窗口，不调用模型 |

## 什么时候换窗

默认按 40 万 token 的窗口算，上下文到 20 万、30 万、35 万 token 时分三级提醒：到 20 万时，如果任务刚告一段落就换窗；到 30 万时，边做边记账、到下一个任务边界换窗；到 35 万时，立刻准备换窗。三档是绝对 token 数，不随上限变化，但都不会晚于上限减 3 万——上限只有 30 万时，30 万和 35 万两档都落在 27 万。故意放得晚：换窗会丢掉工作细节，所以尽量把一个窗口用完。

- 模型自己申请换窗，要求距上次换窗至少 30 次模型请求（按真实模型请求计，不按工具调用计；上下文到 20 万 token 时不受此限），每小时最多 4 次；账本要新，即最近一次用户请求之后本窗口有记账，且之后的工具结果不超过 5 个。否则申请被拒，并告诉模型原因。
- 引擎自动压缩时由 mod 接管，用交接信息代替摘要。账本不新，或者之后有超过 25 个没记账的工具结果时，把摘要交还给引擎。
- 缓存已经过期、上下文又超过 8 万 token 时，下一条用户消息会先写进会话目录的 `held.json` 扣下，换完窗口再提交，因为反正要整段重写缓存。重启后的进程在第一次请求前没有自己的上下文数字，这时用 cache-keeper 的 `cachedPrefixTokens`（跨重启保留）顶上。带附件的消息一样扣下：`held.json` 记下附件的数量和类型，换窗后只补发文字——引擎只给附件的类型、不给字节，图片或文件补不回来。图片本身留在 `%TEMP%\claude\<cwd 的 slug>\<sessionId>\images\` 里（修改时间就是粘贴时间）：扣下时按最近约 2 分钟、数量与图片数一致取最新的那几个，把绝对路径随补发的文字交给模型（“请用 Read 查看”），用户提示“图片已按路径转交”。找不到（目录不在、数量对不上、太旧）或不是图片的附件，补发的文字里说明原本附了 N 个、已丢失、别猜内容，同时给用户一条系统提示，请他重新粘贴附件。换窗期间新来的消息排队在后面。`held.json` 写不下时消息照常提交，不丢。进程中断或重新打开会话后遗留的扣留消息不会自动重发，只告诉用户。
- 上下文超过 12 万 token 时，加载会重建缓存的工具组（如 computer-use）之前先换窗；同一组在同一窗口里只拦一次，换窗后可以再拦。
- 有文件没写进磁盘时，不做零摘要换窗，改由引擎摘要。
- 5 小时额度用到 90% 以上时，换窗后不会自己接着干，等用户发话。

- 冷缓存换窗前，先把 cache-keeper 保活看到的任务状态写进账本：它发布在 `cache-keeper.snapshot`（`{ at, entries }`），每次覆盖上一份，这里只认最新那份。`at` 不早于最后一次真实主线程请求、且这份快照没被消费过，就逐条 `ledger_append`，`text` 以「保活快照：」开头；单条没通过校验（比如 in_progress 缺 next_step）只跳过那一条，写失败只记日志，都不挡住换窗。每份快照只消费一次。

## 配置

下面这些阈值可以在插件配置里改，也可以用同名的大写环境变量改（环境变量优先）。

| 选项 | 环境变量 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `enabled` | `CTX_MOD` | `false` | 不设环境变量时是否启用；`CTX_MOD=1` 开、`CTX_MOD=0` 关，环境变量优先 |
| `compactWindow` | `CTX_MOD_COMPACT_WINDOW` | `400000` | 引擎没报告自动压缩阈值时，按多大的窗口算 |
| `boundaryTokens` | `CTX_MOD_BOUNDARY_TOKENS` | `200000` | 一级提醒：上下文到这么多 token 时，任务告一段落就换窗 |
| `softTokens` | `CTX_MOD_SOFT_TOKENS` | `300000` | 二级提醒：边做边记账，到下一个任务边界换窗 |
| `urgentTokens` | `CTX_MOD_URGENT_TOKENS` | `350000` | 三级提醒：立刻准备换窗 |
| `cooldownRequests` | `CTX_MOD_COOLDOWN_REQUESTS` | `30` | 两次换窗之间至少经过多少次模型请求；`0` 去掉冷却 |
| `maxSwitchesPerHour` | `CTX_MOD_MAX_SWITCHES_PER_HOUR` | `4` | 每小时最多换几次窗；`0` 表示不再批准换窗 |
| `coldMinTokens` | `CTX_MOD_COLD_MIN_TOKENS` | `80000` | 缓存已过期时，上下文超过多少 token 才扣下消息、先换窗 |
| `gateMinTokens` | `CTX_MOD_GATE_MIN_TOKENS` | `120000` | 上下文超过多少 token 时，加载会重建缓存的工具组之前先换窗 |
| `noter` | `CTX_MOD_NOTER` | `false` | 是否让一个 Haiku 小模型读用户消息、把已定决策存进会话目录（见下一节）。关时不调模型，决策仍由规则提取 |
| — | `CTX_MOD_LEDGER_BACKFILL` | `false` | 值为 `1` 且笔记员也开着时，才在同一个后台运行里给“这一轮主模型没记账”的上一轮补一条记录（见“账本补记”） |

- 配置只在会话启动时读一次。取值必须是有限正数（`cooldownRequests`、`maxSwitchesPerHour` 可以是 `0`）；读不到或数值非法时回退默认值，不会报错。
- 三档提醒必须满足 `boundaryTokens ≤ softTokens ≤ urgentTokens`；不满足时三档整组回退默认值，并在调试日志里记一条。
- 想更早换窗（例如上下文到 16–20 万就换），把三档一起调低，比例和默认差不多：比如 `boundaryTokens=160000`、`softTokens=180000`、`urgentTokens=200000`。代价是换窗更频繁：每换一次都只带走账本里记下的东西和磁盘上的文件，没记账的中间结论会丢，缓存也要整段重建。调低之前先让账本保持新。
- 其余阈值仍是 `hooks/lib/types.ts` 里 `DEFAULTS` 的内部常量，不对外开放。`/ctx-mod` 会把与默认值不同的配置列出来；全是默认时不多输出任何东西。

## Haiku 笔记员（实验，默认关）

规则提取只认标记和句式，一段没带标记的话里定下的事会漏掉。打开 `noter`（或 `CTX_MOD_NOTER=1`）后，每收到一条用户亲口说的消息，就在后台用 Haiku 读一遍游标之后的新消息，把其中的长期规则、方案选择和要记住的环境事实记下来，追加到会话目录的 `noted.jsonl`。交接里的“用户已定决策”一节因此变成两部分：笔记员读过的部分按笔记显示，游标之后的少数消息仍走原来的规则提取，合成同一节。它推翻了旧条目时会记一条撤销。

- 默认关闭；开关关着时一个字节都不变，不启动任何子进程。
- 模型调用在回合之外，用 `claude -p --model claude-haiku-5-5 --effort medium`，给子进程设了 `CTX_MOD=0`，不会递归触发本 mod；`noter.lock` 防止并发，超过 15 分钟视为过期。
- 状态文件：`noted.jsonl`（每条决策一行，撤销行形如 `{"revoke":{"seq":3,"by":9}}`）、`noter-cursor.json`（`{"cursorSeq":N}`）、`noter.log`（每批一行：范围、新增、撤销、丢弃、耗时、费用；失败也记在这里）。任何一步失败都不动游标。
- 回退：把 `noter` 设回 `false`（或删掉环境变量 `CTX_MOD_NOTER`）即恢复纯规则提取，已有的 `noted.jsonl` 会被忽略；想彻底清掉就删掉这三个文件。手动补跑一次：`node scripts/noter.mjs <会话目录> [--max-batches N]`。
- 代价：每批一次模型调用（默认每次最多 4 批），实测一批约 4 万字符输入、数美分以内。觉得贵就把开关关掉。

## 账本补记（实验，默认关）

主模型有时在一轮里改了不少东西却没记一笔账，换窗口时那一轮就只留在历史里。打开 `CTX_MOD_LEDGER_BACKFILL=1`（必须同时开着笔记员）后，收到新的用户消息时，同一个后台运行会看上一轮（从上一条用户亲口消息到这条之前）：那一轮没调用过 `ledger_append`、除账本工具外至少 3 个工具调用、还没补记过，就让小模型补一条进展记录，最多一次模型请求。

- 只写进展：状态只能是 `in_progress` 或 `blocked`（模型说 done/superseded 一律按 in_progress 记），evidence 只留该轮动作里真实出现过的编号，一轮最多 2 条，text 截到 200 字，新起任务 id 一轮最多一个。已有的 `next_step`、`anchors`、`done_when`、`dead_ends` 一律沿用，不改。某个任务在这一轮之前就已经 done/superseded 时，这条记录被丢弃，不会把它重新打开。
- 落盘方式：子进程不碰 `ledger.jsonl`（那个文件由主进程整页重写），只把记录写进 `backfill-pending.json`；钩子进程在下一次用户消息或工具调用之后把它并进账本，编号由主进程分配，所以和主模型自己记账不会重号。
- 记录带 `"source": "backfill"`，文字以“〔补记〕”开头，交接首页和 `ledger_read` 里都能看出来；窗口号和时间取那一轮自己的，所以不会让账本在别人眼里显得“刚更新过”。
- 同一轮只处理一次，失败最多重试一次（`backfill-state.json` 记着每轮的尝试次数）。
- 试跑（不写盘、不落日志，只打印将要写入的记录和实际用量）：`node scripts/noter.mjs <会话目录> --backfill-round <轮次编号> --dry-run`；列出可试跑的轮次：`node scripts/noter.mjs <会话目录> --list-backfill-rounds`。

## 数据放在哪

每个会话一个目录：`~/.claude/ctx-mod/<session-id>/`。跨会话的 `~/.claude/ctx-mod/costly.json` 记录哪些工具组加载后会重建缓存，写入时用 `costly.json.lock` 加锁。

| 文件 | 内容 |
| --- | --- |
| `history-wNNN.jsonl` | 第 N 个窗口的历史，一行一条 |
| `big-<编号>-<字段>-<n>.txt` | 超长正文或工具参数的完整原文 |
| `ledger.jsonl` | 当前这一页账本 |
| `archive-NNN.jsonl` | 翻页归档的账本 |
| `handoff-wNNN.md` | 进入第 N 个窗口时的交接信息原文 |
| `events.jsonl` | 每次换窗的记录 |
| `meta.json` | 编号、窗口号、文件活动、派发名单、重建记录等状态 |
| `held.json` | 缓存过期时扣下、还没提交的用户消息 |
| `noted.jsonl` / `noter-cursor.json` / `noter.log` | 笔记员记下的决策、它读到哪儿、每次运行的日志（开关打开时才有） |
| `backfill-pending.json` / `backfill-state.json` | 补记等着并进账本的记录、哪些轮次已经试过（补记开关打开时才有） |

这些文件含有会话的全部内容，包括工具输出。mod 不会把它们发到任何地方。

保留期为 30 天。清理由独立脚本完成，mod 本身不删文件（引擎的文件接口没有删除操作）：

```
# 先列出将被删除的目录（dry run，不删除）
powershell -File scripts\prune-sessions.ps1
# 确认后真正删除
powershell -File scripts\prune-sessions.ps1 -Apply
```

脚本只删数据根目录下 GUID 命名、最后写入早于 30 天的会话目录；根目录下的 `costly.json` 和 `probe-*.jsonl` 不动。它不会自动运行，需要你手动执行，或自行配置计划任务。

## 已知限制

- 助手在回合中间、工具调用之前说的话，有一部分在引擎里是思考块，不会进历史。每回合最后的正式回复不受影响。
- 换窗只保留账本里记下的东西和磁盘上的文件。模型没记账的中间结论会丢，所以账本不新时 mod 会拒绝零摘要换窗。
- 请求数、窗口大小等判断依赖引擎的事件，引擎版本变了可能要跟着改。
- `costly.json` 跨会话表已加锁，但抢不到锁就放弃这次记录，仍是尽力而为；它影响加载前的拦截和交接提示。
- 真实引擎中很多改动要重启已开会话才生效。有些行为只在单元测试或假引擎里验证过。桌面应用和终端交互会话还没测。

## 开发

```
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .
```

`.claude-plugin/types/` 是引擎加载 mod 时生成的类型定义，不入库。从磁盘加载开发中的 mod：`claude --plugin-dir <这个目录>`。
