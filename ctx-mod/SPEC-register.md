# 任务说明：ctx-mod 的引擎接线层

把引擎事件钩子接到已经写好的状态对象（Session）上。这是集成工作，核心逻辑都已存在并有测试（当前 149 个测试全过，tsc 0 错误）。

## 位置与边界

- mod 根目录 M = `C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod`
- 允许新建或修改：
  - `M\hooks\probe.ts`（新建：把现有 `M\hooks\register.ts` 的全部内容原样搬过来，只把导出的 `register` 改名为 `registerProbe`，类型仍是 Register）
  - `M\hooks\register.ts`（重写：正式接线，开头调用 `registerProbe(on, options)`）
    （已作废：探针已移出，见 phase0/）
  - `M\tests\register.test.ts`（新建）
  - `M\hooks\lib\session.ts` 和 `M\tests\session.test.ts`：只允许加下面"给 Session 加的两个方法"及其测试，不改已有行为
- 不要改：`hooks\lib` 下其他文件、`tests\probe.test.ts`、`plugin.json`、`hooks.json`、`tsconfig.json`、本文件。
- 先读（只读）：
  - `M\NOTES-dev.md` 的"结论"和"对设计的影响"两节。这是在真实引擎上实测出来的事实，以它为准。
  - `M\hooks\register.ts`（现有探针）：每一种要用到的钩子和 `$` 调用，这里都有一个在真实引擎上跑通过的写法，照它的形状写。
  - `M\hooks\lib\session.ts` 开头的类型（Io、Env、ToolResult、Session），以及 `usage.ts`、`types.ts` 的导出。
  - 引擎 API 类型定义 `M\.claude-plugin\types\claude-code\index.d.ts`（约 1.4 万行，不要通读，用搜索定位：`'prompt.compose'`、`export type PromptComposeResult`、`export type ToolSpec`、`export type SessionAppendInput`、`export type SessionCompactInput`、`export type TurnCompleteInput`、`export type PromptSubmitInput`，读命中处前后几十行）。
  - 测试写法参考：`M\tests\probe.test.ts` 和 `C:\Users\yadaz\.claude\skills\cache-keeper\tests\world.ts`（怎样用 `on(...)` 在测试里充当引擎底层、怎样用 `$` 触发事件）。
- 风格与现有文件一致：无分号、单引号、2 空格、箭头函数、`import type`。运行环境没有 Node 也没有 DOM（不能用 fs、process、console、setTimeout；定时器用 `$.clock.after`）。import 用相对路径带 `.ts` 后缀，不能用动态 import()。
- 禁止：运行 `claude -p` 或除文末三条验证命令之外的任何 `claude` 命令；git 操作。

## 给 Session 加的两个方法（session.ts）

- `isLedgerFresh(): boolean`（同步）：最近一条真人请求之后，本窗口是否有账本条目。复用 requestSwitch 里已有的那段判断，抽成内部函数两处共用。
- `lastRequestAt(): number | null`（同步）：noteRequest 最后一次记下的时间，没有则 null。session.ts 内部已有同名状态字段，通过方法暴露即可。

## 总开关

模块级 `enabled`：在 `session.start` 里读环境变量 `CTX_MOD`（`await $.env.get('CTX_MOD')`），等于 `'1'` 才启用。未启用时除了探针之外什么都不做：不注册工具和命令，下面所有钩子第一行就 `return next(e)`。目的是不影响开发期间加载了本 mod 的日常会话。

## 每个会话一个 Session

