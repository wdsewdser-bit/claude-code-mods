import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Draft } from '../types'
import {
  idOf,
  isEffort,
  migrationPlan,
  clearSlot,
  normalize,
  parseTier,
  removeProvider,
  resolveTier,
  setSlot,
  TIERS,
  callLabel,
  toolDescription,
} from './lib/config.ts'
import type { Config, Result, Tier } from './lib/config.ts'
import { GPT_DEFAULT_MODEL, GPT_MODELS, gptLabel, gptModelOf, gptToolDescription } from './lib/gpt.ts'
import {
  eventLine,
  formatList,
  formatStatus,
  isJobKey,
  isStatus,
  jobKey,
  JOB_PREFIX,
  jobsRootOf,
  MAX_JOBS,
  newJobId,
  normalizeReadPaths,
  normalizeRecord,
  normalizeStatus,
  pidMatches,
  recordFromNote,
  statusText,
  STATUSES,
  summarize,
  uuid,
} from './lib/jobs.ts'
import { liveEvents, spanOf, tokensOf, usageOf } from './lib/jobs.ts'
import type { Agent, JobRecord, JobStatusFile, LiveEvent, Mode, Ptc } from './lib/jobs.ts'
import { barOf, normalizeQuota, resetIn, usedColor } from './lib/quota.ts'
import type { GptQuota } from './lib/quota.ts'

const COMMAND = 'delegate'
const PANE = 'delegate'
const toolOf = (tier: Tier): string => `mcp__delegate__delegate_${tier}`
// gpt is a target like a tier, but it has no slot: the model is chosen per call and CPA supplies the endpoint.
const GPT_TOOL = 'mcp__delegate__delegate_gpt'
const STORE_KEY = 'cfg'
// 旧版把全部作业挤在这一个 key 里；现在每条作业单独 job:<id>，这张表只当镜像和迁移用。
const JOBS_KEY = 'jobs'
// resume 用的是 agent id（= session id），作业 id 是 bg-/fg-；这一条索引把两者连起来。
const AGENT_PREFIX = 'agent:'
const MAX_REPLY = 20_000
// A finished background job speaks to the model through a prompt: keep it short, the rest is in a file.
const BG_INLINE = 6_000

const EMPTY: Draft = {
  pName: '',
  pUrl: '',
  pKey: '',
  keyFor: '',
  keyValue: '',
  flashProvider: '',
  flashModel: '',
  proProvider: '',
  proModel: '',
  flashEffort: '',
  proEffort: '',
}

const draftAtom = atom({ plugin: 'delegate', key: 'draft' } as const, EMPTY)
const flashAtom = atom({ plugin: 'delegate', key: 'flash' } as const, '')
const versionAtom = atom({ plugin: 'delegate', key: 'version' } as const, 0)

// Calls in flight, so the status line is cleared only when the last one ends.
let running = 0

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

type CpaProvider = { id: string; name: string; prefix: string; protocol: string; baseUrl: string; keyMask: string; models: string[] }
type CpaAccount = { name: string; email?: string; disabled?: boolean; status?: string }
type AdminReply = { ok: boolean; error?: string; providers?: CpaProvider[]; models?: string[]; accounts?: CpaAccount[]; url?: string; state?: string; status?: string }
const admin = async ($: EngineInterface, command: string, input: Record<string, unknown> = {}): Promise<AdminReply> => {
  const ran = await $.process.run(['node', `${$.plugin.root}/scripts/cpa-admin.mjs`, command], { stdin: JSON.stringify(input), timeoutMs: 120_000 })
  const result = JSON.parse(ran.stdout.trim().split('\n').at(-1) || '{}') as AdminReply
  if (ran.exitCode !== 0 || !result.ok) throw new Error(result.error || 'CPA 操作失败')
  return result
}
let migrationPending: Promise<Config> | undefined
const loadConfig = async ($: EngineInterface): Promise<Config> => {
  if (migrationPending) return migrationPending
  let raw: unknown
  try { raw = await $.store.get(STORE_KEY) } catch { return normalize(undefined) }
  const plan = migrationPlan(raw)
  if (!plan.providers.length) return plan.config
  migrationPending = (async () => {
    const existing = (await admin($, 'providers')).providers || []
    for (const p of plan.providers) await admin($, 'save', { ...p, models: [...new Set([...(existing.find(x => x.id === p.id)?.models || []), ...p.models])] })
    // No store write on failure: legacy secrets stay available for a safe retry.
    await $.store.set(STORE_KEY, plan.config)
    return plan.config
  })()
  try { return await migrationPending } finally { migrationPending = undefined }
}

// One tool per tier, so the person's tool row already reads delegate_flash / delegate_pro.
const describeTool = async ($: EngineInterface, config: Config): Promise<void> => {
  for (const tier of TIERS) await describeOne($, config, tier)
}

const describeOne = async ($: EngineInterface, config: Config, tier: Tier): Promise<void> => {
  try {
    await $.tool.register({
      name: `delegate_${tier}`,
      description: `【${tier} 档】${toolDescription(config)}`,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '自包含的任务说明' },
          mode: {
            type: 'string',
            enum: ['read', 'work'],
            description: 'read 只读（默认）；work 可改文件和跑命令',
          },
          ptc: {
            type: 'string',
            enum: ['only', 'off'],
            description: "仅 read 模式：默认 'only'，子代理只用一个只读的 run_code，在程序里批量 read/glob/grep 再汇总（默认只能读 cwd，不能写文件、跑命令，另带 WebFetch 读网页）；要读 cwd 以外的目录时优先把它们列进 readPaths，不必因此改用 'off'；'off' 改用原生 Read/Grep/Glob/WebFetch（readPaths 不适用，兜底用）",
          },
          readPaths: {
            type: 'array',
            items: { type: 'string' },
            description: "可选：额外可读的绝对目录（cwd 以外的），仅 read 模式且 ptc 为 only 时生效；列在这里就能在只读 run_code 里 read/grep/glob，不必改用 ptc:'off'。只放宽读，写权限不变；不存在的目录自动忽略。resume 不传则沿用该 agent 上次的。",
          },
          cwd: { type: 'string', description: '工作目录；不填用当前会话的' },
          maxTurns: { type: 'number', description: '最多轮数，默认不限（1000）' },
          effort: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'xhigh', 'max', 'off'],
            description: '只对这一次调用覆盖思考强度；不填用该档位的设置。疑难根因、复杂设计才用 max',
          },
          background: {
            type: 'boolean',
            description: 'true：立即返回，完成后自动通知你（你有别的事可做、任务较久时用）；默认 false：等它做完再继续',
          },
          resume: {
            type: 'string',
            description: '上次返回的 agent ID：接着那个代理的上下文继续，不新建（沿用它的档位、mode、ptc、readPaths 和目录；显式传 mode/ptc/readPaths 则覆盖）',
          },
        },
        required: ['task'],
      },
    })
  } catch (error) {
    $.ui.log(`delegate: tool not registered: ${messageOf(error)}`, { to: 'debug' })
  }
}

// delegate_gpt: GPT through the local CPA proxy (ChatGPT subscription). No provider, no key, no slot to set up.
const describeGpt = async ($: EngineInterface): Promise<void> => {
  try {
    await $.tool.register({
      name: 'delegate_gpt',
      description: `【gpt 档】${gptToolDescription()}`,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '自包含的任务说明' },
          model: {
            type: 'string',
            enum: [...GPT_MODELS],
            description: "默认 gpt-6.1-sol，日常都用它；只有真正高难的问题才传 'gpt-6-astra'（更慢，别当默认）；gpt-6.1-terra 只在 DS 不可用时当下位替代，固定按 max 跑（传别的 effort 也按 max）",
          },
          mode: {
            type: 'string',
            enum: ['read', 'work'],
            description: 'read 只读（默认）；work 可改文件和跑命令',
          },
          ptc: {
            type: 'string',
            enum: ['only', 'off'],
            description: "仅 read 模式：默认 'only'，子代理只用一个只读的 run_code，在程序里批量 read/glob/grep 再汇总（默认只能读 cwd，不能写文件、跑命令，另带 WebFetch 读网页）；要读 cwd 以外的目录时优先把它们列进 readPaths，不必因此改用 'off'；'off' 改用原生 Read/Grep/Glob/WebFetch（readPaths 不适用，兜底用）",
          },
          readPaths: {
            type: 'array',
            items: { type: 'string' },
            description: "可选：额外可读的绝对目录（cwd 以外的），仅 read 模式且 ptc 为 only 时生效；列在这里就能在只读 run_code 里 read/grep/glob，不必改用 ptc:'off'。只放宽读，写权限不变；不存在的目录自动忽略。resume 不传则沿用该 agent 上次的。",
          },
          cwd: { type: 'string', description: '工作目录；不填用当前会话的' },
          maxTurns: { type: 'number', description: '最多轮数，默认不限（1000）' },
          effort: {
            type: 'string',
            enum: ['medium', 'high', 'xhigh', 'max'],
            description: '思考强度（映射到 Claude Code 的 --effort），不填就是 medium。medium 是最低档；判断量较大、跨模块的改动或审查用 high；真正高难的问题用 xhigh，一般就够了；max 只在 xhigh 仍不稳时用',
          },
          background: {
            type: 'boolean',
            description: 'true：立即返回，完成后自动通知你（你有别的事可做、任务较久时用）；默认 false：等它做完再继续',
          },
          resume: {
            type: 'string',
            description: '上次返回的 agent ID：接着那个代理的上下文继续，不新建（沿用它的 mode、ptc、readPaths 和目录；显式传 mode/ptc/readPaths 则覆盖）',
          },
        },
        required: ['task'],
      },
    })
  } catch (error) {
    $.ui.log(`delegate: gpt tool not registered: ${messageOf(error)}`, { to: 'debug' })
  }
}

const saveConfig = async ($: EngineInterface, config: Config): Promise<void> => {
  await $.store.set(STORE_KEY, config)
  await describeTool($, config)
  await update($, versionAtom, n => n + 1)
}

type JobReply = {
  ok: boolean
  text?: string
  error?: string
  sessionId?: string | null
  turns?: number | null
  ms?: number
  // 实际作答的模型（按出现顺序去重）；一个都没看到就是 null
  models?: string[] | null
  // 任务自己写的 TASK_TERMINAL（completed / blocked / failed）；没写就是 null
  terminal?: string | null
}

// 进程成功（ok）不等于任务完成：把任务终态和实际模型单独说一行，附在返回文本末尾。
const runnerNote = (reply: JobReply): string => {
  const models = Array.isArray(reply.models)
    ? reply.models.filter(m => typeof m === 'string' && m !== '')
    : []
  const terminal = typeof reply.terminal === 'string' && reply.terminal !== '' ? reply.terminal : null
  // 完成且只有一个模型：只说实际模型，不用再报终态
  if (terminal === 'completed' && models.length === 1) return `实际模型=${models[0]}`
  const parts: string[] = []
  if (terminal !== 'completed') parts.push(`TASK_TERMINAL=${terminal ?? 'none'}`)
  if (models.length > 0) parts.push(`实际模型=${models.join(', ')}`)
  return parts.length === 0 ? '' : `runner：${parts.join('；')}`
}

