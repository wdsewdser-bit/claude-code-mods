# 任务说明：加载会重建缓存的工具组之前，上下文过大就先换窗口

M = `C:\Users\yadaz\.claude\skills\ctx-mod`

## 背景

- 已有（见 `SPEC-costly.md`，已实现）：`session.noteStep` 在 ToolSearch 加载后的下一个请求上判断缓存是否被重建，重建就把工具组记进 `state.costlyLoads`（按会话，随 `meta.json` 落盘），交接信息只提示这些组。
- 实测 `mcp__computer-use__*`：加载后下一个请求只读到系统提示词那段（约 5 万），其余全部重写。上下文 6.3 万时重写 2.9 万，15 万时重写 11.7 万，23.4 万时重写 20.3 万。也就是重写量约等于“上下文 − 5 万 + 约 1.7 万工具定义”。
- 目标：上下文超过门槛时，在这类工具组**加载之前**把 ToolSearch 拦下，让模型先记账、换窗口，在新窗口里加载。新窗口里只需重写交接信息和工具定义。
- 拦截点定在 ToolSearch **执行之前**：`register.ts` 里通用的 `on('tool.call', …)`（搜 `// A tool of this mod's own is answered by its matcher above`），在 `const result = await next(e)` 之前返回 `{ deny: 文案 }`。那里已经有一处这样的写法（`正在换窗口：请立即结束本回合`）。不要在 `next(e)` 之后拒绝：工具已经执行，引擎是否撤销加载没有验证过。
- `costlyLoads` 现在按会话存，一个新会话第一次加载时还不知道哪组贵，所以要加一张跨会话的表。

## 共同规则

- 只改下面点名的文件。不运行 `claude -p`，不做 git 操作，不加依赖，不删除或放宽已有测试（断言因本次改动而变化时可以同步更新，并在报告里逐条列出）。
- 风格与现有文件一致：无分号、单引号、2 空格、箭头函数、`import type`；导出项和不显然的分支上方写一句英文注释说明“为什么”。
- 运行环境没有 Node 也没有 DOM，lib 里不要 import `node:*`，也不要从 `'claude-code'` 引类型进 `hooks\lib`。不改变已有导出的签名；可以新增可选字段和新导出。
- 旧数据兼容：磁盘上已有的 `meta.json` 没有新字段，读到时当作空。跨会话表文件不存在或损坏时当作空表，绝不抛错。
- 钩子绝不能因为这项功能出错而影响工具调用：门的判断放在已有的 `try` 里，出错只记日志（`logError`），然后照常 `next(e)`。
- 先读齐再动手，其余按需 Grep，不通读 `session.ts` 和 `register.ts`：
  - `hooks\lib\session.ts`：`costlyLoads`、`pendingLoads`、`lastContext` 出现的每一处；`noteStep`；`record(` 的实现；`load`；`requestSwitch`；`buildHandoff`；`commitSwitch`。
  - `hooks\lib\usage.ts`：`gateSwitch`。
  - `hooks\lib\history.ts`：`toolGroupOf`、`loadedTools`、`costlyToolsOf`。
  - `hooks\lib\handoff.ts`：`renderTools`（里面有“约 X.X 万”的写法）和 `assemble`。
  - `hooks\register.ts`：上面说的通用 `tool.call` 钩子、`envOf`、`argsOf`、`idOf`。
  - `hooks\lib\types.ts`：`Config` 和 `DEFAULTS`。
- 验证（三条都要真的跑，用 PowerShell；测试输出只看末尾计数和失败用例）：
  1. `claude plugin test "C:\Users\yadaz\.claude\skills\ctx-mod"`：全部通过（现在是 243 个，只能增加）。
  2. `npx --yes -p typescript tsc -p "C:\Users\yadaz\.claude\skills\ctx-mod"`：0 错误。
  3. `claude plugin validate --strict "C:\Users\yadaz\.claude\skills\ctx-mod"`：通过。
- 返回：第一行 `TASK_TERMINAL: completed|blocked|failed`；怎么改的（文件和函数名）；没做的条目；测试通过和失败数；tsc 和 validate 的结果；同步改过的已有断言；测试底座触发不了的路径（如果有）；遗留问题。有任何一条验证没跑或没过，就不能报 completed。

