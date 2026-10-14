# 任务说明：“延迟工具”提示只针对实测会让缓存重建的工具组

M = `C:\Users\yadaz\.claude\skills\ctx-mod`

## 背景（真实会话里量到的）

- 一个真实会话里有 11 次 ToolSearch 加载。其中 8 次（WebFetch、WebSearch、SendMessage、Chrome 浏览器的 MCP 工具）之后的下一个请求缓存完整命中：`cache_read_input_tokens` 约等于上一个请求的整个上下文。另外 3 次加载的是 `mcp__computer-use__*`，下一个请求的缓存读取掉到只剩系统提示词那一段（约 5 万），其余全部重写：上下文 6.3 万时重写 2.9 万，15 万时重写 11.7 万，23.4 万时重写 20.3 万。
- 现在交接信息里的“上个窗口加载并用过的延迟工具”一节把所有加载并用过的工具都列出来，并建议第一步就加载。对那 8 次不花钱的加载，这个建议没有好处；提前加载却没用上，每个请求还要多带那组工具的定义。
- 要改成：mod 自己量出哪些工具组加载后缓存被重建，只对这些工具组给提示，并把代价写清楚。
- 引擎有 `turn.step` 钩子：`on('turn.step', ($, e, next) => …)`。`e`（`TurnStepInput`）有 `agentId?`（主循环没有）；`await next(e)` 的结果（`TurnStepResult`）有 `usage: TurnUsage | null`，其中有 `input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`。类型在 `M\.claude-plugin\types\claude-code\index.d.ts` 第 13430–13531 行和第 6423–6445 行，只读这两段。

## 共同规则

- 只改下面点名的文件。不运行 `claude -p`，不做 git 操作，不加依赖，不删除或放宽已有测试（断言的文案因本次改动而变化时可以同步更新，并在报告里列出）。
- 风格与现有文件一致：无分号、单引号、2 空格、箭头函数、`import type`；导出项和不显然的分支上方写一句英文注释说明“为什么”。
- 运行环境没有 Node 也没有 DOM，lib 里不要 import `node:*`，也不要从 `'claude-code'` 引类型进 `hooks\lib`。不改变已有导出的签名；可以新增可选字段和新导出。
- 旧数据兼容：磁盘上已有的 `meta.json` 没有新字段，读到时当作空。
- `turn.step` 钩子绝不能影响请求：mod 未启用时直接 `return next(e)`；否则先 `const result = await next(e)`，记录放在 try 里，出错只记日志（照 `register.ts` 里 `logError` 的用法），最后原样返回 `result`。不要改写 `e`。
- 先读齐再动手：`hooks\lib\history.ts` 里的 `loadedTools`（搜 `export const loadedTools`）；`hooks\lib\handoff.ts` 里的 `renderTools` 和 `assemble`；`hooks\lib\session.ts` 里 `roster` 出现的每一处（状态、默认值、从 meta 恢复、写 meta，新字段照它的写法加）、`record(` 的实现、`buildHandoff`、`commitSwitch`；`hooks\register.ts` 里 `on('agent.spawn'`（照它的写法加新钩子）和 `tool-result` 分支里记录 `loaded` 的地方。其余按需 Grep，不通读 `session.ts` 和 `register.ts`。
- 验证（三条都要真的跑，用 PowerShell；测试输出只看末尾计数和失败用例）：
  1. `claude plugin test "C:\Users\yadaz\.claude\skills\ctx-mod"`：全部通过（现在是 225 个，只能增加）。
  2. `npx --yes -p typescript tsc -p "C:\Users\yadaz\.claude\skills\ctx-mod"`：0 错误。
  3. `claude plugin validate --strict "C:\Users\yadaz\.claude\skills\ctx-mod"`：通过。
- 返回：第一行 `TASK_TERMINAL: completed|blocked|failed`；怎么改的（文件和函数名）；没做的条目；测试通过和失败数；tsc 和 validate 的结果；同步改过文案的已有断言；测试底座触发不了的钩子（如果有）；遗留问题。有任何一条验证没跑或没过，就不能报 completed。

## F1. 量出哪些工具组加载后缓存被重建

文件：`hooks\lib\history.ts`、`hooks\lib\session.ts`、`tests\session.test.ts`、`tests\history.test.ts`。