- `sessions: Map<string, Session>`，键是 `await $.session.id()`。
- 目录：家目录取 `USERPROFILE`，没有再取 `HOME`（用 `$.env.get`），去掉末尾的斜杠；dir 为 `${home}/.claude/ctx-mod/${sessionId}`。`$.fs` 不展开波浪号，不要用波浪号。
- Io：`{ read: p => $.fs.read(p), write: (p, t) => $.fs.write(p, t), now: () => Date.now() }`
- config 用 types.ts 的 DEFAULTS。
- `envOf($)` 返回 Env：
  - `tokens` 取 `(await $.session.usage()).context.tokens`
  - `limit` 每个会话只算一次并缓存：`usage.limitOf((await $.session.usage({ breakdown: 'summary' })).context.breakdown?.autoCompactThreshold, config)`
  - `fiveHourPercent` 取 rateLimits 里 kind 为 `'five_hour'` 的 percentUsed
  - `cache` 取 `(await $.state.get({ plugin: 'cache-keeper', key: 'cache' } as const)).value ?? null`
  - 任何一步失败都退化成 undefined 或 null，不抛。
- 主会话的判断：`e.agentId === undefined`。子代理的事件一律 `return next(e)`。

## 钩子

所有钩子的主体都包在 try/catch 里，出错时走引擎默认行为（`next(e)`），并 `$.ui.log('ctx-mod: …', { to: 'debug' })`。

### 1. session.start（启用时）

注册 4 个工具（`$.tool.register`，`isDeferred: false`，名字 `context`、`ledger_append`、`ledger_read`、`history`；模型看到的全名是 `mcp__ctx-mod__<name>`）和一个命令 `ctx-mod`。工具描述和 inputSchema 用中文写清楚字段：字段含义见 session.ts 里对应方法和 types.ts 的 LedgerInput；`context` 的字段是 `action`（`'status'` 或 `'new'`）、`reason`（可选字符串）、`expect_more_work`（可选布尔）。最后 `return next(e)`。

### 2. command.run（matcher `{ command: 'ctx-mod' }`）

返回 `{ text }`，内容是启用状态加 `session.status(env)`。

### 3. prompt.compose（启用时）

在 `next(e)` 的 sections 末尾追加一段固定文本（scope 用 `'session'`），文本见"文本常量"。按类型定义里 PromptComposeResult 和 section 的确切形状写。

### 4. tool.call，四个自有工具各一个 matcher

matcher 形如 `{ tool: 'mcp__ctx-mod__context' }`。

- `e.agentId !== undefined`：返回 `{ result: '这个工具只能由主会话调用。', isError: true }`
- `context`：`e.action === 'new'` 时返回 `session.requestSwitch(e, env)`；否则 `{ result: session.status(env) }`
- `ledger_append`：`session.ledgerAppend(e, env)`
- `ledger_read`：`session.ledgerRead(e)`
- `history`：`session.historyTool(e)`
- 工具参数就是 `e` 上的字段（和信封字段混在一起），直接把 `e` 当输入对象传。

### 5. tool.call，无 matcher（主会话，且不是自有工具时才处理）

调 `next` 之前：

- 记下 `calls.set(e.tool_use_id, { tool: String(e.tool), input: e })`，Map 只保留最近 200 个。
- 如果 `session.pending()` 非 null，直接返回 `{ deny: '正在换窗口：请立即结束本回合，不要再调用工具。' }`。
- 给这个钩子加 `.catch(($, e, next) => next(e))`，保证本钩子出错时放行而不是卡住工具。

`const result = await next(e)` 之后：

- `session.noteRequest()`
- 取 env；如果模块变量 `awaitingPrefix` 为真且 `env.tokens` 有值，调 `session.notePrefix(env.tokens)` 并清掉标记
- `const text = session.reminder(env)`，非 null 就 `await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })`
- 返回 result

### 6. session.append（主会话；始终以 `return next(...)` 结束）

