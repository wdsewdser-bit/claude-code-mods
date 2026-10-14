# SPEC-p2a：账本补记不丢下一步、搜索说明范围、确认来源的人话不被误删（astra 审查 P2 第 7、11、12 条）

三条互不依赖，都小。总原则同前：改动最小，不加依赖，不改弱已有测试；磁盘上的旧账本和旧历史照常读，不迁移；代码注释英文，面向模型的字符串中文、用平实的话。

## 一、账本补记时，省略的字段表示"保持不变"（第 7 条）

位置：`hooks/lib/ledger.ts` 的 `tasksOf` / `TaskState` / `windowNotesOf` 和渲染首页、交接的地方；`hooks/lib/session.ts` 里读 `task.latest.next_step` / `task.latest.anchors` 的地方（先 Grep `latest.next_step|latest.anchors` 找全）。

现状：`tasksOf` 把最后一条记录整体当成 `latest`。补记一条进展时没带 `next_step` / `anchors`，交接里之前的下一步和待改位置就没了。

1. `TaskState` 加"解析后的"下一步和待改位置：最新一条带了就用它的；没带就沿用**同一任务里最近一条带了的**，并记下它来自哪条记录。
2. 明确清空：`next_step` 传空字符串、`anchors` 传空数组，表示清空，不再往前找。先看 `entryOf` 现在怎么解析这两种输入，必要时让它能区分"没传"和"传了空"；`ledger_append` 的工具说明补一句"省略表示沿用上一条，传空表示清空"。
3. 任务状态是 `done` / `superseded` 时不沿用（已结束的任务没有下一步）。
4. 交接和首页里，沿用来的下一步要标出来源，形如 `下一步（沿用 #L32 的记录，可能已过时）：…`；最新一条自己带的照旧显示。待改位置同理，沿用的在那一节的任务行上标一次。
5. `windowNotesOf` 只取最新一条所在窗口的记录。改成：这个窗口的记录没用完条数和字数预算时，用同一任务更早窗口的记录从新到旧补满（预算、上限不变）。更早窗口的记录在显示时带上窗口号，让模型知道那是旧窗口写的。

## 二、历史搜索说清搜了哪些窗口，没搜到就往前找（第 11 条）

位置：`session.ts` 的 `historySearch`（`SEARCH_WINDOWS = 3`）和 `register.ts` 里 `TOOLS` 的 history 说明。

现状：没指定 `window` 时只搜最近 3 个窗口，没命中就返回"没有匹配。"，模型会以为这件事从没发生过。

1. 没指定 `window` 且最近 3 个窗口里没有命中时，自动往更早的窗口找，一次加一个窗口，找到有命中的窗口就停，或者找到第 1 个窗口为止。
2. 结果末尾总是加一行说明实际搜索范围，但只在范围不是"全部窗口"时加。例如 `（搜了第 3–5 个窗口；第 1–2 个窗口没搜，要搜用 window 指定）`。全部搜过仍没有命中时写 `第 1–5 个窗口里都没有匹配。`
3. 指定了 `window` 时行为不变，没命中时写明只搜了那个窗口。
4. 工具说明里补一句默认范围和自动往前找的规则。

## 三、来源已确认是人的消息，不再被开头的文本猜测排除（第 12 条）

位置：`session.ts` 的 `looksLikePerson`，`register.ts` 的 `session.append` 的 `prompt` 分支和 `queued_command` 分支。

现状：`looksLikePerson` 把所有以 `<` 开头的文本都排除。人发的 `<task>…</task>` 或以 HTML / XML 开头的消息，即使 `origin` 明确是 composer / sdk，也不会被记成人的请求。

1. `looksLikePerson` 加第二个参数表示"来源已确认是人"。已确认时，只排除确定不是人话的几种开头：
   - 斜杠命令的信封：`<command-name>`、`<command-message>`、`<command-args>`、`<local-command-stdout>`、`<local-command-stderr>`、`<local-command-caveat>`；
   - `<task-notification>`、`<system-reminder>`；
   - 现有的另外四条（`This session is being continued…`、`Caveat:`、`ctx-mod：`、交接开头）。
   其余以 `<` 开头的都算人话。
2. 来源没确认时（导入旧对话，没有来源信息），规则不变。
3. "来源已确认"的条件就是 `prompt` 分支里现有的那三个：匹配到 `personTexts`、`isPersonOrigin(e.origin)`、`isOurUser(e.origin)`。`queued_command` 分支匹配到 `personTexts` 也算。
4. 注意：斜杠命令是人从输入框打的，来源同样是 composer，所以第 1 条的信封名单不能省；`isOurUser` 重新提交的是人的原话，但本 mod 自己发的续跑提示以 `ctx-mod：` 开头，仍要排除。

## 测试

- 一：补记不带 `next_step` / `anchors` 时交接里仍有之前的，并带来源标注；传空清空后没有；`done` 的任务不沿用；跨窗口补记后旧窗口的记录仍出现并带窗口号；预算和条数上限仍然生效。
- 二：第 5 窗口搜只在第 1 窗口出现的词能命中，并说明范围；全部没有时写明都搜过；指定 `window` 时不往前找。
- 三：来源是 composer 的 `<task>…</task>` 记为人的请求；来源是 composer 的 `<command-name>/compact</command-name>` 不是；没有来源的 `<task>…</task>`（导入）仍不是；`ctx-mod：` 开头的仍不是。

## 验收（主会话会重跑）

```
claude plugin test C:\Users\yadaz\.claude\skills\ctx-mod
npx --yes -p typescript tsc -p C:\Users\yadaz\.claude\skills\ctx-mod
claude plugin validate C:\Users\yadaz\.claude\skills\ctx-mod --strict
```

基线：333 个测试全过，tsc 0 错误，validate --strict 通过。
