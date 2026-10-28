# cache-keeper

Claude Code mod（function hooks 插件）：观察 prompt cache、在同一进程内保活、跑 5m / 1h TTL 的 A/B 实验并出报告。按《Claude Code 缓存保活与 5 分钟缓存 A/B 测试实施规范》v1.0 实现，针对 Claude Code 2.1.288 的 Mods API，2026-10-08 在 2.1.293 上复验（validate、test、transcript 解析）。

保活只能用 `$.model.fork`：缓存按模型和前缀存，换成 Haiku 或 `$.model.complete({ cache: true })` 的请求是另一条 5 分钟缓存，续不了主会话的 1 小时条目。

## 安装

```
/plugin install cache-keeper --marketplace wdsewdser-bit/claude-code-mods
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/cache-keeper status` | 版本、模型、TTL（请求值 / 日志实测值）、缓存前缀、idle、meter |
| `/cache-keeper start` / `stop` | 开 / 关保活。默认开；`stop` 只关当前 session |
| `/cache-keeper anchor [on|off]` | 查看 / 设置当前会话是否为锚点（见「锚点会话」）；`on` 会顺带开启保活，`off` 不动保活开关 |
| `/cache-keeper probe` | 立刻做一次 `$.model.fork` 探测，报告命中情况与 meter 前后值 |
| `/cache-keeper agents` | 子代理的 TTL、被跟踪的子代理和保活计数；`agents ping` 立刻给每个都保活一次 |
| `/cache-keeper experiment preflight` | 不花 token 的实验前检查 |
| `/cache-keeper experiment <plan>` | 在当前 session 跑一个实验 cell（见下） |
| `/cache-keeper experiment abort` | 中止当前实验 |
| `/cache-keeper report` | 生成 `cache-events.csv`、`experiment-summary.json`、`cache-report.md` |

## 保活规则

保活默认开启，只在全部成立时发一次 `$.model.fork({ prompt: 'Reply with OK only.' })`：没有被 `stop`；没有 turn 在跑；最近一次主线程请求的缓存前缀（read + write）≥ `minCacheReadTokens`；距该请求**开始**已到阈值（5m：245 s，1h：3120 s）但未超过 TTL；meter 未到 `maxRateLimitPercent`；没有处于"待重建基线"。

- TTL 已过就不再发：那只会是一次整段重写，等下一次真实请求。
- 一段 idle 内的保活次数有上限 `maxIdleKeepalives`，默认 3（1h TTL 下约覆盖 4 小时闲置），之后任缓存过期；设 0 = 按 API 单价的 break-even（Opus 5.5：5m 24 次、1h 39 次；Sonnet 5.5：5m 24 次）。这是 API 口径的启发式，不是套餐额度结论。
- 连续 `maxConsecutiveProbeFailures` 次 miss / 失败，或 5 小时额度超阈值：自动停止并提示。周额度不参与：它没用完时停保活只会换来一次整段重写，用完后请求失败，按失败次数停。
- 模型或 effort 变化、compact 之后：暂停，直到下一次真实请求再次命中缓存。`/clear` 后等待新基线。
- 不启动第二个 `claude --resume` 进程，不碰认证 token，不调用私有接口。
- 一段闲置的**最后一次**保活（发完这次 `idleKeepalives` 就等于 budget）、缓存前缀 ≥ 80k、且 `ledgerSnapshot`（默认 `true`）开着时，fork 的 prompt 换成要求模型只输出一个 JSON 数组：主会话里还开着的任务，每项 `{task_id, title, status: in_progress|blocked, text, next_step}`，最多 8 项，没有就是 `[]`。这次请求照常算作保活（命中、计数、TTL 续期都与普通保活一致）；解析失败（前后有文字、被代码块包裹都允许）就当没有快照，不影响保活结果。手动 `probe` 和实验里的 keeper 步骤永远用 `probePrompt`。

## 子代理保活

