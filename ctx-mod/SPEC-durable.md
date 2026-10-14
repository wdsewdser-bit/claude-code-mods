# 任务说明：写盘失败要看得见，没写进磁盘就不做零摘要换窗

M = `C:\Users\yadaz\.claude\skills\ctx-mod`

## 背景

- 这个 mod 的承诺是“原文和账本都在磁盘上，所以换窗口时可以不让模型写摘要”。现在这个承诺有一个洞：写盘失败被当成成功。
- 现状（都在 `hooks\lib\history.ts` 的 `createQueue` 和 `hooks\lib\session.ts`）：
  - `createQueue` 的 `push` 在写入抛错时也照常 resolve，调用方分不出成败；`createSession` 里 `createQueue(writeThrough)` 没传 `onError`，失败没有任何日志。
  - `record`、`ledgerAppend`、`commitSwitch` 都是 `void queue.push(...)`，不等结果。`ledgerAppend` 在写盘之前就回“已记录 #L1”。
  - `flush` 只等队列排空，不管里面有没有失败。
  - `commitSwitch` 归档时先排归档页的写入，紧接着就把这些条目从 `state.page` 拿走并重写 `ledger.jsonl`。归档页写失败而账本写成功时，这些条目就只剩内存里有。
  - `session.ts` 已经有一个 `failedWrites: Set<string>`（`writeThrough` 维护），目前只用来解释“归档页文件缺失”。
- 外部审查用“所有写入都抛 EIO”复现过：仍然返回“已记录 #L1”，窗口推进到 2，`flush` 正常返回，磁盘上什么都没有。
- 目标是三件事：失败看得见；失败的写入有一次重试；磁盘上不全时不做零摘要换窗，退回引擎自己的摘要。**不做**分代快照、提交清单、跨文件事务。

## 共同规则

- 只改下面点名的文件。不运行 `claude -p`，不做 git 操作，不加依赖，不删除或放宽已有测试（断言因本次改动而变化时可以同步更新，并在报告里逐条列出）。
- 风格与现有文件一致：无分号、单引号、2 空格、箭头函数、`import type`；导出项和不显然的分支上方写一句英文注释说明“为什么”。
- 运行环境没有 Node 也没有 DOM，lib 里不要 import `node:*`，也不要从 `'claude-code'` 引类型进 `hooks\lib`。
- 钩子绝不能因为这项功能出错而影响引擎：新增的判断放在已有的 `try` 里，出错只记日志（`logError`）。
- 内存里的状态仍然是本进程内的真相：写盘失败时不回滚内存、不让工具调用报错，只是如实告知并阻止“以为磁盘上有”的操作。
- 先读齐再动手，其余按需 Grep，不通读 `session.ts`（约 1500 行）和 `register.ts`（约 1070 行）：
  - `hooks\lib\history.ts`：`createQueue` 整个函数和 `Queue` 类型。
  - `hooks\lib\session.ts`：`Io` 类型；`createSession` 开头的 `failedWrites` / `writeThrough` / `queue`；`saveMeta`；`record(` 里排写入的几行；`ledgerAppend` 末尾；`commitSwitch`；`flush`；`status`；`failedWrites` 出现的每一处。
  - `hooks\register.ts`：`sessionOf` 里构造 `io` 的地方；`on('session.compact', …)` 整个钩子；`on('turn.complete', …)` 里 `switchReason = 'model'` 到 `session.flush()` 那一段；`committed`、`switchReason` 出现的每一处；`logError`。
  - 测试底座：`tests\session.test.ts` 顶部的 `makeIo`，以及那条“two switches with the first write still in flight”（它用手动放行的写入，改成等待写入结果的地方不能让它卡死）。
- 验证（三条都要真的跑，写成一条 PowerShell 命令；测试输出只筛失败用例和末尾计数）：
  1. `claude plugin test "C:\Users\yadaz\.claude\skills\ctx-mod"`：全部通过（现在是 266 个，只能增加）。
  2. `npx --yes -p typescript tsc -p "C:\Users\yadaz\.claude\skills\ctx-mod"`：0 错误。
  3. `claude plugin validate --strict "C:\Users\yadaz\.claude\skills\ctx-mod"`：通过。
- 轮数有上限（约 30 轮工具调用后会被叫停）：独立的读取和 Grep 一次并行发出；先把产品代码写完跑一次 tsc，再集中写测试跑一次完整验证。
- 返回：第一行 `TASK_TERMINAL: completed|blocked|failed`；怎么改的（文件和函数名）；没做的条目；测试通过和失败数；tsc 和 validate 的结果；同步改过的已有断言（逐条）；测试底座触发不了的路径；遗留问题。有任何一条验证没跑或没过，就不能报 completed。

