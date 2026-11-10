# delegate

把任务交给更便宜的模型执行：DS（任意 OpenAI chat 协议供应商，经本地 Anthropic→OpenAI 代理）和 GPT（经本地 CLIProxyAPI，走 ChatGPT 订阅）。

## 提供的工具

- `delegate_flash` / `delegate_pro`：DS 快档 / 强档。`mode` 为 `read`（只读）或 `work`（可改文件），支持 `background`、`resume`（续用同一子代理，沿用上次的 mode/ptc/模型/档位）、`effort`。
- `delegate_gpt`：GPT 执行，默认 `gpt-6.1-sol`，可选 `gpt-6-astra`；档位最低 medium。
- `delegate_send` / `delegate_status` / `delegate_list` / `delegate_cancel`：后台任务插话、查看、列表、取消。任务状态落盘在 `~/.claude/delegate/jobs/`，重启后仍能找回并续用。
- `/delegate`：管理供应商、协议（chat / responses / anthropic）、key 和模型列表。

界面上有实时面板（事件流、轮数、上下文）和按钮栏（运行数、GPT 5 小时额度、DS 今日用量）。

## DS 每日 token 用量

- `delegate_flash` / `delegate_pro` 每次运行都会把整次运行的 token 记进日账本：**输入 + 缓存读 + 缓存写 + 输出**。
  以作业为单位记“该作业到目前为止的总量”，同一作业反复更新只换自己那一条，不会重复加；resume 续用同一 agent 是新的作业。
  跨零点的作业记在开始那天。供应商不返回 usage 时记为未知，汇总里会注明“N 个作业无用量数据”，不会当成 0。`delegate_gpt` 不在此列。
- 账本存在插件的 store 里，每条作业一个 `usage:<jobId>`，多个会话同时写不会互相覆盖；只保留最近 30 天。
- 面板和按钮栏显示 `DS 今日 1.2亿`；设了上限时显示 `DS 今日 1.2亿/8亿 15%`，`delegate_list` 末尾也有同一行。
- `/delegate` → 「DS 每日用量」里可设每日上限，默认 0 = 不设上限（只统计、不提醒）。可写 `800000000`、`8亿`、`800M`、`0.8B`、`80万` 这类简写。
- 今日用量到上限的 80% / 100% 时，`delegate_flash` / `delegate_pro` 的返回末尾会多一行提醒；**不会拦截派发**（上限是人估的，可能已经加了号）。

## 依赖

- DS：本地 `a2o`（ant2oai）代理，`scripts/run_proxy.py` 在它外面加了 system 消息展开和 `--effort`。
- GPT：本地 CLIProxyAPI，默认 `http://127.0.0.1:8317`；启动脚本默认在 `~/tools/cliproxyapi/ensure_cpa.py`，可用 `DELEGATE_CPA_ENSURE`、`DELEGATE_CPA_BASE` 覆盖。
- 子代理用 ptc-run 的提示词（`scripts/ptc-*-system.md`）。

## 安全

- key 只经 stdin 传给 `scripts/cpa-admin.mjs`，输出一律脱敏；作业记录不保存供应商 key。
- `work` 模式的子代理可以直接改文件和执行命令。

## 开发

```
claude plugin validate delegate
claude plugin test delegate
```
