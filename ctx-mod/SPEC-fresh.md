# 任务说明：账本要真的跟得上，才允许不写摘要就换窗口

M = `C:\Users\yadaz\.claude\skills\ctx-mod`

## 背景

- 换窗口时不让模型写摘要，靠的是账本。现在判断“账本够新”的条件太弱（`session.ts` 的 `isLedgerFresh` → `ledger.ts` 的 `hasFreshEntry`）：本窗口里只要有任意一条账本，时间不早于最近一次用户请求，就算新。
- 外部审查复现过：写一条正文为空的账本，再执行 20 个工具调用，仍然判定“新”并批准换窗，那 20 步的结论没有进交接信息。
- 另外两处相关的弱点：
  - `ledger_append` 允许 `text` 是空串，`in_progress` 的任务可以不写 `next_step`。
  - 给同一个任务补一条记录时如果省略 `next_step` 和 `anchors`，新记录成为该任务的最新记录，交接信息里之前的下一步和待改位置就没了。
- 目标：账本记录带上“写到历史哪一条为止”；用它量出“记账之后又做了多少步没记”；这个数太大时，模型申请换窗要先补账，自动压缩退回引擎摘要；交接信息如实写出没记账的那一段。

## 共同规则

- 只改下面点名的文件。不运行 `claude -p`，不做 git 操作，不加依赖，不删除已有测试。
- 这次会让一些已有测试的**输入**变得不合法（空 `text`、`in_progress` 不带 `next_step`）。允许给这些输入补上合法的值；不允许为了通过而删断言或放宽断言。改过输入或断言的已有测试在报告里逐条列出。
- 风格与现有文件一致：无分号、单引号、2 空格、箭头函数、`import type`；导出项和不显然的分支上方写一句英文注释说明“为什么”。
- 运行环境没有 Node 也没有 DOM，lib 里不要 import `node:*`，也不要从 `'claude-code'` 引类型进 `hooks\lib`。不改变已有导出的签名；可以新增可选字段和新导出。
- 旧数据兼容：磁盘上已有的账本条目没有新字段，按下面写明的回退规则处理，绝不抛错。
- 先读齐再动手，其余按需 Grep，不通读 `session.ts` 和 `register.ts`：
  - `hooks\lib\ledger.ts`：`validate`、`stamp`、`tasksOf`、`hasFreshEntry`。
  - `hooks\lib\types.ts`：`LedgerInput`、`LedgerEntry`、`Config`、`DEFAULTS`。
  - `hooks\lib\session.ts`：`ledgerAppend`、`isLedgerFresh`、`requestSwitch`、`buildHandoff`。
  - `hooks\lib\usage.ts`：`gateSwitch`。
  - `hooks\lib\history.ts`：`recentActions`、`isOwnRow`。
  - `hooks\lib\handoff.ts`：`HandoffInput`、`assemble`、`renderActions`（注意超预算时“最近的动作”会被整段裁掉）。
  - `hooks\register.ts`：`on('session.compact', …)` 里的 `session.isLedgerFresh()`。
- 验证（三条都要真的跑，写成一条 PowerShell 命令；测试输出只筛失败用例和末尾计数）：
  1. `claude plugin test "C:\Users\yadaz\.claude\skills\ctx-mod"`：全部通过（现在是 277 个，只能增加）。
  2. `npx --yes -p typescript tsc -p "C:\Users\yadaz\.claude\skills\ctx-mod"`：0 错误。
  3. `claude plugin validate --strict "C:\Users\yadaz\.claude\skills\ctx-mod"`：通过。
- 轮数有上限：独立的读取和 Grep 一次并行发出；先把产品代码写完跑一次 tsc，再集中改测试、写测试，跑一次完整验证。
- 返回：第一行 `TASK_TERMINAL: completed|blocked|failed`；怎么改的（文件和函数名）；没做的条目；测试通过和失败数；tsc 和 validate 的结果；改过输入或断言的已有测试（逐条）；测试底座触发不了的路径；遗留问题。有任何一条验证没跑或没过，就不能报 completed。

## F1. 账本记录带上“写到历史哪一条为止”

文件：`hooks\lib\types.ts`、`hooks\lib\ledger.ts`、`hooks\lib\session.ts`、`tests\ledger.test.ts`、`tests\session.test.ts`。

- `LedgerEntry` 新增可选字段 `through?: number`：写这条记录时历史里最后一条的编号。
- `stamp` 的 `meta` 新增可选字段 `through?: number`，给了就写进条目。`session.ledgerAppend` 传 `state.seq`。
- 测试：新记录带 `through`，值等于记账时的历史编号；没传时条目里没有这个字段。

## F2. 记账内容的最低要求，以及省略字段时沿用

文件：`hooks\lib\ledger.ts`、`hooks\lib\session.ts`、`hooks\register.ts`（只改 `ledger_append` 工具描述里和这两条规则有关的文字，如果有的话）、`tests\ledger.test.ts`、`tests\session.test.ts`。

- `validate`：
  - `text` 去掉首尾空白后不能为空（所有状态）。原来的提示“（可以是空串）”改成要求写一句这一步的要点。
  - `status` 是 `in_progress` 时必须有下一步：这次给了非空的 `next_step`，或者这次省略了而该任务已有的最新记录里有非空的 `next_step`。两者都没有，或者这次显式给了空串，就报一条：`status 是 in_progress，必须写 next_step：换窗口后要接着做的下一步。任务做完了就标 done。`
  - 判断“该任务已有的最新记录”用 `context.entries`（已有）和 `tasksOf`。