子代理的缓存和主会话是两套：前缀不同，互相不续期；TTL 也分开，引擎默认给主会话以外的请求（子代理、workflow、后台请求）5 分钟。要 1 小时，在 `~/.claude/settings.json` 里写 `"subagentPromptCacheTtl": "1h"`，或设环境变量 `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h`（优先于设置）。settings.json 只要有一处语法错误，整个文件都不生效，引擎不报错。

一个子代理跑完后，mod 按它最后一次请求计时，到阈值（1h：3120 s，5m：245 s）就用 `$.session.send` 把它唤起一次，只让它回 OK：这次请求读它自己的缓存前缀，TTL 重新计。每个子代理最多 `subagentKeepalives` 次（默认 2，1h 下约覆盖 2.7 小时；0 = 关），主模型再给它派活后重新计数。

- 只保 `minCacheReadTokens` 以上的前缀；主保活被 `stop`、或 meter 到 `maxRateLimitPercent` 时不发。
- 保活的那一轮结束时引擎会给主会话发完成通知，mod 在 `prompt.submit` 把它丢掉，主模型不会被叫起来。transcript 里留一行 "Prompt dropped by a hook: cache-keeper kept subagent … warm"。
- 子代理的对话里会多出保活的一问一答，各几十个 token。
- 某次保活没命中（实际 TTL 比设想的短）：不再保那个子代理；连续 `maxConsecutiveProbeFailures` 次就整个停掉子代理保活。
- 后台子代理按引擎的列表认，前台子代理按 session 存下的 `subagents/agent-<id>.meta.json` 认；引擎自己的 fork（compact 等）两处都没有，不会被唤起。agent 定义里单独写的 `cacheTtl` 这里看不到。

## TTL 的来源与验证

请求值按引擎自己的优先级读取：`FORCE_PROMPT_CACHING_5M` > `CLAUDE_CODE_PROMPT_CACHE_TTL` > 设置项 `promptCacheTtl` > 自动（订阅内 1h）。

Mods API 的 usage 只有四个 token 计数，没有 5m/1h 拆分。所以实测值来自 transcript：每个 turn 结束后读 `message.usage.cache_creation.ephemeral_5m/1h_input_tokens` 和 `message.diagnostics.cache_miss_reason`，按"四个计数相同 + 时间最近"配到在线记录上。请求值与实测值不符时标 `TTL_CONFIG_MISMATCH`，该 run 不进入成本比较。没有请求值时，保活按实测值排程；两者都没有就不保活。

## 实验

无人值守跑一组（CLI 需先 `claude auth login` 登录一次）：

```bash
node "$HOME/.claude/skills/cache-keeper/scripts/run-experiments.ts" --dry-run
```

去掉 `--dry-run` 即开跑。默认组是 A、B 各一次加 C1 每个 TTL 三次（约 3.8 小时）；`--set smoke` 只跑 A@5m（2 分钟），`--set full` 再加 C2 和 D（约 11.6 小时）；`--cells keeper:5m,keeper-control:1h --reps 3` 自选。它为每个 cell 起一个全新的无头 session、设好 TTL、等 mod 写出 run 记录后关掉，第一个 cell 失败或 meter 到 85% 就停，最后生成报告。

手动跑单个 cell：每个 cell 用一个**全新 session**，TTL 在启动前定好：

```powershell
& "$HOME\.claude\skills\cache-keeper\scripts\run-cell.ps1" -Ttl 5m
```

session 内先 `/cache-keeper experiment preflight`，再跑一个 plan：

| plan | 实验 | 时长 | 内容 |
| --- | --- | --- | --- |
| `ttl` | A | 1.5 min | 建缓存，90 s 后 probe。5m 和 1h 各跑一次 |
| `renew` | B | 12 min | 5m：4:00、8:00 保活，12:00 probe |
| `renew-control` | B 对照 | 6.5 min | 5m：不保活，6:30 probe |
| `active` | C1 | 33 min | 每 3 分钟一次 probe，共 11 次。5m 和 1h 各 3 次 |
| `intermittent` | C2 | 50 min | 每 10 分钟一次 probe，共 5 次。5m 和 1h 各 3 次 |
| `keeper` | D2 | 18 min | 5m：每 4:05 保活，18:00 probe |
| `keeper-control` | D1 | 18 min | 不保活，18:00 probe。5m 是对照，1h 是"直接用 1h"基线 |

