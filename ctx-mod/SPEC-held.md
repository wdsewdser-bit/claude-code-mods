# 任务说明：缓存过期时扣下的用户消息不能丢

M = `C:\Users\yadaz\.claude\skills\ctx-mod`

## 背景

- `hooks\register.ts` 的 `on('prompt.submit', …)`：用户发消息时如果缓存已过期且上下文超过 `coldMinTokens`，这条消息会被扣下（返回 `{ drop }`），300 毫秒后由定时器先执行一次压缩（换窗口），再用 `$.prompt.submit({ text, asUser: true })` 把原话重新提交。
- 这条路径有三个会丢消息或出乱子的地方：
  1. `$.prompt.submit` 可以**正常返回** `{ drop: reason }` 而不抛错（类型见 `M\.claude-plugin\types\claude-code\index.d.ts` 第 9096–9103 行，只读这一段）。现在只处理了抛错：别的插件把重新提交的消息丢掉时，用户的话没了，也没有任何提示。
  2. 扣下的原话只存在定时器的闭包里。引擎的约定是插件热重载会取消还没到点的定时器（同一文件第 3419–3425 行）。扣下之后、重新提交之前发生热重载或进程退出，这条消息就没了。
  3. 没有并发控制：第一条被扣下、压缩还在进行时用户又发一条，会再排一个压缩定时器，两条消息的先后也不保证。
- 目标：扣下的消息先落盘再扣；重新提交的结果要检查；同一时间只跑一个这样的换窗流程，期间到的消息按顺序排在后面；任何没送达的消息都要让用户看到原文。

## 共同规则

- 只改下面点名的文件。不运行 `claude -p`，不做 git 操作，不加依赖，不删除已有测试，不放宽断言（断言因本次改动而变化时可以同步更新，并在报告里逐条列出）。
- 风格与现有文件一致：无分号、单引号、2 空格、箭头函数、`import type`；导出项和不显然的分支上方写一句英文注释说明“为什么”。
- 运行环境没有 Node 也没有 DOM，lib 里不要 import `node:*`，也不要从 `'claude-code'` 引类型进 `hooks\lib`。不改变已有导出的签名；可以新增可选字段和新导出。
- 旧数据兼容：`held.json` 不存在或损坏时当作没有扣下的消息，绝不抛错。
- 这条路径上任何一步出错，宁可让消息照常进入（缓存重写一次，只是多花钱），也不能让它消失。
- 先读齐再动手，其余按需 Grep：
  - `hooks\register.ts`：`on('prompt.submit', …)` 整个钩子；`sessionOf`；`on('session.end', …)` 里重置模块级变量的那几行；`switchReason` 出现的每一处；`logError`。
  - `hooks\lib\session.ts`：`load` 的末尾；`flush`；`Session` 类型；`queue.push` 现在返回 `Promise<boolean>`（上上项改的）。
  - `tests\register.test.ts`：现有覆盖缓存过期换窗的测试（搜 `cold` 或“缓存已过期”），看底座怎么驱动 `prompt.submit`、定时器和 `command.run`。
- 验证（三条都要真的跑，写成一条 PowerShell 命令；测试输出只筛失败用例和末尾计数）：
  1. `claude plugin test "C:\Users\yadaz\.claude\skills\ctx-mod"`：全部通过（现在是 295 个，只能增加）。
  2. `npx --yes -p typescript tsc -p "C:\Users\yadaz\.claude\skills\ctx-mod"`：0 错误。
  3. `claude plugin validate --strict "C:\Users\yadaz\.claude\skills\ctx-mod"`：通过。
- 轮数有上限：独立的读取和 Grep 一次并行发出；先把产品代码写完跑一次 tsc，再集中写测试，跑一次完整验证。
- 返回：第一行 `TASK_TERMINAL: completed|blocked|failed`；怎么改的（文件和函数名）；没做的条目；测试通过和失败数；tsc 和 validate 的结果；同步改过的已有断言（逐条）；测试底座触发不了的路径；遗留问题。有任何一条验证没跑或没过，就不能报 completed。

## H1. 扣下的消息先落盘

文件：`hooks\lib\session.ts`、`tests\session.test.ts`。

