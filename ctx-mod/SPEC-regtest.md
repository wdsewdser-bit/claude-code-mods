# 任务说明：给 register.ts 写套件测试

只新建一个文件：`M\tests\register.test.ts`。不要改其他任何文件。如果你认为 `register.ts` 有缺陷，写进报告，不要去改它。

M = `C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod`

## 先读（只读）

- `M\hooks\register.ts`：被测对象。它是 Claude Code mod 的引擎接线层，把引擎事件接到 `hooks\lib\session.ts` 的 Session 上。
- `M\phase0\probe.test.ts.txt`：一份同一个 mod 早期的套件测试，展示了怎样用 `on(...)` 在测试里充当引擎底层、怎样用 `$` 触发事件、怎样用 `mock.clock` 和 `mock.env`。照它的形状写。
- `C:\Users\yadaz\.claude\skills\cache-keeper\tests\world.ts`：另一个 mod 的测试底座，更完整，可以借鉴它提供底层的方式（`store`、`fs`、`session.usage`、`turn.step`、`turn.complete`、`prompt.submit` 等）。
- 测试套件的类型：在 `M\.claude-plugin\types\claude-code\index.d.ts` 里搜索 `claude-code/testing`、`export type Engine`、`MockClock`，读命中处前后几十行。不要通读这个文件（约 1.4 万行）。

## 测试套件的要点

- `import { expect, mock, test } from 'claude-code/testing'`，测试函数签名是 `async ($, on) => {}`。
- 测试里用 `on('事件名', handler)` 注册的钩子位于被测 mod 的下面，充当引擎：它返回什么，mod 的 `next(e)` 就得到什么。
- `$` 是引擎接口，用来触发事件，例如 `$.session.start({ cwd: '/work', surface: null, isInteractive: true })`、`$.session.compact(...)`、`$.session.append(...)`、`$.tool.call(...)`、`$.turn.complete(...)`、`$.prompt.submit(...)`、`$.command.run(...)`。入参形状按类型定义；类型太严的地方可以 `as never`。
- 没有 `toBeCloseTo`。可用的断言以类型定义为准。
- 运行环境没有 Node：不能用 fs、process、console、setTimeout。

## 被测行为的关键事实

- 总开关：`session.start` 时读环境变量 `CTX_MOD`，等于 `'1'` 才启用。测试里用 `mock.env(on, { CTX_MOD: '1', USERPROFILE: 'C:\\Users\\someone' })`。
- 数据目录是 `C:\Users\someone/.claude/ctx-mod/<会话id>/`，文件经 `$.fs.write` 写出。测试里用内存 Map 接住 `fs.write`，`fs.read` 读不到时返回 `{ deny: 'ENOENT: …' }`。引擎可能把路径规范成反斜杠，断言路径时用正则匹配文件名结尾。
- 自有工具的全名是 `mcp__ctx-mod__context`、`mcp__ctx-mod__ledger_append`、`mcp__ctx-mod__ledger_read`、`mcp__ctx-mod__history`。
- 用户消息要先经过 `prompt.submit`（来源 `{ kind: 'composer' }` 或 `{ kind: 'sdk' }`），再经过 `session.append`（door 为 `'prompt'`），mod 才会把它认成真人请求。两步的文本要相同。
- 工具结果行经过 `session.append`（door 为 `'tool-result'`）时会被记录并在内容末尾加 `[#编号]`。
- 换窗口时 mod 的 `session.compact` 钩子不调 `next`，直接返回一条消息；底层的 `session.compact` 不会被调用。

## 要写的测试

尽量覆盖下面这些。某一项在套件里触发不了，就跳过并在报告里说明原因，不要为了凑数写无意义的断言。每个测试只验证一件事，名字用英文短句。

1. 未设 `CTX_MOD`：一次压缩原样落到底层的 `session.compact`，并且没有任何文件被写到 ctx-mod 的数据目录。
2. 启用后，`session.start` 注册了四个工具和 `ctx-mod` 命令（在测试的 `tool.register` 和 `command.register` 底层里收集名字）。
3. 启用后，带 `agentId` 的 `ledger_append` 调用得到 `isError` 结果，文本说明只能由主会话调用。
4. 启用后，一条 door 为 `'tool-result'` 的行经过 `session.append` 后，返回的行内容末尾带 `[#1]`（或当时应有的编号），且内存文件系统里出现了以 `history-w001.jsonl` 结尾的文件并含该工具结果的文本。
5. 启用后，一条真人请求（先 `prompt.submit` 再 `session.append`）被认成真人请求：随后不带 `request_ref` 的合法 `ledger_append` 成功（结果文本含"已记录"），且以 `ledger.jsonl` 结尾的文件被写出。
6. 启用后，没有先经过 `prompt.submit` 的 `'prompt'` 行（来源 `{ kind: 'unclassified' }`）不被认成真人请求：不带 `request_ref` 的 `ledger_append` 返回校验失败。
7. 启用后，`history` 工具带 `tool_name` 过滤能搜到对应工具的结果；并且信封里的 `tool` 字段不会被当成过滤条件（即不带 `tool_name` 时能搜到其他工具的结果）。
8. 启用后，模型调 `context` 的 `new` 被批准（把底层 `session.usage` 的 tokens 设到 urgent 级别，并先有一条真人请求和一条账本记录），之后别的工具调用得到 `deny`。
9. 启用后，`trigger` 为 `'auto'` 且账本新鲜的压缩：返回的 `messages` 只有一条，文本里含真人请求原文和账本里的 `next_step`；底层的 `session.compact` 没有被调用；以 `handoff-w002.md` 结尾的文件被写出。
10. 启用后，`trigger` 为 `'auto'` 但账本不新鲜的压缩：底层被调用，返回的 `messages` 比底层给的多一条。
11. 启用后，第 8 项的批准之后触发一次主会话的 `turn.complete`（`reason: 'answer'`）：mod 调用了 `command.run`（命令名 `compact`）。在测试底层接住 `command.run` 并记录；如果套件要求底层的 `command.run` 再去触发 `session.compact` 才能让流程继续，就在底层里调用 `$` 做这件事，做不到就只断言 `command.run` 被调用。

## 验证（必须真的跑）

1. `claude plugin test "C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod"`：全部通过。
2. `npx --yes -p typescript tsc -p "C:\Users\yadaz\.claude\dev-mods\91b2aebc-5b5e-4cc3-8854-67d53392c94c\ctx-mod"`：0 错误。

禁止运行 `claude -p` 或其他 claude 命令，禁止 git 操作。

时间约 9 分钟。先写出共用的底座（world）和第 1 到 4 项，跑通并落盘；再逐项往后加，每加一两项就跑一次测试并落盘。到第 7 分钟左右无论做到哪都停下来汇报。一个测试如果反复调不通，先用 `test.skip` 或注释标出并写明卡在哪，不要删掉也不要放宽成无意义的断言。

## 返回

第一行 `TASK_TERMINAL: completed|blocked|failed`。然后：

- 写了哪几项、每项是否通过
- 没写或跳过的项及原因
- 两条验证命令的实际结果（贴输出尾部）
- 写测试时发现的 `register.ts` 的疑似缺陷（逐条，带行号和触发方式）