- `session.ledgerAppend`：校验通过后、`stamp` 之前，`status` 是 `in_progress` 或 `blocked` 且这次省略了 `next_step`（`undefined`）时，沿用该任务最新记录的 `next_step`；`anchors` 同理（省略时沿用，给了就用新的，给空数组表示清空）。沿用只看当前账本页（`state.page`）里的记录。
- 测试：空 `text` 被拒；`in_progress` 首条记录不带 `next_step` 被拒；第二条省略 `next_step` 和 `anchors` → 通过，且存下来的条目带着上一条的下一步和待改位置；显式给新 `next_step` → 用新的；`anchors: []` → 清空；`done` 不沿用。

## F3. 量出“记账之后没记的步数”，并用它把关

文件：`hooks\lib\types.ts`、`hooks\lib\usage.ts`、`hooks\lib\session.ts`、`hooks\register.ts`、`tests\usage.test.ts`、`tests\session.test.ts`、`tests\register.test.ts`。

- `Config` 新增两项，`DEFAULTS` 里的值如下，各写一句注释：
  - `freshTailSteps: 5`：模型申请换窗时，最近一次记账之后最多允许有这么多个没记账的工具结果。
  - `autoTailSteps: 25`：自动压缩时，超过这个数就不做零摘要，退回引擎的摘要。
- `session.ts` 新增内部函数（是否导出由你定）算“没记账的一段”：
  - 取本窗口（`entry.window === state.window`）账本条目里最新的一条。
  - 没记账的步 = 本窗口的历史行里 `role === 'tool'`、不是本 mod 自己的工具（`isOwnRow`，需要的话从 `history.ts` 导出）、且在那条记录之后的行。“之后”的判断：条目有 `through` 就用 `row.seq > entry.through`；没有（旧数据）就用 `row.ts > entry.ts`。
  - 本窗口一条账本都没有时，本窗口所有这样的行都算。
  - 返回：步数、这段的首尾历史编号、那条账本记录的编号（没有就是 `null`）。
- `requestSwitch`（模型调用 `context new`）：“账本够新”改为 `isLedgerFresh()` 且没记账的步数 `<= config.freshTailSteps`。
- `gateSwitch` 的 `input` 新增可选字段 `staleReason?: string`：账本不够新时用它代替原来那句固定文案的前半句。`requestSwitch` 按情况传：
  - 本窗口在最近一次用户请求之后没记过账：`账本还不新：这个窗口里在最近一次用户请求之后还没有记过账。`
  - 记过但之后步数超了：`账本还不新：最近一次记账（#L27）之后又有 12 个工具结果没有记进账本（#640–#655）。`
  - 两种后面都接：`先用 ledger_append 写明这些步骤的结论、下一步和关键文件，再换窗口。`
  - 没传 `staleReason` 时文案和现在完全一样。
- `Session` 新增方法 `canSkipSummary(): boolean`：`isLedgerFresh()` 且没记账的步数 `<= config.autoTailSteps`。`register.ts` 的 `session.compact` 里，自动压缩那一支的 `session.isLedgerFresh()` 换成 `session.canSkipSummary()`。本 mod 自己发起的那一支（`mine`）不变：模型申请的已经在批准时把过关，缓存过期的那种换窗本来就不看账本。
- 测试：
  - 记账后做 5 步 → `context new` 批准（其他条件满足时）；做 6 步 → 拒绝，文案含那条账本编号、步数和首尾历史编号；补一条账本后 → 批准。
  - 本 mod 自己的工具结果（`mcp__ctx-mod__*`）不算步数。
  - 旧条目没有 `through` 时按时间判断。
  - `canSkipSummary`：25 步 → `true`；26 步 → `false`；本窗口没记过账 → `false`。
  - `gateSwitch`：不传 `staleReason` 时文案不变；传了就用它。
  - `register.test.ts`：账本新鲜但之后有 26 步时，自动压缩走了引擎摘要（`next` 被调用）且结果里仍追加了本 mod 的交接信息；25 步以内仍是零摘要。

## F4. 交接信息如实写出没记账的那一段

文件：`hooks\lib\handoff.ts`、`hooks\lib\session.ts`、`tests\handoff.test.ts`、`tests\session.test.ts`。

- `buildHandoff`：“最近的动作”的条数改为：没记账的步数，但不少于 `config.recentActions`、不多于 25。这样没记账的那一段在零摘要换窗时全部列在交接信息里。
- `HandoffInput` 新增可选字段 `coverage?: string`，在 `assemble` 里放在“工作集”之前，**不参与裁剪**（“最近的动作”超预算时会被整段裁掉，这句话必须留下）。没记账的步数大于 0 时由 `buildHandoff` 传入：
  - 本窗口记过账：
    ```
    ## 账本没覆盖到的部分
    最近一次记账（#L27）之后还有 12 个工具结果没有记进账本（#640–#655）。它们的结论账本里没有：最近的那些列在“最近的动作”里，需要细节时用 history 按编号读原文，不要凭印象继续。
    ```
  - 本窗口没记过账：
    ```
    ## 账本没覆盖到的部分
    上个窗口里没有记过账，有 12 个工具结果（#640–#655）只在历史里。开工前先用 history 读最近的用户请求和这些结果，不要凭印象继续。
    ```
  - 步数为 0 时不出这一节。
- 测试：三种情况各一条（有账本有尾巴、没账本、无尾巴不出这一节）；尾巴 18 步时“最近的动作”列出 18 条；超过 25 步时列 25 条；交接超预算、动作被裁掉时这一节仍在。
