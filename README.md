# claude-code-mods

几个 Claude Code mod（function hooks 插件），用来让长会话便宜、不断档。

| mod | 作用 |
| --- | --- |
| [cache-keeper](cache-keeper) | 观察 prompt cache 的命中情况，在会话闲置时保活主会话和子代理的缓存，额度快用完时让主会话收尾并在重置后继续，还能跑 5 分钟 / 1 小时 TTL 的对比实验 |
| [dispatch-gate](dispatch-gate) | 主会话的软闸门：连续自己干太多就提醒一次、再拦一次；Claude 子代理一小时内派超过 3 个也拦一次。都是软拦截，重试即放行 |
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
- ptc-run 的 `run_code` 不经过 Claude Code 的权限确认，等于让模型直接读写文件、执行命令。
- 这些 mod 都依赖引擎的内部事件，Claude Code 升级后可能需要跟着改。

## 开发

```
claude plugin validate cache-keeper
claude plugin test cache-keeper
claude plugin validate ctx-mod
claude plugin test ctx-mod
```

## 许可

MIT，见 [LICENSE](LICENSE)。