- `history.ts`：把 `loadedTools` 里“工具名归到哪一组”的规则抽成导出的纯函数 `toolGroupOf(name): string`（`mcp__<server>__<tool>` 归为 `mcp__<server>__*`，其他名字就是它自己），`loadedTools` 改为调用它，行为不变。
- `session.ts` 的会话状态新增：
  - `costlyLoads: Record<string, number>`：工具组 → 最近一次加载后重写的 token 数。随 `meta.json` 落盘和恢复（恢复时只保留值是有限正数的项，缺字段当作 `{}`）。
  - 两个不落盘的量：`pendingLoads: string[]`（刚加载、还没等到下一个请求的工具组）和 `lastContext: number | null`（主循环上一个请求的 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`）。
- `record()`：记录的行是 `tool === 'ToolSearch'` 且 `loaded` 非空时，把这些名字的组（去重）并入 `pendingLoads`。
- `Session` 新增方法 `noteStep(usage: { input: number; read: number; write: number }): Promise<void>`，逻辑：
  1. `pendingLoads` 非空且 `lastContext !== null` 时判断是否重建：`usage.read < lastContext * 0.9` 且 `lastContext - usage.read > 5000`。是重建就把 `pendingLoads` 里每个组记进 `costlyLoads`，值为 `usage.write`，并写 meta。不是重建就什么都不记（已经在 `costlyLoads` 里的组保持不变：一组工具在一个窗口里只有第一次加载会重建）。
  2. 无论如何清空 `pendingLoads`，并把 `lastContext` 设为 `usage.input + usage.read + usage.write`。
- 换窗口成功后（`commitSwitch` 里推进窗口号的地方）把 `lastContext` 设回 `null`、清空 `pendingLoads`：新窗口的第一个请求不能拿上一个窗口的上下文来比。
- 测试：按背景里的三组真实数字各写一条（上一个请求 234264、下一个请求 read 50621 / write 202702 → 该组进 `costlyLoads`，值 202702；上一个 63181、read 50714、write 28616 → 记入；上一个 221207、read 221205、write 7531 → 不记入）；没有待定加载时 `noteStep` 只更新 `lastContext`；换窗口后的第一个 `noteStep` 不判断；`costlyLoads` 重开会话后还在；旧 meta 能打开；`toolGroupOf` 的两种名字。

## F2. 钩子接入

文件：`hooks\register.ts`、`tests\register.test.ts`。

- 新增 `on('turn.step', …)`：`e.agentId === undefined`（只看主循环）且 `result.usage !== null` 时调用 `session.noteStep({ input: usage.input_tokens, read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens })`，三个数都用 `typeof === 'number'` 检查，不是数字当 0。
- 测试：看 `tests\register.test.ts` 的底座能不能触发 `turn.step`。能就写一条端到端：一步（usage 上下文 150006）→ 带 `tool_reference` 的 ToolSearch 结果（`mcp__computer-use__screenshot`）→ 调用一次该工具 → 下一步 usage 为 read 50714 / write 117386 → 自动压缩得到的交接信息含 F3 的那一节和 `mcp__computer-use__*`。底座确实触发不了时，在报告里写明试了什么，并保证 F1 和 F3 的测试覆盖到逻辑。

## F3. 交接信息只提示会重建的工具组

文件：`hooks\lib\handoff.ts`、`hooks\lib\session.ts`、`tests\handoff.test.ts`、`tests\session.test.ts`、`tests\register.test.ts`。

- `buildHandoff`：`loadedTools(rows, state.window)` 的结果只保留组名在 `state.costlyLoads` 里的项，并带上重写量。一项都不剩时不出这一节。
- `renderTools` 的入参每项改为 `{ name: string; calls: number; rebuilt: number }`（`rebuilt` 是重写的 token 数；类型怎么声明由你定，但不要破坏 `history.ts` 里 `loadedTools` 的返回类型）。输出改为：
  ```
  ## 加载时会重建缓存的延迟工具
  - mcp__computer-use__*（上个窗口调用 56 次；上次加载后重写了约 11.7 万 token）
  这些工具组第一次加载时，整段对话的缓存会重建，上下文越大重写越多。账本的下一步明确要用到其中某组时，在第一步就用一次 ToolSearch 加载它；不确定会不会用到就先不加载，因为加载后每个请求都要多带它的定义。其他延迟工具随用随加载，不必提前。
  ```
  重写量的写法：一万及以上写成“约 X.X 万”（保留一位小数，四舍五入），不到一万写成“约 N”（整数）。
- `assemble` 里这一节的位置不变（子代理之后、工作集之前，不参与裁剪）。
- 同步更新断言了旧标题“上个窗口加载并用过的延迟工具”和旧说明文字的已有测试，并在报告里列出。已有的那条 register 端到端测试（ToolSearch 后调用工具，交接信息含旧标题）要改成符合新行为：没有量到重建时不出这一节。
- 测试：`costlyLoads` 为空 → 没有这一节；加载并用过两组、只有一组在 `costlyLoads` → 只列那一组；重写量两种写法（117386 → `约 11.7 万`，8200 → `约 8200`）。
