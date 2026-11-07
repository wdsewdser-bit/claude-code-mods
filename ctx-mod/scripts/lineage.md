# 会话续接与一次性迁移

## 自动续接

仅在目标没有 meta.json、且还没有本地历史编号时尝试识别。优先读取物理转录首条非元数据 user 正文（跳过元数据、compact_boundary、纯工具结果）；找不到转录才用引擎 messages()。仅匹配以“这是第 N 个窗口，上一个窗口的对话不在上下文里”开头的正文。

只探测各会话的 handoff-wNNN.md，统一 CRLF/CR/LF 并忽略首尾空白后全文比较，不依赖标题或快照路径。唯一命中、且前驱 meta 有有效 window/seq，才记录 meta.lineage = { sessionId, lastWindow, lastSeq, mode: "reference" }。没有命中、候选不可读或有多份相同正文均不猜测，继续作为普通新会话。

前驱 36，新会话首次窗口为 37。历史使用**按会话编号 + 只读回溯**，不重新编号或复制历史：本地 read/search 没命中时查询前驱，scope:all 同时查询前驱（limit 对各会话分别生效）。结果标注“旧会话”。同号时本会话优先；要明确读取旧编号：

- history: { action: "read", seq: 7552, session_id: "旧会话id" }
- history: { action: "search", query: "关键词", session_id: "旧会话id", scope: "all" }
- ledger_read: { view: "archive:1", session_id: "旧会话id" }

ledger_read 的 home/current/query 和交接均带上只读前驱视图。归档保留原目录/页号，决策从原历史提取并应用原 decisions.jsonl 的撤销。不会向前驱写任何文件。支持前驱链，循环或超过 16 层停止回溯。旧任务不与本地同名 task_id 自动合并；当前进度以本地为准，旧记录中的编号必须按来源会话读取。decision_revoke 及 ledger_append 的编号校验仍只作用于本会话，不跨会话改写旧决定/引用。

## 一次性迁移（Node 24+）

先停止目标会话；应用后重启，避免内存中的旧 meta 覆盖迁移。脚本只增加只读链接并调整当前窗口号；本地历史、账本、归档、决策、held、交接和事件的文件内容/编号均不重写。

默认只预演：

    node scripts/migrate-lineage.mjs <新会话id> <前驱id>

指定测试数据根目录：

    node scripts/migrate-lineage.mjs new old --root /tmp/ctx-mod-fixture

确认后应用：

    node scripts/migrate-lineage.mjs <新会话id> <前驱id> --apply

apply 先将整个目标目录备份为同级的 <新会话id>.bak-lineage-<时间>，再用临时文件替换目标 meta.json。不会修改前驱。新会话原窗口 3、前驱窗口 36：当前逻辑窗口改成 39，下次交接显示 40；旧文件及行内窗口 1–3 保留。重复链接同一前驱无操作，不重复加窗口；其他已有链接、循环、无效元数据和目标符号链接拒绝应用。迁移前后检测 meta 是否变化，但不能代替停机保证。

## 验证

    claude plugin test .
    claude plugin validate --strict .
    node --test tests/lineage-migration.node.mjs

迁移集成测试仅使用新建临时目录；不对运行数据目录应用迁移。修改前的源文件和既有测试备份为 .bak-lineage。