"建缓存"是提交一条带约 60k token 静态填充的消息（`tokens=N` 可调），填充以本次 run 的 nonce 开头，所以不同 run 不会读到彼此的缓存。benchmark probe 是真实 turn（写进 transcript，能拿到 5m/1h 拆分），keeper 步骤是 fork。

实验期间不要用这个账号做别的事：本 session 的 subagent、实验外的 turn、其他装了本 mod 的 Claude Code session 的请求都会让该 run 标记为 `contaminated` 并排除出主统计。网页和手机端的使用从这里看不到，需要自己保证。

## 数据

所有 session 共用一个目录，默认 `~/.claude/cache-keeper/`（`dataDir` 可改；写相对路径就落在各 session 的工作目录下）：

```text
~/.claude/cache-keeper/
  cache-events.csv           每个请求一行（规范 §13 的字段，另加 result、cost_basis）
  experiment-summary.json    按 cell 汇总 + 对比 + 结论
  cache-report.md
  raw/
    events-<session>-<n>.jsonl   在线记录，含 meter 前后值
    run-<实验>-<ttl>-r<n>-<session>.json
```

报告把两种成本分开：API 等价成本按官方单价（2026-10-08 核对，含 Haiku 5.5 按 prompt 长度的两档）由日志算；套餐额度只看 `$.session.usage().rateLimits` 的百分比增量。meter 判定要求每侧至少 3 次干净重复、且增量至少 2 个百分点，否则写"无法判断"。

离线工具（Node 24+，只读 transcript）：

```bash
node scripts/analyze-transcript.ts <session.jsonl>
```

```bash
node scripts/analyze-transcript.ts --report <dataDir>
```

## 解释一次缓存未命中（CACHE-01）

```bash
node scripts/explain-cache.ts <session.jsonl>            # 或 --session <id> 在 ~/.claude/projects 下找
node scripts/explain-cache.ts <session.jsonl> --json     # 机器可读
node scripts/explain-cache.ts <session.jsonl> --tail 20  # 只看最后 20 个请求
```

逐个请求列出：工具清单 hash、系统提示 hash / 字符数、插件集 hash（MCP + skills，能拿到多少算多少）、`cache_read` / `cache_creation`、缓存是否命中、距上次请求的间隔、TTL，以及未命中的原因。原因分三级：

- **observed**：transcript 里直接可见。`message.diagnostics.cache_miss_reason`、工具清单 hash 变化、系统提示 hash 变化、插件集 hash 变化、`previous_message_not_found`（服务端驱逐）、两次请求之间的 `compact_boundary`（`compaction`，带 `trigger`）。
- **inferred**：只能推断。距上次请求超过 TTL、模型变化、客户端版本变化、空闲压缩（`idle_compact`）。
- **空闲压缩（`idle_compact`）**：引擎在缓存过期前按 TTL 的 0.9（1h 缓存约 54 分钟）给空闲的大会话做压缩。transcript 的 `compactMetadata` 只写 `trigger`（`manual` / `auto`）和 token 数，引擎内部标记 `precomputed` 目前不落盘（2.1.299–2.1.306 的 469 条边界里一条都没有），所以：边界带 `precomputed: true` 时记 observed；否则只有 `trigger` 为 `auto` 且压缩前空闲 ≥ 50 分钟时记 inferred。同一段空闲后因上下文超限触发的 auto 压缩看起来一模一样，无法区分；`manual` 压缩即使空闲很久也仍是普通 `compaction`。
- **unknown**：没有可见原因，或该会话的 transcript 根本没带前缀信息。拿不到的字段标 `unknown`，不猜。