const runJob = async (
  $: EngineInterface,
  job: Record<string, unknown>,
): Promise<JobReply> => {
  const script = `${$.plugin.root}/scripts/run-delegate.mjs`
  const input = JSON.stringify(job)
  try {
    let stdout = ''
    let stderr = ''
    let code: number | null = null
    try {
      // process.spawn, not process.run: run caps a child at ten minutes; the runner enforces its own (2 h) limit
      const child = $.process.spawn({ argv: ['node', script], input })
      let step = await child.next()
      while (!step.done) {
        if (step.value.stream === 'stdout') stdout += step.value.text
        else stderr += step.value.text
        step = await child.next()
      }
      code = step.value?.code ?? null
    } catch (error) {
      // a host without process.spawn (the test kit) falls back to run and its ten-minute cap
      if (!messageOf(error).includes('no implementation for process.spawn')) throw error
      const ran = await $.process.run(['node', script], { stdin: input, timeoutMs: 600_000 })
      stdout = ran.stdout
      stderr = ran.stderr
      code = ran.exitCode
    }
    const line = stdout.trim().split('\n').at(-1) ?? ''
    try {
      return JSON.parse(line) as JobReply
    } catch {
      return {
        ok: false,
        error: `runner gave no result (exit ${code}): ${stderr.slice(-300)}`,
      }
    }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

const setFlash = async ($: EngineInterface, text: string): Promise<void> => {
  await update($, flashAtom, () => text)
}

const setDraftField = async (
  $: EngineInterface,
  field: keyof Draft,
  value: string,
): Promise<void> => {
  await update($, draftAtom, d => ({ ...d, [field]: value }))
}

const applyResult = async (
  $: EngineInterface,
  result: Result,
  ok: string,
  clear: Partial<Draft>,
): Promise<void> => {
  if (result.error !== undefined) {
    await setFlash($, result.error)

    return
  }
  await saveConfig($, result.config)
  await update($, draftAtom, d => ({ ...d, ...clear }))
  await setFlash($, ok)
}

const EFFORT_CHOICES = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'off'] as const
let delArmed: string | undefined
let cpaProviders: CpaProvider[] = []
let cpaAccounts: CpaAccount[] = []
let paneLoaded = false
let paneTab = 'slots'
let editId: string | undefined
let editProtocol = 'chat'
let fetched: string[] = []
let selected: string[] = []
let modelPage = 0
let providerPage = 0
let addedPage = 0
let loginUrl = ''
let loginState = ''
let loginNext = 0
let loginUntil = 0
let loginPending = false
const redraw = async ($: EngineInterface): Promise<void> => { await update($, versionAtom, n => n + 1) }
const paneAction = async ($: EngineInterface, fn: () => Promise<void>): Promise<void> => {
  try { await fn() } catch { await setFlash($, 'CPA 操作失败，请检查供应商设置或本机服务后重试') }
  await redraw($)
}
const refreshProviders = async ($: EngineInterface): Promise<void> => {
  const result = await admin($, 'providers')
  cpaProviders = result.providers || []
  const config = await loadConfig($)
  const providers = cpaProviders.map(p => ({ id: p.id, name: config.providers.find(x => x.id === p.id)?.name || p.name }))
  await saveConfig($, normalize({ ...config, providers }))
  paneLoaded = true
}
const refreshAccounts = async ($: EngineInterface): Promise<void> => { cpaAccounts = (await admin($, 'gpt-accounts')).accounts || [] }
const editProvider = async ($: EngineInterface, p?: CpaProvider): Promise<void> => {
  editId = p?.id || ''; editProtocol = p?.protocol || 'chat'; fetched = []; selected = []; modelPage = 0; addedPage = 0
  const c = await loadConfig($)
  await update($, draftAtom, d => ({ ...d, pName: c.providers.find(x => x.id === p?.id)?.name || p?.name || '', pUrl: p?.baseUrl || '', pKey: '' }))
  await redraw($)
}
const saveProvider = async ($: EngineInterface, models?: string[]): Promise<void> => {
  const d = await read($, draftAtom)
  const existing = cpaProviders.find(p => p.id === editId)
  const id = editId || idOf(d.pName, cpaProviders.map(p => p.id))
  if (!d.pName.trim()) { await setFlash($, '名称不能为空'); return }
  await admin($, 'save', { id, name: d.pName, protocol: editProtocol, baseUrl: d.pUrl, ...(d.pKey.trim() ? { key: d.pKey.trim() } : {}), models: models || existing?.models || [] })
  const config = await loadConfig($)
  await saveConfig($, { ...config, providers: [...config.providers.filter(p => p.id !== id), { id, name: d.pName.trim() }] })
  editId = id
  await update($, draftAtom, d => ({ ...d, pKey: '' }))
  await refreshProviders($)
  await setFlash($, '供应商已保存到 CPA')
}
const startLogin = async ($: EngineInterface): Promise<void> => {
  if (loginState) await admin($, 'gpt-login-cancel', { state: loginState })
  const r = await admin($, 'gpt-login-start')
  loginUrl = r.url || ''; loginState = r.state || ''
  if (!/^https:\/\//.test(loginUrl) || !loginState) throw new Error('登录接口未返回 URL / state')
  loginNext = 0; loginUntil = Date.now() + 300_000
  try { await $.process.run(['cmd', '/c', 'start', '', loginUrl]) } catch { /* link remains visible */ }
}
// Called by the existing session-scoped clock, never a short-lived button handler's clock.
const pollLogin = async ($: EngineInterface): Promise<void> => {
  if (!loginState || loginPending || Date.now() < loginNext) return
  loginPending = true
  const state = loginState
  try {
    const status = await admin($, 'gpt-login-status', { state })
    if (state !== loginState) return
    if (status.status === 'ok') {
      loginState = ''; loginUrl = ''
      await refreshAccounts($); await refreshQuota($, true); await setFlash($, 'Codex 登录成功')
    } else if (status.status === 'error' || Date.now() > loginUntil) {
      await admin($, 'gpt-login-cancel', { state }); loginState = ''; await setFlash($, '登录失败或超时，请重试')
    }
  } catch { if (state === loginState) { loginState = ''; await setFlash($, '登录轮询失败，请刷新后重试') } }
  finally { loginPending = false; loginNext = Date.now() + 2000; await redraw($) }
}

const effortAction = async ($: EngineInterface, tier: Tier, effort: string): Promise<void> => {
  const config = await loadConfig($)
  await applyResult(
    $,
    setSlot(config, tier, { provider: '', modelId: '', effort }),
    `${tier} 推理强度：${effort === 'default' ? '默认' : effort}`,
    {},
  )
}

const removeProviderAction = async ($: EngineInterface, id: string, name: string): Promise<void> => {
  if (delArmed !== id) {
    delArmed = id
    await setFlash($, `再点一次「确认删除？」删掉「${name}」，用到它的模型位会被清空`)

    return
  }
  delArmed = undefined
  await admin($, 'delete', { id })
  await refreshProviders($)
  await changeAction($, c => removeProvider(c, id), `已删除供应商「${name}」，用到它的模型位已清空`)
}

const changeAction = async (
  $: EngineInterface,
  make: (config: Config) => Result,
  ok: string,
): Promise<void> => {
  await applyResult($, make(await loadConfig($)), ok, {})
}

const testAction = async ($: EngineInterface, target: Agent): Promise<void> => {
  const job: Record<string, unknown> = {
    task: 'Reply with the single word OK and call no tools.',
    mode: 'read',
    maxTurns: 3,
    timeoutMs: 90_000,
  }
  if (target === 'gpt') {
    Object.assign(job, { gpt: true, model: GPT_DEFAULT_MODEL })
  } else {
    const resolved = resolveTier(await loadConfig($), target)
    if ('error' in resolved) {
      await setFlash($, resolved.error)

      return
    }
    Object.assign(job, {
      model: resolved.modelId,
      effort: resolved.effort,
    })
  }
  await setFlash($, `测试 ${target} 中…`)
  const reply = await runJob($, job)
  await setFlash(
    $,
    reply.ok
      ? `测试 ${target} 通过：${(reply.text ?? '').slice(0, 60)}（${Math.round((reply.ms ?? 0) / 1000)} 秒）`
      : `测试 ${target} 失败：${reply.error ?? reply.text ?? '未知原因'}`,
  )
}

type LegacyNote = Record<string, unknown>


const loadLegacyJobs = async ($: EngineInterface): Promise<Record<string, LegacyNote>> => {
  try {
    const raw = await $.store.get(JOBS_KEY)

    return typeof raw === 'object' && raw !== null ? (raw as Record<string, LegacyNote>) : {}
  } catch {
    return {}
  }
}

// 旧版整表照写（老版本和外部脚本可能还在读它），失败不算数。
const mirrorLegacy = async ($: EngineInterface, rec: JobRecord): Promise<void> => {
  try {
    const table = await loadLegacyJobs($)
    // 旧表的键一直是 agent id（resume 就是拿它查的），没有 id 才退回作业 id。
    table[rec.sessionId ?? rec.jobId] = {
      jobId: rec.jobId,
      tier: rec.tier,
      cwd: rec.cwd,
      mode: rec.mode,
      ptc: rec.ptc,
      ...(rec.readPaths === undefined ? {} : { readPaths: rec.readPaths }),
      at: rec.at,
      status: rec.status,
      model: rec.model,
      background: rec.background,
      summary: rec.summary,
      sessionId: rec.sessionId,
      ...(rec.endedAt === undefined ? {} : { endedAt: rec.endedAt }),
      ...(rec.notified === true ? { notified: true } : {}),
    }
    const kept = Object.entries(table)
      .sort((a, b) => Number(b[1].at ?? 0) - Number(a[1].at ?? 0))
      .slice(0, MAX_JOBS)
    await $.store.set(JOBS_KEY, Object.fromEntries(kept))
  } catch {}
}

/** 一条作业一个 key：两个会话同时派活也不会互相覆盖。 */
const saveJob = async ($: EngineInterface, rec: JobRecord): Promise<void> => {
  try {
    await $.store.set(jobKey(rec.jobId), rec)
  } catch (error) {
    $.ui.log(`delegate: 作业 ${rec.jobId} 没写进 store：${messageOf(error)}`, { to: 'debug' })
  }
  if (rec.sessionId !== null && rec.sessionId !== '') {
    try {
      await $.store.set(`${AGENT_PREFIX}${rec.sessionId}`, rec.jobId)
    } catch {}
  }
  await mirrorLegacy($, rec)
  await pruneJobs($)
}

const loadJob = async ($: EngineInterface, id: string): Promise<JobRecord | undefined> => {
  try {
    const rec = normalizeRecord(await $.store.get(jobKey(id)), id)
    if (rec !== undefined) return rec
  } catch {}
  // resume 传的是 agent id：顺着索引找回那条作业。
  try {
    const jobId = await $.store.get(`${AGENT_PREFIX}${id}`)
    if (typeof jobId === 'string' && jobId !== '') {
      const rec = normalizeRecord(await $.store.get(jobKey(jobId)), jobId)
      if (rec !== undefined) return rec
    }
  } catch {}
  const note = (await loadLegacyJobs($))[id]

  return note === undefined ? undefined : recordFromNote(id, note)
}

const listJobs = async ($: EngineInterface): Promise<JobRecord[]> => {
  const found = new Map<string, JobRecord>()
  let keys: string[] = []
  try {
    keys = await $.store.keys()
  } catch {
    keys = []
  }
  for (const key of keys.filter(isJobKey)) {
    const id = key.slice(JOB_PREFIX.length)
    try {
      const rec = normalizeRecord(await $.store.get(key), id)
      if (rec !== undefined) found.set(rec.jobId, rec)
    } catch {}
  }
  const known = new Set<string>()
  for (const rec of found.values()) {
    known.add(rec.jobId)
    if (rec.sessionId !== null) known.add(rec.sessionId)
  }
  for (const [id, note] of Object.entries(await loadLegacyJobs($))) {
    if (known.has(id)) continue
    // 同一条作业在旧表里可能有两条键（计划里的 id 和跑完后的 agent id），只认一条。
    if (typeof note.jobId === 'string' && known.has(note.jobId)) continue
    const rec = recordFromNote(id, note)
    if (rec !== undefined) found.set(rec.jobId, rec)
  }

  return [...found.values()].sort((a, b) => b.at - a.at)
}

/** 按开始时间留最近 MAX_JOBS 条；多出 10 条以上才动手，免得每次写都扫全表。 */
const pruneJobs = async ($: EngineInterface): Promise<void> => {
  let keys: string[] = []
  try {
    keys = (await $.store.keys()).filter(isJobKey)
  } catch {
    return
  }
  if (keys.length <= MAX_JOBS + 10) return
  const records: JobRecord[] = []
  for (const key of keys) {
    try {
      const rec = normalizeRecord(await $.store.get(key), key.slice(JOB_PREFIX.length))
      if (rec !== undefined) records.push(rec)
    } catch {}
  }
  records.sort((a, b) => b.at - a.at)
  for (const rec of records.slice(MAX_JOBS)) {
    try {
      await $.store.delete(jobKey(rec.jobId))
      if (rec.sessionId !== null && rec.sessionId !== '') await $.store.delete(`${AGENT_PREFIX}${rec.sessionId}`)
    } catch {}
  }
}

const homeOf = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  } catch {
    return undefined
  }
}