- `e.door === 'prompt'`：text 为各文本块拼接。`isPerson` 为真的条件：`e.origin.kind` 是 `'composer'`、`'bridge'`、`'sdk'` 之一；或者是本 mod 自己用 asUser 重新提交的（`origin.kind === 'plugin'` 且 `origin.name === 'ctx-mod'` 且 `origin.asUser === true`）。调 `await session.record({ uuid: e.uuid, role: 'user', ...(isPerson ? { isPerson: true } : {}), text })`。不改写这一行。
- `e.door === 'response'`：把文本块拼接，非空就 record（role 为 `'assistant'`）。不改写。
- `e.door === 'tool-result'`：对 content 里每个 `type === 'tool_result'` 的块：
  - 用 `tool_use_id` 从 `calls` 里取出 tool 和 input。取不到时 tool 用 `e.origin.kind === 'tool' ? e.origin.tool : 'unknown'`，input 用 `{}`。
  - 块的文本：content 是字符串就用它，是数组就把其中 text 项拼接。
  - `isError` 为 `block.is_error === true`。
  - `const rec = await session.record({ uuid: e.uuid, role: 'tool', tool, path, isError, text })`，其中 path 取 input 的 `file_path`、`notebook_path`、`path` 中第一个是字符串的。
  - `session.activity(tool, input, rec.seq, isError)`
  - 改写这个块，在内容末尾加上历史编号：content 是字符串时末尾加换行和 `[#seq]`；是数组时追加一个 `{ type: 'text', text: '[#seq]' }` 项。本 mod 自有工具（名字以 `mcp__ctx-mod__` 开头）的结果只记录不加编号。
  - 最后 `return next({ ...e, message: { ...e.message, content: 新 content } })`
- 其他 door：`return next(e)`

### 7. turn.complete（主会话）

先 `const result = await next(e)`。然后如果 `session.pending()` 非 null：

- `e.reason !== 'answer'`：`session.clearPending()`
- 否则：
  - 设 `switchReason = 'model'`、`committed = false`
  - `await $.command.run({ command: 'compact' })`。实测：这样进来的压缩 trigger 是 `'manual'`，本 mod 自己的 session.compact 钩子会跑。
  - finally 里设 `switchReason = null`
  - 若 `committed` 仍为 false：`session.clearPending()`
  - 若 committed 且 `usage.shouldContinue(env.fiveHourPercent, env.cache, config)`：`await $.prompt.submit({ text: CONTINUE_TEXT })`

最后 `await session.flush()`（无论是否有 pending，每个主回合结束都 flush 一次）。返回 result。

### 8. session.compact

`e.agentId !== undefined`，或 `e.trigger === 'precompute'`，或未启用：`return next(e)`。

设 `mine = switchReason !== null && e.trigger === 'manual'`。

情况一：`mine`，或者 `e.trigger === 'auto' && session.isLedgerFresh()`。零摘要换窗口，不调 next：

- `const text = await session.buildHandoff({ isMidTurn: e.trigger === 'auto' })`
- `await session.commitSwitch({ trigger: mine ? switchReason : 'auto', tokensBefore: env.tokens, handoffText: text })`
- 设 `committed = true`、`awaitingPrefix = true`
- `return { messages: [{ role: 'user', text, toolUses: [] }] }`

情况二：自动压缩但账本不新鲜，或用户自己手动压缩。

- `const result = await next(e)`
- 如果 result 有 `messages`（不是 skip）：同样 buildHandoff（isMidTurn 同上）、commitSwitch（trigger 用 `e.trigger === 'auto' ? 'auto-summary' : 'manual'`）、设 `awaitingPrefix = true`，返回 `{ ...result, messages: [...result.messages, { role: 'user', text, toolUses: [] }] }`

出错：还没调过 next 就 `return next(e)`；已经拿到 result 就原样返回 result。绝不返回 `{ skip }`。

### 9. prompt.submit（冷缓存规则；启用时）

同时满足才动作：

- `e.origin.kind` 是 `'composer'`、`'bridge'`、`'sdk'` 之一
- `e.attachments` 为空
- `env.tokens !== undefined && env.tokens >= config.coldMinTokens`
- `usage.isCold({ now: Date.now(), cache: env.cache, lastRequestAt: session.lastRequestAt() }, config)` 为真

动作：记下 `held = e.text`；用 `$.clock.after(300, …)` 在定时器里依次做：设 `switchReason = 'cold'`，`await $.command.run({ command: 'compact' })`，finally 里设回 null，再 `await $.prompt.submit({ text: held, asUser: true })`；整个异步过程的错误用 `$.ui.log` 记下。然后本钩子 `return { drop: 'ctx-mod：缓存已过期，先换窗口再处理这条消息' }`。

