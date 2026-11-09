# cc-restart

让会话里的模型自己重启 Claude 桌面版。重启后只重新打开**发起重启的那个会话**；其他正在干活的会话写进唤醒消息，由发起会话用桌面版自带的跨会话消息工具去通知。

这是一个 Claude Code mod（TypeScript 插件），放在 `~/.claude/skills/cc-restart/`，由 Claude Code 的 skills-dir 自动加载，不需要改 settings.json 或 installed_plugins.json。

## 工具

`mcp__cc-restart__restart_cc`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `message` | string | `[cc-restart] Claude Code 已重启，请读账本，接着之前的任务继续` | 发起会话被唤醒时提交的文字（后面会自动附上 others 通知说明） |
| `delaySeconds` | number | `5` | 调用后等多少秒再重启（0–600） |
| `wakeTaskId` | string | — | 一般**不用传**：第一步返回的任务 id 会记进 `<数据目录>/wake-plan.json`，第二次调用直接读它。传 `none` 表示跳过唤醒任务直接重启（重启后需手动打开本会话） |

### 两步调用（不依赖 `wakeTaskId` 参数）

1. **第一次调用**：不重启，只返回一次性定时任务的参数（`taskId` 形如 `cc-restart-wake-<ms>`、`fireAt`、`prompt`），同时把 `{taskId, ts}` 写进 `<数据目录>/wake-plan.json`（默认 `~/.claude/cc-restart/wake-plan.json`，与 `pending.json` 同目录）。
2. 模型按返回的参数调用 `mcp__scheduled-tasks__create_scheduled_task` 建任务。
3. **第二次调用**（参数同第一次，不需要 `wakeTaskId`）：工具从 `wake-plan.json` 取出任务 id，然后
   - 在桌面版定时任务注册表 `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude-code-sessions\<account>\<workspace>\scheduled-tasks.json` 里确认存在 `id` 与之一致且 `enabled !== false` 的条目（两层目录都未知，逐个查）；找不到就返回 `wake-task-missing`，不重启；
   - 按任务 id 里的时间戳算离到点还有多久，不足 `delaySeconds × 1000 + 10 秒` 时删掉计划并返回 `wake-task-too-close`，让模型删掉旧任务后重新调用（那时会生成新计划）；
   - 都通过后写 `pending.json`、启动 worker，成功后清空 `wake-plan.json`。

这样即使模型看到的工具参数定义还是旧的、`wakeTaskId` 被丢掉，第二次调用也能认出自己处在第二步，不会被当成第一步重来。

## 流程

1. 工具枚举桌面版当前打开的所有 Code 会话，判断每个是否在干活（规则见下）。
2. 写 `~/.claude/cc-restart/pending.json`：**只有一条**，是发起会话；其他会话放在它的 `others` 数组里。
3. 启动独立的 PowerShell worker（WMI `Win32_Process.Create`，脱离本进程树），等 `delaySeconds` 秒。
4. worker 只结束 MSIX 包里的 `Claude.exe`，重新启动桌面版，然后**只对发起会话**执行一次 `claude --desktop --resume <id>`。
5. 发起会话触发 `session.start`：`wake=true` 且 10 分钟内就 `$.prompt.submit({ text: message })`，然后删掉自己那一条（数组空则删文件）。
6. 被唤醒的发起会话读到消息里的 others 列表，调用 `mcp__ccd_session_mgmt__list_sessions` / `mcp__ccd_session_mgmt__send_message`（或新的 `SendMessage`，`to` 填 `local_…`）通知其他会话。

## 唤醒消息（发起会话）

调用者给的 `message` 后面会自动追加：

- 调用 `mcp__ccd_session_mgmt__list_sessions`，按 cwd、标题、CLI 会话 id 把下列会话对应到 `local_` 会话 id；
- 对每个 `wake=true` 的会话调用 `mcp__ccd_session_mgmt__send_message`（`session_id` 用 local id，`message` 用给出的 message）；目标会话会立刻开始一轮，忙时排队；
- `wake=false` 的不用处理；
- 处理完汇报通知了哪些、哪些没对上。

每个 other 的字段：`cliSessionId`、`localId`（来自桌面版数据，没找到时是 null）、`cwd`、`标题`、`wake`、`reason`、`message`、`interrupted`。

## CLI uuid ↔ 桌面版 local_ 会话 id 的映射（已查实）

桌面版自己保存了映射，文件是：

```
%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude-code-sessions\<account>\<workspace>\local_<uuid>.json
```

每个会话一个 JSON，关键字段：

- `sessionId`：`local_<uuid>`，就是 `send_message` / `SendMessage` 的 `session_id` / `to`；
- `cliSessionId`：CLI 会话 uuid，等于转录文件名和 `--resume` 参数里的那个；
- `cwd`、`originCwd`、`title`、`isArchived`、`lastActivityAt`。

`-Discover` 会读这些文件，把 `localId`、`title`、`cwd` 一起带出来，因此 others 里通常已经写好了 localId，发起会话不需要自己匹配；没查到映射（或会话是归档的）时 `localId` 为 null，消息里会标注「没有找到映射，需要自己匹配」。

