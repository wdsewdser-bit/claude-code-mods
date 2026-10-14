# SPEC-complete：历史要真的完整（astra 审查 P1 第 4 条）

## 起因

交接信息对新窗口承诺"之前的命令、子代理任务原文、工具输出都能用 history 找回"，现在并不总能兑现：

1. `session.append` 只接 `prompt` / `response` / `tool-result` 三个入口，其余（`delivery`、`tool-message`、`attachment`、`command`、`hook-context`、`note`、`compaction`）直接放过。后果包括：后台子代理的结果通知没落盘；**人在回合中途打的消息（以 `queued_command` 附件送达）没落盘，也不会进"最近的用户请求"**。
2. 工具调用参数只留 `briefOf` 的 300 字符摘要：Agent 的任务正文、SendMessage 的消息、长命令都丢了。
3. 单条正文超过 `MAX_RECORD_CHARS`（20 万字符）直接截断，原文没有另存。
4. `importMessages` 只在 `state.seq === 0` 时导入；mod 停用期间（或钩子出错漏记）产生的消息，重新启用后不补。

## 总原则

- 改动最小，不加依赖，不改弱已有测试；代码注释英文、风格和密度跟周围一致。
- 磁盘上的旧历史（没有新字段的行）必须照常读、照常搜，不迁移。
- 新增的每个写盘都走已有的 `queue`，并沿用 SPEC-durable 的"写失败看得见"机制，不另起一套。
- 分四段做（A→B→C→D），**每段结束时测试全绿再进下一段**；预算不够时停在段边界并如实报告做到哪段。

## A. 其余入口落盘

位置：`hooks/register.ts` 的 `on('session.append', …)`，`hooks/lib/types.ts` 的 `HistoryRecord`，`hooks/lib/history.ts` 的 `search`。

1. `HistoryRecord` 加两个可选字段：`door?: string`（只在三个老入口之外的行上写）、`name?: string`（附件类型，如 `queued_command`）。
2. 三个老入口之后加一个通用分支：`e.message.role` 有值（即模型在请求里读得到这一行）就落盘，`role` 取 `e.message.role`，`door` 取 `e.door`，`name` 取 `e.message.name`，正文取文本块。`role` 没值的行（`notice` 等模型读不到的）不记。正文为空且没有非文本块的不记。
3. 非文本块不能悄悄消失：一行里有 image / document 等非文本块时，在正文末尾补一行占位，形如 `[非文本内容：image×2]`。`tool-result` 入口的 `resultText` 同样处理。
4. 人在回合中途打的消息：`door === 'attachment' && name === 'queued_command'` 时，如果渲染后的正文**包含** `personTexts` 里某条还没消费的原话，就按人的消息记（`isPerson: true`，正文记那条原话本身，`door` / `name` 照写），并从 `personTexts` 里消费掉；仍要过 `stripInjected` + `looksLikePerson`。不匹配的 `queued_command`（如排队的任务通知）按普通行记。
   - 说明：`PromptAttachmentOrigin` 对送进回合的消息一律是 `engine`，所以只能靠 `personTexts` 认人。真实引擎里这种附件的包装文字没见过，所以用"包含"而不是"相等"。
5. 搜索默认不被引擎注入的背景淹没：新增谓词（放在 `isOwnRow` 旁边），`door` 为 `attachment`（`queued_command` 除外）、`hook-context`、`note` 的行算"背景行"，`search` 默认跳过；`history` 工具的 search 加可选参数 `door`（字符串），给了就按它过滤且不跳过背景行。按编号 `read` 不受影响。工具 schema 和说明同步改（中文，见 `TOOLS`）。
6. 审计所有按 `role === 'user'` 或 `role === 'assistant'` 取行的地方（`personRequests`、`latestAssistantRow`、SPEC-fresh 的"记账后没记的步数"、交接信息各节），确认新入口的行不会被当成人的请求、助手的最后回复或一个"步骤"。有 `door` 的行一律不算。

## B. 工具调用参数全文

位置：`register.ts` 的 `tool-result` 分支和 `importedOf`，`session.ts` 的 `record` / `importMessages` / `historyTool`，`history.ts` 的 `search` / `readRecord`。

1. tool 行加两个可选字段：`args?: string`（参数全文）、`callId?: string`（`tool_use_id`，D 段对齐要用）。
2. `args` 的写法：顶层每个键一段 `key: value`，字符串值原样（可以多行），其余值 `JSON.stringify`，段之间换行。写一个纯函数（放 `history.ts`），导入路径和实时路径共用。
   - 注意 `calls` 里存的 `input` 是整个事件 `e`，要先用 `argsOf` 去掉信封字段，只留工具自己的参数。
