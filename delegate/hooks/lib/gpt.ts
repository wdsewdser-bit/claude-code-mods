/** delegate_gpt: GPT through the local CPA (CLIProxyAPI) proxy, billed to the ChatGPT subscription.
 *  Nothing here touches the flash/pro slots: the runner asks ensure_cpa.py for the endpoint and key. */

export const GPT_MODELS = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol'] as const
export type GptModel = (typeof GPT_MODELS)[number]

export const GPT_DEFAULT_MODEL: GptModel = 'gpt-6.1-sol'

export const isGptModel = (v: unknown): v is GptModel =>
  typeof v === 'string' && (GPT_MODELS as readonly string[]).includes(v.trim())

/** Empty means the default; anything else unknown is refused rather than silently swapped for another model. */
export const gptModelOf = (v: unknown): GptModel | { error: string } => {
  const name = typeof v === 'string' ? v.trim() : ''
  if (name === '') return GPT_DEFAULT_MODEL
  if (isGptModel(name)) return name

  return { error: `未知的 GPT 模型「${name}」，可用：${GPT_MODELS.join('、')}` }
}

/** The line the person sees for a call. Never sent to the model. */
export const gptLabel = (model: string, flags: { background: boolean; work: boolean }): string =>
  `gpt · ChatGPT 订阅 / ${model}${flags.background ? ' · 后台' : ' · 前台'}${flags.work ? ' · 可改文件' : ' · 只读'}`

export const gptToolDescription = (): string =>
  [
    '把一个自包含的任务交给 GPT 去做，它在独立进程里有自己的上下文和读文件、搜索（可选改文件、跑命令）的工具，只把最终文本返回给你。额度走 ChatGPT 订阅，不占 Claude 额度。',
    '用来做较难的任务：后端实现、代码审查、需要多条线索对照的排查。它通过本机的 CPA 代理连 ChatGPT，用到时 runner 会自动把 CPA 拉起来，第一次调用可能多等几秒。',
    "- model 默认 gpt-6.1-sol，日常都用它；只有真正高难的问题（想不透的根因、难判的设计取舍）才传 model: 'gpt-6-astra'，它更慢，不要当默认。",
    '任务说明要自包含：写清目标、允许读写的路径、已知事实、期望的输出格式。它看不到你的对话。',
    '返回里的 agent ID 可以填进 resume 继续同一个代理（它记得之前读过的内容和 mode，比新建便宜、不用重讲背景）；resume 没传 mode 就沿用该代理上次的 mode，显式传则以传入的为准；换任务或上下文已很长时才新建。',
    'background=true 立即返回，任务做完后会自动通知你（结果在通知里）：你手头有别的事可做、任务较久、或要同时派几个互不依赖的包时用；你下一步就依赖它的结果时用默认的前台，别用后台再干等。',
    '轮数和时长基本不设限（只有 2 小时的防卡死兜底），不用为了怕超时把任务拆碎；预计超过几分钟的任务用 background=true。万一超时，返回里会带 agent ID 和它做到哪：先核对文件，没做完就 resume 续做，不要原样重试。汇报要求它精简：结论、改了哪些文件、测试结果。',
    'mode=read（默认）只读；mode=work 可改文件和跑命令（它只用一个 run_code 工具，在程序里批量调用 read/edit/bash 等），仅在任务明确需要改动时用。',
    "read 模式默认也只用一个只读的 run_code（默认只能读 cwd 内的文件，不能写文件、跑命令），在程序里批量读取、检索后汇总，另外带一个 WebFetch 可以读网页；要读 cwd 以外的目录时，把它们列进 readPaths（绝对目录，只放宽读），不必改用 ptc:'off'；只有 readPaths 也覆盖不了（比如需要别的工具）才传 ptc:'off' 改用原生 Read/Grep/Glob/WebFetch。",
  ].join('\n')
