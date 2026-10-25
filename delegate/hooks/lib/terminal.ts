// 任务终态与实际模型的解析。纯函数，不 import 任何东西：runner 用它组装结果，测试也直接 import 它。

// 任务自己的结论写在最终文本里：TASK_TERMINAL: completed|blocked|failed。取最后一次出现，允许前后有 markdown 的
// ** 或反引号；没找到就是 null（不是空串）。ok 只代表 CLI 没报错，两者不要混。
const TERMINAL_RE = /TASK_TERMINAL:\s*[*`_]*\s*(completed|blocked|failed)/gi

export const terminalOf = (text: unknown): string | null => {
  if (typeof text !== 'string') return null
  let found: string | null = null
  for (const m of text.matchAll(TERMINAL_RE)) found = (m[1] ?? '').toLowerCase()
  return found
}

// 每条 assistant 消息里实际作答的模型，按首次出现顺序去重（一次运行可能换过模型）。
export const addModel = (models: string[], o: { message?: { model?: unknown } } | null | undefined): string[] => {
  const model = typeof o?.message?.model === 'string' ? o.message.model.trim() : ''
  if (model !== '' && !models.includes(model)) models.push(model)
  return models
}
