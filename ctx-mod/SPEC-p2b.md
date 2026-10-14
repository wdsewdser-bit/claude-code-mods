# SPEC-p2b：请求数按真实的模型请求计（astra 审查 P2 第 8 条）

## 起因

`noteRequest()` 在 `tool.call` 钩子里、每个普通工具调用结束后执行（`register.ts` 约 751 行）。后果：

- 一次模型请求里并行跑 3 个工具，记成 3 次请求；本 mod 自己的工具不计；**纯文本的请求（不调工具）完全不计**。
- `lastRequestAt` 因此是"最后一个普通工具结束的时间"。连续聊天不调工具时它一直不更新，过了缓存寿命（`cacheTtlSec`，3600 秒）后 `isCold` 会把其实还热着的缓存判成过期，白白扣下消息去换窗。
- 换窗后的前缀采样（`awaitingPrefix` → `notePrefix`）也挂在第一次普通工具调用上，新窗口第一轮不调工具就一直采不到。

## 改动

位置：`hooks/register.ts` 的 `on('turn.step', …)`（约 937 行）和 `tool.call` 后半段（约 745–760 行）；`hooks/lib/session.ts` 的 `noteRequest` / `noteStep` / `notePrefix`；`hooks/lib/types.ts` 里 `cooldownRequests` 的注释。

1. 请求在 `turn.step` 里记：主循环（`e.agentId === undefined`）的一步返回后记一次，不管这一步有没有调工具、`usage` 是不是 null。子代理的步不记。
2. 同一步不重复记：按 `e.turnId` + `e.index` 去重（记住上一次记的那一对即可，不用存整张表）。
3. `tool.call` 后半段里的 `session.noteRequest()` 删掉。那里的上下文提醒（`session.reminder(env)`）留着不动。
4. 前缀采样也挪到 `turn.step`：换窗后主循环第一步返回且有 `usage` 时采一次，值取这一步的 `input + read + write`，传给 `notePrefix`（它内部减掉交接信息大小的逻辑不变）。`tool.call` 里那段采样删掉。`awaitingPrefix` 的置位和清零点（约 1060、1085、1230 行）不变。
5. `cooldownRequests`（默认 30）数值不动，注释写清单位是"主循环的模型请求数"。磁盘上旧的 `requestsSinceSwitch` 不迁移。
6. `/ctx-mod` 状态里"距上次换窗口 N 次请求"文案不用改，现在名副其实了。

## 测试

- 一步里 3 个普通工具调用 → 请求数加 1，不是 3。
- 纯文本的一步（没有工具调用）→ 请求数加 1，`lastRequestAt` 更新。
- 子代理的步不计。
- 同一个 `turnId` / `index` 来两次只计一次。
- 换窗后第一步没有工具调用也能采到前缀。
- 已有测试里靠工具调用把请求数顶上去的（冷却门槛、冷缓存判断相关），改成用 `turn.step` 驱动，并在报告里列出改了哪几条。

## 验收（主会话会重跑）

```
claude plugin test C:\Users\yadaz\.claude\skills\ctx-mod
npx --yes -p typescript tsc -p C:\Users\yadaz\.claude\skills\ctx-mod
claude plugin validate C:\Users\yadaz\.claude\skills\ctx-mod --strict
```

基线：356 个测试全过，tsc 0 错误，validate --strict 通过。
