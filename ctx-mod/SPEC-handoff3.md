# 任务说明：按真实会话的数据再改三处交接信息

M = `C:\Users\yadaz\.claude\skills\ctx-mod`

## 背景（真实会话 089d6739 里观察到的）

新代码下换了两次窗口，换完都能直接接着干，但有三处浪费：

1. 16:18 那次换窗口前，模型想写一条 1637 字的账本，被 1500 字上限拒绝，按提示拆成了两条（#L12 调研结论、#L13 管线事实）。交接信息里每个任务只显示最新一条，于是最重要的 #L12 没进交接信息，模型换完后先调了两次 `ledger_read`。
2. 交接信息的“最近的动作”10 条里有 5 条是本 mod 自己的工具调用（`ledger_append`、`context`），`history` 搜索结果里也混进了以前的 `history`、`ledger_read` 调用结果。
3. 模型在上下文 15 万和 25 万时用 ToolSearch 加载桌面控制工具，引擎随后把整段消息缓存重建了（分别重写 11.7 万和 20.3 万 token）。同样的加载发生在刚换完窗口、上下文只有 6 万时，只重写 2.9 万。交接信息应当告诉新窗口“上个窗口加载并用过哪些延迟工具”，让它在第一步就加载。

## 共同规则

- 只改下面点名的文件。不运行 `claude -p`，不做 git 操作，不加依赖，不删除或放宽已有测试（断言的文案因本次改动而变化时可以同步更新，并在报告里列出）。
- 风格与现有文件一致：无分号、单引号、2 空格、箭头函数、`import type`；导出项和不显然的分支上方写一句英文注释说明“为什么”。
- 运行环境没有 Node 也没有 DOM。不改变已有导出的签名；可以新增可选字段和新导出。
- 旧数据兼容：磁盘上已有的 history 行和账本行没有新字段，读到时必须正常工作。
- 先读齐要改的位置再动手：`hooks\lib\ledger.ts` 第 300–460 行（`TaskState`、`tasksOf`、`renderHome`）、`hooks\lib\history.ts` 第 150–300 行（`search`、`recentActions`）、`hooks\lib\handoff.ts` 全文（125 行）、`hooks\lib\session.ts` 第 974–1022 行（`buildHandoff`）、`hooks\register.ts` 第 697–744 行（`tool-result` 分支）和第 21 行的 `PREFIX`。其余按需用 Grep 定位，不通读 `session.ts` 和 `register.ts`。
- 验证（必须真的跑，三条都要）：
  1. `claude plugin test "C:\Users\yadaz\.claude\skills\ctx-mod"`：全部通过（现在是 197 个，只能增加）。
  2. `npx --yes -p typescript tsc -p "C:\Users\yadaz\.claude\skills\ctx-mod"`：0 错误。
  3. `claude plugin validate --strict "C:\Users\yadaz\.claude\skills\ctx-mod"`：通过。
- 按 A、B、C 的顺序做，每做完一条就跑一次测试。
- 返回：第一行 `TASK_TERMINAL: completed|blocked|failed`；每条怎么改的（文件和函数名）；没做的条目；测试通过和失败数；tsc 和 validate 的结果；同步改过文案的已有断言；遗留问题。

## A. 进行中的任务显示同一窗口里写的多条账本

文件：`hooks\lib\ledger.ts`、`tests\ledger.test.ts`（没有就放进已有的账本测试文件）。

- `renderHome` 里“进行中 / 受阻的任务”现在只输出 `  - 最新：${task.latest.text}`。改为：取该任务在 `task.latest.window` 这个窗口里写的条目（`input.entries` 里 task_id 相同且 window 相同），从最新往回取，最多 3 条，且这些条目的 `text` 总长不超过 3000 个字符；最新一条无论多长都要取。
- 只取到 1 条时输出保持原样（`  - 最新：…`），已有测试不应因此变化。
- 取到多条时按旧到新输出：
  ```
    - 记录（同一窗口写的 N 条，旧→新）：
      - #L12：…
      - #L13：…
  ```
  编号用条目的账本序号，写法与 `ledger_read` 输出里的 `#L<n>` 一致。
- `  - 下一步：…` 仍只取最新一条的 `next_step`，位置不变。
- 这一节仍然不参与裁剪。
- 测试：同一窗口两条 → 两条都出现且旧的在前；三条以上 → 只有最新 3 条；总长超 3000 → 较旧的被丢掉而最新一条保留；不同窗口的旧条目不出现；只有一条时输出与现在完全相同。