hash 的输入是 transcript 里的 `prompt_snapshot`、`deferred_tools_record` / `deferred_tools_delta`、`mcp_instructions_delta`、`skill_listing`。没有工具定义时工具 hash 按名字算（`toolHashBasis: names`），两者都没有就是 `none`；插件集同理（`mcp+skills` / `mcp` / `skills` / `none`）。系统提示只存 hash 和长度，不存正文。

## 影子模式与净收益（CACHE-02）

`ledgerSnapshot`（默认 `true`）：一段闲置的最后一次保活顺便问一次还开着的任务，结果发布在 `snapshot` 槽里（见下）。关掉后每次保活都只发 `probePrompt`。

`shadowMode`（默认 `false`）：不发送任何保活请求，只把"这次本该保活"记成 `kind: shadow` / `result: would_have_keepalive` 的事件；用户下一次请求到来时再记一行 `kind: recovery`，带 `shadow_recovery_sec`（距上一次请求的真实间隔）。影子模式不改动真实保活的状态（`lastActivityAt`、`idleKeepalives`、失败计数、暂停原因），关掉开关后行为与原来一致；子代理的 would-have 也会记录（带 `agent_id`）。

统计脚本（Node 24+，只读 transcript，可选读事件目录）：

```bash
node scripts/keepalive-net.ts                                   # 最近 200 个转录
node scripts/keepalive-net.ts --sort size --max-files 40        # 最长的会话
node scripts/keepalive-net.ts --events ~/.claude/cache-keeper   # 附带影子事件统计
node scripts/keepalive-net.ts --prices '[["opus-5-5",{"input":4,"write5m":5,"write1h":8,"read":0.2,"output":20}]]'
```

对每一对相邻请求：间隔超过 TTL、前缀 ≥ `--min-prefix`（默认 40000）才计入；按 keeper 的阈值（5m 245 s / 1h 3120 s）模拟最多 `--max-idle` 次保活。省下的钱 = 下一次请求实际写入的 `cache_creation_input_tokens` ×（写价 − 读价），且只在下一次请求没有命中缓存时计；成本 = 每次保活按读价读整段前缀 + 少量输入/输出。价格是 API 等价 USD / 百万 token，默认值在脚本顶部，来源 platform.claude.com/docs/en/about-claude/pricing（2026-10-08 读取），可用 `--prices` 覆盖。

大转录默认按 `--max-bytes`（12 MB）和 `--max-total-bytes`（200 MB）跳过，跳过的数量会打印出来；要覆盖更多就调大这两个值。`--ttl auto` 用线程里最后一次可见的 5m/1h 拆分，mixed 按 1h；没有拆分时按 5m，并在输出里给出 `ttlDefaultedGaps`。

## 已知限制

- fork 请求不写进 transcript，所以 keeper 行拿不到 5m/1h 拆分；它极少写缓存，写了就按该 session 的 TTL 计价（`cost_basis` 会标 `assumed-*`）。
- 前台子代理运行期间主会话的 turn 还没结束，主保活不发；单个子代理连续跑过主会话的 TTL，回来那一步会整段重写。
- system prompt / 工具定义的变化没有直接事件，只能通过随后请求的 miss 和 `cache_miss_reason` 看出来。
- transcript 超过 4 MiB 时改用 `node scripts/analyze-transcript.ts --tail` 读尾部；没有 node 就拿不到拆分。
- Mods API 仍是 early access，升级 Claude Code 后先跑 `claude plugin validate` 和 `claude plugin test`。

## 额度桥接（v0.4.0）

5 小时额度到 `bridgeAtPercent`（默认 90）时：给**主会话**发一条收尾消息（只完成当前一步、写交接、停下）；之后按 TTL 持续保活到额度重置（不受 `maxIdleKeepalives` 限制，不设百分比停止线（额度再高也保，直到重置）；距重置够近、缓存撑得到重置后的「继续」就不再多 ping）；重置后约 20 秒自动发「继续」。