## D1. 队列说出成败

文件：`hooks\lib\history.ts`、`tests\history.test.ts`。

- `Queue.push` 的返回类型改为 `Promise<boolean>`：这次写入（被后来的同路径写入合并时，指最终写下去的那份）成功为 `true`，抛错为 `false`。仍然绝不 reject，失败的写入仍然不能卡住队列。`onError` 的行为不变。
- 测试：写入成功 → `true`；写入抛错 → `false` 且后面排的写入照常执行；两次同路径 `push` 被合并时两个 promise 得到同一个结果。

## D2. 会话记住失败、重试一次、如实告知

文件：`hooks\lib\session.ts`、`tests\session.test.ts`。

- `failedWrites` 改成记住失败的那份内容（`Map<路径, 文本>`）：`writeThrough` 失败时存，之后同路径写成功时删。已有的 `failedWrites.has(...)` 用法保持可用。
- `Io` 新增可选字段 `onWriteError?: (path: string, error: unknown) => void`，`writeThrough` 失败时调用它（调用本身包在 try 里，它抛错不能影响写入流程）。
- `flush()`：`ensureLoaded` → `queue.idle()` → 如果有失败的写入，把每条失败的内容重新 `push` 一次（此时队列是空的，不会用旧内容盖掉更新的排队内容）→ 再 `queue.idle()`。只重试这一次。
- `Session` 新增同步方法 `unsaved(): string[]`：上一次写入失败、还没写成功的文件名（不带目录），按名字排序。
- `ledgerAppend`：等账本那次写入的结果（`await queue.push(...)`）。失败时结果文本在“已记录 #L…”之后加一行：`注意：账本这次没能写进磁盘（内存里有，本会话内仍然有效）；下次记账会重写整个文件。`。不标成错误（条目已经在内存里，标成错误会让模型重复记账）。
- `commitSwitch` 的归档顺序：有条目要归档时，先等归档页那次写入的结果。成功才把页表加一页、把 `state.page` 换成留下的条目并重写 `ledger.jsonl`；失败就这次不归档（`state.page` 和 `state.archive` 都不动），下次换窗口再试。其余部分（窗口号推进等）照旧。
- `status(env)` 的那一行：`unsaved()` 非空时末尾加 ` · 有 N 个文件没写进磁盘`。
- 测试（用一个可以开关“写入抛错”的 `Io`）：
  - 所有写入都抛错：`ledgerAppend` 的结果含“没能写进磁盘”且不是错误；`flush()` 正常返回；`unsaved()` 列出账本、meta 和分片文件。
  - 写入恢复后再 `flush()`：`unsaved()` 变空，磁盘上的分片、账本内容和内存一致。
  - 只让归档页的写入失败：`commitSwitch` 之后 `ledger.jsonl` 里仍有那些本该归档的条目，meta 的归档页数是 0；恢复后下一次 `commitSwitch` 才归档到 `archive-001.jsonl`。
  - `onWriteError` 在失败时被调用，带路径；它自己抛错时写入流程照常。
  - `status` 在有未写盘文件时带那一句。

## D3. 没写进磁盘就不做零摘要换窗

文件：`hooks\register.ts`、`tests\register.test.ts`。

- `sessionOf` 里构造 `io` 时加上 `onWriteError`：`(path, error) => logError($, \`write ${path}\`, error)`（按 `logError` 的实际签名写）。
- `on('session.compact', …)`：进入“零摘要”分支（`mine || (e.trigger === 'auto' && session.isLedgerFresh())`）之前，先 `await session.flush()`，再看 `session.unsaved()`。非空时不走零摘要分支，记一条日志（写明哪些文件没写进磁盘），然后落到下面已有的 `next(e)`：让引擎自己做摘要，摘要之后照旧追加本 mod 的交接信息。
- 这样退回时，如果这次压缩是本 mod 发起的（`mine`），后面的流程要和零摘要时一致：在 `next(e)` 之后那个分支里 `commitSwitch` 成功后，`mine` 为真就把 `committed` 置为 `true`（`turn.complete` 里靠它决定换窗后是否自动续跑；不置的话模型申请的换窗会被当成没发生）。先读 `committed` 的每一处用法确认这样改不影响别的路径，有疑问就在报告里写明而不是硬改。
- 测试：看底座能不能让某些路径的写入失败。能就写两条端到端：
  - 写入都失败时，模型批准的换窗（或自动压缩且账本新鲜）→ 走了引擎的摘要（`next` 被调用），结果里既有引擎的摘要也有本 mod 的交接信息。
  - 写入正常时行为不变：仍然是零摘要，`next` 没被调用。
  底座确实做不到时，在报告里写明试了什么。
