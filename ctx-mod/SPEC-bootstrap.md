# 任务说明：让旧会话也能零摘要换窗口

M = `C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod`

## 背景

ctx-mod 只从自己被加载那一刻开始把对话记进磁盘（`session.append` 钩子）。一个早就存在的会话（旧会话）第一次带着本 mod 启动时，磁盘上没有历史、没有账本，这时换窗口，交接信息几乎是空的。

目标：用户恢复一个上下文很大、缓存已过期的旧会话后，输入 `/ctx-mod switch`，本 mod 不调用模型，直接把窗口换成一份由代码生成的交接信息，里面有最近的用户请求、上一次助手的最后回复、最近的动作和文件工作集。

引擎提供 `$.session.messages()`：返回已有对话，最多最新 4096 条，每条 `{ role: 'user' | 'assistant', text, toolUses, toolResults? }`。类型定义在 `M\.claude-plugin\types\claude-code\index.d.ts`，搜 `export type SessionMessage`、`ToolUseSummary`、`ToolResultSummary`，按实际字段写，不要猜。

## 共同规则

- 只改下面点名的文件。不运行 `claude -p`，不做 git 操作，不加依赖，不删除或放宽已有测试。
- 风格与现有文件一致：无分号、单引号、2 空格、箭头函数、`import type`；导出项和不显然的分支上方写一句英文注释说明"为什么"。
- 运行环境没有 Node 也没有 DOM。
- 不改变已有导出的签名；可以新增。
- 验证（必须真的跑）：
  1. `claude plugin test "C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod"`：全部通过（现在是 169 个）。
  2. `npx --yes -p typescript tsc -p "C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod"`：0 错误。
  3. `claude plugin validate --strict "C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod"`：通过。
- 时间约 9 分钟。按 C1、C2、C3 的顺序做，每做完一条就落盘并跑一次测试。到第 7 分钟左右无论做到哪都停下来汇报。
- 返回：第一行 `TASK_TERMINAL: completed|blocked|failed`；每条怎么改的；没做的条目；测试通过和失败数；tsc 和 validate 结果；遗留问题。

## C1. 导入旧对话

文件：`hooks\lib\session.ts`、`hooks\register.ts`、`tests\session.test.ts`、`tests\register.test.ts`。

`session.ts` 新增方法 `importMessages(messages): Promise<number>`，返回导入的记录数。入参类型在 `session.ts` 里自己声明一个最小结构（不要从 `'claude-code'` 引类型进 lib），大意：

```ts
export type ImportedMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { name: string; input?: unknown; text?: string; isError?: boolean }[]
}
```

字段名以类型文件里 `ToolUseSummary` 的实际字段为准，由 `register.ts` 负责把引擎的值映射成这个结构。

行为：

- 只在 `state.seq === 0`（这个会话在磁盘上还没有任何记录）时导入，否则直接返回 0。因此重复调用是安全的。
- 按顺序逐条走已有的 `record()`，这样分片、截断、编号都沿用现有逻辑：
  - `role: 'user'` 且 `text.trim()` 非空：记为 `role: 'user'`。是否标 `isPerson: true` 用一个导出的纯函数 `looksLikePerson(text)` 判断：文本以 `<` 开头（如 `<system-reminder>`、`<local-command-caveat>`、`<command-name>`、`<task-notification>`）、以 `This session is being continued from a previous conversation` 开头、以 `Caveat:` 开头、或以 `ctx-mod：` 开头的，不算真人；其余算真人。
  - `role: 'assistant'` 且 `text.trim()` 非空：记为 `role: 'assistant'`。
  - 助手消息的每个 `toolUses` 项，如果已经有结果：记一条 `role: 'tool'`，带 `tool`（工具名）、`path`（从 input 的 `file_path`、`notebook_path`、`path` 里取第一个字符串）、`isError`、`text`（结果文本）；然后调用已有的 `activity(tool, input, record.seq, isError)`，让文件工作集也有旧会话的读写记录。
- 导入的记录没有 uuid，`RecordInput.uuid` 若是必填就传空字符串或改成可选（改成可选时不要影响已有调用）。
- 导入不更新 `lastRequestAt`（旧消息的时间未知）。
- 导入完成后调用内部的 `saveMeta()`。

