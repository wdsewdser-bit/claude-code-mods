# claude-code-mods 待办总表

来源：《claude-code-mods 全系统优化审查与实施路线图》v1.0（2026-10-19）、作者回应修订（同日：read_many 降为 P2，fanout 暂缓，取消 Project Memory，代码精简和输出过滤列为 PTC 首要目标）及 PTC 实验报告。
规则：每项先写验收再动手；涉及费用的改动必须过 A/B 闸门（Haiku 和 DS 各 n≥10，配对、随机顺序、缓存健康窗口），不达标就回退，并在本表记录结论。
状态：todo / doing / done / dropped（dropped 要写原因）。

## 第 1 批：小修（确定要做）
| ID | 内容 | 验收 | 状态 |
|---|---|---|---|
| PTC-01 | register.tpl.ts 改 isDeferred: false，首轮加载 run_code（用户全局“始终加载”设置对它没生效） | 新会话首轮工具清单里有 run_code | done（2026-10-19 无头新进程实测：init 工具清单含 run_code，未经 ToolSearch 直接调用成功） |
| DOC-01 | README 默认值（6000→8000 等）和 register.tpl.ts、runner.js 对齐；build 后检查生成文件无差异 | grep 一致；`node build.cjs` 后 git diff 为空 | done |
| PTC-06 | read 返回 revision（内容 hash）；edit/replace 接受 `expectedRevision`，跨 run_code 也能做 STALE 检查 | 跨调用过期修改必定报 STALE，什么都不写 | done（runner 两进程用例 8/8；新进程 tools.revision 实测可用） |
| CTX-02 | history search 在行内没命中时扫外置 big-*.txt，命中给出 seq 和绝对 offset | 在 overflow 尾部埋唯一词能搜到 | done（单元测试覆盖；真实超 20 万字符记录未实测） |
| CTX-01 | 测量写放大：logicalNewBytes / physicalBytesWritten / writeCalls | 跑一个长会话，给出 WAF 数值 | done（首个数据点：小会话逻辑 30.7KB / 实际 213KB，WAF=6.93，写盘 12 次、合并 5 次；分片越大 WAF 越高，CTX-01b 值得做） |

