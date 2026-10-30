export type Provider = { id: string; name: string }
export type Tier = 'flash' | 'pro'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'off'
export type Slot = { providerId: string; modelId: string; effort?: Effort }
export type Config = {
  providers: Provider[]
  slots: Record<Tier, Slot | null>
  /** delegate_gpt 的来源：'' 或缺省 = ChatGPT 订阅；否则是 CPA 供应商 id（按 'id/model' 路由）。 */
  gptSource?: string
  /** GPT 模型名的显示：true（默认）只显示裸模型名，false 显示 '供应商id/模型'。发给 CPA 的 model 一直带前缀。 */
  gptHidePrefix?: boolean
}

export const TIERS: readonly Tier[] = ['flash', 'pro']

export const SEED: Config = {
  providers: [
    {
      id: 'command',
      name: 'Command Code',
    },
  ],
  slots: {
    flash: { providerId: 'command', modelId: 'deepseek/deepseek-v4.1-flash' },
    pro: { providerId: 'command', modelId: 'deepseek/deepseek-v4-pro' },
  },
  gptSource: '',
  gptHidePrefix: true,
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export const isEffort = (v: unknown): v is Effort => v === 'low' || v === 'medium' || v === 'xhigh' || v === 'high' || v === 'max' || v === 'off'

const slotOf = (raw: unknown, providers: readonly Provider[]): Slot | null => {
  if (!isRecord(raw)) return null
  const providerId = text(raw.providerId)
  const modelId = text(raw.modelId)
  if (modelId === '' || !providers.some(p => p.id === providerId)) return null

  return isEffort(raw.effort) ? { providerId, modelId, effort: raw.effort } : { providerId, modelId }
}

/** Reads whatever the store held back into a valid Config, seeding when empty. */
export const normalize = (raw: unknown): Config => {
  if (!isRecord(raw)) return structuredClone(SEED)
  const providers: Provider[] = []
  for (const one of Array.isArray(raw.providers) ? raw.providers : []) {
    if (!isRecord(one)) continue
    const id = text(one.id)
    if (id === '' || providers.some(p => p.id === id)) continue
    providers.push({ id, name: text(one.name) || id })
  }
  const slots = isRecord(raw.slots) ? raw.slots : {}
  // A gpt source that pointed at a removed provider falls back to the subscription, like a slot.
  const wanted = text(raw.gptSource)

  return {
    providers,
    slots: { flash: slotOf(slots.flash, providers), pro: slotOf(slots.pro, providers) },
    gptSource: wanted !== '' && providers.some(p => p.id === wanted) ? wanted : '',
    // 只有明确写了 false 才显示前缀；旧配置没有这个字段，按默认（隐藏）处理。
    gptHidePrefix: raw.gptHidePrefix !== false,
  }
}

export const idOf = (name: string, taken: readonly string[]): string => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'provider'
  let id = base
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`

  return id
}

export type Result = { config: Config; error?: string }

export const addProvider = (config: Config, input: { name: string }): Result => {
  const name = input.name.trim()
  if (!name) return { config, error: '名称不能为空' }
  return { config: { ...config, providers: [...config.providers, { id: idOf(name, config.providers.map(p => p.id)), name }] } }
}

/** Build a migration without mutating the original: the caller persists only after all CPA saves succeed. */
export const migrationPlan = (raw: unknown): { config: Config; providers: { id: string; name: string; protocol: 'chat'; baseUrl: string; key: string; models: string[] }[] } => {
  const config = normalize(raw)
  const providers = []
  if (isRecord(raw) && Array.isArray(raw.providers)) for (const p of raw.providers) {
    if (!isRecord(p) || !text(p.url) || !text(p.key) || !config.providers.some(x => x.id === text(p.id))) continue
    providers.push({ id: text(p.id), name: text(p.name) || text(p.id), protocol: 'chat' as const,
      baseUrl: text(p.url).replace(/\/chat\/completions\/?$/, ''), key: text(p.key),
      models: [...new Set(TIERS.map(t => config.slots[t]).filter(s => s?.providerId === text(p.id)).map(s => s!.modelId))] })
  }
  return { config, providers }
}

// A slot that pointed at a removed provider becomes empty: normalize drops it.
export const removeProvider = (config: Config, providerId: string): Result => ({
  config: normalize({
    ...config,
    providers: config.providers.filter(p => p.id !== providerId),
  }),
})

const findProvider = (config: Config, wanted: string): Provider | undefined => {
  const w = wanted.trim().toLowerCase()

  return config.providers.find(p => p.id === w || p.name.toLowerCase() === w)
}

/**
 * Points a tier at a provider and a model id. An empty field keeps what the
 * slot already has, so changing only the model id (or only the provider) works.
 */
export const setSlot = (
  config: Config,
  tier: Tier,
  input: { provider: string; modelId: string; effort?: string },
): Result => {
  const current = config.slots[tier]
  const provider =
    input.provider.trim() === ''
      ? config.providers.find(p => p.id === current?.providerId)
      : findProvider(config, input.provider)
  const modelId = input.modelId.trim() || current?.modelId || ''
  if (provider === undefined) {
    return {
      config,
      error:
        input.provider.trim() === ''
          ? '这个位置还没有供应商，请填供应商名称'
          : `没有叫「${input.provider.trim()}」的供应商，先添加供应商`,
    }
  }
  if (modelId === '') return { config, error: '请填模型 ID' }
  // Empty keeps what the slot has, like the other fields; 'default' clears it.
  const wanted = input.effort?.trim().toLowerCase() ?? ''
  if (wanted !== '' && wanted !== 'default' && !isEffort(wanted)) {
    return { config, error: '推理强度只能是 low、medium、high、xhigh、max、off 或 default（留空不改）' }
  }
  const effort = wanted === '' ? current?.effort : wanted === 'default' ? undefined : (wanted as Effort)

  return {
    config: {
      ...config,
      slots: {
        ...config.slots,
        [tier]: effort === undefined ? { providerId: provider.id, modelId } : { providerId: provider.id, modelId, effort },
      },
    },
  }
}

export const clearSlot = (config: Config, tier: Tier): Result => ({
  config: { ...config, slots: { ...config.slots, [tier]: null } },
})

/** '' puts delegate_gpt back on the ChatGPT subscription; anything else must name a known provider. */
export const setGptSource = (config: Config, providerId: string): Result => {
  const id = providerId.trim()
  if (id === '') return { config: normalize({ ...config, gptSource: '' }) }
  if (!config.providers.some(p => p.id === id)) return { config, error: `没有叫「${id}」的供应商，先添加供应商` }

  return { config: normalize({ ...config, gptSource: id }) }
}

export const setGptHidePrefix = (config: Config, hide: boolean): Result => ({
  config: { ...config, gptHidePrefix: hide },
})

export const maskKey = (key: string): string =>
  key === '' ? '未设置' : `已设置（…${key.slice(-4)}）`

export const parseTier = (v: unknown): Tier | undefined =>
  v === 'flash' || v === 'pro' ? v : undefined

/** The line the person sees for a call: tier, provider / model, how it runs. Never sent to the model. */
export const callLabel = (
  config: Config,
  tier: Tier,
  flags: { background: boolean; work: boolean },
): string => {
  const slot = config.slots[tier]
  const provider = config.providers.find(p => p.id === slot?.providerId)
  const where = slot === null || provider === undefined ? '未设置' : `${provider.name} / ${slot.modelId}${slot.effort === undefined ? '' : ` · ${slot.effort}`}`

  return `${tier} · ${where}${flags.background ? ' · 后台' : ' · 前台'}${flags.work ? ' · 可改文件' : ' · 只读'}`
}

export type Resolved = {
  tier: Tier
  modelId: string
  providerName: string
  effort?: Effort
}

export const resolveTier = (
  config: Config,
  tier: Tier,
): Resolved | { error: string } => {
  const slot = config.slots[tier]
  if (slot === null) return { error: `${tier} 位还没有设置模型。在 /delegate 面板里设置。` }
  const provider = config.providers.find(p => p.id === slot.providerId)
  if (provider === undefined) return { error: `${tier} 位的供应商已被删除` }

  return {
    tier,
    modelId: `${provider.id}/${slot.modelId}`,
    providerName: provider.name,
    ...(slot.effort === undefined ? {} : { effort: slot.effort }),
  }
}

/** What the model reads: tiers, never model names, so swapping a backend needs no re-briefing. */
export const toolDescription = (config: Config): string => {
  const ready = TIERS.filter(t => config.slots[t] !== null)

  return [
    '把一个自包含的任务交给外部模型去做，它在独立进程里有自己的上下文和读文件、搜索（可选改文件、跑命令）的工具，只把最终文本返回给你。不占 Claude 额度。',
    '两个工具对应两个档位（不是模型名）：delegate_flash 与 delegate_pro。',
    '- flash：快而便宜。检索定位、读代码归纳、批量机械改写、跑固定命令、格式化、整理清单。大多数派发用它。',
    '- pro：更强更贵。需要更多判断的多文件分析、较复杂的改动、flash 做不好时升级。',
    '任务说明要自包含：写清目标、允许读写的路径、已知事实、期望的输出格式。它看不到你的对话。',
    '返回里的 agent ID 可以填进 resume 继续同一个代理（它记得之前读过的内容和 mode，比新建便宜、不用重讲背景）；resume 没传 mode 就沿用该代理上次的 mode，显式传则以传入的为准；换任务或上下文已很长时才新建。',
    'background=true 立即返回，任务做完后会自动通知你（结果在通知里）：你手头有别的事可做、任务较久、或要同时派几个互不依赖的包时用；你下一步就依赖它的结果时用默认的前台，别用后台再干等。',
    '轮数和时长基本不设限（只有 2 小时的防卡死兜底），不用为了怕超时把任务拆碎；预计超过几分钟的任务用 background=true。万一超时，返回里会带 agent ID 和它做到哪：先核对文件，没做完就 resume 续做，不要原样重试。汇报要求它精简：结论、改了哪些文件、测试结果。',
    'mode=read（默认）只读；mode=work 可改文件和跑命令（它只用一个 run_code 工具，在程序里批量调用 read/edit/bash 等），仅在任务明确需要改动时用。',
    "read 模式默认也只用一个只读的 run_code（默认只能读 cwd 内的文件，不能写文件、跑命令），在程序里批量读取、检索后汇总，另外带一个 WebFetch 可以读网页；要读 cwd 以外的目录时，把它们列进 readPaths（绝对目录，只放宽读），不必改用 ptc:'off'；只有 readPaths 也覆盖不了（比如需要别的工具）才传 ptc:'off' 改用原生 Read/Grep/Glob/WebFetch。",
    ready.length === 2 ? '' : `当前已配置的档位：${ready.join('、') || '无（先用 /delegate 设置）'}`,
  ]
    .filter(Boolean)
    .join('\n')
}
