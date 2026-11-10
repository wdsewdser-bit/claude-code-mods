# effort-auto

主会话专用的自适应思考档位：常驻 `low`，需要判断时模型自己用 `effort` 工具临时升档，判断做完自动回到执行。默认关闭；关闭时不注册工具、不改动任何请求。

子代理（`agentId` 存在的循环）完全不处理：不调档、不计数、不在工具结果里注入提醒、不写日志。

## 配置

manifest 的 `userConfig`（`/config` 里可改），环境变量优先：

| 键 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `EFFORT_AUTO` | `false` | 打开插件。`1/true/yes/on` 为开。 |
| `maxRaises` | `EFFORT_AUTO_MAX_RAISES` | `4` | 一轮里最多接受几次升档，超过的忽略并在工具结果里说明。 |
| `maxHighSteps` | `EFFORT_AUTO_MAX_HIGH_STEPS` | `5` | 升到 high / xhigh 一次最多持续几个请求。 |
| `logPath` | `EFFORT_AUTO_LOG` | 空 | 空表示 `~/.claude/effort-auto/steps-<session>.jsonl`。 |

常驻档固定为 `low`，不设配置项。

## 规则放在哪

规则的**唯一一份全文**就是 `effort` 工具的 description：它随每次请求的工具列表一起发送，位于缓存前缀内，**压缩或换上下文窗口都不会丢**。早期版本在会话第一条用户消息里注入同样一段（`prompt.submit`），压缩后会被摘要掉，已删除；现在同一段规则只出现一次。

代价是这段说明对所有循环可见（工具注册是会话级的），但插件只对主会话的请求、工具报错和日志动手。

## 规则

- **常驻 low**：每一轮（收到新的用户消息）从 `low` 开始。
- **升档**：`effort { level: "medium" | "high" | "xhigh", steps?: 3, reason?: "一句话" }`，从**下一个请求**起生效，`steps` 用完自动回到 `low`；可以和其他工具放在同一条消息里并行调用。
- **强制兜底**：high / xhigh 一次最多 `maxHighSteps`（默认 5）步，超出部分被截断，工具结果里会说明。
- **每轮上限**：一轮最多接受 `maxRaises`（默认 4）次升档，之后的调用被忽略并在结果里说明，档位不变。
- **连续两次工具报错**：不改档位，只在下一步的请求里注入一段提醒（区分误报与真问题），并列出常见误报（权限确认被拒、输出含 error 但退出码为 0、预期中的文件不存在、超时后重试成功、用户中断）。单次报错不提醒；中间有一次成功即重新计数；`deny`（权限拒绝）不算工具失败。
- **不支持 effort 的模型**：`turn.step` 的 `e.effort` 为 `undefined` 时原样通过，什么都不改也不写日志。

## 日志

每一步一行 JSON：

```json
{"at":"2026-10-29T06:00:00.000Z","sessionId":"...","turnId":"...","step":0,"effort":"low","source":"reset","raises":0,"reason":"根因不明","reminder":false,"usage":{"output":144,"thinking_tokens":null}}
```

| 字段 | 说明 |
| --- | --- |
| `at` / `sessionId` / `turnId` / `step` | 时间、会话、轮次、该轮内的步号（`turn.step` 的 `index`）。 |
| `effort` | 这一请求实际用的档位。 |
| `source` | `default` 常驻 low；`tool` 工具升的档；`expire` 升档在这之前到期，本步落回 low；`reset` 本轮第一步；`cap` 本步之前有一次升档因每轮上限被忽略。 |
| `raises` | 到这一步为止本轮已接受的升档次数。 |
| `reason` | 生效中的升档写的理由（可选）。 |
| `reminder` | 这一步的请求是否带着“连续两次报错”的提醒。 |
| `usage` | 该请求的 `output` 与 `thinking_tokens`，拿不到记 `null`。 |

## 测试

```sh
claude plugin test .
claude plugin validate --strict .
tsc --noEmit -p tsconfig.json
```

真机冒烟见 [SMOKE.md](./SMOKE.md)。