const rootOf = async ($: EngineInterface): Promise<string | undefined> => jobsRootOf(await homeOf($))

// 第一条消息之前 $.session.id() 可能迟迟不返回；按钮栏的绘制等它就会整条不出来，所以限时 300ms。
// 每次都重新问：模块级的 id 缓存会在桌面端多会话共用进程时一直返回上一个会话的 id（owner 全串）。
// 宿主没有 setTimeout（hooks 模块只有 $.clock），限时用 $.clock.after 做。
const SESSION_ID_WAIT_MS = 300
// 宿主不许把 $（或 $.session）当值传、也不许读，所以做不到「按 $ 实例」的 WeakMap。
// 折中：模块级只记「上一次成功拿到的 id」，且只在本次 300ms 超时时兜底；拿到新 id 立刻覆盖。
// 代价：桌面端多会话共用一个进程时，超时窗口内可能返回另一个会话的 id（最多 300ms，且下一次调用就纠正）。
const SESSION_FALLBACK_MS = 5_000
let lastSessionId: { id: string; at: number } | undefined
const sessionOf = async ($: EngineInterface): Promise<string | undefined> => {
  const id = await new Promise<string | undefined>(resolve => {
    let settled = false
    let timer: { cancel: () => void } | undefined
    const settle = (value: string | undefined): void => {
      if (settled) return
      settled = true
      try {
        timer?.cancel()
      } catch {}
      resolve(value)
    }
    try {
      timer = $.clock.after(SESSION_ID_WAIT_MS, () => settle(undefined))
    } catch {
      settle(undefined)
    }
    void Promise.resolve()
      .then(() => $.session.id())
      .then(
        value => settle(typeof value === 'string' && value !== '' ? value : undefined),
        () => settle(undefined),
      )
  })
  if (id !== undefined) {
    lastSessionId = { id, at: Date.now() }

    return id
  }

  // 超时兜底：只用刚刚拿到的值，太旧就当拿不到（宁可当作「无会话」，也不把别的会话的 id 当成自己的）。
  const last = lastSessionId

  return last !== undefined && Date.now() - last.at < SESSION_FALLBACK_MS ? last.id : undefined
}

/** 属于本会话的作业：旧记录没有 owner，只在「全部会话」里出现。 */
const mine = (r: JobRecord, me: string | undefined): boolean => me !== undefined && r.owner === me

// 面板的「看全部会话」开关按会话存。StateAddress 只有 plugin/key/id，liveAll 不是 StateFamily，
// 类型上不许填 id，所以会话维度放在 store 的键里：liveAll:<sessionId>。
// 共用 atom 只当重绘信号：别的会话在里面写的值不会被当成自己的。
const liveAllKey = (sessionId: string): string => `liveAll:${sessionId}`
const readLiveAll = async ($: EngineInterface): Promise<boolean> => {
  await read($, liveAllAtom) // 只为订阅重绘，值不用
  const me = await sessionOf($)
  // 拿不到会话 id 就按「只看本会话」：不读共用槽，免得显示别的会话的选择。
  if (me === undefined) return false
  try {
    return (await $.store.get(liveAllKey(me))) === true
  } catch {
    return false
  }
}
const writeLiveAll = async ($: EngineInterface, isAll: boolean): Promise<void> => {
  const me = await sessionOf($)
  if (me !== undefined) {
    try {
      await $.store.set(liveAllKey(me), isAll)
    } catch {}
  }
  // 只当重绘信号：每次都翻转，保证值一定变化（别的会话写过同样的值也会触发重绘）。
  await update($, liveAllAtom, v => !v)
}

const jobDir = (root: string, id: string): string => `${root}/${id}`

// runner 写的 status.json 不是原子写，读到一半就重读一次，还是不行就当没有。
const readStatus = async ($: EngineInterface, dir: string): Promise<JobStatusFile | undefined> => {
  try {
    return normalizeStatus(JSON.parse(await $.fs.read(`${dir}/status.json`)))
  } catch {
    return undefined
  }
}

const readResult = async ($: EngineInterface, dir: string): Promise<JobReply | undefined> => {
  try {
    const raw = JSON.parse(await $.fs.read(`${dir}/result.json`)) as unknown

    return typeof raw === 'object' && raw !== null ? (raw as JobReply) : undefined
  } catch {
    return undefined
  }
}

/** 事件日志只取尾巴几条，别把整个文件塞进上下文。 */
const tailEvents = async ($: EngineInterface, dir: string, count: number): Promise<string[]> => {
  let text = ''
  try {
    text = await $.fs.read(`${dir}/events.jsonl`)
  } catch {
    return []
  }

  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .slice(-count)
    .map(line => eventLine(line))
}

// 按 pid 问一句，不按进程名或命令行搜（那会杀到别人的 claude）。
const isAlive = async ($: EngineInterface, pid: number): Promise<boolean> => {
  try {
    const run = await $.process.run(['tasklist', '/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      timeoutMs: 10_000,
    })

    return new RegExp(`"${pid}"`).test(run.stdout)
  } catch {
    return false
  }
}

const sessionCwd = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const cwd = await $.session.cwd()

    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