- 只有最近 10 分钟（取它与缓存 TTL 中更短的一个）内有**用户或助手消息**、或仍在跑回合、或仍有后台任务的会话才会被唤醒；久未动的旧会话不会被叫起来。保活 fork 不算活动，不刷新计数。
- 不给子代理发任何消息。每个窗口只收尾一次。
- 收尾后你自己又发了消息 = 接管，重置后不再自动继续。`stop`（命令或按钮）取消桥接。
- 输入框上方有一条状态栏，带「开启保活」「关闭保活」两个按钮，等同 `/cache-keeper start|stop`，只作用于当前会话。
- 周额度到 `weeklyHandoffAtPercent`（默认 98，0 = 关）时，给最近 10 分钟内有用户消息、或仍在跑回合、或仍有后台任务的主会话发一条通知：写一份交接检查点（更新已有台账，没有就新建 `HANDOFF.md`），然后继续干活。每个周窗口只发一次；不叫停、不保活到重置、重置后不自动继续，由新对话按文档接手。与保活开关无关。
- 选项：`bridgeEnabled`、`bridgeAtPercent`、`weeklyHandoffAtPercent`。逻辑在 `hooks/lib/bridge.ts`，测试在 `tests/bridge.test.ts`。

## 给其他 mod 读的缓存状态（v0.4.1）

- `$.state` 里发布 `cache-keeper.cache`：`{ lastActivityAt, ttl, expiresAt, cachedPrefixTokens, isEnabled, pausedReason, bridgePhase }`。`expiresAt` 之后缓存就是冷的；`bridgePhase` 为 `wrapped` 表示已发收尾、正在等 5 小时额度重置。别的 mod 把 `cache-keeper` 列进 `dependencies` 后用 `$.state.get({ plugin: 'cache-keeper', key: 'cache' })` 读，只读。
- `cache-keeper.snapshot`：`{ at, entries }`，最后一次保活看到的还开着的任务（`at` 是那次请求开始的时间，`entries` 最多 8 项，每项 `{ task_id, title, status, text, next_step? }`）。只在 `ledgerSnapshot` 开着、前缀 ≥ 80k、且是一段闲置的最后一次保活时写；解析失败就不写。ctx-mod 在冷缓存换窗前读它：`at` 不早于最后一次真实主线程请求、且这份快照没被消费过，就把每条写进账本。
- 别的 mod 回答了压缩（不调 `next`）时，本 mod 的 `session.compact` 钩子可能收不到。另加两道判断，任一成立就按"已压缩"暂停保活，直到下一次真实请求再次命中：引擎存下压缩边界行（`session.append`，`door: compaction`）；或保活前发现当前上下文不到所记前缀的一半。

## 锚点会话（v0.5.0）

用途：让一个几乎空的会话长期挂着，靠保活让跨会话共享的系统前缀缓存不过期，别的会话开局就能命中它。

- 开启：`/cache-keeper anchor on`（保活原本是关的则一并开启），或点输入框上方栏里的「设为锚点」；`anchor off` 或「取消锚点」只清掉锚点标记，不改保活开关；`/cache-keeper anchor` 查看当前状态。栏文字在锚点开启时带「锚点」。状态跨重载保存。
- 与普通保活的差别：不受 `maxIdleKeepalives` 限制（status 里 budget 显示 unbounded），也没有 5 小时额度的百分比停止线（与额度桥接期间一致）。其余停止条件不变：被 `stop`、连续失败、压缩暂停、前缀小于 `minCacheReadTokens`。
- 缓存一旦过期仍不会补写：弹一次提示「anchor cache expired」，之后要在该会话里手动发一条消息重建；下一次真实请求或保活命中后提示复位。
- 只有锚点与目标会话的插件 / MCP / 工具集一致，系统前缀才相同、缓存才共享；两边不一致时锚点保的是另一份缓存。
