# claude-code-mods

几个 Claude Code mod（function hooks 插件），用来让长会话便宜、不断档。

| mod | 作用 |
| --- | --- |
| [away-autopilot](away-autopilot) | 用户 5 分钟没回复带 `[待确认]` 标记的问题时，提示模型自行决定、继续推进；模型也可以调用 `pause` 工具停下等用户 |
| [cache-keeper](cache-keeper) | 观察 prompt cache 的命中情况，在会话闲置时保活主会话和子代理的缓存，额度快用完时让主会话收尾并在重置后继续，还能跑 5 分钟 / 1 小时 TTL 的对比实验 |
| [cc-restart](cc-restart) | 让会话里的模型自己重启 Claude 桌面版（Windows），重启后用一次性定时任务唤醒发起会话，再由它通知其他正在干活的会话 |
| [delegate](delegate) | 把任务派给 DS（任意 OpenAI 协议供应商）或 GPT（ChatGPT 订阅）执行，支持后台、续用、中途插话和实时面板 |
| [dispatch](dispatch) | 技能：根代理派活规则（分包、模型与档位、执行包写法、验收），配合 delegate 和 dispatch-gate |
| [dispatch-gate](dispatch-gate) | 主会话的软闸门：连续自己干太多就提醒一次、再拦一次；Claude 子代理一小时内派超过 3 个也拦一次。都是软拦截，重试即放行 |
| [effort-auto](effort-auto) | 主会话专用的自适应思考档位：常驻 low，需要判断时模型自己临时升档、判断完自动回落；子代理不处理，默认关闭 |
| [ctx-mod](ctx-mod) | 任务账本、可检索的完整历史、不靠模型摘要的换窗口、子代理冷续用提醒。依赖 cache-keeper |
| [ptc-run](ptc-run) | 程序化工具调用：一段 JS 程序一次完成多步读写、搜索、批量文件操作和并发命令，只把结果放回上下文 |
| [read-dedup](read-dedup) | 重复 Read 去重：文件没变只回一行提示，变了只回差异 |

都是实验性的，针对 Claude Code 2.1.29x 的 Mods API 开发。界面文字和给模型看的说明目前是中文。

## 安装

在终端里的 Claude Code 会话中输入（桌面应用的 Code 标签页里这条命令不可用，但在终端里按用户范围装好后，那里也会加载）：

```
/plugin install cache-keeper --marketplace wdsewdser-bit/claude-code-mods
/plugin install ctx-mod --marketplace wdsewdser-bit/claude-code-mods
```

第一次会问是否添加这个 marketplace，回答 `y`，再选安装范围。

- cache-keeper 装好即生效，选项在安装时的设置页或配置菜单里改。
- ctx-mod 装好后默认不动，要带着环境变量 `CTX_MOD=1` 启动 Claude Code 才启用。

各自的说明见各目录下的 README。

## 要知道的事

- cache-keeper 的保活会发真实的模型请求（每次只让模型回一个 OK），会消耗额度。它有次数上限和额度阈值，默认值见它的说明。
- ctx-mod 把会话的全部内容（包括工具输出）写在 `~/.claude/ctx-mod/` 下，不上传，也不自动清理。
- delegate 依赖本地代理（a2o、CLIProxyAPI），`work` 模式的子代理可以直接改文件、执行命令。
- ptc-run 的 `run_code` 不经过 Claude Code 的权限确认，等于让模型直接读写文件、执行命令。
- cc-restart 的重启会打断所有会话（包括后台子代理），只支持 Windows 上 MSIX 安装的桌面版。
- 这些 mod 都依赖引擎的内部事件，Claude Code 升级后可能需要跟着改。

## 开发

跑全部测试（每个 mod 的 `claude plugin test`，加上插件测试器跑不了的 `node --test` 文件），末尾打印一张汇总表，有失败时退出码为 1：

```
node scripts/test-all.mjs
node scripts/test-all.mjs ptc-run   # 只跑一个 mod
```

单个 mod 用：

```
claude plugin validate <mod>
claude plugin test <mod>
```

read-dedup 的测试（`read-dedup/tests/*.ts`）、`ptc-run/tests/*.mjs` 和 `delegate/tests/*.test.mjs` 用的是 node:test，插件测试器会报 cannot import "node:test"，要直接 `node --test <文件>` 跑；`scripts/test-all.mjs` 已经包含这些。

最后一项是 `scripts/mod-compat-check.ts` 的兼容性检查：把各 mod 用到的引擎事件 / `$` API 名和已安装的 claude 二进制比对，防止引擎升级后钩子静默失效。二进制路径运行时解析（`CLAUDE_BIN` → `where claude` / `which claude` → `npm root -g` 下的 `@anthropic-ai/claude-code/bin/`），找不到时该项显示 skipped、不算失败；`node scripts/test-all.mjs --no-compat` 可跳过。

## 数据清理

这些 mod 的数据只增不减。`scripts/prune-data.mjs` 按保留期清理，默认只列清单（dry-run），加 `--apply` 才真正删除：

```
node scripts/prune-data.mjs                        # 看看会删什么
node scripts/prune-data.mjs --apply                # 真的删
node scripts/prune-data.mjs --days 14 --tmp-hours 24 --only ctx-mod,tmp
```

| 数据 | 规则 |
| --- | --- |
| `~/.claude/ctx-mod` | 删最后写入早于保留期（默认 30 天）的 GUID 会话目录；根下的 `costly.json`、`probe-*.jsonl` 等不动 |
| `~/.claude/delegate` | 删早于保留期、已结束（非运行中）的 `jobs/<id>/` 及其 `results/<id>.md`；key、配置、keepalive、venv、usage 账本和认不出归属的文件一律不删 |
| `~/.claude/cache-keeper` | 只删 `raw/events-*.jsonl` 和 `raw/run-*.json`；`cache-events.csv`、`experiment-summary.json`、`cache-report.md` 不动 |
| 临时目录 `cc-ptc` / `cc-ptc-locks` | `cc-ptc` 下 mtime 早于 `--tmp-hours`（默认 48 小时）的条目；`cc-ptc-locks` 里超过 1 天的陈旧锁 |

参数还有 `--ctx-days` / `--delegate-days` / `--cache-days` / `--json`；保留期小于 1 会被拒绝。只删数据根内的路径，链接和目录联接不跟进，删不掉的单项记录后继续、最后非零退出。

## 许可

MIT，见 [LICENSE](LICENSE)。