## 第 2 批：实验性功能（大胆试，A/B 决定去留）
| ID | 内容 | 假设 / 闸门 | 状态 |
|---|---|---|---|
| PTC-09 | 先分析：从实验转录里抽出模型实际写的 run_code 程序（E6 有 626 个），统计重复模板（路径处理、行号格式化、grep 后筛选、测试输出解析等）和每段的输出 token。按“净节省 = 少生成和少回传的成本 − 新增说明和执行成本”排出候选 SDK 原语 | 只读分析，产出候选清单，决定 PTC-02/05 是否做、怎么做 | done（8277 个程序，95% 来自 DS 的 delegate PTC SDK，方言为 file_path/lines[]；报告 D:\ptcab\scratch\ptc09
eport.md。代码侧样板下沉的总天花板约 12% 输出 token，典型会话净省 DS $0.0001、Haiku $0.002；更大的杠杆在回传，其中 read 占回传的 80%。候选按序：test 摘要、带行号文本、紧凑 read、grep 文本、bash 参数可选、read_many（排最后）） |
| OPS-01 | （提前）统一成本口径和 A/B 夹具，复用 D:\ptcab：按未命中/缓存写/缓存读/输出分列，Haiku 和 DS 各 n≥10 | 后面每项都依赖它 | todo |
| PTC-02 | （P2，看 PTC-09 结果）`tools.read_many`：按顺序返回 path/revision/totalLines/coveredRange/truncated/fullRef，带总输出预算 | 多文件只读题：费用中位数 ≤ 现状，重读次数下降 | todo（PTC-09 排第 6，净收益最低） |
| PTC-04 | 统一 Outcome `{status,data,coverage,refs,diagnostics,sideEffects}`，用适配层包装，不破坏旧返回 | 错误/超时/部分成功的报告准确率；费用不升 | todo |
| PTC-05 | pytest/vitest 只打印失败摘要（优先解析 JUnit/JSON），完整日志用 ref | 跑测试题：输出字符数下降，质量不降 | 未过闸门，提示已回退（2026-10-19 DS flash task3 A/B 各 n=10：费用中位数 A $0.0167 / B $0.0184（+10%，置换检验 p=0.21），调用 28→31，评分 8/8 对 7.9；测试那一步回传少 33%（每次运行约 11.5K 字符），但总回传没降。SDK 里的 tools.test 和 read .text 保留，没写进提示就没有成本；B 版提示存为 D:\ptcab\scratch\ptc-only-system.v6-test.md，数据见 abtest/summary-run1.txt） |
| PTC-10 | 未过闸门（2026-10-19 两轮 A/B，task3，DS flash，每组 n=10）。第 1 轮：R（150 行，只给 more 字段）费用 +9%，调用 24.5→29.5；原因是模型只打印 lines，看不到 more，误以为已经读完，又多读了几次。第 2 轮改为在 lines 末尾加提示行：R2（150）费用 +14%，p=0.08，回传反而更多；R3（300）费用和对照持平（p=0.70），但有 1 次失控到 97 轮后超时。结论：截断 read 只会把重复读换成补读，省不下钱。runner 里的开关 PTC_RUN_DSH_READ_LIMIT 保留，默认关闭。提示存档在 D:\ptcab\scratch\ptc-only-system.R*.md，数据在 abtest/summary-run3.txt、summary-run4.txt |
eport.md）：read 占回传 54–65%，其中 97% 是整块打印；30–44% 的 read 不带 limit；超过 200 行的读取占 read 字符的 74%；重叠 ≥80% 的重复读占 54%（与编辑无关的占 32%）；读大块后又 grep 同一文件的占 24%。候选方案：无 limit 时默认 150 行并提示剩余行数（预计省总回传 11–16%）、大文件先返回结构摘要、会话内已读区间去重、先 grep 后带 offset 读、行号前缀按需 | 下一步：先单独 A/B“默认 150 行”这一项 | todo |
| PTC-05b | v6 的三个缺陷（PTC-10 发现）：tools.test 在 workdir 无效或启动失败时返回空的 unknown，没有错误信息和 tail（XB4 复现，用的是 /tmp/... 的 msys 路径）；提示示例 3 对带行号的 .text 用 ^ 锚定正则，结果失效；fullOutput 是文件路径，却被当成内容切片（XB7）。修好后再重做 A/B（B 组多出的 42 次调用里，这三处能解释 10–16 次；差异总体不显著，p=0.195） | 缺陷已修（error 兜底、msys 路径、outputPath），但三轮 A/B 都比对照贵：v6 +10%，v6b +28%，T2（只改 test、去掉 .text）+17%，p=0.009 显著。T2 的输出 token 从 17.3K 增到 20.3K，回传也增加。结论：不要把 tools.test 写进 DS 提示。SDK 里保留实现，不写进提示就没有成本 | dropped（提示层） |
| PTC-07 | grep 结果 queryRef 分页 + 快照指纹，文件变了标 snapshot_stale | 大搜索翻页不重跑 rg | todo |
| PTC-03 | （暂缓，不删）`tools.fanout` 有界并发（只读优先，bash 默认串行除非 readOnly），单项超时、取消、部分成功 | 并发/取消/partial 测试通过；混合任务耗时下降 | todo |
| PTC-08 | `flow` DAG（dependsOn） | 先看 PTC-03 后模型是否常写依赖逻辑 | todo |
| CTX-01b | 按 WAF 结果选追加写或小 segment + manifest | WAF 实降，迁移前后 seq 和 SHA-256 一致 | todo（A-04 建议改为追加写；要先确认 Mods API 能可靠追加） |
| CTX-03 | context preview：换窗前检查覆盖清单；held.json 显式 recover | 换窗漏项可检出 | todo |


