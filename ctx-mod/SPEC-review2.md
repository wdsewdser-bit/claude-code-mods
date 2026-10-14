# 任务说明：只读审查 session.ts 和 register.ts

做一次只读的独立代码审查。不要改任何文件。目标是找出真实的缺陷，不是提风格意见。

## 范围

目录 M = `C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod`

- `M\hooks\lib\session.ts`（每个会话一个的状态对象）和 `M\tests\session.test.ts`
- `M\hooks\register.ts`（引擎钩子接线，目前没有测试）

它们依赖的纯库（`hooks\lib` 下的 usage、history、ledger、workset、handoff、types）已经审查并修复过，只在需要确认契约时去读，不必再审。

## 背景

这是 Claude Code 的一个 mod，在长会话里主动换上下文窗口。它把对话每一行落盘、让模型维护只追加的任务账本、记录文件读写活动，换窗口时用代码生成一条交接信息放进新窗口，不走摘要。

在真实引擎上实测得到的事实写在 `M\NOTES-dev.md`，先读其中"台账"一节里"实测中发现并已修的问题"和后面的"结论"表。审查时以这些事实为准，例如：

- 换窗口由 mod 调 `$.command.run({ command: 'compact' })` 触发，自己的 `session.compact` 钩子回答。
- `$.command.run` 和 `$.prompt.submit` 不能在 `command.run`、`prompt.submit` 钩子里直接调，能在 `turn.complete` 或定时器里调。
- 自动压缩发生在回合中间。
- 子代理的事件带 `agentId`，主会话没有。
- 引擎的文件接口只有整文件覆盖写，读超过 4 MiB 会失败。
- 同一模块里同一事件只能有一个不带 matcher 的钩子。

## 重点找这些

1. **状态一致性**：`register.ts` 用了几个模块级变量（`switchReason`、`committed`、`awaitingPrefix`、`continueAfterTurn`、`personTexts`、`calls`、`sessions`、`enabled`）。在这些情形下会不会留下错误状态：钩子中途抛错；用户中断回合；压缩被别的 mod 或引擎跳过；`/clear` 或 resume 换了会话 id；同一进程里先后有多个会话；热重载（模块变量清空而磁盘状态还在）。
2. **换窗口流程的每条路径**：模型申请并获批后正常到回合结束；获批后被自动压缩抢先；获批后用户中断；自动压缩且账本新鲜；自动压缩但账本不新鲜；用户手动压缩；冷缓存规则（扣下提示、定时器里压缩、重新提交）。每条路径上：会不会重复提交换窗口（`commitSwitch` 调两次）、会不会漏发或多发"继续"、`pending` 会不会永远不清导致此后所有工具调用都被拒、失败时是否回到引擎默认行为。
3. **会把会话卡死或弄坏的地方**：任何钩子会不会在出错时不调 `next` 也不返回合法结果；`tool.call` 的通用钩子在 `pending` 非空时拒绝所有工具，有没有可能把 mod 自己的工具或必要的工具也拒掉、或者永远不放开；`session.append` 改写工具结果时，会不会破坏引擎要求保留的字段、会不会给同一行加两次编号。
4. **落盘**：`session.ts` 里写入是否都走了队列；`meta.json`、`ledger.jsonl`、分片文件之间会不会出现"内存已变但没排队写"的情况；重建 Session 后（同一目录）状态是否完整恢复，特别是 `seq`、窗口号、账本页、归档目录；`events.jsonl` 的"读出旧内容再整文件写"在连续两次换窗口时会不会丢行。
5. **不可信输入**：四个工具的参数来自模型。`register.ts` 的 `argsOf` 之后，`session.ts` 的各个工具方法对类型不对的字段是否都安全。
6. **与说明不符的行为**：`session.ts` 里 `requestSwitch` 的放行逻辑、`reminder` 每窗口一次、`commitSwitch` 的翻页保护、`buildHandoff` 不改状态，是否如其注释所述。
7. **测试盲区**：`session.test.ts` 没覆盖到的最重要行为（只列最重要的几条）。

## 方法

通读两个文件。对可疑点构造具体场景并尽量实际验证：可以写临时脚本，但只能写到系统临时目录，不能写进 M，也不能改 M 里任何文件。允许运行 `claude plugin test "<M>"` 和 `npx --yes -p typescript tsc -p "<M>"`。禁止运行 `claude -p` 或其他 claude 命令，禁止 git 操作。

时间约 9 分钟。先读 `register.ts`（约 730 行）里各钩子，再读 `session.ts` 里 `requestSwitch`、`buildHandoff`、`commitSwitch` 和落盘相关的部分；到第 7 分钟左右停下来写报告。

## 返回

第一行 `TASK_TERMINAL: completed|blocked|failed`。然后按严重程度排序列出发现，最多 12 条，每条包含：文件和行号、一句话缺陷、触发它的具体场景或输入、实际结果与应有结果、把握（确认、很可能、存疑）。只报确实有问题的，纯风格问题不要报。最后用两三行说明哪些部分认真看过且认为没问题，哪些部分没来得及看。
