# ptc-run

在 Claude Code 里实现程序化工具调用（PTC）：注册一个工具 `mcp__ptc-run__run_code`，模型用一段 JS 程序一次完成多步操作，只有 `console.log` 的输出和返回值会回到上下文。

适合：有依赖关系的多步操作（grep → 按结果读文件 → 批量改）、需要先过滤再看的大输出、批量复制/移动/删除。

## SDK

- `tools.read({path,offset?,limit?,numbered?})` / `tools.write` / `tools.edit`：edit 是原子写。同一程序里先 `read` 再 `edit` 会做 mtime 过期检查（STALE）；跨 `run_code` 调用用 `tools.revision({path})`（文件内容 sha256 的前 16 位十六进制）配合 `edit` 的 `expectedRevision`，内容不一致就整次不写并报 STALE。`all:true` 时返回改动处数和行号，可传 `expect` 声明预期处数，不符则整次不写（COUNT_MISMATCH）。
- `tools.glob / grep`：调用 ripgrep，遵循 `.gitignore`，跳过隐藏项、`node_modules`、`target`、`.venv`，单文件上限 2MB；结果分页（glob 默认每页 5000 条，grep 默认每页 500 条）。
- `tools.replace`：跨文件正则替换，支持 `dryRun`、`expect` 和 `expectedRevision`（`{路径: revision}` 映射，任一路径不匹配则全部不写）；结果带每个文件的处数和行号，`maxReplacements` 默认 100000。一次改了多处的写操作会在输出开头列出，成功时也会。
- `tools.batch`：复制/移动/删除的预检、执行、续跑，带日志，支持跨盘（`toRoot`）；单次最多 512 个操作，计划会记录源文件状态，续跑时重新校验（STALE）。
- `tools.bash`：同步执行一条命令，默认超时 120000 ms；`background:true` 转后台任务（上限 2 小时）。
- `tools.sh(command, {tail?=60, cwd?, timeoutMs?})`：跑一条命令，返回 `{code, text}`，`text` 是 stdout+stderr 合并后的最后 `tail` 行；被截掉时首行写“省略前 N 行”。只读模式同 `tools.bash` 一样抛 `POLICY_DENIED`。
- `tools.peek(path, pattern, {context?=2, limit?=20})`：返回文件里匹配 pattern（JS 正则字符串）的行及上下文，带真实行号，不相邻的段落之间用 `--` 分隔。
- `lib`：个人函数库，两层，同名时会话级覆盖全局。全局 `~/.claude/ptc-run/lib.js`（`PTC_RUN_LIB` 可改路径），会话级 `~/.claude/ptc-run/sessions/<会话 id>/lib.js`；会话 id 由钩子从 `$.session.id()` 取出、随 run_code 载荷传给运行器（子代理的调用用它所属主会话的 id），一个会话读不到别的会话的库。程序里 `lib.<名字>(...)` 调用，`lib.help()` 列出全部并标“全局 / 本会话”。
  - 库文件格式是 JSON：`{"version":1,"functions":{"<名字>":{"source":"(tools, ...args) => { ... }","doc":"一行说明"}}}`。`source` 是函数表达式，第一个参数固定是本程序的 `tools`（只读模式的限制同样生效）。
  - `lib.def(name, source, doc, {scope?='session'|'global'})`：在程序里登记快捷函数。先用 `new Function` 校验语法（语法错什么都不写），同名替换，原子写（临时文件 + 改名），登记后本次程序内立刻可用；只读模式抛 `POLICY_DENIED`。每次登记后同目录的 `index.json`（`[{name, doc}]`）同步更新，供其他 mod 只读使用。
  - 两层文件各自出错（不是 JSON、函数语法错）只在输出开头加一行 `[lib]` 警告，程序照常运行；文件不存在则那一层为空。会话目录超过 30 天没人动会在运行时清理（每天最多一次）。
- `tools.parallel([{command,cwd?,timeoutMs?}], {concurrency})`：并发执行多条命令，默认并发 4（最大 16），单次最多 64 条；按输入顺序返回；单项超时不影响其他项，结束时清理子进程。
- `ref.put / page / text / release`：输出超过 8000 字符（可用 `maxChars` 调整，最大 50000）时保留前约 70% 和后 30%，中段落盘成 ref，按需分页读取（`ref.page` 默认每页 50 条、单条上限 16384 字节）。ref 存在系统临时目录 `cc-ptc/` 下，保留 24 小时。
- `ref.store(key,value)` / `ref.load(key)`：按名字存一个 JSON 值，供后面的 `run_code` 直接取用，不用重复打印或重跑。key 限 1–64 位 `[A-Za-z0-9_.-]`，值上限 8 MB；存在同一会话目录下的 `kv-<key>.json`，和 ref 一样保留 24 小时，同名覆盖（原子写）。`ref.store` 返回 `{key,bytes}`；`ref.load` 在不存在或已过期时返回 `undefined`，不抛错。只读模式下只有 `ref.load` 可用。
- `run_code` 整程序默认超时 300000 ms（最大 600000 ms）；`root:"D:/abs/dir"` 可把相对路径、glob/grep 和 bash 的基准目录切到该目录。

