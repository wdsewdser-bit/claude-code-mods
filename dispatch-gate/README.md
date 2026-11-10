# dispatch-gate

主会话的软闸门：连续自己做太多，就提醒一次、再拦一次；Claude 子代理派得太密，也拦一次。所有拦截都是软的——每个连续段、每个小时窗口最多拦一次，模型重试即放行。

## 它管什么

**方向一：主会话自己干太多。** 按请求计数（一个 `turn.step` 记 1，同一请求里并发 5 个 Read 仍记 1），只看主会话，不看子代理：

| 请求里有什么 | 对计数 |
| --- | --- |
| 派发：`Agent`、`Task`、`SendMessage`、`mcp__delegate__delegate_flash/pro` | 清零，并给 3 批只读验收宽限 |
| 执行：`Read/Grep/Glob/Bash/PowerShell/Edit/MultiEdit/Write/NotebookEdit/BashOutput/mcp__ptc-run__run_code` | +1（宽限期内全是 Read/Grep/Glob 的批次不计） |
| 簿记：`mcp__ccd_turn__update_plan/wrap_up`、`mcp__ctx-mod__context/history/ledger_append/ledger_read` | 不变，也不清零 |
| 其他（WebFetch、浏览器、LSP、AskUserQuestion、纯文本） | 不变，也不清零 |

优先级：派发 > 执行 > 簿记 > 其他，混合批次按最高的算。

- 第 4 个连续执行请求（`remindAt`）：在 `classic.PostToolBatch` 里注入一次提醒，本段只提醒一次。
- 第 8 个连续执行请求（`denyAt`）：该请求里的第一个执行类 `tool.call` 被拒一次，本段只拒一次，重试即放行。
- 用户新消息、`session.start/end`、任何派发都会清零。
- 只能主会话做的事不计：`claude --version/--print/--doctor`、`--inspect`、`debugpy/gdb/lldb`、`-it`/`--interactive`、`chrome/msedge/playwright` 这类 Bash 或 run_code 输入，以及本来就不在执行类里的浏览器、LSP、AskUserQuestion。

**方向二：Claude 子代理派得太密。** 统计主会话调用 `Agent`/`Task` 的次数，滚动 1 小时窗口内超过 `agentPerHour`（默认 3）时，对下一次派发软拦截一次：拒绝理由里要求先按文件集合合并分包；确实不能合并的，重新调用并在 prompt 开头写明为什么不能合并。重试即放行，同一小时内不再拦。派给 DS（`mcp__delegate__delegate_flash/pro`）不计入这一侧、不设上限，并且也会清零"自己干"的计数。

## 配置

安装时的设置页或 `/plugin` 的配置菜单里改：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `soft` | `off` 什么都不做；`remind` 只提醒不拦；`soft` 提醒 + 两处软拦截 |
| `remindAt` | 4 | 连续第几个执行请求后提醒 |
| `denyAt` | 8 | 连续第几个执行请求后拦一次 |
| `agentPerHour` | 3 | 一小时内允许派几个 Claude 子代理 |
| `grace` | 3 | 派发之后几批只读验收不计 |

环境变量（启动 Claude Code 时给）：`DISPATCH_GATE=0` 整段关掉，`DISPATCH_GATE_MODE=off|remind|soft` 覆盖 `mode`。

## 不会死锁

一个连续段最多拒一个批次，被拒后下一批一定放行；一个小时窗口最多拒一次派发，重试一定放行；派发或用户消息立即清零；子代理自己的调用一律不管；hook 抛错一律走引擎原路径（fail-open）。状态只在内存里，重启即清空，重启后只会更宽松。

## 安装

```
/plugin install dispatch-gate --marketplace wdsewdser-bit/claude-code-mods
```

## 开发

```
claude plugin validate dispatch-gate --strict
claude plugin test dispatch-gate
```

离线回放（不调模型、不联网，只读转录）：

```
node dispatch-gate/scripts/replay.ts [--mode off|remind|soft] [--remind-at N] [--deny-at N] [--agent-per-hour N] [--json] <transcript.jsonl>...
```

它按主会话的请求走同一套状态机，打印 L1 提醒、L2 拦截和每次 Claude 子代理派发（被拒的标 `REFUSED`）。子代理自己的转录在 sidechain 文件里，所以主会话转录正好是主线程的请求。

## 回滚

`mode=off`、`DISPATCH_GATE=0`、`/plugin disable dispatch-gate`，或者直接删掉这个目录。不改 ctx-mod、不改 `CLAUDE.md`。
