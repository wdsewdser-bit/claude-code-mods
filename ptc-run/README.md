# ptc-run

在 Claude Code 里实现程序化工具调用（PTC）：注册一个工具 `mcp__ptc-run__run_code`，模型用一段 JS 程序一次完成多步操作，只有 `console.log` 的输出和返回值会回到上下文。

适合：有依赖关系的多步操作（grep → 按结果读文件 → 批量改）、需要先过滤再看的大输出、批量复制/移动/删除。

## SDK

- `tools.read({path,offset?,limit?,numbered?})` / `tools.write` / `tools.edit`：edit 是原子写。同一程序里先 `read` 再 `edit` 会做 mtime 过期检查（STALE）；跨 `run_code` 调用用 `tools.revision({path})`（文件内容 sha256 的前 16 位十六进制）配合 `edit` 的 `expectedRevision`，内容不一致就整次不写并报 STALE。`all:true` 时返回改动处数和行号，可传 `expect` 声明预期处数，不符则整次不写（COUNT_MISMATCH）。
- `tools.glob / grep`：调用 ripgrep，遵循 `.gitignore`，跳过隐藏项、`node_modules`、`target`、`.venv`，单文件上限 2MB；结果分页（glob 默认每页 5000 条，grep 默认每页 500 条）。
- `tools.replace`：跨文件正则替换，支持 `dryRun`、`expect` 和 `expectedRevision`（`{路径: revision}` 映射，任一路径不匹配则全部不写）；结果带每个文件的处数和行号，`maxReplacements` 默认 100000。一次改了多处的写操作会在输出开头列出，成功时也会。
- `tools.batch`：复制/移动/删除的预检、执行、续跑，带日志，支持跨盘（`toRoot`）；单次最多 512 个操作，计划会记录源文件状态，续跑时重新校验（STALE）。
- `tools.bash`：同步执行一条命令，默认超时 120000 ms；`background:true` 转后台任务（上限 2 小时）。
- `tools.parallel([{command,cwd?,timeoutMs?}], {concurrency})`：并发执行多条命令，默认并发 4（最大 16），单次最多 64 条；按输入顺序返回；单项超时不影响其他项，结束时清理子进程。
- `ref.put / page / text / release`：输出超过 8000 字符（可用 `maxChars` 调整，最大 50000）时保留前约 70% 和后 30%，中段落盘成 ref，按需分页读取（`ref.page` 默认每页 50 条、单条上限 16384 字节）。ref 存在系统临时目录 `cc-ptc/` 下，保留 24 小时。
- `run_code` 整程序默认超时 300000 ms（最大 1800000 ms）；`root:"D:/abs/dir"` 可把相对路径、glob/grep 和 bash 的基准目录切到该目录。

错误带 `[CODE]` 前缀和 `nextAction` 提示。

## 要知道的事

- 工具不再延迟加载（`isDeferred: false`），会话首轮即可直接调用，不需要先等工具搜索。
- 带 `expectedRevision` 的 edit/replace 会在系统临时目录 `cc-ptc-locks/` 下加跨进程写锁，保证“校验 revision、写入”在锁内完成；等锁超过约 2 秒报 `LOCKED`，什么都不写；超过 30 秒的锁视为崩溃遗留，可以接管。多文件 replace 按顺序加锁。注意：多文件写入不是事务，中途崩溃时已写的文件不会回滚。
- DSH 方言（delegate 的 ptc-only）里另有 `tools.test`（测试摘要），以及 read 结果的不可枚举字段 `.text` / `.content`；设了 `PTC_RUN_DSH_READ_LIMIT` 时，不带 limit 的读取会截断，并追加一行 `kind:"notice"` 提示。这些都是实验功能，默认不写进提示，A/B 结果见 BACKLOG.md。
- `run_code` 里的工具调用不经过 Claude Code 的权限确认，等同于给了模型直接读写文件和执行命令的能力。
- 设置环境变量 `PTC_DENY_CREDENTIALS=1` 后，读取类操作会拒绝 `~/.ssh`、`.env`、`*.pem` 等凭据文件（`bash` 不受限）。默认关闭。
- 只读模式（`PTC_RUN_READONLY=1`）下写入和命令类工具被拒绝，但 `tools.read`、`tools.revision`、`tools.glob`、`tools.grep` 等只读工具可用，且只能读取工作目录（及 `PTC_RUN_RO_ROOTS` 指定的额外目录）内的文件。
- 需要 ripgrep：优先用 `bin/rg.exe`（仓库里不带，可从 ripgrep 官方 Release 下载放进去后运行 `node build.cjs`），否则从 PATH 找 `rg`。
- 沙箱用 Node 子进程执行，需要本机装有 Node。

## 开发

`src/runner.js` 和 `src/register.tpl.ts` 是源码，改完运行 `node build.cjs` 生成 `hooks/register.ts`（mod 运行时没有 fs，runner 以字符串内嵌）。