## G1. 归因修正和跨会话表

文件：`hooks\lib\session.ts`、`tests\session.test.ts`。

- `noteStep`：只有 `pendingLoads.length === 1` 时才判断并记录。同一步加载了多个组时不记：分不清是哪一组造成的。已有测试如果同时加载两组并断言两组都记入，改成符合新行为并在报告里列出。
- 跨会话表文件：`createSession` 第一个参数 `root` 的上一级目录下的 `costly.json`（`/ctx` → `/costly.json`；`C:/Users/x/.claude/ctx-mod/<id>` → `C:/Users/x/.claude/ctx-mod/costly.json`）。`root` 里没有 `/` 时不使用跨会话表，读写都跳过。
- 文件格式：`{"version":1,"groups":{"mcp__computer-use__*":{"write":117386,"context":150006,"at":1760000000000}}}`。`write` 是重写的 token 数，`context` 是加载前的上下文，`at` 是 `io.now()`。
- 载入：`load` 的末尾读这个文件。只保留 `write` 是有限正数、`at` 是有限数且 `io.now() - at` 不超过 30 天的项，存进不落盘的会话状态 `sharedCostly`。30 天过期是它的失效机制：过期后门不再拦，加载照常发生，仍然重建就会被重新记入。
- 记录：`noteStep` 判定重建时，除了已有的 `state.costlyLoads[group] = usage.write`，还要更新跨会话表：先重新读一次文件（别的会话可能刚写过），按上面的规则过滤，合并本组，经已有的写队列（`queue.push`）写回，并更新 `sharedCostly`。
- `Session` 新增方法 `costlyGroups(): Record<string, number>`：`sharedCostly`（取 `write`）与 `state.costlyLoads` 合并，同名时本会话的优先。`buildHandoff` 里传给 `costlyToolsOf` 的表改用它。
- 测试：
  - 同一步加载两个组后重建 → 两组都不记入。
  - 会话 A（目录 `/ctx`）量到重建 → `/costly.json` 里有该组；同一个 `box` 上新开的会话 B（目录 `/other`）的 `costlyGroups()` 含该组。
  - `at` 超过 30 天的项被忽略；文件内容不是 JSON 时会话照常可用、表为空。
  - 文件里已有别的组时，记录新组不会把它冲掉。

## G2. 门

文件：`hooks\lib\types.ts`、`hooks\lib\history.ts`、`hooks\lib\usage.ts`、`hooks\lib\session.ts`、`hooks\lib\handoff.ts`、`hooks\register.ts`，以及对应的 `tests\*.test.ts`。

- `types.ts`：`Config` 新增 `gateMinTokens: number`（注释：上下文超过它，加载会重建缓存的工具组之前先换窗口），`DEFAULTS` 里取 `120_000`。
- `history.ts`：新增导出的纯函数 `groupsWanted(query: string, known: readonly string[]): string[]`，判断一次 ToolSearch 查询会加载 `known` 里的哪些组：
  - `query` 以 `select:` 开头：其余部分按逗号分开、去空白，每个名字用 `toolGroupOf` 归组，返回其中在 `known` 里的组（去重，保持 `known` 的顺序）。
  - 其他（关键词查询）：每个组取“核心名”，`mcp__<server>__*` 的核心名是 `<server>`，其他组的核心名就是组名。核心名和查询都转小写后，核心名是查询的子串就算命中；再把两边的 `-` 和 `_` 换成空格比一次（`computer use` 也能命中 `computer-use`）。