错误带 `[CODE]` 前缀和 `nextAction` 提示。

## 要知道的事

- 工具不再延迟加载（`isDeferred: false`），会话首轮即可直接调用，不需要先等工具搜索。
- 带 `expectedRevision` 的 edit/replace 会在系统临时目录 `cc-ptc-locks/` 下加跨进程写锁，保证“校验 revision、写入”在锁内完成；等锁超过约 2 秒报 `LOCKED`，什么都不写；超过 30 秒的锁视为崩溃遗留，可以接管。多文件 replace 按顺序加锁。注意：多文件写入不是事务，中途崩溃时已写的文件不会回滚。
- DSH 方言（delegate 的 ptc-only）里另有 `tools.test`（测试摘要），以及 read 结果的不可枚举字段 `.text` / `.content`；设了 `PTC_RUN_DSH_READ_LIMIT` 时，不带 limit 的读取会截断，并追加一行 `kind:"notice"` 提示。这些都是实验功能，默认不写进提示。
- `run_code` 里的工具调用不经过 Claude Code 的权限确认，等同于给了模型直接读写文件和执行命令的能力。
- 设置环境变量 `PTC_DENY_CREDENTIALS=1` 后，读取类操作会拒绝 `~/.ssh`、`.env`、`*.pem` 等凭据文件（`bash` 不受限）。默认关闭。
- 只读模式（`PTC_RUN_READONLY=1`）下写入和命令类工具被拒绝，但 `tools.read`、`tools.revision`、`tools.glob`、`tools.grep` 等只读工具可用，且只能读取会话工作目录和 `PTC_RUN_READ_ROOTS` 指定的额外可读目录内的文件。
  - `PTC_RUN_READ_ROOTS`（delegate 的 `readPaths` 走这个）是**可读目录列表**：既放宽读，也放宽 `root` 能指向的范围；分隔符同 PATH，Windows 用 `;`、其他平台用 `:`，两种分隔符都接受，盘符后的冒号（`C:/`）不算分隔符。相对路径、不存在的目录会被忽略。
  - `PTC_RUN_RO_ROOTS` 不是可读目录列表：它只列“只读模式下 `run_code` 的 `root` 参数可以指向哪些目录”（会话工作目录之外的额外基准目录），每项是绝对路径，只按 `;` 分隔；它不放宽普通读取，读取范围仍由工作目录和 `PTC_RUN_READ_ROOTS` 决定。
- 需要 ripgrep：默认用 mod 自己目录下的 `bin/rg.exe`（钩子在 `$.plugin.root` 下拼 `bin/rg.exe` 传给 runner，只读模式的 broker 拿同一个值）。解析顺序是 `PTC_RUN_RG` 环境变量（显式覆盖）、钩子传入的 mod 目录下的 `bin/rg.exe`、`~/.claude/skills/ptc-run/bin/rg.exe`、PATH 上的 `rg`；普通路径由 runner 解析，只读路径由 broker 按同一顺序自己解析。仓库的 `ptc-run/bin/rg.exe` 不入库，从 ripgrep 官方 Release 下载放进去即可；`node build.cjs` 生成的文件里不写任何本机绝对路径。
- 沙箱用 Node 子进程执行，需要本机装有 Node。

## 开发

`src/runner.js` 和 `src/register.tpl.ts` 是源码，改完运行 `node build.cjs` 生成 `hooks/register.ts`（mod 运行时没有 fs，runner 以字符串内嵌）。

## 减少请求次数与上下文

- **单步提醒**：只对主会话。一条用户消息到回合结束算一轮；某次模型请求只发了 1 个执行/读取类调用（Bash、Read、Grep、Glob）且没有 run_code、没有派活（Agent、mcp__delegate__*、SendMessage）时，连续计数 +1；记账/计划类（mcp__ctx-mod__*、mcp__ccd_turn__*、mcp__effort-auto__*、ToolSearch）既不算也不打断。达到阈值（选项 `nudgeAfter`，默认 2；环境变量 `PTC_RUN_NUDGE`，0 关闭）注入一行提醒，之后每再多 4 次再提醒一次。run_code、派活、或一次并行 2 个以上执行类调用清零，新一轮也清零。
- **Bash 输出上限**：Bash 工具返回给模型的结果超过 `bashMaxChars`（默认 8000；`PTC_RUN_BASH_MAX`，0 关闭）时，保留开头 60% 和结尾 30%，中间换成一行“省略 N 字符，全文在 <文件>”，全文写到 `~/.claude/ptc-run/overflow/`（超过 200 个文件删最旧的）。主会话和子代理都生效。
- 两项都在工具调用热路径上：任何异常都会吞掉并写到 debug 日志，工具调用本身不受影响。