## B. 本 mod 自己的工具行不进“最近的动作”和搜索结果

文件：`hooks\lib\types.ts`、`hooks\lib\history.ts`、`hooks\register.ts`、`tests\history.test.ts`。

- 把 `'mcp__ctx-mod__'` 这个前缀放到 `types.ts` 里导出（例如 `OWN_TOOL_PREFIX`），`register.ts` 第 21 行的 `PREFIX` 改为引用它，不要留两份字面量。
- `recentActions`：先排除 `tool` 以该前缀开头的行，再取最后 `count` 条。
- `search`：默认跳过 `tool` 以该前缀开头的行；调用方显式传了 `tool` 过滤条件时不跳过（这样仍能按工具名查到它们）。
- 这些行照常写入磁盘、照常能用 `readRecord` 按编号读，只是不出现在上面两处。
- 测试：混有 `mcp__ctx-mod__ledger_append` 行时，`recentActions` 返回的 `count` 条全是别的工具；`search` 默认搜不到 `mcp__ctx-mod__history` 行，带 `tool: 'mcp__ctx-mod__history'` 时能搜到。

## C. 交接信息列出上个窗口加载并用过的延迟工具

文件：`hooks\lib\types.ts`、`hooks\lib\history.ts`、`hooks\lib\handoff.ts`、`hooks\lib\session.ts`、`hooks\register.ts`，以及对应测试文件。

- `HistoryRecord` 和 `RecordInput` 新增可选字段 `loaded?: string[]`：一次 ToolSearch 实际加载的工具名。
- `register.ts` 的 `tool-result` 分支：`tool === 'ToolSearch'` 时，从 `block.content`（数组）里取出所有 `type === 'tool_reference'` 的部分的 `tool_name`（做 `typeof === 'string'` 检查）。非空时把它作为 `loaded` 传给 `session.record`；并且如果 `resultText(block.content)` 是空串，就把记录的 `text` 写成 `已加载：a、b、c`。`session.ts` 的 `record()` 把 `loaded` 落盘（照 `input` 字段的写法）。这个结果本来就不追加 `[#编号]`，保持不变。
- `history.ts` 新增导出纯函数 `loadedTools(rows, window): { name: string; calls: number }[]`：
  1. 收集该窗口里 `tool === 'ToolSearch'` 的行加载的名字：有 `loaded` 用 `loaded`；没有（旧数据）而 `input` 以 `select:` 开头时，用冒号后面按逗号分开并 trim 的名字。
  2. 统计该窗口里每个工具被调用的次数（`role === 'tool'` 的行按 `tool` 计数）。只保留加载过且调用次数大于 0 的名字。
  3. 形如 `mcp__<server>__<tool>` 的名字按 server 合并成一项 `mcp__<server>__*`，次数相加；其他名字各自一项。
  4. 按首次加载的先后排序，最多 8 项。
- `handoff.ts`：新增导出 `renderTools(tools)`，为空返回空串，否则：
  ```
  ## 上个窗口加载并用过的延迟工具
  - mcp__computer-use__*（调用 56 次）
  - WebFetch（调用 6 次）
  接下来确定还要用到的，在第一步用一次 ToolSearch 全部加载：现在上下文小，加载代价低；等上下文变大后再加载会让整段缓存重建。用不到的不要加载。
  ```
  `HandoffInput` 新增可选 `tools?: string`（已渲染的文本）；`assemble` 把它放在 `agents` 之后、`workset` 之前，和 `agents` 一样不参与裁剪。同步更新 `assemble` 上方和内部的注释。
- `session.ts` 的 `buildHandoff`：用 `loadedTools(rows, state.window)` 渲染后传给 `assemble`（空串时不传）。
- 测试：`loadedTools` 的合并、只保留用过的、旧数据 `select:` 回退、上限 8 项；`assemble` 里这一节的位置（在子代理之后、工作集之前）和为空不出；register 测试里一次带 `tool_reference` 的 ToolSearch 结果之后再调用其中一个工具，自动压缩得到的交接信息含 `## 上个窗口加载并用过的延迟工具` 和该工具名（或其 `mcp__<server>__*` 合并项）。