## 识别「桌面版拉起的 Code 会话」的依据

1. 进程名 `claude.exe`，可执行文件在 `%LOCALAPPDATA%\Claude-Data\<包>\claude-code\<版本>\<hash>\claude.exe`。
2. 命令行有会话 id：桌面版用 `--resume=<uuid>`；也兼容 `--resume <uuid>` / `--session-id <uuid>`。
3. **直接父进程**的可执行文件在 MSIX 包内（`...\WindowsApps\Claude_*\app\Claude.exe`）。父进程是 `node`（终端或 delegate 的 `run-delegate.mjs`）的不算——本机实测：桌面版会话的父进程直接是桌面版主进程，delegate 子会话的父进程是 node。
4. 转录在 `~/.claude/projects/<slug>/<sessionId>.jsonl`。

脚本只读取这些进程，从不结束它们；重启时只结束 MSIX 包里的 `Claude.exe`。

## 判断「正在干活」的规则

读转录末尾 512 KiB 逐行解析。满足任意一条就算 `wake=true`：

**(a) 回合还没结束**：
- 最后一条记录是 `api-request`；
- 最后一条 user/assistant 消息是 `user`（真人消息或工具结果，助理还没回）；
- 最后一条消息是 `assistant` 且带 `tool_use`。

**(b) 回合已结束，但重启会杀掉还在等结果的后台任务**（格式对照过 `~/.claude/projects` 的真实记录）：
- 后台 Bash：`tool_result` 文本 `Command running in background with ID: <id>. Output is being written to: ...`，之后没有 `<task-id><id></task-id>` 的 task-notification。
- 后台子代理：`Agent` 的 `tool_use` 带 `run_in_background: true`，之后没有 `<tool-use-id>` 等于该 tool_use id 的 task-notification。
- delegate：`tool_result` 文本 `[delegate ... · 后台任务 bg-xxx] 已启动`，之后没有 `【delegate 后台任务 bg-xxx 完成】` / `失败】`。
- Monitor：`Monitor` 的 `tool_use` 之后没有对应 task-notification。
- ScheduleWakeup：最后一次不是 `stop: true`，且其后没有真人消息。
- CronCreate：存在且没有对应的 `CronDelete`。

都不满足按**空闲**处理，并把依据写进日志和干跑输出。中断任务按 `type+id` 去重。

## pending.json（一条 + others）

```json
[
  {
    "sessionId": "<发起会话>",
    "cwd": "D:\\work",
    "wake": true,
    "message": "<调用者文字 + others 通知说明>",
    "ts": 1794164000000,
    "state": "working",
    "reason": "发起重启的会话",
    "initiator": true,
    "interrupted": [],
    "others": [
      {"cliSessionId":"<cli uuid>","localId":"local_…","cwd":"D:\\other","title":"…","wake":true,"reason":"…","message":"…","interrupted":[{"type":"delegate","id":"bg-…","detail":"…"}]},
      {"cliSessionId":"<cli uuid>","localId":null,"cwd":"D:\\idle","title":"…","wake":false,"reason":"…","message":"","interrupted":[]}
    ]
  }
]
```

## 并发保护

多个会话同时启动的窗口很小（现在只有发起会话被重新打开），但删除仍然走 PowerShell 的 `-Consume`：命名互斥量 `Local\cc-restart-pending` + 读、过滤、写临时文件、`Move-Item -Force` 原子替换，不会覆盖或丢掉别人的条目。

## 干跑

```
node --experimental-strip-types scripts/dryrun.ts
node --experimental-strip-types scripts/dryrun.ts --transcript tests/fixtures/working-with-background.jsonl
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-claude.ps1 -DryRun
```

第一条列出桌面版当前打开的每个会话、干活/空闲、命中的规则、标题与 localId，然后打印模拟的 pending.json 和发起会话的唤醒消息全文；第二条用真实格式样本验证规则 (b)；第三条列出会结束的进程、启动目标、只 resume 发起会话以及 others 列表。

## 限制与风险

- 真实重启链路（WMI detach → 杀进程 → 启动 → resume 发起会话 → 唤醒 → 用 session 工具通知其他会话）只做了干跑，没有实际执行。
- `send_message` 投递后目标会话是否会由桌面版自动拉起（而不是因为进程已被关闭而失败），没有实测；消息里要求发起会话汇报哪些会话没通知成功。
- 映射来自桌面版的 `claude-code-sessions/*/local_*.json`；归档会话、或桌面版改了数据格式时 `localId` 可能缺失，此时靠 `list_sessions` 的 cwd/标题匹配。
- 状态判断读转录尾部 512 KiB；后台任务启动在更早位置、完成通知在尾部之外时可能漏判。
- ScheduleWakeup / Cron 判断偏保守，可能多唤醒一次。
- 依赖 Windows 与 MSIX 安装的 Claude 桌面版（包族名 `Claude_pzs8sxrjxfjjc`，通过 `Get-StartApps` 动态获取）。

## 开发

```
npx -p typescript tsc -p .
claude plugin test .
claude plugin validate --strict .
```