// 测试环境可能没有真时钟；真机上是 $.clock.sleep。
const nap = async ($: EngineInterface, ms: number): Promise<void> => {
  try {
    await $.clock.sleep(ms)
  } catch {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
}

let jobSeq = 0
const nextJobId = (background: boolean): string => {
  jobSeq = (jobSeq + 1) % 1296

  return newJobId(background, Date.now(), jobSeq)
}

// Checked before the runner starts: spawn's own failure for a bad cwd says nothing useful.
const cwdProblem = async (
  $: EngineInterface,
  cwd: string | undefined,
): Promise<string | undefined> => {
  if (cwd === undefined || cwd === '') return undefined
  const stat = await $.fs.stat(cwd).catch(() => undefined)
  if (stat === undefined) return `cwd 不存在：${cwd}`
  if (stat.kind !== 'dir') return `cwd 不是目录：${cwd}`

  return undefined
}

// GPT 的提示缓存闲置久了就会被清掉（官方说法一般 5–10 分钟，最长 1 小时），续用一个闲置太久的大上下文代理，
// 第一轮整段上下文按未命中重读，吃订阅额度。这种续用先拦一次并说明代价；原样再发一次、或 10 分钟内再发就放行。
// DS 的缓存能留几小时，也不占 Claude 额度，不拦。
// 2026-10-29 实测：GPT 经 CPA 闲置 130 分钟仍命中约 98%，更久的没测；先按 3 小时拦。
const GPT_COLD_MINUTES = 180
const GPT_COLD_MIN_TOKENS = 60_000
const RESEND_MINUTES = 10
const heldResumes = new Map<string, { at: number; task: string }>()

const coldResumeNotice = async (
  $: EngineInterface,
  target: Agent,
  old: JobRecord | undefined,
  task: string,
): Promise<string | undefined> => {
  if (target !== 'gpt' || old === undefined || old.status === 'running' || old.endedAt === undefined) return undefined
  const id = old.sessionId ?? old.jobId
  const now = Date.now()
  const held = heldResumes.get(id)
  if (held !== undefined) {
    heldResumes.delete(id)
    if (held.task === task || now - held.at < RESEND_MINUTES * 60_000) return undefined
  }
  const idle = now - old.endedAt
  if (idle <= GPT_COLD_MINUTES * 60_000) return undefined
  const root = await rootOf($)
  if (root === undefined) return undefined
  const { context } = usageOf(await readEventLines($, jobDir(root, old.jobId)))
  if (context <= GPT_COLD_MIN_TOKENS) return undefined
  heldResumes.set(id, { at: now, task })

  return `delegate: GPT 代理 ${id} 已闲置 ${spanOf(idle)}，提示缓存很可能已经过期，续用第一轮要按未命中重读约 ${tokensOf(context)} token 的上下文，计入 GPT 订阅额度。建议新建一个 GPT 代理，用它最后的报告加文件路径写个短交接；若仍要续用，原样再发一次。`
}

const callTool = async (
  $: EngineInterface,
  target: Agent,
  input: Record<string, unknown>,
): Promise<{ result: string; isError?: true }> => {
  const task = typeof input.task === 'string' ? input.task.trim() : ''
  if (task === '') return { result: 'delegate: task 不能为空', isError: true }
  const resume = typeof input.resume === 'string' ? input.resume.trim() : ''
  const old = resume === '' ? undefined : await loadJob($, resume)
  if (resume !== '' && old === undefined) {
    return {
      result: `delegate: 没有 ID 为 ${resume} 的代理（delegate_list 能列出最近的作业，包括重启前的）。去掉 resume 新建一个。`,
      isError: true,
    }
  }
  const coldNotice = await coldResumeNotice($, target, old, task)
  if (coldNotice !== undefined) return { result: coldNotice, isError: true }
  const given = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : undefined
  let cwd = given ?? old?.cwd
  let cwdNote = ''
  const badCwd = await cwdProblem($, cwd)
  if (badCwd !== undefined) {
    // 显式传的目录错了就报错；沿用旧作业的目录没了，退回本会话的目录（CLI 按 ID 全机找 transcript）。
    if (given !== undefined) return { result: `delegate: ${badCwd}`, isError: true }
    const fallback = await sessionCwd($)
    if (fallback === undefined) return { result: `delegate: ${badCwd}`, isError: true }
    cwd = fallback
    cwdNote = `（原目录 ${old?.cwd ?? '?'} 已不存在，改用 ${fallback}）`
  }
  const config = await loadConfig($)
  // gpt has no slot: this call picks the model (default gpt-6.1-sol) and the runner gets the endpoint from CPA.
  // resume 没传 model 时沿用原作业的 GPT 模型，免得 Astra 续用时悄悄换成默认的 Sol
  const inheritedModel =
    input.model === undefined && old?.tier === 'gpt' && typeof gptModelOf(old.model) === 'string' ? old.model : input.model
  const gptModel = target === 'gpt' ? gptModelOf(inheritedModel) : undefined
  if (gptModel !== undefined && typeof gptModel !== 'string') {
    return { result: `delegate: ${gptModel.error}`, isError: true }
  }
  const resolved = target === 'gpt' ? undefined : resolveTier(config, target)
  if (resolved !== undefined && 'error' in resolved) {
    return { result: `delegate: ${resolved.error}`, isError: true }
  }
  // A resume keeps what that agent last ran as, unless this call says otherwise.
  const mode: Mode =
    input.mode === 'read' || input.mode === 'work' ? input.mode : (old?.mode ?? 'read')
  const ptc: Ptc =
    input.ptc === 'only' || input.ptc === 'off' ? input.ptc : (old?.ptc ?? 'only')
  // 额外可读目录：没传就沿用该 agent 上次的；传了（哪怕是空数组）就以传入为准。只在 read + ptc:'only' 时有意义。
  const givenReadPaths = Array.isArray(input.readPaths) ? normalizeReadPaths(input.readPaths) : undefined
  const readPaths = givenReadPaths ?? old?.readPaths ?? []
  const readPathsActive = mode === 'read' && ptc === 'only' && readPaths.length > 0
  const background = input.background === true
  const label =
    target === 'gpt'
      ? gptLabel(gptModel as string, { background, work: mode === 'work' })
      : callLabel(config, target, { background, work: mode === 'work' })
  const effort =
    target === 'gpt'
      ? gptModel === 'gpt-6.1-terra'
        ? 'max' // terra 低于 max 几乎不思考（bug hunt：xhigh 11.3 分，max 40.7 分），一律按 max 跑
        : // GPT 最低 medium：不填或传 low 都按 medium 跑
        input.effort === 'high' || input.effort === 'xhigh' || input.effort === 'max'
        ? input.effort
        : input.effort === undefined && (old?.effort === 'high' || old?.effort === 'xhigh' || old?.effort === 'max')
          ? old.effort // resume 没传 effort：沿用原作业的档位
          : 'medium'
      : isEffort(input.effort)
        ? input.effort
        : input.effort === undefined && isEffort(old?.effort)
          ? old?.effort
          : undefined
  const recordedCwd = cwd ?? (await sessionCwd($)) ?? ''
  const common = {
    task,
    mode,
    ...(mode === 'read' ? { ptc: ptc === 'off' ? false : 'only' } : {}),
    ...(readPathsActive ? { readPaths } : {}),
    cwd: cwd ?? (recordedCwd === '' ? undefined : recordedCwd),
    maxTurns: typeof input.maxTurns === 'number' ? input.maxTurns : undefined,
    resume: resume === '' ? undefined : resume,
  }
  // gpt carries no url/key: the runner asks ensure_cpa.py for them (and starts CPA if it is down).
  const job =
    resolved === undefined
      ? { ...common, gpt: true, model: gptModel, effort }
      : { ...common, model: resolved.modelId, effort: effort ?? resolved.effort }
  const modelId = resolved === undefined ? String(gptModel) : resolved.modelId
  // 开跑前就记下来（status=running），宿主重启后也还能按 agent ID 找回这个代理。
  // 新建任务给一个 UUID 让 runner 用 --session-id 传下去；resume 不传，沿用旧 id。
  const at = Date.now()
  const jobId = nextJobId(background)
  const sessionId = resume === '' ? uuid() : undefined
  const record: JobRecord = {
    jobId,
    sessionId: sessionId ?? resume,
    tier: target,
    model: modelId,
    ...(typeof job.effort === 'string' ? { effort: job.effort } : {}),
    cwd: recordedCwd,
    mode,
    ptc,
    ...(readPaths.length === 0 ? {} : { readPaths }),
    background,
    status: 'running',
    at,
    summary: summarize(task),
  }
  const owner = await sessionOf($)
  if (owner !== undefined) record.owner = owner
  await saveJob($, record)
  await showLive($, jobId)
  const wire: Record<string, unknown> = {
    ...job,
    jobId,
    tier: target,
    // 流式输入：任务作为第一条 user 消息写进去，stdin 保持打开，才能中途插话。
    stream: true,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
  if (background) {
    void runBackground($, record, wire)
    const startQuota = target === 'gpt' ? await gptQuotaLine($) : ''

    return {
      result: `[delegate ${target} · ${mode} · 后台任务 ${jobId}] 已启动（agent ${record.sessionId ?? '?'}）。完成后会自动通知你（结果和 agent ID 都在通知里）。期间继续做别的，不要轮询，也不要为同一件事再派一个；要看进度用 delegate_status("${jobId}")，要停用 delegate_cancel("${jobId}")，要补充要求用 delegate_send("${jobId}", "…")。${cwdNote}${startQuota === '' ? '' : `\n${startQuota}`}`,
    }
  }

  running += 1
  $.ui.status(`◆ 委派 ${label} · 运行中`)
  try {
    return await settle($, record, await runJob($, wire))
  } finally {
    running -= 1
    if (running === 0) $.ui.status(undefined)
  }
}

const settle = async (
  $: EngineInterface,
  record: JobRecord,
  reply: JobReply,
): Promise<{ result: string; isError?: true }> => {
  // 成功分支的 sessionId 可能是流里收集的（runner 会回退到 sid），所以以回复为准，其次才用计划里的 id。
  const sessionId =
    typeof reply.sessionId === 'string' && reply.sessionId !== '' ? reply.sessionId : (record.sessionId ?? '')
  record.sessionId = sessionId === '' ? null : sessionId
  record.status = reply.ok ? 'done' : reply.error === 'cancelled' ? 'cancelled' : 'failed'
  record.endedAt = Date.now()
  if (typeof reply.turns === 'number') record.turns = reply.turns
  if (!reply.ok) record.error = (reply.error ?? reply.text ?? '').slice(0, 300)
  await saveJob($, record)
  const id = record.sessionId ?? ''
  const quotaNote = record.tier === 'gpt' ? await gptQuotaLine($) : ''
  const head = `[delegate ${record.tier} · ${record.mode} · agent ${id === '' ? '?' : id} · ${reply.turns ?? '?'} 轮 · ${Math.round((reply.ms ?? 0) / 1000)} 秒 · ${record.jobId}]${quotaNote === '' ? '' : `\n${quotaNote}`}`
  const note = runnerNote(reply)
  const tail = note === '' ? '' : `\n${note}`
  if (!reply.ok) {
    return { result: `${head}\n失败：${reply.error ?? reply.text ?? '未知原因'}${tail}`, isError: true }
  }
  const text = reply.text ?? ''

  return {
    result: `${head}\n${text.length > MAX_REPLY ? `${text.slice(0, MAX_REPLY)}\n…（已截断）` : text}${tail}`,
  }
}

// A job started with background: true: it runs on, and says so through a prompt when it ends.
const runBackground = async (
  $: EngineInterface,
  record: JobRecord,
  job: Record<string, unknown>,
): Promise<void> => {
  try {
    const done = await settle($, record, await runJob($, job))
    let where = ''
    try {
      const home = await homeOf($)
      if (home !== undefined) {
        const file = `${home.replace(/\\/g, '/')}/.claude/delegate/results/${record.jobId}.md`
        await $.fs.write(file, done.result)
        where = `\n完整结果：${file}`
      }
    } catch {
      where = ''
    }
    const body =
      done.result.length > BG_INLINE
        ? `${done.result.slice(0, BG_INLINE)}\n…（已截断）`
        : done.result
    await $.prompt.submit({
      text: `【delegate 后台任务 ${record.jobId} ${done.isError === true ? '失败' : '完成'}】\n${body}${where}`,
    })
    // 通知发出去才算数：没发出去的，session.start 会在重启后补发一次。
    record.notified = true
    await saveJob($, record)
  } catch (error) {
    $.ui.log(`delegate: background job ${record.jobId} failed: ${messageOf(error)}`, { to: 'debug' })
  }
}

// ---- 作业管理：列出、看进度、取消、插话 -------------------------------------

const jobTools = (): { name: string; description: string; inputSchema: Record<string, unknown> }[] => [
  {
    name: 'delegate_list',
    description:
      '列出最近的 delegate 作业（包括 Claude Code 重启之前的）：作业 id、agent/session id、档位与模型、状态、cwd、开始/结束时间、任务首行摘要。重启后想接着用之前的子代理，先用它找到 agent id，再传给 delegate_flash / delegate_pro / delegate_gpt 的 resume。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: [...STATUSES, 'all'],
          description:
            '只看某个状态：running 运行中 / done 完成 / failed 失败 / cancelled 已取消 / orphaned 宿主重启后中断（可 resume）；不填就是全部',
        },
        limit: { type: 'number', description: '最多列几条，默认 20' },
      },
    },
  },
  {
    name: 'delegate_status',
    description:
      '看一条作业现在在做什么：状态、轮数、最后用的工具、最后输出、最近的流事件。运行中的作业每处理一条事件就更新一次状态文件，所以随时问都能看到它做到哪了。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '作业 id（delegate_list 里的那个，如 bg-xxx）' } },
      required: ['id'],
    },
  },
  {
    name: 'delegate_cancel',
    description:
      '取消一条还在运行的作业：runner 看到标记就杀掉子进程树（含本地代理），作业以 ok:false / error:cancelled 结束并留下 agent id，之后可以用那个 id resume 接着做。只按这条作业自己记录的 pid 杀进程。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '作业 id' } },
      required: ['id'],
    },
  },
  {
    name: 'delegate_send',
    description:
      '给正在跑的作业追加一条消息：不打断正在跑的工具，当前轮结束后它会把这条当作新一轮接着做。用来补要求、纠偏、让它顺带检查别的东西。已经结束的作业不能插话，改用 resume 把要求写进 task。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '作业 id' },
        message: { type: 'string', description: '要它知道的话（自包含，它看不到你的对话）' },
      },
      required: ['id', 'message'],
    },
  },
]

const describeJobTools = async ($: EngineInterface): Promise<void> => {
  for (const tool of jobTools()) {
    try {
      await $.tool.register(tool)
    } catch (error) {
      $.ui.log(`delegate: tool ${tool.name} not registered: ${messageOf(error)}`, { to: 'debug' })
    }
  }
}

const idOfInput = (input: Record<string, unknown>): string =>
  typeof input.id === 'string' ? input.id.trim() : ''

const noSuchJob = (id: string): { result: string; isError: true } => ({
  result: `delegate: 没有作业 ${id}（delegate_list 看有哪些）。`,
  isError: true,
})

const listAction = async (
  $: EngineInterface,
  input: Record<string, unknown>,
): Promise<{ result: string; isError?: true }> => {
  const filter = typeof input.status === 'string' ? input.status.trim() : ''
  if (filter !== '' && filter !== 'all' && !isStatus(filter)) {
    return { result: `delegate_list: status 只能是 ${STATUSES.join(' / ')} 或 all`, isError: true }
  }
  const limit = typeof input.limit === 'number' ? Math.min(Math.max(Math.trunc(input.limit), 1), 50) : 20
  const all = await listJobs($)
  const root = await rootOf($)
  const live: Record<string, JobStatusFile> = {}
  for (const rec of all) {
    if (rec.status !== 'running' || root === undefined) continue
    const status = await readStatus($, jobDir(root, rec.jobId))
    if (status !== undefined) live[rec.jobId] = status
  }
  const shown = filter === '' || filter === 'all' ? all : all.filter(rec => rec.status === filter)

  return { result: formatList(shown, { now: Date.now(), limit, filter: filter === 'all' ? '' : filter, live }) }
}

