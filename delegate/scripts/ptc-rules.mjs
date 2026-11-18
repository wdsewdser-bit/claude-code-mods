import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 执行代理 run_code 工作规则的唯一来源：AGY（run-agy.mjs 拼进 agent 文件）、DS 与 GPT（run-delegate.mjs 拼到
// ptc-only / ptc-readonly 系统提示后面）都从这里取。主会话（CC 本体）的同一套规则写在用户的 CLAUDE.md 里。
// 接口不同：AGY 和主会话是同步的旧接口（tools.read({path}) 返回字符串），DS/GPT 是 await 的 DSH 接口
// （tools.read({file_path}) 返回 { lines }），所以只统一规则，骨架按接口分开写。不要在提示词文件里手工粘贴规则。
const SKELETON = {
  sync: '- 骨架示例（一块内容一个程序）：const hit = tools.grep({...}); const s = tools.read({path, offset, limit}); tools.edit({...}); const t = tools.sh("pytest ...", {tail: 40}); console.log(只打印需要的摘录)。',
  dsh: '- 骨架（一块内容一个程序，接口以上面的 SDK 声明为准，每个调用都要 await）：const hit = await tools.grep({ pattern, path }); const s = await tools.read({ file_path, offset, limit }); await tools.edit({ file_path, old_string, new_string }); const t = await tools.bash({ description: "运行测试", command: "pytest -q 2>&1 | tail -40" }); console.log(只打印需要的摘录)。read 返回 { lines: [{ number, text }] }，grep 返回 { matches: [{ path, lineNumber, line }] }，bash 看 exitCode 和 stdout.text。',
  dshRo: '- 骨架（一块内容一个程序，接口以上面的 SDK 声明为准，每个调用都要 await）：const hit = await tools.grep({ pattern, path }); const s = await tools.read({ file_path, offset, limit }); console.log(只打印需要的摘录)。read 返回 { lines: [{ number, text }] }，grep 返回 { matches: [{ path, lineNumber, line }] }。',
}

/** 工作方式（硬规则）：kind 为 sync（AGY / 主会话接口）、dsh（DS/GPT 可写）、dshRo（DS/GPT 只读）。 */
export const hardRules = kind => [
  '## 工作方式（硬规则）',
  '- 每一轮只调用一次 run_code。一块内容（定位→读→改→验证）写在同一个程序里完成，程序内用变量和 if 判断衔接，不要拆成多轮。',
  SKELETON[kind],
  '- 信息不够时，在同一个程序里继续查，不要停下来一次只问一个。',
  '- 先 grep/glob 定位，再按行号范围读需要的片段，不整读大文件；只打印结论和带行号的摘录，不打印整个结果对象。',
]

/** 交差规则：范围、何时停下、最终报告和 TASK_TERMINAL 行（主会话的 delegate 插件按这一行判定结果）。 */
export const reportRules = [
  '## 规则',
  '- 不提交、不推送、不加依赖、不为让测试通过而削弱测试；不做任务没要求的重构和格式化。',
  '- 遇到这些情况先停下，在报告里写清现状和可选做法，用 TASK_TERMINAL: blocked 结束：改动会超出任务给的范围或路径；有几种做法会实质改变结果而任务没指定；任务前提不成立；要做难以撤销的操作（删除、覆盖、发布）。',
  '- 做完给最终报告（中文，简洁）：结论、改了哪些文件（绝对路径）、怎么验证的（命令和真实输出）、还有什么没验证。只报真实结果，没跑过的检查写明没跑。',
  '- 报告最后单独一行：TASK_TERMINAL: completed（目标完成且必要验证做过）、TASK_TERMINAL: blocked（缺信息或权限）或 TASK_TERMINAL: failed（尝试后失败）。',
]

/** DS/GPT 系统提示末尾追加的整段。 */
export const delegateRulesBlock = kind => [...hardRules(kind), '', ...reportRules].join('\n')

// 系统提示 = 提示词文件 + ptc-rules.mjs 的共享规则（和 AGY 同一来源）。A/B 用的环境变量覆盖文件原样使用。
// 拼好的内容按内容哈希写进临时目录，相同内容复用同一个文件。
export const composedPromptFile = (file, kind, overridden) => {
  if (overridden) return file
  const text = fs.readFileSync(file, 'utf8').trimEnd() + '\n\n' + delegateRulesBlock(kind) + '\n'
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0
  const out = path.join(os.tmpdir(), `delegate-prompt-${kind}-${(h >>> 0).toString(16)}.md`)
  try { if (fs.readFileSync(out, 'utf8') === text) return out } catch {}
  fs.writeFileSync(out, text)
  return out
}