> A/B 观察（PTC-05）：DS 每次运行的费用中，未命中输入（约 60K token，主要来自回传内容）约占一半，缓存读约占 20%，输出约占 30%。所以要降成本，主要是减少回传，尤其是 read 的回传（占 80%）。

> 三轮 A/B 的教训：对照组在三轮之间的费用中位数是 $0.0167、$0.0141、$0.0149，波动在 ±10% 左右，和各项改动的效应量级相同。task3 的评分已经饱和（全是 8/8），这道题对“省钱型”改动不敏感。下一次 PTC 实验应换成 read 更多、文件更大的题，并且每组 n≥20。

## 审查 v1.2 后的下一批（2026-10-19）
| ID | 内容 | 验收 | 状态 |
|---|---|---|---|
| A-01 | PTC-01 首轮成本：用真实 usage 对比 isDeferred true 和 false 时首个请求的输入、缓存写和缓存读，覆盖主会话和子代理 | 给出新增的 token 数；重复会话的前缀命中稳定 | done（haiku 新进程：false 时前缀 24663–24677，true 时 22485，多 ~2.2K token；重复会话全命中） |
| A-02 | PTC-06 竞态：两个 writer 都通过 revision 检查后同时提交，确认不会静默覆盖；没办法做到原子时，在文档里写明限制 | 并发压力测试 | done（加锁前 200 次并发有 103 次静默覆盖，加锁后为 0；锁目录 cc-ptc-locks，等锁 2 秒报 LOCKED，30 秒可抢占；报告 D:\ptcab\scratchatchA\ptc-report.md） |
| A-03 | CTX-02 规模：100、1000、10000 个 overflow 文件，测命中与未命中时的 p50/p95、损坏或缺失文件的情况、读盘字节数 | 延迟可控，不崩溃 | done（正确性：偏移抽样 20/20 正确；缺失、截短、不可读的 part 跳过并提示，之前不可读会让搜索 reject，已修。性能：10000 条超长记录时 p95 为 7–8 秒，但现实里几乎没有超长记录，暂不建索引） |
| A-04 | CTX-01 采样：短会话、中会话、接近 2 MiB 分片的长会话，分别记录 WAF | 画出 WAF 和分片体积的关系 | done（基准结果：逐条落盘时长会话 WAF=182，每 50 条合并时 8.85；按分片大小分段，0–256K 为 26，1–2M 为 307。建议 CTX-01b 用追加写；报告 batchA\ctx-report.md） |
| A-05 | 截断提示行改成不污染 lines（例如 kind:"notice"，或只出现在打印出来的文本里）；开关保持默认关闭 | 编辑和拼接时不会把提示行当成源码 | done（提示行改为 kind:"notice"、number:null，新增 content getter；默认关闭） |
| OPS-02 | 实验完整性：result/grade 和副本放在不同目录；自动统计启动数、完成数、超时数；同时报告均值、中位数和 CI；超时样本计入 | 统计可以复现 | todo |
| PTC-11 | 短读取策略提示（只改提示，不动 API），换成读取量大、评分不饱和的题，按时间块配对 | 质量不降，净费用下降 | todo |

## 第 3 批：观测与缓存
| ID | 内容 | 状态 |
|---|---|---|
| CACHE-01 | cache explain：工具清单 hash、系统提示版本、插件集 hash、未命中原因（observed/inferred/unknown） | todo |
| CACHE-02 | 保活 shadow 模式：记录 would_have_keepalive 和实际恢复间隔，算净收益 | todo |
| DEDUP-01 | read-dedup 回归：外部修改、CRLF、软链接、大小写路径、重叠区间；记录 savedChars | todo |
| SEC-01 | 只读 broker：junction、网络出口、resume 继承配置 | todo |

## 已决定不做
| ID | 原因 |
|---|---|
| MEM-01 Project Memory | 与 Claude Code 自带 auto-memory 重复 |
| Rust 执行器 | 没有证据显示 Node I/O 是瓶颈 |