const statusAction = async (
  $: EngineInterface,
  input: Record<string, unknown>,
): Promise<{ result: string; isError?: true }> => {
  const id = idOfInput(input)
  if (id === '') return { result: 'delegate_status 需要 id（delegate_list 里那个作业 id）', isError: true }
  const rec = await loadJob($, id)
  const root = await rootOf($)
  const dir = root === undefined ? undefined : jobDir(root, id)
  const status = dir === undefined ? undefined : await readStatus($, dir)
  if (rec === undefined && status === undefined) return noSuchJob(id)
  const result = dir === undefined ? undefined : await readResult($, dir)
  const events = dir === undefined ? [] : await tailEvents($, dir, 8)

  return { result: formatStatus(rec, status, events, result, Date.now()) }
}

const cancelAction = async (
  $: EngineInterface,
  input: Record<string, unknown>,
): Promise<{ result: string; isError?: true }> => {
  const id = idOfInput(input)
  if (id === '') return { result: 'delegate_cancel 需要 id（delegate_list 里那个作业 id）', isError: true }
  const rec = await loadJob($, id)
  if (rec === undefined) return noSuchJob(id)
  if (rec.status !== 'running') {
    const hint = rec.sessionId === null ? '' : `；要接着做就用 resume ${rec.sessionId}`

    return { result: `delegate: ${id} 已经结束了（${statusText(rec.status)}）${hint}`, isError: true }
  }
  const root = await rootOf($)
  if (root === undefined) return { result: 'delegate: 找不到家目录，没法取消', isError: true }
  const dir = jobDir(root, id)
  try {
    await $.fs.write(`${dir}/cancel`, JSON.stringify({ at: Date.now(), by: 'delegate_cancel' }))
  } catch (error) {
    return { result: `delegate: 写不了取消标记：${messageOf(error)}`, isError: true }
  }
  // runner 每 0.5 秒看一次取消标记；等它自己收尾，等不到再按 status.json 的 pid 兜底。
  let status = await readStatus($, dir)
  const end = Date.now() + 4000
  while (Date.now() < end) {
    if (status !== undefined && (status.phase === 'cancelled' || status.phase === 'done' || status.phase === 'failed')) break
    if (status?.pid !== undefined && !(await isAlive($, status.pid))) break
    await nap($, 400)
    status = await readStatus($, dir)
  }
  const stillAlive = status?.pid !== undefined && (await isAlive($, status.pid))
  let forced = false
  if (stillAlive && pidMatches(status, rec) && status?.pid !== undefined) {
    // 兜底：只杀 status.json 里记的 pid，且开始时间对得上才算这条作业的进程。
    try {
      await $.process.run(['taskkill', '/PID', String(status.pid), '/T', '/F'], { timeoutMs: 20_000 })
      forced = true
    } catch {}
  }
  const sessionId = status?.sessionId ?? rec.sessionId
  if (forced || !stillAlive) {
    rec.status = 'cancelled'
    rec.endedAt = Date.now()
    rec.error = 'cancelled'
    await saveJob($, rec)
  }
  const how = forced ? '（runner 没来得及收尾，已按它记录的 pid 强制结束）' : stillAlive ? '（取消标记已写入，但进程还在，pid 校验不符所以没有强杀）' : ''
  const next =
    sessionId === null
      ? '它没留下 agent id，只能重新派。'
      : `agent ${sessionId} 还在，要接着做就 resume 它（delegate_flash / delegate_pro / delegate_gpt 传 resume: "${sessionId}"），它带着已经做过的内容继续。`

  return {
    result: `[delegate ${id} 已取消${how}]\n${next}`,
    ...(stillAlive && !forced ? { isError: true as const } : {}),
  }
}

