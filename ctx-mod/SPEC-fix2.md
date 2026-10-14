# 任务说明：修复第二轮审查的发现

M = `C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod`

本文件分 A、B 两个包，由两个执行者同时做，互不改对方的文件。你做哪个包，派给你的消息里会说。

共同规则：

- 不运行 `claude -p` 或下面两条之外的任何 `claude` 命令，不做 git 操作。
- 风格与现有文件一致：无分号、单引号、2 空格、箭头函数、`import type`；导出项和不显然的分支上方写一句英文注释说明"为什么"。
- 运行环境没有 Node 也没有 DOM。
- 验证（必须真的跑）：
  1. `claude plugin test "C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod"`：全部通过。另一个包的执行者同时在改文件，如果失败只出在对方的测试文件里，注明即可。
  2. `npx --yes -p typescript tsc -p "C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod"`：你的文件 0 错误。
- 时间约 9 分钟。按下面的编号顺序做，每修完一条就落盘并跑一次测试。到第 7 分钟左右无论做到哪都停下来汇报。
- 返回：第一行 `TASK_TERMINAL: completed|blocked|failed`；每条怎么改的（一行一条）；没做的条目；测试通过和失败数；tsc 结果；遗留问题。

## 包 A：`hooks\register.ts` 和 `tests\register.test.ts`

只改这两个文件。

A1. **子代理守卫失效**（确认）。四个自有工具的钩子先 `argsOf(e)` 再判断 `input.agentId`，而 `argsOf` 已经把 `agentId` 删掉，条件恒假，子代理能写账本。改成对原始 `e` 判断：`if (e.agentId !== undefined) return { result: '这个工具只能由主会话调用。', isError: true }`，放在 `argsOf` 之前。`tests\register.test.ts` 里被跳过或注释掉的第 3 项（子代理调用 `ledger_append` 被拒）恢复成正常测试，并对四个工具都断言一遍。

A2. **压缩失败后 pending 不清**（确认）。`turn.complete` 里 `$.command.run({ command: 'compact' })` 抛错时，`clearPending()` 和 `flush()` 都被跳过，此后 120 秒内所有工具调用都被拒。要求：无论 `command.run` 成功、抛错还是没有触发提交，只要这次没有提交成功（`committed` 为 false），都要 `session.clearPending()`；`session.flush()` 放进 finally，保证每个主回合结束都执行。加测试：底层的 `command.run` 抛错，之后别的工具调用不再被拒。

A3. **模块级状态跨会话残留**（确认）。`session.end` 只清了 `sessions` 和 `limits`。在 `session.end` 里把 `switchReason`、`committed`、`awaitingPrefix`、`continueAfterTurn` 复位，清空 `personTexts` 和 `calls`。`enabled` 不动。加测试：一次自动压缩（置了 `awaitingPrefix`）之后触发 `session.end`，再用另一个会话 id 开始，新会话第一次工具调用之后其 `meta.json` 里没有 `lastPrefix`（或为 null）。

A4. **冷缓存路径重新提交失败时用户消息静默丢失**（存疑，但后果重）。定时器里 `$.prompt.submit({ text: held, asUser: true })` 失败时，除了记日志，再用 `$.session.append` 追加一条 `type: 'system'` 的提示，文本为：`ctx-mod：换窗口后没能重新提交你的消息，请重发：` 加上原文的前 500 个字符。`$.session.append` 自己也失败就只记日志。

A5. **冷缓存路径留下未配对的 personTexts**（很可能）。提示被扣下时不要把它的文本放进 `personTexts`（它不会被追加成一行）；重新提交那次才放。做法：把 `personTexts.push` 移到确定不扣下之后。

## 包 B：`hooks\lib\session.ts` 和 `tests\session.test.ts`

只改这两个文件。不要改变已有导出的签名（`register.ts` 依赖它们）；可以新增方法。

B1. **重载后交接信息丢掉"最近的用户请求"**（确认）。`load()` 只读当前窗口的分片，`buildHandoff` 和 `ledgerRead` 的 home 视图用 `personRequests(allRows(), …)`，重载后旧窗口的请求不在内存里。要求：`buildHandoff`、`commitSwitch`、home 视图在取最近真人请求之前，先按需把更早窗口的分片读进缓存，从当前窗口往回读，直到凑够 `config.recentRequests` 条真人请求或读到第 1 个窗口为止（多数情况下只多读一两个分片）。抽成一个内部函数三处共用。加测试：窗口 1 里有真人请求，换窗口后在同一目录重建 Session，`buildHandoff` 的结果仍含那条请求的原文；`commitSwitch` 的翻页保护在重建后仍然保护与该请求相关的任务。

B2. **同步读取在加载前返回默认值**（确认）。`window()`、`isLedgerFresh()`、`latestPersonSeq()`、`pending()`、`lastRequestAt()` 在 `createSession` 之后、任何异步方法之前调用，会返回空状态的默认值（窗口 1、不新鲜）。新增 `ready(): Promise<void>`（等同于内部的 `ensureLoaded`，并且为 `isLedgerFresh` 做 B1 那样的回读），并在这几个同步方法的注释里写明"调用前需先 `await ready()`"。不要把它们改成异步。加测试：目录里 meta 写着窗口 2，新建 Session 后 `await ready()` 再读 `window()` 得到 2。

说明：`register.ts` 里调用 `ready()` 由包 A 之外的人后续接上，你不用管。

B3. **`events.jsonl` 丢行**（机制确认）。`commitSwitch` 每次从磁盘读旧内容再整文件写，读不到队列里还没落盘的那次写。改成在内存里保留已知的 events 文本：第一次用到时从磁盘读一次，之后每次在内存里追加新行，再把完整文本排队写出。加测试：用"写入要等手动放行"的 Io，连续两次 `commitSwitch` 之间不放行写入，最后放行并 `flush()`，`events.jsonl` 有两行。

B4. **`activity()` 之后没有排队写 meta**（确认，后果轻）。`activity()` 存入活动后调用一次内部的 `saveMeta()`。

B5. **重复申请换窗口会顺延 pending**（很可能）。`requestSwitch` 在已有未过期的 `pending` 时，直接返回同一句批准文本，不改 `pending.at`，也不重新做放行检查。加测试。

B6. **归档写失败时 meta 仍声明有这一页**（存疑）。给 `createQueue` 传入 `onError`：记下失败的路径；`ledgerRead` 读归档页读不到时，错误信息里写明"归档页文件缺失"。不需要回滚 meta。这条优先级最低，时间不够就不做并在报告里说明。