3. `input`（300 字符摘要）保留不动，交接信息和搜索命中的展示还用它。
4. 行内 `args` 上限 `MAX_ARGS_CHARS = 50_000`；超出的部分走 C 段的另存。
5. `search`：正文没命中时，先查 `args` 再查 `input`；命中 `args` 时摘录取 `args` 里命中处前后。
6. `history` 工具的 read 加可选参数 `field`：`text`（默认，结果正文）或 `input`（参数全文），分页规则（offset / length / total / hasMore）相同。该行没有 `args` 时，`field: 'input'` 返回摘要 `input` 并说明这是旧行、只有摘要。
7. 交接信息里凡是说"任务原文可用 history 找回"的句子，补上具体读法（`field: "input"`）。

## C. 超长原文另存

位置：`history.ts` 的 `clipRecord`，`session.ts` 的 `record` 和读路径。

1. 行内仍然只留开头（正文 20 万、参数 5 万字符），所有现有消费者看到的行不变。
2. 被截的字段把**完整原文**另存为同目录的 `big-<seq>-<field>-<n>.txt`（`field` 为 `text` 或 `args`，`n` 从 0 起），每个文件最多 `OVERFLOW_PART_CHARS = 1_000_000` 字符（UTF-8 最坏约 3 MB，低于引擎 4 MiB 的读上限），不切开代理对。
3. 行上记 `overflow?: { text?: { chars: number; parts: number }; args?: { chars: number; parts: number } }`。行内截断提示改成说明全文可分页读、搜索只覆盖行内这部分。
4. 读：`readRecord` 的调用方发现该字段有 `overflow` 时，按 offset 算出要读哪几个分片文件，读出后切片；`total` 是原文长度。分片读不到时，退回行内的开头，并在结果里明说"这一段原文没有写进磁盘"，不能装作读全了。
5. 写：分片先入队、行后入队；任何一个分片写失败，走 SPEC-durable 已有的失败标记和重试（重试时要能重写分片，所以原文在写成功前不能丢）。
6. SPEC 第 2 条修过的"从磁盘恢复最大编号 / 列目录找分片"逻辑不能把 `big-*.txt` 当成历史分片。

## D. 停用期间的消息补录

位置：`session.ts` 的 `importMessages`，`register.ts` 的 `importedOf` / `importOldConversation`。

1. `importMessages` 在已有历史时不再直接返回 0，而是补录**引擎对话尾部还没记录的那一段**：找到引擎消息里最后一条"已知"的，导入它之后的全部。没有任何一条已知时全部导入。空历史时行为不变。
2. "已知"的判定（`SessionMessage` 没有 uuid，只能这样对齐）：
   - 它的某个 `toolUses[].tool_use_id` 等于某个 tool 行的 `callId`；或
   - 它的某个工具结果正文以本 mod 加的 `[#n]` 结尾且 `n <= state.seq`（覆盖没有 `callId` 的旧行）；或
   - 去掉全部空白后，它的正文与某条已记录的 user / assistant 行的正文相等，或一方包含另一方且较短的一方不少于 12 个字符。只跟"锚点之后"的行比（锚点 = 前两条规则命中的最后一个 tool 行；没有锚点就跟当前窗口的全部行比）。
3. `ImportedMessage.toolUses` 要带上 `tool_use_id`，导入的 tool 行同样写 `callId` 和 `args`。
4. 补录的行不能被当成人的新请求去改交接信息的"最近的用户请求"顺序以外的东西；`isPerson` 仍按现有的 `stripInjected` + `looksLikePerson` 判，并确认本 mod 自己的交接信息开头不会被判成人的话。
5. 补录了多少条写一行调试日志；`/ctx-mod` 状态里不用加东西。
6. 已知限制写进 NOTES-dev：只能补尾部；mod 停用期间如果引擎自己压缩过，压缩前的内容补不回来。

## 测试

每段至少覆盖：

- A：`delivery` / `compaction` / `attachment` 行落盘且带 `door`；`notice`（无 role）不记；`queued_command` 匹配 `personTexts` 时 `isPerson` 且进 `personRequests`，不匹配时不是；默认搜索跳过背景行、带 `door` 能搜到；非文本块有占位。
- B：Agent 的 `prompt`、超过 300 字符的命令能用 `field: 'input'` 完整读回；搜索能命中只出现在参数里的词；旧行（无 `args`）读 `input` 有说明。
- C：30 万字符正文能分页读到最后一个字符；分片读失败时结果里有明说；`big-*.txt` 不影响编号恢复。
- D：已有历史 + 尾部两条未记录消息 → 只导入这两条；全部已知 → 导入 0 条且连续调两次仍是 0；旧行靠 `[#n]` 对齐；空历史行为不变。

## 验收（主会话会重跑）

```
claude plugin test C:\Users\yadaz\.claude\skills\ctx-mod
npx --yes -p typescript tsc -p C:\Users\yadaz\.claude\skills\ctx-mod
claude plugin validate C:\Users\yadaz\.claude\skills\ctx-mod --strict
```

基线：305 个测试全过，tsc 0 错误，validate --strict 通过。