const sendAction = async (
  $: EngineInterface,
  input: Record<string, unknown>,
): Promise<{ result: string; isError?: true }> => {
  const id = idOfInput(input)
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (id === '') return { result: 'delegate_send 需要 id（delegate_list 里那个作业 id）', isError: true }
  if (message === '') return { result: 'delegate_send: message 不能为空', isError: true }
  const rec = await loadJob($, id)
  if (rec === undefined) return noSuchJob(id)
  if (rec.status !== 'running') {
    const hint = rec.sessionId === null ? '' : `；要接着做就用 resume ${rec.sessionId}，把要求写进 task`

    return { result: `delegate: ${id} 已经结束了（${statusText(rec.status)}），插不了话${hint}`, isError: true }
  }
  const root = await rootOf($)
  if (root === undefined) return { result: 'delegate: 找不到家目录，没法送消息', isError: true }
  const dir = jobDir(root, id)
  const status = await readStatus($, dir)
  if (status !== undefined && status.stream !== true) {
    return {
      result: 'delegate: 这个作业不是流式输入启动的（旧版本），插不了话；用 delegate_cancel 结束它再 resume 把要求写进 task。',
      isError: true,
    }
  }
  const file = `${dir}/inbox/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  try {
    await $.fs.write(file, JSON.stringify({ text: message, at: Date.now() }))
  } catch (error) {
    return { result: `delegate: 写不了消息文件：${messageOf(error)}`, isError: true }
  }

  return {
    result: `[delegate ${id}] 消息已送到 runner，它会在当前轮结束后把这条当作新一轮处理（不打断正在跑的工具）。用 delegate_status("${id}") 看它有没有接上。`,
  }
}

// 重启后补一件事：把“已完成但没通知”的后台作业补发一条，把“还在 running 但进程已经没了”的标成 orphaned。
const notifyDone = async ($: EngineInterface, rec: JobRecord): Promise<void> => {
  const root = await rootOf($)
  const dir = root === undefined ? undefined : jobDir(root, rec.jobId)
  const result = dir === undefined ? undefined : await readResult($, dir)
  const status = dir === undefined ? undefined : await readStatus($, dir)
  const text = result?.text ?? status?.lastText ?? result?.error ?? ''
  const agent = result?.sessionId ?? rec.sessionId
  const body = text.length > BG_INLINE ? `${text.slice(0, BG_INLINE)}\n…（已截断）` : text
  const state = rec.status === 'done' ? '完成' : rec.status === 'cancelled' ? '已取消' : '失败'
  const head = `【delegate 后台任务 ${rec.jobId} ${state}（重启后补发）】\n[agent ${agent ?? '?'} · ${rec.turns ?? '?'} 轮 · ${rec.tier} / ${rec.model === '' ? '?' : rec.model} · ${rec.mode}]`
  const next = agent === null || agent === undefined ? '' : `\n要接着做就用 resume ${agent}`
  await $.prompt.submit({ text: `${head}\n${body}${next}` })
}

const recoverJobs = async ($: EngineInterface): Promise<void> => {
  const records = await listJobs($)
  if (records.length === 0) return
  const root = await rootOf($)
  const me = await sessionOf($)
  const pending: JobRecord[] = []
  for (const rec of records) {
    if (rec.status === 'running') {
      const status = root === undefined ? undefined : await readStatus($, jobDir(root, rec.jobId))
      const alive = status?.pid === undefined ? false : await isAlive($, status.pid)
      if (alive) continue
      const result = root === undefined ? undefined : await readResult($, jobDir(root, rec.jobId))
      if (result !== undefined) {
        // runner 在宿主死后自己跑完了：按它留下的 result.json 收尾，再补一条通知。
        rec.status = result.ok ? 'done' : result.error === 'cancelled' ? 'cancelled' : 'failed'
        rec.endedAt = status?.endedAt ?? status?.updatedAt ?? Date.now()
        if (typeof result.turns === 'number') rec.turns = result.turns
        if (typeof result.sessionId === 'string' && result.sessionId !== '') rec.sessionId = result.sessionId
        if (!result.ok) rec.error = (result.error ?? '').slice(0, 300)
        await saveJob($, rec)
        if (rec.background) pending.push(rec)
      } else {
        // 宿主重启把 runner 带走了（或者它自己崩了）：还能 resume，标出来别当成还在跑。
        rec.status = 'orphaned'
        rec.endedAt = status?.updatedAt ?? status?.endedAt ?? Date.now()
        await saveJob($, rec)
      }
    } else if (
      rec.background &&
      rec.notified !== true &&
      (rec.status === 'done' || rec.status === 'failed' || rec.status === 'cancelled')
    ) {
      pending.push(rec)
    }
  }
  // 别的会话派的作业不在这里补发：那边恢复时自己会补。
  for (const rec of pending.filter(r => r.owner === undefined || r.owner === me).slice(0, 5)) {
    try {
      await notifyDone($, rec)
      rec.notified = true
      await saveJob($, rec)
    } catch (error) {
      $.ui.log(`delegate: 补发 ${rec.jobId} 的通知失败：${messageOf(error)}`, { to: 'debug' })
    }
  }
}

// ── 实时面板：左边作业列表，右边选中作业的进度、事件流、插话和取消 ──
const LIVE = 'delegate-live'
const liveSelAtom = atom({ plugin: 'delegate', key: 'liveSel' } as const, '')
const liveMsgAtom = atom({ plugin: 'delegate', key: 'liveMsg' } as const, '')
const liveNoteAtom = atom({ plugin: 'delegate', key: 'liveNote' } as const, '')
const liveTickAtom = atom({ plugin: 'delegate', key: 'liveTick' } as const, 0)
const liveMoreAtom = atom({ plugin: 'delegate', key: 'liveMore' } as const, false)
const liveAllAtom = atom({ plugin: 'delegate', key: 'liveAll' } as const, false)
// 事件区翻页：往前翻了几页（0 = 最新一页，跟着新事件走）
const livePageAtom = atom({ plugin: 'delegate', key: 'livePage' } as const, 0)
const PAGE = 12
const ROW_PICKED = '#2e2e2e'
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
const ROW_HOVER = '#252525'
let liveTimer: { cancel: () => void } | undefined

// GPT 额度：面板重绘时顺带查，一分钟最多一次；查完 tick 一下让面板重画。
const QUOTA_TTL = 60_000
let quota: GptQuota | undefined
let quotaAt = 0
let quotaPending = false

const refreshQuota = async ($: EngineInterface, force = false): Promise<void> => {
  if (quotaPending || (!force && Date.now() - quotaAt < QUOTA_TTL)) return
  quotaPending = true
  try {
    const ran = await $.process.run(['node', `${$.plugin.root}/scripts/gpt-quota.mjs`], { timeoutMs: 30_000 })
    const line = ran.stdout.trim().split('\n').at(-1) ?? ''
    try {
      quota = normalizeQuota(JSON.parse(line))
    } catch {
      quota = { ok: false, error: ran.stderr.trim().slice(0, 120) || '额度脚本没有输出' }
    }
  } catch (error) {
    quota = { ok: false, error: messageOf(error).slice(0, 120) }
  } finally {
    quotaAt = Date.now()
    quotaPending = false
  }
  await update($, liveTickAtom, n => n + 1)
}

// GPT 作业结束时附上订阅额度，方便主会话决定还能不能接着派 GPT。15 秒内查过就复用。
const gptQuotaLine = async ($: EngineInterface): Promise<string> => {
  if (Date.now() - quotaAt > 15_000) await refreshQuota($, true)
  if (quota === undefined) return ''
  if (!quota.ok) return `[GPT 额度查询失败：${quota.error}]`
  const now = Date.now()
  const at = (t: number): string => {
    const d = new Date(t)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const parts = quota.windows.map(w => {
    const reset = w.resetAt === undefined ? '' : `，${resetIn(w.resetAt, now)}（${at(w.resetAt)}）`
    return `${w.label}剩 ${Math.round(100 - w.used)}%${reset}`
  })
  const stale = quota.source === 'cached' ? `；缓存值，${Math.round((now - quota.at) / 60_000)} 分钟前` : ''

  return `[GPT 额度：${parts.join(' · ')}${quota.limitReached ? '；已触顶' : ''}${stale}]`
}

const AGENT_TAG: Record<Agent, { text: string; color: string; bg: string }> = {
  flash: { text: 'DS flash', color: '#6cb6ff', bg: '#132e4a' },
  pro: { text: 'DS pro', color: '#a8a2ff', bg: '#2a2556' },
  gpt: { text: 'GPT', color: '#4ac26b', bg: '#14331f' },
}
const DOT: Record<JobRecord['status'], { glyph: string; color: string }> = {
  running: { glyph: '●', color: 'suggestion' },
  done: { glyph: '●', color: 'success' },
  failed: { glyph: '●', color: 'error' },
  cancelled: { glyph: '○', color: 'inactive' },
  orphaned: { glyph: '◌', color: 'warning' },
}

// 每 2 秒看一眼：面板开着、有作业在跑、且作业状态确实变了才重绘；作业刚停时再画一次收尾。
// 不能无条件每秒重绘：宿主里每次读取都要跨进程，一次绘制可能超过 1 秒，会被下一次重绘打断，面板永远画不出来。
// 只在 session.start 里起一次：那里的 $ 跟会话一样长，派活钩子里的 $ 钩子返回就失效。
let liveWasRunning = false
let liveBusy = false
let liveSig = ''
const ensureLiveTimer = ($: EngineInterface): void => {
  if (liveTimer !== undefined) return
  try {
    liveTimer = $.clock.every(2000, () => {
      if (liveBusy) return
      liveBusy = true
      void (async () => {
        await pollLogin($)
        // 闲着时也按 TTL 刷新 GPT 额度，按钮栏才不会停在旧读数上（refreshQuota 自己会触发重绘）。
        await refreshQuota($)
        const running = (await listJobs($)).filter(r => r.status === 'running')
        if (running.length === 0 && !liveWasRunning) return
        const stopped = running.length === 0
        liveWasRunning = !stopped
        if (!stopped && !(await $.ui.panes()).some(p => p.id === LIVE)) return
        const root = await rootOf($)
        let sig = ''
        for (const r of running) {
          const st = root === undefined ? undefined : await readStatus($, jobDir(root, r.jobId))
          sig += `${r.jobId}:${st?.turns ?? 0}:${st?.updatedAt ?? 0};`
        }
        if (!stopped && sig === liveSig) return
        liveSig = sig
        await update($, liveTickAtom, n => n + 1)
      })()
        .catch(error => $.ui.log(`delegate: 面板计时出错：${messageOf(error)}`, { to: 'debug' }))
        .finally(() => {
          liveBusy = false
        })
    })
  } catch {
    liveTimer = undefined
  }
}

const showLive = async ($: EngineInterface, jobId?: string): Promise<void> => {
  try {
    if (jobId !== undefined) await update($, liveSelAtom, () => jobId)
    await $.ui.open({ id: LIVE, title: '委派任务' })
  } catch (error) {
    $.ui.log(`delegate: 实时面板打不开：${messageOf(error)}`, { to: 'debug' })
  }
}

// runner 在 events.jsonl 超过 512KB 时把它轮转成 events.1.jsonl：先读旧的再读新的，列表才不会在轮转时清空。
const readEventLines = async ($: EngineInterface, dir: string): Promise<string[]> => {
  const lines: string[] = []
  for (const name of ['events.1.jsonl', 'events.jsonl']) {
    try {
      lines.push(...(await $.fs.read(`${dir}/${name}`)).split('\n').filter(l => l.trim() !== ''))
    } catch {}
  }
  return lines
}

const liveSendAction = async ($: EngineInterface, id: string): Promise<void> => {
  const text = (await read($, liveMsgAtom)).trim()
  if (text === '') {
    await update($, liveNoteAtom, () => '先写一句要说的话')

    return
  }
  const out = await sendAction($, { id, message: text })
  await update($, liveMsgAtom, () => '')
  await update($, liveNoteAtom, () =>
    out.isError === true ? out.result.replace(/^delegate[^:：]*[:：]\s*/, '') : '已送达，它这一轮结束后处理',
  )
  await update($, liveTickAtom, n => n + 1)
}

const liveCancelAction = async ($: EngineInterface, id: string): Promise<void> => {
  await update($, liveNoteAtom, () => '正在取消…')
  const out = await cancelAction($, { id })
  await update($, liveNoteAtom, () => (out.isError === true ? out.result : '已取消，可用 agent ID 续跑'))
  await update($, liveTickAtom, n => n + 1)
}

const EVENT_ICON: Record<LiveEvent['kind'], { glyph: string; color: string }> = {
  tool: { glyph: '⚙', color: 'subtle' },
  text: { glyph: '✦', color: 'claude' },
  think: { glyph: '…', color: 'inactive' },
  you: { glyph: '›', color: 'suggestion' },
  end: { glyph: '■', color: 'success' },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: '管理委派用的供应商、API key 与 flash / pro 两个模型位（面板）；gpt 走本机 CPA，不用配置；也列作业、看进度、取消、插话',
        argumentHint: '[live | list | status <id> | cancel <id> | send <id> <话> | test flash|pro|gpt]',
        // 前台 delegate 调用会把主模型卡在工具调用上，取消只能靠人在这里下命令。
        immediate: true,
      })
      await describeTool($, await loadConfig($))
      await describeGpt($)
      await describeJobTools($)
      // 重启后：补发没发出去的后台通知，把进程没了的 running 标成 orphaned（仍可 resume）。
      await recoverJobs($)
      ensureLiveTimer($)
      await redraw($) // 会话就绪后补画一次按钮栏
    } catch (error) {
      $.ui.log(`delegate: ${messageOf(error)}`, { to: 'debug' })
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim()
    const [sub, ...rest] = args === '' ? [] : args.split(/\s+/)
    const tail = args.replace(/^\S+\s*/, '')
    if (sub === 'test') {
      await testAction($, rest[0] === 'gpt' ? 'gpt' : (parseTier(rest[0]) ?? 'flash'))

      return { text: await read($, flashAtom) }
    }
    if (sub === 'live') {
      await showLive($)

      return { text: '委派任务实时面板已打开。' }
    }
    if (sub === 'list') {
      return { text: (await listAction($, { limit: 20 })).result }
    }
    if (sub === 'status') {
      const out = await statusAction($, { id: rest[0] ?? '' })
      await update($, versionAtom, n => n + 1)

      return { text: out.result }
    }
    if (sub === 'cancel') {
      const out = await cancelAction($, { id: rest[0] ?? '' })
      await update($, versionAtom, n => n + 1)

      return { text: out.result }
    }
    if (sub === 'send') {
      const id = rest[0] ?? ''
      const message = tail.replace(/^\S+\s*/, '')
      const out = await sendAction($, { id, message })

      return { text: out.result }
    }
    await $.ui.open({ id: PANE, title: '委派：供应商与模型位' })

    return { text: '委派面板已打开。' }
  })

  for (const tier of TIERS) {
    on('tool.call', { tool: toolOf(tier) }, async ($, e) => {
      try {
        return await callTool($, tier, e as unknown as Record<string, unknown>)
      } catch (error) {
        return { result: `delegate: ${messageOf(error)}`, isError: true as const }
      }
    })
  }

  for (const tier of TIERS) {
  on('ui.render', { component: 'ToolUse', tool: toolOf(tier) }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const input = (typeof e.input === 'object' && e.input !== null ? e.input : {}) as Record<string, unknown>
    const label = callLabel(await loadConfig($), tier, {
      background: input.background === true,
      work: input.mode === 'work',
    })

    return (
      <Box>
        <Text bold>delegate</Text>
        <Text> {label}</Text>
        {e.isRunning && <Text dimColor> · 运行中…</Text>}
        {e.isErrored && <Text color="red"> · 失败</Text>}
      </Box>
    )
  })
  }

  on('tool.call', { tool: 'mcp__delegate__delegate_list' }, async ($, e) => {
    try {
      return await listAction($, e as unknown as Record<string, unknown>)
    } catch (error) {
      return { result: `delegate: ${messageOf(error)}`, isError: true as const }
    }
  })

  on('tool.call', { tool: 'mcp__delegate__delegate_status' }, async ($, e) => {
    try {
      return await statusAction($, e as unknown as Record<string, unknown>)
    } catch (error) {
      return { result: `delegate: ${messageOf(error)}`, isError: true as const }
    }
  })

  on('tool.call', { tool: 'mcp__delegate__delegate_cancel' }, async ($, e) => {
    try {
      return await cancelAction($, e as unknown as Record<string, unknown>)
    } catch (error) {
      return { result: `delegate: ${messageOf(error)}`, isError: true as const }
    }
  })

  on('tool.call', { tool: 'mcp__delegate__delegate_send' }, async ($, e) => {
    try {
      return await sendAction($, e as unknown as Record<string, unknown>)
    } catch (error) {
      return { result: `delegate: ${messageOf(error)}`, isError: true as const }
    }
  })

  on('tool.call', { tool: GPT_TOOL }, async ($, e) => {
    try {
      return await callTool($, 'gpt', e as unknown as Record<string, unknown>)
    } catch (error) {
      return { result: `delegate: ${messageOf(error)}`, isError: true as const }
    }
  })

  on('ui.render', { component: 'ToolUse', tool: GPT_TOOL }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const input = (typeof e.input === 'object' && e.input !== null ? e.input : {}) as Record<string, unknown>
    const model =
      typeof input.model === 'string' && input.model.trim() !== '' ? input.model.trim() : GPT_DEFAULT_MODEL
    const label = gptLabel(model, {
      background: input.background === true,
      work: input.mode === 'work',
    })

    return (
      <Box>
        <Text bold>delegate</Text>
        <Text> {label}</Text>
        {e.isRunning && <Text dimColor> · 运行中…</Text>}
        {e.isErrored && <Text color="red"> · 失败</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: LIVE }, async ($, e) => {
    // 绘制出错时把错误画出来，不留空白面板。
    try {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    await read($, liveTickAtom)
    const now = Date.now()
    const me = await sessionOf($)
    const showAll = await readLiveAll($)
    const everyJob = await listJobs($)
    const jobs = (showAll ? everyJob : everyJob.filter(r => mine(r, me))).slice(0, 30)
    const nOther = everyJob.filter(r => !mine(r, me)).length
    const scopeToggle = (
      <Button key="live-scope" plain dimColor onPress={() => writeLiveAll($, !showAll)}>
        {showAll ? '全部会话 · 只看本会话' : `本会话${nOther > 0 ? ` · 看全部（另有 ${nOther}）` : ''}`}
      </Button>
    )
    const root = await rootOf($)
    const live: Record<string, JobStatusFile> = {}
    if (root !== undefined) {
      for (const r of jobs) {
        if (r.status !== 'running') continue
        const s = await readStatus($, jobDir(root, r.jobId))
        if (s !== undefined) live[r.jobId] = s
      }
    }
    const want = await read($, liveSelAtom)
    const sel = jobs.find(r => r.jobId === want) ?? jobs.find(r => r.status === 'running') ?? jobs[0]
    const note = await read($, liveNoteAtom)
    const msg = await read($, liveMsgAtom)
    const elapsed = (r: JobRecord): number => (r.endedAt ?? (r.status === 'running' ? now : r.at)) - r.at
    const turnsOf = (r: JobRecord): number => live[r.jobId]?.turns ?? r.turns ?? 0
    const nRunning = jobs.filter(r => r.status === 'running').length
    // 旧版只记了 tier/cwd/mode/开始时间：没有摘要、结束时间和事件文件。
    const legacy = (r: JobRecord): boolean => r.status !== 'running' && r.endedAt === undefined && r.summary === ''
    const titleOf = (r: JobRecord): string =>
      r.summary !== '' ? r.summary : `${r.mode === 'work' ? '改动' : '只读'} · ${r.cwd.split('/').filter(Boolean).at(-1) ?? '旧任务'}`
    const metaOf = (r: JobRecord): string =>
      legacy(r)
        ? `${statusText(r.status)} · ${r.at > 0 ? `${spanOf(now - r.at)}前开始` : '时间未知'}`
        : `${statusText(r.status)} · 第 ${turnsOf(r)} 轮 · ${spanOf(elapsed(r))}`
    void refreshQuota($).catch(() => undefined)

    const more = await read($, liveMoreAtom)
    const shown = more ? jobs : jobs.slice(0, 6)
    const nDone = jobs.filter(r => r.status === 'done').length

    const quotaBox = (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={2} paddingY={1} overflow="hidden">
        <Box justifyContent="space-between">
          <Text>
            <Text weight="semibold">GPT 额度</Text>
            {quota?.ok === true && quota.plan !== '' && <Text dimColor> · {quota.plan}</Text>}
            {quota?.ok === true && quota.source === 'cached' && <Text color="warning"> · 缓存于 {spanOf(now - quota.at)}前</Text>}
            {quota?.ok === true && quota.limitReached && <Text color="error"> · 已触限</Text>}
          </Text>
          <Button key="live-quota-refresh" plain dimColor onPress={() => refreshQuota($, true)}>
            {quotaPending ? '查询中…' : '↻ 刷新'}
          </Button>
        </Box>
        {quota === undefined && <Text dimColor>查询中…</Text>}
        {quota?.ok === false && <Text dimColor>{quota.error}</Text>}
        {quota?.ok === true && (
          <Box flexDirection="column" marginTop={1}>
            {quota.windows.map(w => {
              const [usedBar, restBar] = barOf(w.used, 12)

              return (
                <Box key={`live-quota-${w.label}`}>
                  <Box width={10} flexShrink={0}>
                    <Text dimColor wrap="truncate">
                      {w.label}
                    </Text>
                  </Box>
                  <Text color={usedColor(w.used)}>{usedBar}</Text>
                  <Text color="inactive">{restBar}</Text>
                  <Box width={6} flexShrink={0} justifyContent="flex-end">
                    <Text weight="semibold" tabular>
                      {Math.round(w.used)}%
                    </Text>
                  </Box>
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    {resetIn(w.resetAt, now)}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )

    if (jobs.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          {quotaBox}
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={2} paddingY={1}>
            <Text weight="semibold">{showAll ? '还没有委派任务' : '本会话还没有委派任务'}</Text>
            <Text dimColor>派出 delegate_flash / pro / gpt 后，这里会实时显示它们在做什么。</Text>
            {scopeToggle}
          </Box>
        </Box>
      )
    }

    let events: LiveEvent[] = []
    let usage = { context: 0, output: 0 }
    if (sel !== undefined && root !== undefined) {
      const lines = await readEventLines($, jobDir(root, sel.jobId))
      events = liveEvents(lines, 400)
      usage = usageOf(lines)
    }
    const page = await read($, livePageAtom)
    const pages = Math.max(1, Math.ceil(events.length / PAGE))
    const at = Math.min(page, pages - 1)
    const end = events.length - at * PAGE
    const shownEvents = events.slice(Math.max(0, end - PAGE), end)
    // 已结束的作业不在 live 里：真实上下文仍在它的 status.json，不能退回事件流里 CPA 偏大的预估值。
    const s =
      sel === undefined
        ? undefined
        : (live[sel.jobId] ?? (root === undefined ? undefined : await readStatus($, jobDir(root, sel.jobId))))
    const current =
      sel?.status === 'running'
        ? s?.lastTool
          ? `正在调用 ${s.lastTool.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '')}`
          : (s?.phase ?? '启动中')
        : ''
    const stat = (label: string, value: string) => (
      <Box flexDirection="column" minWidth={9}>
        <Text dimColor size="footnote">
          {label}
        </Text>
        <Text weight="semibold" size="heading" tabular>
          {value}
        </Text>
      </Box>
    )
    const tagOf = (r: JobRecord) => {
      const t = AGENT_TAG[r.tier]

      // 放在第二行右侧，不挡标题；圆角边框做成胶囊样式。
      return (
        <Box flexShrink={0} borderStyle="round" borderColor={t.color} backgroundColor={t.bg} paddingX={1}>
          <Text color={t.color} size="footnote" weight="semibold" wrap="truncate">
            {t.text}
          </Text>
        </Box>
      )
    }

    const list = (
      <Box flexDirection="column" borderStyle="round" borderDimColor flexGrow={1} minWidth={30} overflow="hidden">
        <Box justifyContent="space-between" paddingX={2} paddingY={1}>
          <Text weight="semibold">☰ 委派任务</Text>
          <Text dimColor>
            运行中 {nRunning} · 已完成 {nDone}
          </Text>
        </Box>
        <Box paddingX={2} marginTop={-1} marginBottom={1}>
          {scopeToggle}
        </Box>
        {shown.map(r => {
          const dot = DOT[r.status]
          const picked = r.jobId === sel?.jobId
          const pick = async () => {
            await update($, livePageAtom, () => 0)
            await update($, liveSelAtom, () => r.jobId)
          }

          return (
            <Box
              key={`live-row-${r.jobId}`}
              flexDirection="column"
              paddingX={2}
              paddingY={1}
              backgroundColor={picked ? ROW_PICKED : undefined}
              hover={picked ? undefined : { backgroundColor: ROW_HOVER }}
            >
              <Button key={`live-pick-${r.jobId}`} plain onPress={pick}>
                <Text color={dot.color}>● </Text>
                <Text weight={picked ? 'semibold' : 'regular'} dimColor={legacy(r)}>
                  {clip(titleOf(r), 28)}
                </Text>
              </Button>
              <Box justifyContent="space-between" alignItems="center" gap={1}>
                <Button key={`live-meta-${r.jobId}`} plain dimColor onPress={pick}>
                  {`   ${metaOf(r)}`}
                </Button>
                {tagOf(r)}
              </Box>
            </Box>
          )
        })}
        {jobs.length > 6 && (
          <Box paddingX={2} paddingY={1}>
            <Button key="live-more" plain dimColor onPress={() => update($, liveMoreAtom, v => !v)}>
              {more ? '收起' : `显示更多（${jobs.length - 6}）`}
            </Button>
          </Box>
        )}
      </Box>
    )

    const detail = sel !== undefined && (
      <Box flexDirection="column" borderStyle="round" borderDimColor flexGrow={2} minWidth={30} overflow="hidden">
        <Box justifyContent="space-between" paddingX={2} paddingY={1} gap={1}>
          <Box flexDirection="column" flexShrink={1}>
            <Text weight="semibold" size="heading" wrap="wrap">
              {clip(titleOf(sel), 80)}
            </Text>
            <Text dimColor wrap="wrap">
              {[AGENT_TAG[sel.tier].text, sel.model, sel.mode, sel.jobId].filter(x => x !== '').join(' · ')}
            </Text>
          </Box>
          {sel.status === 'running' && (
            <Button key={`live-cancel-${sel.jobId}`} variant="secondary" onPress={() => liveCancelAction($, sel.jobId)}>
              ◻ 取消
            </Button>
          )}
        </Box>

        {legacy(sel) ? (
          <Box flexDirection="column" paddingX={2} paddingBottom={1}>
            <Text dimColor>{metaOf(sel)}</Text>
            <Text dimColor>这是旧版记录，只存了档位、目录和开始时间，没有保存过程。</Text>
            <Text dimColor wrap="truncate-middle">
              agent {sel.sessionId ?? '?'}
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box gap={3} paddingX={2} paddingY={1} borderStyle="single" borderDimColor>
              {stat('轮数', String(turnsOf(sel)))}
              {stat('用时', spanOf(elapsed(sel)))}
              {/* 优先用 runner 从 message_delta 取的真数；旧作业或没有该字段时退回事件流里的预估值。 */}
              {stat('上下文', tokensOf(s?.contextTokens ?? usage.context))}
              {/* 事件流里 assistant 行的 output_tokens 是 0，运行中只有 status.json 的 outputTokens 有数（runner 从
                  stream_event 里数出来）；跑完之后 result 行给的是总数，两边取大的那个。 */}
              {stat('输出', tokensOf(Math.max(usage.output, s?.outputTokens ?? 0)))}
            </Box>
            {usage.context === 0 && turnsOf(sel) > 0 && sel.tier !== 'gpt' && (
              <Box paddingX={2}>
                <Text dimColor size="footnote">
                  这条线路经 run_proxy，上游不回传用量，所以上下文和输出是空的；改走 CPA 后会有。
                </Text>
              </Box>
            )}
            <Box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
              {current !== '' && <Text color="suggestion">◌ {current}</Text>}
              {sel.status !== 'running' && <Text dimColor>{statusText(sel.status)}</Text>}
              <Box flexDirection="column" {...(e.surface === 'terminal' ? { height: PAGE + 1, overflow: 'hidden' as const } : {})}>
              {events.length > PAGE && (
                <Box justifyContent="space-between">
                  <Button key="live-older" plain dimColor onPress={() => update($, livePageAtom, p => Math.min(p + 1, pages - 1))}>
                    {at < pages - 1 ? '▲ 更早' : '　'}
                  </Button>
                  <Text dimColor size="footnote">{`${Math.max(1, end - PAGE + 1)}–${end} / ${events.length}`}</Text>
                  <Button key="live-newer" plain dimColor onPress={() => update($, livePageAtom, () => 0)}>
                    {at > 0 ? '▼ 最新' : '　'}
                  </Button>
                </Box>
              )}
              {events.length === 0 && <Text dimColor>还没有事件。</Text>}
              {shownEvents.map((ev, i) => {
                const icon = EVENT_ICON[ev.kind]

                return (
                  <Box key={`live-ev-${i}`} gap={1}>
                    <Text color={icon.color}>{icon.glyph}</Text>
                    {ev.kind === 'tool' ? (
                      <Text wrap="truncate-end">
                        <Text>{ev.title} </Text>
                        <Text mono dimColor>
                          {clip(ev.detail, 72)}
                        </Text>
                      </Text>
                    ) : ev.kind === 'you' ? (
                      <Text color="suggestion" wrap="truncate-end">
                        你：{ev.detail}
                      </Text>
                    ) : ev.kind === 'end' ? (
                      <Text wrap="truncate-end">
                        <Text color="success">{ev.title} </Text>
                        <Text dimColor>{ev.detail}</Text>
                      </Text>
                    ) : ev.kind === 'think' ? (
                      <Text dimColor italic wrap="truncate-end">
                        {ev.detail}
                      </Text>
                    ) : (
                      <Text weight="medium" wrap="truncate-end">
                        {ev.detail}
                      </Text>
                    )}
                  </Box>
                )
              })}
              </Box>
            </Box>
          </Box>
        )}

        {sel.status === 'running' && (
          <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="single" borderDimColor>
            <Input
              key={`live-msg-${sel.jobId}`}
              placeholder="补充一句要求，回车发送"
              value={msg}
              submitLabel="➤ 插话"
              onInput={v => {
                void update($, liveMsgAtom, () => v)
                if (note !== '') void update($, liveNoteAtom, () => '')
              }}
              onSubmit={() => liveSendAction($, sel.jobId)}
            />
            <Text dimColor color={note.startsWith('先写') ? 'error' : undefined}>
              {note !== '' ? note : '插话会在它当前这一轮结束后处理'}
            </Text>
          </Box>
        )}
        {sel.status !== 'running' && note !== '' && (
          <Box paddingX={2} paddingBottom={1}>
            <Text dimColor>{note}</Text>
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1} overflow="hidden">
        {quotaBox}
        <Box flexWrap="wrap" gap={1} alignItems="flex-start" overflow="hidden">
          {list}
          {detail}
        </Box>
      </Box>
    )
    } catch (error) {
      $.ui.log(`delegate live: ${messageOf(error)}`, { to: 'debug' })
      const { Text } = $.ui.resolve(e)
      return <Text color="error">{`实时面板出错：${messageOf(error)}`}</Text>
    }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // 绘制里出任何错都会让整条栏消失（还可能连累链下面的 hook），所以整体兜住，出错就退回别的 mod 和引擎的画。
    let drawn: Awaited<ReturnType<typeof next>> | undefined
    try {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e)
    drawn = below
    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, liveTickAtom)
    await read($, versionAtom)
    const me = await sessionOf($)
    const nRunning = (await listJobs($)).filter(r => r.status === 'running' && mine(r, me)).length
    // 额度只在已有的计时器（ensureLiveTimer 每 2 秒）里刷新：绘制路径里不许 update，绘制中 state.set 会被拒。
    const five = quota?.ok === true ? quota.windows.find(w => w.label === '5 小时') : undefined
    // Button 只收字符串和 Text：条件部分先拼好，不留 false。
    const parts = [
      <Text key="d" color={nRunning > 0 ? 'suggestion' : 'inactive'}>
        {nRunning > 0 ? '◆ ' : '◇ '}
      </Text>,
      <Text key="n">委派</Text>,
      <Text key="s" dimColor>
        {nRunning > 0 ? ` · 运行中 ${nRunning}` : ' · 无运行'}
      </Text>,
    ]
    if (five !== undefined) {
      parts.push(
        <Text key="g" dimColor>
          {' · GPT 5h '}
        </Text>,
        <Text key="gp" color={usedColor(five.used)}>
          {`${Math.round(five.used)}%`}
        </Text>,
      )
    }
    parts.push(
      <Text key="o" dimColor>
        {' ›'}
      </Text>,
    )

    return (
      <Box flexWrap="wrap" columnGap={4} alignItems="center">
        <Button key="delegate-open-live" plain onPress={() => showLive($)}>
          {parts}
        </Button>
        {below}
      </Box>
    )
    } catch (error) {
      $.ui.log(`delegate bar: ${messageOf(error)}`, { to: 'debug' })

      // next 已经调用过就用它的结果；没调用过就让下面的 hook 和引擎照常画。
      return drawn ?? (await next(e))
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text, Select } = $.ui.resolve(e)
    await read($, versionAtom)
    const config = await loadConfig($)
    if (!paneLoaded) {
      try { await refreshProviders($); await refreshAccounts($) } catch { /* refresh button permits retry */ }
    }
    const draft = await read($, draftAtom)
    const note = await read($, flashAtom)
    const card = (key: string, title: string, body: unknown) => <Box key={key} flexDirection="column" overflow="hidden" borderStyle="round" borderDimColor paddingX={2} gap={1}><Button key={'section-' + key} plain onPress={() => paneAction($, async () => { paneTab = key; if (key === 'gpt') await refreshQuota($) })}>{title + (paneTab === key ? ' ▾' : ' ▸')}</Button>{paneTab === key ? [body] : []}</Box>
    const button = (key: string, label: string, fn: () => Promise<void>) => <Button key={key} plain onPress={() => paneAction($, fn)}>{label}</Button>
    const modelOptions = cpaProviders.flatMap(p => p.models.map(m => ({ label: (config.providers.find(x => x.id === p.id)?.name || p.name) + ' / ' + m, value: JSON.stringify([p.id, m]) })))
    const slots = TIERS.map(tier => {
      const slot = config.slots[tier]
      return <Box key={tier} flexDirection="column">
        <Select key={tier + '-model'} label={tier + ' 模型'} options={[{ label: '未设置', value: '' }, ...modelOptions]} value={slot ? JSON.stringify([slot.providerId, slot.modelId]) : ''} onSelect={v => paneAction($, async () => {
          if (!v) { await changeAction($, c => clearSlot(c, tier), '已清空'); return }
          const [provider, modelId] = JSON.parse(v) as string[]
          await changeAction($, c => setSlot(c, tier, { provider, modelId }), '模型位已保存')
        })} />
        <Select key={tier + '-effort'} label="推理强度" options={EFFORT_CHOICES.map(value => ({ value, label: value === 'default' ? '默认' : value }))} value={slot?.effort || 'default'} onSelect={v => effortAction($, tier, v)} />
      </Box>
    })
    const providerRows = cpaProviders.slice(providerPage * 2, providerPage * 2 + 2).map(p => <Box key={p.id} flexDirection="column" overflow="hidden">
      <Text weight="semibold">{config.providers.find(x => x.id === p.id)?.name || p.name}{' · ' + p.protocol + ' · ' + p.keyMask}</Text>
      <Text wrap="truncate-middle">{p.baseUrl}</Text>
      <Text wrap="truncate-end">{'模型：' + (p.models.join('、') || '未添加')}</Text>
      <Box gap={2}>{[
        button('edit-' + p.id, '编辑 / 模型', () => editProvider($, p)),
        button('delete-' + p.id, delArmed === p.id ? '确认删除？' : '删除', () => removeProviderAction($, p.id, p.name)),
      ]}</Box>
    </Box>)
    const providerControls = [
      button('refresh-cpa', '刷新', async () => { await refreshProviders($); await refreshAccounts($); await refreshQuota($, true) }),
      button('new-provider', '＋ 添加供应商', () => editProvider($)),
      button('provider-prev', '上一页', async () => { providerPage = Math.max(0, providerPage - 1) }),
      button('provider-next', '下一页', async () => { providerPage = Math.min(Math.max(0, Math.ceil(cpaProviders.length / 2) - 1), providerPage + 1) }),
    ]
    const editor = []
    if (editId !== undefined) {
      const p = cpaProviders.find(p => p.id === editId)
      const modelRows = (p?.models || []).slice(addedPage * 4, addedPage * 4 + 4).map(m => <Box key={'added-' + m} gap={1}><Text wrap="truncate-middle">{m}</Text>{button('remove-' + m, '移除', async () => {
        await saveProvider($, (p?.models || []).filter(x => x !== m))
        const c = await loadConfig($)
        for (const t of TIERS) if (c.slots[t]?.providerId === p?.id && c.slots[t]?.modelId === m) c.slots[t] = null
        await saveConfig($, c)
      })}</Box>)
      const choices = fetched.slice(modelPage * 5, modelPage * 5 + 5).map(m => button('fetch-' + m, (selected.includes(m) ? '☑ ' : '☐ ') + m, async () => { selected = selected.includes(m) ? selected.filter(x => x !== m) : [...selected, m] }))
      editor.push(<Box key="editor" flexDirection="column" borderStyle="single" borderDimColor overflow="hidden" paddingX={1}>
        <Text>{editId ? '编辑 ' + editId : '新供应商'}</Text>
        <Input key="pName" label="名称" value={draft.pName} onInput={v => setDraftField($, 'pName', v)} onSubmit={() => paneAction($, () => saveProvider($))} />
        <Select key="protocol" label="协议" options={['chat', 'responses', 'anthropic'].map(value => ({ value, label: value }))} value={editProtocol} onSelect={async v => { editProtocol = v; await redraw($) }} />
        <Input key="pUrl" label="base-url" value={draft.pUrl} onInput={v => setDraftField($, 'pUrl', v)} onSubmit={() => paneAction($, () => saveProvider($))} />
        <Input key="pKey" label="key（留空保留）" value={draft.pKey} onInput={v => setDraftField($, 'pKey', v)} onSubmit={() => paneAction($, () => saveProvider($))} />
        <Box gap={2}>{[
          button('save-provider', '保存', () => saveProvider($)),
          button('fetch-models', '获取模型', async () => { await saveProvider($); fetched = (await admin($, 'fetch-models', { id: editId })).models || []; selected = []; modelPage = 0 }),
          button('close-editor', '收起', async () => { editId = undefined; await setDraftField($, 'pKey', '') }),
        ]}</Box>
        {modelRows}
        <Box gap={1}>{[
          button('added-prev', '已添加上一页', async () => { addedPage = Math.max(0, addedPage - 1) }),
          button('added-next', '已添加下一页', async () => { addedPage = Math.min(Math.max(0, Math.ceil((p?.models.length || 0) / 4) - 1), addedPage + 1) }),
        ]}</Box>
        {choices}
        <Box gap={1}>{[
          button('model-prev', '候选上一页', async () => { modelPage = Math.max(0, modelPage - 1) }),
          button('model-next', '候选下一页', async () => { modelPage = Math.min(Math.max(0, Math.ceil(fetched.length / 5) - 1), modelPage + 1) }),
          button('add-selected', '添加选中（' + selected.length + '）', async () => { const current = cpaProviders.find(p => p.id === editId); await saveProvider($, [...new Set([...(current?.models || []), ...selected])]); selected = [] }),
        ]}</Box>
      </Box>)
    }
    const gptControls = [
      button('quota', '刷新用量', async () => { await refreshQuota($, true) }),
      button('login', '登录新账号', () => startLogin($)),
      button('accounts', '刷新账号', () => refreshAccounts($)),
    ]
    if (loginState) gptControls.push(button('cancel-login', '取消登录', async () => { await admin($, 'gpt-login-cancel', { state: loginState }); loginState = ''; loginUrl = '' }))
    const gptRows = cpaAccounts.map(a => <Box key={a.name} gap={1}><Text wrap="truncate-middle">{(a.email || a.name) + (a.disabled ? ' · 禁用' : ' · 启用')}</Text>{button('use-' + a.name, '使用', async () => { await admin($, 'gpt-use', { name: a.name }); await refreshAccounts($) })}</Box>)
    const quotaRows = quota?.ok ? quota.windows.map(w => <Text key={w.label}>{w.label + ' 已用 ' + w.used + '% ' + resetIn(w.resetAt, Date.now())}</Text>) : [<Text key="no-quota" dimColor>{quota && !quota.ok ? quota.error : '点击刷新用量查看 GPT 额度'}</Text>]
    return <Box flexDirection="column" overflow="hidden" gap={1}>
      <Text wrap="truncate-end">{note}</Text>
      {card('slots', '模型位', <Box flexDirection="column">{slots}</Box>)}
      {card('providers', '供应商 · CPA', <Box flexDirection="column" overflow="hidden">{providerRows}<Box gap={1}>{providerControls}</Box>{editor}</Box>)}
      {card('gpt', 'GPT · ChatGPT 订阅', <Box flexDirection="column" overflow="hidden">{quotaRows}<Box gap={1}>{gptControls}</Box><Text wrap="truncate-middle">{loginUrl}</Text>{gptRows}</Box>)}
      <Text dimColor>供应商密钥仅保存在本机 CPA 配置中。</Text>
    </Box>
  })
}