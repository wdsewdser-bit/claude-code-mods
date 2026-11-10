# 主会话冒烟（真 claude-opus-5-5）

本文件是给**你本机**用的：这里的沙箱会把模型映射成别的模型，跑出来的结果不算数，所以单测只覆盖逻辑，真机由你跑。

## 1. 起会话

不装插件、不动 `~/.claude` 的配置，只用 `--plugin-dir` 临时加载：

```bash
cd /d/ptcab/scratch/effort-auto
export EFFORT_AUTO=1
export EFFORT_AUTO_LOG="D:/ptcab/scratch/effort-auto/smoke/effort-steps.jsonl"
rm -f "D:/ptcab/scratch/effort-auto/smoke/effort-steps.jsonl"
claude --plugin-dir . --model claude-opus-5-5
```

PowerShell 等价：

```powershell
cd D:\ptcab\scratch\effort-auto
$env:EFFORT_AUTO = "1"
$env:EFFORT_AUTO_LOG = "D:/ptcab/scratch/effort-auto/smoke/effort-steps.jsonl"
if (Test-Path $env:EFFORT_AUTO_LOG) { Remove-Item $env:EFFORT_AUTO_LOG }
claude --plugin-dir . --model claude-opus-5-5
```

不设 `EFFORT_AUTO_LOG` 时，日志在 `~/.claude/effort-auto/steps-<sessionId>.jsonl`（只是日志文件，不是配置）。

## 2. 四段对话

| # | 在会话里发的 | 该看到什么 |
| --- | --- | --- |
| 1 | `把你 effort 工具的 description 原样贴出来，一字不改` | 整段规则：三档的升降条件、用法、两个上限（默认 `high 及以上一次最多 5 步；每轮最多 4 次升档`） |
| 2 | `帮我定：数据层用 SQLite 还是继续 JSON 文件？给结论和理由` | 出现 `source: "tool"` 的行，`effort` 是 `high`（或 `medium`），带 `reason`；结论给出后下一步回到 `low` |
| 3 | `连续读两次 D:/ptcab/scratch/effort-auto/smoke/missing.txt，然后告诉我发生了什么` | 档位不变；第二条工具结果里能看到"连续两次工具报错…"；下一步日志行 `reminder: true` |
| 4 | `用 effort 把档位升到 high，steps 写 50，然后连续读三个文件` | `effort: "high"` 最多 5 行，然后 `effort: "low"` 且该行 `source: "expire"` |
| 5 | `用 Agent 工具派一个子代理读 README.md 并总结` | 子代理那几步**不产生日志行**；主会话照常 |

第 4 段顺带能验"每轮升档上限"（默认 4 次）：让模型多升几次，第 5 次会收到"本轮已升档 4 次，达到上限…"的工具结果，档位不变，下一步 `source: "cap"`。

第 1 段之所以能验规则，是因为规则就住在工具 description 里——**压缩或换窗口后**再问一次同一句，仍应一字不差地贴出整段（旧版注入的规则这时通常已经没了）。

## 3. 看日志

bash：

```bash
cd /d/ptcab/scratch/effort-auto
wc -l smoke/effort-steps.jsonl
head -3 smoke/effort-steps.jsonl
# 每步的档位与来源
python -c "import json;[print(r['step'], r['effort'], r['source'], r['reminder'], (r.get('usage') or {})) for r in map(json.loads, open('smoke/effort-steps.jsonl', encoding='utf-8'))]"
```

PowerShell：

```powershell
Get-Content D:/ptcab/scratch/effort-auto/smoke/effort-steps.jsonl |
  ForEach-Object { $r = $_ | ConvertFrom-Json; "{0} {1,-7} {2,-8} reminder={3}" -f $r.step, $r.effort, $r.source, $r.reminder }
```

要确认的字段：

- `effort`：`low` 是常态；升档时是 `medium`/`high`/`xhigh`，且只持续 `steps` 行。
- `source`：只应出现 `reset` / `default` / `tool` / `expire` / `cap` 五种；每轮第一行是 `reset`。
- `reminder`：第 3 段之后紧跟的那一步为 `true`，其余为 `false`。
- `reason`：升档那几行带着模型写的一句话。
- `usage.output` > 0；`usage.thinking_tokens` 若是 `null`，说明该引擎的 `TurnUsage` 没有这个字段（记录逻辑本身没问题）。
- 日志行数 == 主会话的模型请求数；子代理的请求不出现。

## 4. 验证子代理没被“处理”

规则现在住在工具 description 里，工具是会话级注册，子代理同样看得到这段说明（这是把规则放进工具说明的代价，换来压缩不丢）。要验的是**插件对子代理不动手**：

```bash
grep -c '"turnId"' smoke/effort-steps.jsonl   # 只应有主会话的请求行
```

- 派子代理那一段前后，日志行数只按主会话的步数增长，子代理跑了几步都不会多出行；
- 让子代理连读两次不存在的文件：主会话的下一条工具结果里**不会**因此多出“连续两次工具报错”的提醒（计数只记主会话的工具调用）；
- 子代理若真去调 `effort`，会收到 `effort 只作用于主会话：子代理不升档。` 的报错，档位不变。

## 5. 关闭时什么都不发生

```bash
unset EFFORT_AUTO          # 或不设
claude --plugin-dir . --model claude-opus-5-5
```

- 工具列表里没有 `effort`，因此也没有那段规则；
- 不生成日志文件；
- 问模型"你的 effort 工具"应回答没有这个工具。