- `usage.ts`：`gateSwitch` 的 `input` 新增可选字段 `isForLoad?: boolean`。为 `true` 时不受请求数冷却限制，也不看划算判断（和 `urgent` 走同样的两处放行）；每小时次数上限和“账本要新”照旧。
- `session.ts`：
  - 两个不落盘的状态，`commitSwitch` 推进窗口号的地方清空：`gateAsked: string[]`（本窗口已经拦过的组）和 `gateWanted: string[]`（拦下后还没加载的组）。
  - `Session` 新增同步方法 `gateLoad(query: unknown, tokens: number | undefined): string | null`，返回 `null` 表示放行，返回字符串就是拒绝文案：
    1. `query` 不是字符串、`tokens` 是 `undefined`、或 `tokens <= config.gateMinTokens` → `null`。
    2. `wanted = groupsWanted(query, Object.keys(costlyGroups()))`，去掉本窗口已经加载过的组（本窗口的历史行里 `tool === 'ToolSearch'` 且 `loaded` 里有属于该组的名字）和 `gateAsked` 里已有的组。每组每个窗口只拦一次，第二次放行，这样换窗口被拒绝时模型不会卡死。
    3. `wanted` 为空 → `null`。
    4. 把 `wanted` 并入 `gateAsked` 和 `gateWanted`，返回文案（组名用“、”连接；重写量取这些组里最大的，写法沿用 `renderTools` 里的“约 X.X 万 / 约 N”，把那个格式函数导出复用，不要再写一份；上下文写成整数 k）：
       ```
       先不加载：加载 mcp__computer-use__* 会让整段对话的缓存重建（上次加载后重写了约 11.7 万 token），当前上下文 152k。请先用 ledger_append 把进度记进账本，next_step 写明“换窗后第一步用 ToolSearch 加载 mcp__computer-use__*”，然后调用 context 工具（action: "new"），在新窗口里加载。如果换窗口被拒绝，或者只差这一步就做完，再调用一次 ToolSearch 即可照常加载。
       ```
  - `record()`：记录到 ToolSearch 加载了某组时，把该组从 `gateWanted` 里去掉（模型选择了不换窗直接加载，之后的换窗就和它无关了）。
  - `requestSwitch`：调用 `gateSwitch` 时传 `isForLoad: state.gateWanted.length > 0`。
  - `buildHandoff`：`gateWanted` 非空时，交接信息里加一节，放在“加载时会重建缓存的延迟工具”那一节的位置之前，不参与裁剪：
    ```
    ## 这次换窗口的原因
    换窗口是为了加载 mcp__computer-use__*：第一步先用一次 ToolSearch 加载它，再继续账本里的下一步。
    ```
    怎么把它传进 `assemble` 由你定（照已有各节的写法加一个可选字段）。
- `register.ts`：通用 `tool.call` 钩子里，`next(e)` 之前、已有的 `session.pending()` 检查之后，`String(e.tool) === 'ToolSearch'` 时取当前上下文（`(await envOf($, id)).tokens`，`id` 来自 `idOf($)`，取不到就当 `undefined`），调用 `session.gateLoad(argsOf(e).query, tokens)`，返回字符串就 `return { deny: 那段文案 }`。子代理的调用这个钩子本来就跳过，不用管。
- 测试：
  - `groupsWanted`：`select:` 单个、多个、含不在表里的名字；关键词 `computer-use`、`+computer-use screenshot`、`computer use`；无关关键词返回空。
  - `gateLoad`：上下文不超过门槛 → `null`；超过且命中 → 文案含组名、重写量和当前上下文；同一组第二次 → `null`；本窗口已加载过该组 → `null`；不在表里的组 → `null`；换窗口后同一组可以再被拦。
  - `requestSwitch`：门拦过之后，刚换完窗口（请求数为 0）、账本是新的 → 批准；没被门拦过时同样条件 → 被冷却拒绝；一小时内已换 4 次 → 即使被门拦过也拒绝。
  - 门拦过之后模型直接加载了该组（`record` 一条带 `loaded` 的 ToolSearch 行）→ 之后的 `requestSwitch` 不再享受放行，交接信息里也没有“这次换窗口的原因”一节。
  - 门拦过之后换窗 → 交接信息含“这次换窗口的原因”和组名。
  - `register.test.ts`：看底座能不能驱动通用 `tool.call` 钩子并读到拒绝结果。能就写一条端到端：预先在底座的文件里放一份含 `mcp__computer-use__*` 的 `costly.json`，上下文高于门槛，调用 `ToolSearch`（`query: 'select:mcp__computer-use__screenshot'`）→ 得到拒绝且底层工具没有被执行；同样的调用再来一次 → 放行。底座确实做不到时，在报告里写明试了什么。