实测：在 prompt.submit 钩子里直接调 command.run 会被拒，所以必须走定时器。其余情况 `return next(e)`。

### 10. session.measure（启用时）

`$.ui.status(usage.describeFill(e.context.tokens, limit, session.window()))`，然后 `return next(e)`。limit 没算出来就跳过。

### 11. session.end

`await session.flush()`（失败忽略），从 `sessions` 里删掉该会话，`return next(e)`。

## 文本常量

系统提示固定段（全程不变）：

```
这个会话可能跨多个上下文窗口。你有一个任务账本（mcp__ctx-mod__ledger_append、mcp__ctx-mod__ledger_read）和完整历史（mcp__ctx-mod__history）。工具结果末尾形如 [#123] 的是历史编号。每完成一个阶段，就追加一条账本记录：用 task_id 标识任务，status 填 in_progress / done / superseded / blocked。标 done 时必须在 evidence 里附上证明它的工具结果的历史编号。用户提出新请求时，如果它取代了旧任务，就把旧任务标为 superseded。对还没做完的任务，写明 next_step，并用 anchors 记下接下来要改的位置：文件路径，加一小段能在文件里唯一定位的原文。收到收尾或交接通知时，先更新账本。上下文用量可以用 mcp__ctx-mod__context 查看；它提示可以换窗口时，先记账再调用它的 new。
```

CONTINUE_TEXT：

```
ctx-mod：已换到新的上下文窗口。先用一句话复述当前请求和进度，然后继续。
```

## 测试（register.test.ts）

用测试套件（`import { expect, mock, test } from 'claude-code/testing'`，测试函数签名 `async ($, on) => {}`），照 probe.test.ts 的方式用 `on(...)` 提供底层：fs 用内存 Map；env 用 `mock.env(on, { CTX_MOD: '1', USERPROFILE: 'C:\\Users\\someone' })`；session.id、session.usage、command.register、tool.register、state.get 等按需补。

尽量覆盖下面这些。某一项在套件里触发不了就跳过，并在报告里说明原因，不要为了凑数写无意义的断言：

- 未设 CTX_MOD：一次压缩原样落到底层的 session.compact，且没有写任何 ctx-mod 会话目录下的文件。
- 启用后：子代理（带 agentId）调用 ledger_append 得到 isError 结果。
- 启用后：一条 door 为 `'tool-result'` 的行经过 session.append 后，内容末尾带 `[#1]`，且内存文件系统里出现了 `history-w001.jsonl` 并含该文本。
- 启用后：模型调 context 的 new 被批准后（可把 session.usage 的 tokens 设到 urgent 级别，并先追加一条真人请求和一条账本记录使其放行），下一次别的工具调用得到 deny。
- 启用后：trigger 为 `'auto'` 且账本新鲜的压缩，返回的 messages 只有一条、文本里含真人请求原文，底层的 session.compact 没有被调用。
- 启用后：trigger 为 `'auto'` 但账本不新鲜的压缩，底层被调用，返回的 messages 比底层给的多一条。

## 验证（必须真的跑）

1. `claude plugin test "C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod"`：全部通过。
2. `npx --yes -p typescript tsc -p "C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod"`：0 错误。
3. `claude plugin validate --strict "C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod"`：通过。

Windows 机器。单个任务最长约 9 分钟，顺序是：一，搬 probe.ts；二，session.ts 加两个方法；三，写 register.ts 并让 tsc 和 validate 通过；四，写测试。每完成一步就把文件落盘，不要攒到最后。时间不够时先保证前三步完整且通过类型检查，测试能写几条写几条，并在报告里列出没写的。

## 返回

第一行 `TASK_TERMINAL: completed|blocked|failed`。然后：

- 改动的路径
- 三条验证命令的实际结果（贴输出尾部）
- 哪些测试项没写及原因
- 类型定义与本说明不一致的地方（最重要，逐条写清楚最后按哪个做的）
- 遗留问题
