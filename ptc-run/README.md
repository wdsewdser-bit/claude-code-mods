# ptc-run

在 Claude Code 里实现程序化工具调用（PTC）：注册一个工具 `mcp__ptc-run__run_code`，模型用一段 JS 程序一次完成多步操作，只有 `console.log` 的输出和返回值会回到上下文。

适合：有依赖关系的多步操作（grep → 按结果读文件 → 批量改）、需要先过滤再看的大输出、批量复制/移动/删除。

## SDK

- `tools.read / write / edit`：edit 是原子写，带过期检查（STALE）。
- `tools.glob / grep`：调用 ripgrep，遵循 `.gitignore`，跳过隐藏项、`node_modules`、`target`、`.venv`，单文件上限 2MB；结果分页。
- `tools.replace`：跨文件正则替换，支持 `dryRun`。
- `tools.batch`：复制/移动/删除的预检、执行、续跑，带日志，支持跨盘（`toRoot`）。
- `tools.bash`：同步执行一条命令。
- `tools.parallel([{command,cwd?,timeoutMs?}], {concurrency})`：并发执行多条命令，按输入顺序返回；单项超时不影响其他项，结束时清理子进程。
- `ref.put / page / release`：输出超过约 6000 字符时自动落盘成 ref，按需分页读取。ref 存在系统临时目录 `cc-ptc/` 下，保留 24 小时。

错误带 `[CODE]` 前缀和 `nextAction` 提示。

## 要知道的事

- `run_code` 里的工具调用不经过 Claude Code 的权限确认，等同于给了模型直接读写文件和执行命令的能力。
- 设置环境变量 `PTC_DENY_CREDENTIALS=1` 后，读取类操作会拒绝 `~/.ssh`、`.env`、`*.pem` 等凭据文件（`bash` 不受限）。默认关闭。
- 需要 ripgrep：优先用 `bin/rg.exe`（仓库里不带，可从 ripgrep 官方 Release 下载放进去后运行 `node build.cjs`），否则从 PATH 找 `rg`。
- 沙箱用 Node 子进程执行，需要本机装有 Node。

## 开发

`src/runner.js` 和 `src/register.tpl.ts` 是源码，改完运行 `node build.cjs` 生成 `hooks/register.ts`（mod 运行时没有 fs，runner 以字符串内嵌）。