- 会话目录下新增文件 `held.json`：`{"items":[{"id":1,"text":"原话","at":1760000000000}]}`。`load` 的末尾读它（损坏或缺失当作空）。
- `Session` 新增三个方法：
  - `hold(text: string): Promise<number | null>`：追加一条（`id` 取现有最大值加一，`at` 取 `io.now()`），**等写入结果**。写成功返回 `id`；写失败就把这条从内存里拿掉并返回 `null`（调用方据此不扣这条消息）。
  - `heldItems(): { id: number; text: string; at: number }[]`：按 `id` 升序，返回副本。
  - `release(id: number): Promise<void>`：去掉这一条并写回；`id` 不存在时什么都不做。
- 测试：`hold` 后文件里有这条；重开会话后 `heldItems()` 还在；`release` 后文件和内存都没有；写入失败时 `hold` 返回 `null` 且 `heldItems()` 为空；`held.json` 内容不是 JSON 时会话照常可用。

## H2. 扣下、换窗、重新提交的流程

文件：`hooks\register.ts`、`tests\register.test.ts`。

- 扣之前先 `const heldId = await session.hold(e.text)`；返回 `null`（没能落盘）就不扣，照常 `return next(e)`。
- 单一流程：加一个模块级标志表示“扣下后的换窗流程正在进行”（在 `session.end` 里和其他模块级变量一起重置）。
  - 没有流程在进行、且满足原来的扣下条件 → 落盘、置标志、排定时器、返回 `{ drop }`（文案不变）。
  - 流程正在进行时又来一条**可以扣**的用户消息（`isPersonOrigin(e.origin)` 且没有附件）→ 也落盘并返回 `{ drop }`，文案改成 `ctx-mod：正在换窗口，这条消息排在后面，换完后按顺序处理`，不再排新的定时器。带附件的照常放行（重新提交带不了附件）。
- 定时器里的流程：
  1. 执行压缩（和现在一样，`switchReason = 'cold'`，出错只记日志）。
  2. 循环处理：取 `session.heldItems()` 里最早的一条，重新提交；处理完再取，直到没有（压缩期间新排进来的也在这个循环里按顺序送出）。
  3. 每一条：`const entered = await $.prompt.submit({ text, asUser: true })`。结果里有 `drop`（`'drop' in entered`），或者调用抛错，都算没送达：记日志，并用已有的那种系统消息告诉用户（见下）。
  4. 送达了，或者“没送达但提示已经成功发出”，就 `session.release(id)`。提示也发不出去时**不** release，留在磁盘上等 H3 处理，并且停止循环（避免对同一条死循环）。
  5. 最后在 `finally` 里清掉“流程正在进行”的标志。
- 没送达时的提示文案：`ctx-mod：换窗口后没能重新提交你的消息，请重发：` 后面跟原文。原文不超过 20000 个字符时完整给出；超过时给前 20000 个字符，并在末尾加 `（后面还有 N 个字符没有显示）`。把拼这段文案的逻辑抽成一个函数，H3 复用。
- 测试（底座能驱动到什么程度就测到什么程度，做不到的在报告里写明试了什么）：
  - 重新提交返回 `{ drop }` → 用户收到带原文的系统消息，`held.json` 里这条被清掉。
  - 重新提交抛错 → 同上（已有测试如果覆盖了这一条，确认它仍然通过）。
  - 流程进行中又来一条用户消息 → 被扣下并落盘，只执行了一次压缩，两条按先后顺序重新提交。
  - `hold` 写入失败 → 消息没被扣，照常进入，没有排压缩。
  - 正常情况 → 行为和现在一样，结束后 `held.json` 里没有残留。

## H3. 重开时发现没送达的消息

文件：`hooks\register.ts`、`tests\register.test.ts`。

- `sessionOf` 里新建会话对象并 `ready()` 之后（只在新建时，不是每次取用时）：如果 `session.heldItems()` 非空，说明上一次扣下的消息没有走完流程（热重载取消了定时器，或进程中途退出）。对每一条按顺序发一条系统消息（文案用 H2 的那个函数，开头改成 `ctx-mod：上次换窗口时扣下的一条消息没有送达，请重发：`），发成功就 `release`，发失败记日志并留着。
- 不自动重新提交：这时已经隔了一次重载或重启，隔多久不知道，替用户重发一条旧消息比让他自己决定更糟。
- 这段逻辑出错只记日志，不能影响 `sessionOf` 返回会话。
- 测试：预先在底座的文件里放一份带两条消息的 `held.json`，触发任意一个会调用 `sessionOf` 的钩子 → 用户按顺序收到两条带原文的系统消息，文件被清空；再触发一次不会重复提示。