`register.ts`：在 `sessionOf` 新建 Session 并 `ready()` 之后，调用一次 `$.session.messages()`（放在 try 里，失败只记日志），映射后交给 `importMessages`。只对新建的 Session 做，缓存命中的路径不做。

测试：

- `session.test.ts`：空目录的 Session 导入 5 条消息（含一条带已完成 Read 工具调用的助手消息、一条 `<system-reminder>` 开头的用户消息）后，`historyTool` 能搜到其中的文本；`buildHandoff` 的结果含真人请求原文、不把 `<system-reminder>` 那条当成用户请求；第二次调用 `importMessages` 返回 0；已有记录（seq > 0）的 Session 调用返回 0。
- `looksLikePerson` 的几个正反例。
- `register.test.ts`：底座的 `session.messages` 返回两条旧消息，`session.start` 之后 `history` 工具能搜到旧消息的文本。

## C2. 交接信息带上"上一次助手的最后回复"

文件：`hooks\lib\handoff.ts`、`hooks\lib\session.ts`、`tests\handoff.test.ts`、`tests\session.test.ts`。

没有账本时，新窗口只看得到用户请求和工具动作，看不到助手上次得出的结论。

- `HandoffInput` 新增可选字段 `lastReply?: string`。`assemble` 在 `home` 之后、`workset` 之前插入一节，标题 `## 上一次助手的最后回复`，正文是该文本。为空或缺省时不出这一节。
- 超出 `config.handoffTokens` 时的裁剪顺序改为：先去掉动作，再裁文件片段（现有逻辑），`home` 和 `lastReply` 都不裁。
- `session.ts` 的 `buildHandoff`：取内存里最后一条 `role: 'assistant'` 的记录文本，超过 6000 个字符时保留末尾 6000 个字符并在开头加一行 `（前文已省略，用 history 工具查看 #<seq>）`。取之前先做与真人请求相同的按需回读（现有的那个内部函数），保证重载后也取得到。
- 只在账本没有进行中的任务时带这一节（有进行中的任务时账本已经说明了进度，不重复占预算）。用现有的 `tasksOf` 判断。

测试：有最后回复且无进行中任务时交接信息含这一节；有进行中任务时不含；超长时被截到 6000 字符并带省略行。

## C3. 手动命令 `/ctx-mod switch`

文件：`hooks\register.ts`、`tests\register.test.ts`。

- `command.run` 钩子现在只输出状态。改成：参数（看类型文件里 `command.run` 事件的入参字段名，通常是 `args`）去空白后等于 `switch` 时走换窗口，其余保持现状。命令描述改为 `显示 ctx-mod 的状态；/ctx-mod switch 立即换到新窗口（不调用模型）`。
- 换窗口不能在 `command.run` 钩子里直接调用 `$.command.run`（引擎会拒绝）。照 `prompt.submit` 冷缓存路径的做法：`$.clock.after(300, …)` 里置 `switchReason = 'manual-switch'`，`await $.command.run({ command: 'compact' })`，finally 里复位 `switchReason = null`；钩子本身立刻返回 `{ text: 'ctx-mod：正在换到新窗口（不调用模型）。' }`。`switchReason` 的类型若是联合类型就加上这个值。
- 压缩失败（抛错）时记日志，并用 `$.session.append` 追加一条 `type: 'system'` 的提示：`ctx-mod：换窗口没有成功，上下文保持原样。`
- 换窗口后不自动提交任何消息，等用户自己发下一条。
- 如果历史里一条真人请求都没有（`session.latestPersonSeq()` 取不到），不换窗口，返回 `{ text: 'ctx-mod：还没有可交接的内容，不换窗口。' }`。

测试：`switch` 参数下钩子返回上面那句话，推进时钟 300ms 后底座的 `command.run` 收到 `compact`；随后触发 `session.compact`（trigger `manual`）得到的 `messages` 只有一条、内容是交接信息；无参数时仍输出状态；没有真人请求时不调用 `compact`。
