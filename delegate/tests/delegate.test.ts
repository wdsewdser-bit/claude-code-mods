import { describe, expect, test } from 'claude-code/testing'

import {
  addProvider,
  clearSlot,
  normalize,
  removeProvider,
  resolveTier,
  SEED,
  migrationPlan,
  isEffort,
  setSlot,
  toolDescription,
  callLabel,
} from '../hooks/lib/config.ts'
import {
  GPT_DEFAULT_MODEL,
  GPT_MODELS,
  gptLabel,
  gptModelOf,
  gptToolDescription,
} from '../hooks/lib/gpt.ts'
import {
  eventLine,
  formatList,
  formatStatus,
  jobsRootOf,
  jobKey,
  normalizeReadPaths,
  normalizeRecord,
  normalizeStatus,
  pidMatches,
  spanOf,
  summarize,
  uuid,
} from '../hooks/lib/jobs.ts'
import { liveEvents, tokensOf, usageOf } from '../hooks/lib/jobs.ts'
import type { JobRecord } from '../hooks/lib/jobs.ts'
import { barOf, normalizeQuota, resetIn, usedColor } from '../hooks/lib/quota.ts'
import { addModel, terminalOf } from '../hooks/lib/terminal.ts'

const withKey = () => normalize(undefined)

describe('config', () => {
  test('starts with Command Code in both slots, key unset', () => {
    const c = normalize(undefined)
    expect(c.slots.flash?.modelId).toBe('deepseek/deepseek-v4.1-flash')
    expect(c.slots.pro).not.toBeNull()
    expect(c.providers).toEqual([{ id: 'command', name: 'Command Code' }])
    expect(resolveTier(c, 'flash')).toMatchObject({ modelId: 'command/deepseek/deepseek-v4.1-flash' })
  })

  test('resolves a tier to url, model id and key', () => {
    expect(resolveTier(withKey(), 'flash')).toMatchObject({
      modelId: 'command/deepseek/deepseek-v4.1-flash',
    })
  })

  test('points pro at another provider without touching flash', () => {
    const p = addProvider(withKey(), {
      name: 'OpenCode Go',
    })
    const s = setSlot(p.config, 'pro', { provider: 'opencode go', modelId: 'deepseek-pro' })
    expect(s.error).toBeUndefined()
    expect(resolveTier(s.config, 'pro')).toMatchObject({
      providerName: 'OpenCode Go',
      modelId: 'opencode-go/deepseek-pro',
    })
    expect(resolveTier(s.config, 'flash')).toMatchObject({ providerName: 'Command Code' })
  })

  test('an empty field keeps what the slot already has', () => {
    const c = withKey()
    const onlyModel = setSlot(c, 'flash', { provider: '', modelId: 'new-model' }).config
    expect(onlyModel.slots.flash).toEqual({ providerId: 'command', modelId: 'new-model' })
    const onlyProvider = setSlot(c, 'flash', { provider: 'Command Code', modelId: '' }).config
    expect(onlyProvider.slots.flash?.modelId).toBe('deepseek/deepseek-v4.1-flash')
  })

  test('refuses what cannot work', () => {
    const c = normalize(undefined)
    expect(addProvider(c, { name: '' }).error).toBeDefined()
    expect(setSlot(c, 'pro', { provider: 'nobody', modelId: 'm' }).error).toContain('没有叫')
    expect(
      setSlot(clearSlot(c, 'pro').config, 'pro', { provider: '', modelId: 'm' }).error,
    ).toContain('还没有供应商')
  })

  test('removing a provider empties the slots that used it', () => {
    const c = removeProvider(normalize(undefined), 'command').config
    expect(c.slots).toEqual({ flash: null, pro: null })
    expect(resolveTier(c, 'flash')).toHaveProperty('error')
  })

  test('survives garbage in the store', () => {
    expect(normalize({ providers: 'x', slots: [1, null] }).providers).toEqual([])
    expect(normalize(42).slots.flash).not.toBeNull()
  })

  test('the call label shows tier, provider, model and how it runs', () => {
    const c = normalize(undefined)
    expect(callLabel(c, 'flash', { background: false, work: false })).toBe('flash · Command Code / deepseek/deepseek-v4.1-flash · 前台 · 只读')
    expect(callLabel(c, 'pro', { background: true, work: true })).toContain('后台 · 可改文件')
    expect(callLabel(clearSlot(c, 'pro').config, 'pro', { background: false, work: false })).toContain('未设置')
  })

  test('effort: keeps valid values, drops invalid ones, old configs have none', () => {
    const base = normalize(undefined)
    const raw = (effort: unknown) => ({
      providers: base.providers,
      slots: { flash: { providerId: 'command', modelId: 'm', effort }, pro: { providerId: 'command', modelId: 'm' } },
    })
    expect(normalize(raw('max')).slots.flash?.effort).toBe('max')
    expect(normalize(raw('off')).slots.flash?.effort).toBe('off')
    expect(normalize(raw('high')).slots.flash?.effort).toBe('high')
    expect(normalize(raw('low')).slots.flash?.effort).toBe('low')
    expect(normalize(raw('ultra')).slots.flash).toEqual({ providerId: 'command', modelId: 'm' })
    expect(normalize(raw(3)).slots.flash?.effort).toBeUndefined()
    expect(normalize(raw('max')).slots.pro?.effort).toBeUndefined()
    expect(base.slots.flash?.effort).toBeUndefined()
  })

  test('setSlot sets, keeps, clears and rejects effort', () => {
    const c = withKey()
    const set = setSlot(c, 'flash', { provider: '', modelId: '', effort: 'max' })
    expect(set.error).toBeUndefined()
    expect(set.config.slots.flash?.effort).toBe('max')
    const kept = setSlot(set.config, 'flash', { provider: '', modelId: 'other' })
    expect(kept.config.slots.flash).toEqual({ providerId: 'command', modelId: 'other', effort: 'max' })
    const blank = setSlot(set.config, 'flash', { provider: '', modelId: 'other', effort: '' })
    expect(blank.config.slots.flash?.effort).toBe('max')
    const cleared = setSlot(set.config, 'flash', { provider: '', modelId: '', effort: 'default' })
    expect(cleared.config.slots.flash?.effort).toBeUndefined()
    expect(cleared.config.slots.flash?.modelId).toBe('deepseek/deepseek-v4.1-flash')
    const bad = setSlot(set.config, 'flash', { provider: '', modelId: '', effort: 'ultra' })
    expect(bad.error).toBe('推理强度只能是 low、medium、high、xhigh、max、off 或 default（留空不改）')
    expect(bad.config).toBe(set.config)
    expect(setSlot(c, 'pro', { provider: '', modelId: '', effort: 'off' }).config.slots.pro?.effort).toBe('off')
  })

  test('resolveTier carries effort and callLabel shows it', () => {
    const c = setSlot(withKey(), 'flash', { provider: '', modelId: 'deepseek-v4.1-flash', effort: 'max' }).config
    expect(resolveTier(c, 'flash')).toMatchObject({ effort: 'max' })
    expect(resolveTier(c, 'pro')).not.toHaveProperty('effort')
    expect(callLabel(c, 'flash', { background: false, work: false })).toBe(
      'flash · Command Code / deepseek-v4.1-flash · max · 前台 · 只读',
    )
    expect(callLabel(c, 'pro', { background: false, work: false })).not.toContain('·  max')
  })

  test('migration strips store secrets only in the returned plan and keeps both models', () => {
    const raw = { providers: [{ id: 'command', name: 'Command Code', url: 'https://example.test/v1/chat/completions', key: 'test-secret' }], slots: SEED.slots }
    const plan = migrationPlan(raw)
    expect(plan.providers).toEqual([{ id: 'command', name: 'Command Code', protocol: 'chat', baseUrl: 'https://example.test/v1', key: 'test-secret', models: ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro'] }])
    expect(plan.config.providers).toEqual([{ id: 'command', name: 'Command Code' }])
    expect(JSON.stringify(plan.config)).not.toContain('test-secret')
    expect(raw.providers[0].key).toBe('test-secret')
    expect(migrationPlan(plan.config).providers).toEqual([])
    expect(migrationPlan(null).providers).toEqual([])
  })
  test('CPA efforts round trip and metadata normalization deduplicates', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'off']) {
      expect(isEffort(effort)).toBe(true)
      const result = setSlot(normalize(undefined), 'flash', { provider: '', modelId: '', effort })
      expect(normalize(result.config).slots.flash?.effort).toBe(effort)
      expect(resolveTier(result.config, 'flash')).toMatchObject({ effort })
    }
    expect(isEffort('default')).toBe(false)
    expect(isEffort(null)).toBe(false)
    expect(normalize({ providers: [{ id: 'x', name: 'X', key: 'secret', url: 'https://x' }, { id: 'x' }], slots: {} }).providers).toEqual([{ id: 'x', name: 'X' }])
  })
  test('the tool description names tiers and no model', () => {
    const d = toolDescription(normalize(undefined))
    expect(d).toContain('flash')
    expect(d).toContain('pro')
    expect(d).not.toContain('deepseek')
  })
})

describe('gpt', () => {
  test('defaults to gpt-6.1-sol and refuses an unknown model instead of swapping it', () => {
    expect(gptModelOf(undefined)).toBe('gpt-6.1-sol')
    expect(gptModelOf('')).toBe('gpt-6.1-sol')
    expect(gptModelOf(' gpt-6-astra ')).toBe('gpt-6-astra')
    expect(GPT_DEFAULT_MODEL).toBe('gpt-6.1-sol')
    expect(GPT_MODELS).toContain('gpt-6-astra')
    expect(GPT_MODELS).toContain('gpt-6.1-terra')
    const bad = gptModelOf('gpt-9')
    expect(typeof bad === 'object' && 'error' in bad && bad.error.includes('未知的 GPT 模型')).toBe(true)
  })

  test('the label shows the subscription and the model', () => {
    expect(gptLabel(GPT_DEFAULT_MODEL, { background: false, work: true })).toBe(
      'gpt · ChatGPT 订阅 / gpt-6.1-sol · 前台 · 可改文件',
    )
    expect(gptLabel('gpt-6-astra', { background: true, work: false })).toContain('后台 · 只读')
  })

  test('the description names the hard tasks, the subscription and astra as the rare choice', () => {
    const d = gptToolDescription()
    expect(d).toContain('后端实现')
    expect(d).toContain('代码审查')
    expect(d).toContain('ChatGPT 订阅')
    expect(d).toContain('gpt-6-astra')
    expect(d).toContain('高难')
    expect(d).not.toContain('deepseek')
  })
})

describe('delegate tool', () => {
  const QUOTA = { ok: true, source: 'live', at: 0, plan: 'plus', limitReached: false, windows: [{ label: '5 小时', used: 85, resetAt: Date.now() + 7_200_000 }, { label: '本周', used: 25 }] }

  const setup = (on: never, key: string, reply: Record<string, unknown>) => {
    const store = new Map<string, unknown>([
      ['cfg', normalize(undefined)],
    ])
    const jobs: Record<string, unknown>[] = []
    const files = new Map<string, string>()
    const submitted: string[] = []
    const o = on as (name: string, fn: (_$: unknown, e: never) => unknown) => void
    o('session.start', (_$, e: { cwd: string }) => ({ cwd: e.cwd }))
    o('tool.call', () => ({ deny: 'no such tool' }))
    o('store.get', (_$, e: { key: string }) => ({ value: store.get(e.key) }))
    o('store.set', (_$, e: { key: string; value: unknown }) => {
      store.set(e.key, e.value)
      return { value: undefined }
    })
    o('command.register', (_$, e: { name: string }) => ({ value: { command: e.name } }))
    o('tool.register', (_$, e: { name: string }) => ({
      value: { tool: `mcp__delegate__${e.name}` },
    }))
    o('env.get', () => ({ value: 'C:\\Users\\t' }))
    o('fs.write', (_$, e: { path: string; text: string }) => {
      files.set(e.path, e.text)
      return { value: undefined }
    })
    const paths = new Map<string, 'dir' | 'file'>([
      ['/work', 'dir'],
      ['/proj', 'dir'],
      ['/file.txt', 'file'],
    ])
    o('fs.stat', (_$, e: { path: string }) => {
      // the engine hands an absolute Windows path even for '/proj': C:\proj
      const key = e.path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').toLowerCase()
      const kind = paths.get(key)
      if (kind === undefined) throw new Error('ENOENT')
      return { value: { kind, size: 0, mtimeMs: 0, isLink: false } }
    })
    o('prompt.submit', (_$, e: { text: string }) => {
      submitted.push(e.text)
      return { text: e.text }
    })
    o('process.run', (_$, e: { argv?: string[]; init?: { stdin?: string } }) => {
      // GPT 作业结束时会查一次额度，那不是派活。
      const quota = e.argv?.some(a => a.endsWith('gpt-quota.mjs')) === true
      if (!quota) jobs.push(JSON.parse(e.init?.stdin ?? '{}'))
      return {
        value: {
          exitCode: 0,
          stdout: quota ? `${JSON.stringify(QUOTA)}\n` : `${JSON.stringify(reply)}\n`,
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    })

    return Object.assign(jobs, { files, submitted, store })
  }

  const call = ($: never, input: Record<string, unknown>) =>
    ($ as { tool: { call: (i: never) => Promise<unknown> } }).tool.call({
      tool: `mcp__delegate__delegate_${input.tier ?? 'flash'}`,
      ...input,
    } as never)

  const start = ($: never) =>
    ($ as { session: { start: (i: never) => Promise<unknown> } }).session.start({
      cwd: '/work',
      surface: null,
      isInteractive: true,
    } as never)

  test('runs the job with the tier resolved and returns the text', { timeoutMs: 10_000 }, async ($, on) => {
    const jobs = setup(on as never, 'k-1', { ok: true, text: 'found it', turns: 2, ms: 3000 })
    await start($ as never)
    const ran = await call($ as never, { task: 'find x', tier: 'flash' })
    expect(JSON.stringify(ran)).toContain('found it')
    expect(jobs[0]).toMatchObject({ model: 'command/deepseek/deepseek-v4.1-flash', mode: 'read' })
  })

  test('defaults to flash and takes pro when asked', { timeoutMs: 10_000 }, async ($, on) => {
    const jobs = setup(on as never, 'k-1', { ok: true, text: 'x', sessionId: 's', turns: 1, ms: 1 })
    await start($ as never)
    await call($ as never, { task: 'a' })
    await call($ as never, { task: 'b', tier: 'pro' })
    expect(jobs[0]).toMatchObject({ model: 'command/deepseek/deepseek-v4.1-flash' })
    expect(jobs[1]).toMatchObject({ model: 'command/deepseek/deepseek-v4-pro' })
  })

  test('CPA supplies keys; jobs never carry provider secrets', { timeoutMs: 10_000 }, async ($, on) => {
    const jobs = setup(on as never, '', { ok: true, text: 'no' })
    await start($ as never)
    const ran = await call($ as never, { task: 'find x' })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).not.toHaveProperty('key')
    expect(jobs[0]).not.toHaveProperty('url')
  })

  test('resume continues the same agent with its remembered tier and directory', { timeoutMs: 10_000 }, async ($, on) => {
    const jobs = setup(on as never, 'k-1', {
      ok: true,
      text: 'first',
      sessionId: 'sid-1',
      turns: 1,
      ms: 1000,
    })
    await start($ as never)
    const first = await call($ as never, { task: 'a', tier: 'pro', cwd: '/proj' })
    expect(JSON.stringify(first)).toContain('agent sid-1')
    await call($ as never, { task: 'b', tier: 'pro', resume: 'sid-1' })
    expect(jobs[1]).toMatchObject({ resume: 'sid-1', cwd: '/proj', model: 'command/deepseek/deepseek-v4-pro' })
    const unknown = await call($ as never, { task: 'c', resume: 'nope' })
    expect(JSON.stringify(unknown)).toContain('没有 ID')
    expect(jobs).toHaveLength(2)
  })

  test('resume keeps the mode the agent last ran with, and says which mode it used', { timeoutMs: 10_000 }, async ($: never, on: never) => {
    const jobs = setup(on as never, 'k-1', {
      ok: true,
      text: 'done',
      sessionId: 'sid-1',
      turns: 1,
      ms: 1000,
    })
    await start($ as never)
    await call($ as never, { task: 'a', tier: 'pro', cwd: '/proj', mode: 'work' })
    expect(jobs[0]).toMatchObject({ mode: 'work' })
    const resumed = await call($ as never, { task: 'b', tier: 'pro', resume: 'sid-1' })
    expect(jobs[1]).toMatchObject({ resume: 'sid-1', cwd: '/proj', mode: 'work' })
    expect(JSON.stringify(resumed)).toContain('work')
    const readAgain = await call($ as never, { task: 'c', tier: 'pro', resume: 'sid-1', mode: 'read' })
    expect(jobs[2]).toMatchObject({ resume: 'sid-1', mode: 'read', ptc: 'only' })
    expect(JSON.stringify(readAgain)).toContain('read')
  })

  test('resume keeps ptc, and fills in mode on a note that never recorded it', { timeoutMs: 10_000 }, async ($: never, on: never) => {
    const jobs = setup(on as never, 'k-1', {
      ok: true,
      text: 'done',
      sessionId: 'sid-2',
      turns: 1,
      ms: 1000,
    })
    await start($ as never)
    await call($ as never, { task: 'a', ptc: 'off' })
    expect(jobs[0]).toMatchObject({ mode: 'read', ptc: false })
    await call($ as never, { task: 'b', resume: 'sid-2' })
    expect(jobs[1]).toMatchObject({ mode: 'read', ptc: false })

    jobs.store.set('jobs', { legacy: { tier: 'flash', cwd: '/proj', at: 1 } })
    const legacy = await call($ as never, { task: 'c', resume: 'legacy' })
    expect(jobs[2]).toMatchObject({ resume: 'legacy', mode: 'read', ptc: 'only' })
    expect(JSON.stringify(legacy)).toContain('read')
    expect(
      (jobs.store.get('jobs') as Record<string, { mode?: string; ptc?: string }>).legacy,
    ).toMatchObject({ mode: 'read', ptc: 'only' })
  })

  test('readPaths reach the runner only for read + ptc:only, and resume inherits them', { timeoutMs: 10_000 }, async ($: never, on: never) => {
    const jobs = setup(on as never, 'k-1', { ok: true, text: 'done', sessionId: 'sid-rp', turns: 1, ms: 1 })
    await start($ as never)
    // 新任务：传了就进 job，也记进作业记录
    await call($ as never, { task: 'a', cwd: '/proj', readPaths: ['/ext/one', '/ext/two/'] })
    expect(jobs[0]).toMatchObject({ mode: 'read', ptc: 'only', readPaths: ['/ext/one', '/ext/two'] })
    const rec = jobOf(jobs.store, String(jobs[0]?.jobId))
    expect(rec.readPaths).toEqual(['/ext/one', '/ext/two'])
    // 旧表镜像里也带着，外部脚本能读到
    expect((jobs.store.get('jobs') as Record<string, { readPaths?: string[] }>)['sid-rp']?.readPaths).toEqual(['/ext/one', '/ext/two'])
    // resume 没传：沿用上次的
    await call($ as never, { task: 'b', resume: 'sid-rp' })
    expect(jobs[1]).toMatchObject({ resume: 'sid-rp', readPaths: ['/ext/one', '/ext/two'] })
    // resume 传了：以传入为准（空数组 = 明确不要）
    await call($ as never, { task: 'c', resume: 'sid-rp', readPaths: ['/ext/three'] })
    expect(jobs[2]).toMatchObject({ readPaths: ['/ext/three'] })
    await call($ as never, { task: 'd', resume: 'sid-rp', readPaths: [] })
    expect(jobs[3]).not.toHaveProperty('readPaths')
    // work 模式、ptc:'off' 都不带（只读沙箱之外没有意义）
    await call($ as never, { task: 'e', mode: 'work', readPaths: ['/ext/one'] })
    expect(jobs[4]).not.toHaveProperty('readPaths')
    await call($ as never, { task: 'f', ptc: 'off', readPaths: ['/ext/one'] })
    expect(jobs[5]).not.toHaveProperty('readPaths')
  })

  test('readPaths survive garbage: only absolute-looking strings are kept, duplicates dropped', { timeoutMs: 10_000 }, async ($: never, on: never) => {
    const jobs = setup(on as never, 'k-1', { ok: true, text: 'done', sessionId: 'sid-rp2', turns: 1, ms: 1 })
    await start($ as never)
    await call($ as never, { task: 'a', readPaths: [' C:/Ext/One/ ', 'c:/ext/one', '', 'C:/ext/two', 42] })
    expect(jobs[0]).toMatchObject({ readPaths: ['C:/Ext/One', 'C:/ext/two'] })
    await call($ as never, { task: 'b', readPaths: 'not-an-array' })
    expect(jobs[1]).not.toHaveProperty('readPaths')
  })

  test('a bad cwd fails before the runner starts, foreground and background', { timeoutMs: 10_000 }, async ($: never, on: never) => {
    const jobs = setup(on as never, 'k-1', { ok: true, text: 'never' })
    await start($ as never)
    const missing = await call($ as never, { task: 'a', cwd: '/nope' })
    expect(JSON.stringify(missing)).toContain('cwd 不存在：/nope')
    const notDir = await call($ as never, { task: 'b', cwd: '/file.txt' })
    expect(JSON.stringify(notDir)).toContain('cwd 不是目录：/file.txt')
    const background = await call($ as never, { task: 'c', cwd: '/nope', background: true })
    expect(JSON.stringify(background)).toContain('cwd 不存在：/nope')
    expect(jobs).toHaveLength(0)
    expect(jobs.submitted).toHaveLength(0)
  })

  test('gpt runs through CPA: default model, no url or key in the job', { timeoutMs: 10_000 }, async ($, on) => {
    const jobs = setup(on as never, 'k-1', { ok: true, text: 'gpt did it', sessionId: 'sid-g', turns: 2, ms: 1000 })
    await start($ as never)
    const ran = await call($ as never, { task: 'fix the parser', tier: 'gpt', mode: 'work' })
    expect(JSON.stringify(ran)).toContain('gpt did it')
    expect(jobs[0]).toMatchObject({ gpt: true, model: 'gpt-6.1-sol', mode: 'work' })
    expect(jobs[0]).not.toHaveProperty('url')
    expect(jobs[0]).not.toHaveProperty('key')
    expect(JSON.stringify(ran)).toContain('gpt')
  })

  test('gpt needs no provider key at all', { timeoutMs: 10_000 }, async ($, on) => {
    const jobs = setup(on as never, '', { ok: true, text: 'no key needed' })
    await start($ as never)
    const ran = await call($ as never, { task: 'review this', tier: 'gpt' })
    expect(JSON.stringify(ran)).toContain('no key needed')
    expect(jobs[0]).toMatchObject({ gpt: true, mode: 'read', ptc: 'only' })
  })

  test('gpt takes astra when asked, passes effort, and refuses an unknown model', { timeoutMs: 10_000 }, async ($, on) => {
    const jobs = setup(on as never, 'k-1', { ok: true, text: 'hard one', sessionId: 'sid-a', turns: 1, ms: 1 })
    await start($ as never)
    await call($ as never, { task: 'think', tier: 'gpt', model: 'gpt-6-astra', effort: 'max' })
    expect(jobs[0]).toMatchObject({ model: 'gpt-6-astra', effort: 'max' })
    const bad = await call($ as never, { task: 'x', tier: 'gpt', model: 'gpt-9' })
    expect(JSON.stringify(bad)).toContain('未知的 GPT 模型')
    expect(jobs).toHaveLength(1)
  })

  test('resume keeps a gpt agent on the gpt path', { timeoutMs: 10_000 }, async ($, on) => {
    const jobs = setup(on as never, 'k-1', { ok: true, text: 'done', sessionId: 'sid-g2', turns: 1, ms: 1 })
    await start($ as never)
    await call($ as never, { task: 'a', tier: 'gpt', cwd: '/proj', mode: 'work' })
    await call($ as never, { task: 'b', tier: 'gpt', resume: 'sid-g2' })
    expect(jobs[1]).toMatchObject({ gpt: true, resume: 'sid-g2', cwd: '/proj', mode: 'work', model: 'gpt-6.1-sol' })
  })

  test('resume keeps the gpt model and effort unless new ones are passed', { timeoutMs: 10_000 }, async ($, on) => {
    const jobs = setup(on as never, 'k-1', { ok: true, text: 'done', sessionId: 'sid-g3', turns: 1, ms: 1 })
    await start($ as never)
    await call($ as never, { task: 'a', tier: 'gpt', model: 'gpt-6-astra', effort: 'xhigh' })
    await call($ as never, { task: 'b', tier: 'gpt', resume: 'sid-g3' })
    expect(jobs[1]).toMatchObject({ resume: 'sid-g3', model: 'gpt-6-astra', effort: 'xhigh' })
    await call($ as never, { task: 'c', tier: 'gpt', resume: 'sid-g3', model: 'gpt-6.1-sol', effort: 'high' })
    expect(jobs[2]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' })
  })

  test('a gpt result carries the subscription quota, a ds result does not', { timeoutMs: 10_000 }, async ($, on) => {
    setup(on as never, 'k-1', { ok: true, text: 'done', sessionId: 'sid-q', turns: 1, ms: 1 })
    await start($ as never)
    const gptRan = JSON.stringify(await call($ as never, { task: 'a', tier: 'gpt' }))
    expect(gptRan).toContain('GPT 额度：5 小时剩 15%')
    expect(gptRan).toContain('后重置')
    expect(gptRan).toContain('本周剩 75%')
    const started = JSON.stringify(await call($ as never, { task: 'c', tier: 'gpt', background: true }))
    expect(started).toContain('后台任务 bg-')
    expect(started).toContain('GPT 额度：5 小时剩 15%')
    const dsRan = JSON.stringify(await call($ as never, { task: 'b' }))
    expect(dsRan).not.toContain('GPT 额度')
  })

  test('gpt effort never goes below medium', { timeoutMs: 10_000 }, async ($, on) => {
    const jobs = setup(on as never, 'k-1', { ok: true, text: 'done', sessionId: 'sid-g4', turns: 1, ms: 1 })
    await start($ as never)
    await call($ as never, { task: 'a', tier: 'gpt' })
    await call($ as never, { task: 'b', tier: 'gpt', effort: 'low' })
    expect(jobs[0]).toMatchObject({ effort: 'medium' })
    expect(jobs[1]).toMatchObject({ effort: 'medium' })
  })

  test('background returns at once and reports through a prompt when done', { timeoutMs: 10_000 }, async ($, on) => {
    const jobs = setup(on as never, 'k-1', { ok: true, text: 'late result', sessionId: 'sid-9', turns: 3, ms: 5000 })
    await start($ as never)
    const ran = await call($ as never, { task: 'long job', background: true })
    expect(JSON.stringify(ran)).toContain('后台任务 bg-')
    expect(JSON.stringify(ran)).not.toContain('late result')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(jobs.submitted).toHaveLength(1)
    expect(jobs.submitted[0]).toContain('完成')
    expect(jobs.submitted[0]).toContain('late result')
    expect(jobs.submitted[0]).toContain('agent sid-9')
    expect([...jobs.files.values()][0]).toContain('late result')
  })
})

// ---- 作业持久化 / 列出 / 进度 / 取消 / 插话 / 重启恢复 -------------------------

const HOME = 'C:\\Users\\t'
const ROOT = 'C:/Users/t/.claude/delegate/jobs'
const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)

type Files = Map<string, string>

const jobSetup = (
  on: never,
  reply: Record<string, unknown>,
  opts: { files?: Files; alive?: number[] } = {},
) => {
  const store = new Map<string, unknown>([
    ['cfg', normalize(undefined)],
  ])
  const runs: Record<string, unknown>[] = []
  const seen: Record<string, JobRecord>[] = []
  const files: Files = opts.files ?? new Map<string, string>()
  const alive = new Set<number>(opts.alive ?? [])
  const submitted: string[] = []
  const registered: string[] = []
  const killed: string[] = []
  const o = on as (name: string, fn: (_$: unknown, e: never) => unknown) => void

  o('session.start', (_$, e: { cwd: string }) => ({ cwd: e.cwd }))
  o('session.cwd', () => ({ value: '/work' }))
  o('tool.call', () => ({ deny: 'no such tool' }))
  o('store.get', (_$, e: { key: string }) => ({ value: store.get(e.key) }))
  o('store.set', (_$, e: { key: string; value: unknown }) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  o('store.keys', () => ({ value: [...store.keys()] }))
  o('store.delete', (_$, e: { key: string }) => {
    store.delete(e.key)
    return { value: undefined }
  })
  o('command.register', (_$, e: { name: string }) => ({ value: { command: e.name } }))
  o('tool.register', (_$, e: { name: string }) => {
    registered.push(e.name)
    return { value: { tool: `mcp__delegate__${e.name}` } }
  })
  o('env.get', () => ({ value: HOME }))
  o('fs.write', (_$, e: { path: string; text: string }) => {
    files.set(normPath(e.path), e.text)
    return { value: undefined }
  })
  o('fs.read', (_$, e: { path: string }) => {
    const text = files.get(normPath(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  o('fs.exists', (_$, e: { path: string }) => ({ value: files.has(normPath(e.path)) }))
  o('fs.list', () => ({ value: [] }))
  const kinds = new Map<string, 'dir' | 'file'>([
    ['/work', 'dir'],
    ['/proj', 'dir'],
    ['/file.txt', 'file'],
  ])
  o('fs.stat', (_$, e: { path: string }) => {
    const key = e.path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').toLowerCase()
    const kind = kinds.get(key)
    if (kind === undefined) throw new Error('ENOENT')
    return { value: { kind, size: 0, mtimeMs: 0, isLink: false } }
  })
  o('prompt.submit', (_$, e: { text: string }) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  o('clock.sleep', () => ({ value: undefined }))
  o('process.run', (_$, e: { argv?: string[]; init?: { stdin?: string }; stdin?: string }) => {
    const argv = e.argv ?? []
    if (argv[0] === 'tasklist') {
      const pid = Number(/PID eq (\d+)/.exec(argv[2] ?? '')?.[1] ?? 0)
      return {
        value: {
          exitCode: 0,
          stdout: alive.has(pid) ? `"node.exe","${pid}","Console","1","1 K"` : 'INFO: No tasks are running',
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    if (argv[0] === 'taskkill') {
      killed.push(argv.join(' '))
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    seen.push(
      Object.fromEntries(
        [...store.entries()]
          .filter(([k]) => k.startsWith('job:'))
          .map(([k, v]) => [k, normalizeRecord(v, k.slice('job:'.length)) as JobRecord]),
      ),
    )
    runs.push(JSON.parse(e.init?.stdin ?? e.stdin ?? '{}'))
    return {
      value: {
        exitCode: 0,
        stdout: `${JSON.stringify(reply)}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  return { store, runs, seen, files, submitted, registered, killed, alive }
}

const jobCall = ($: never, tool: string, args: Record<string, unknown>) =>
  ($ as { tool: { call: (i: never) => Promise<unknown> } }).tool.call({ tool, ...args } as never)

const startSession = ($: never) =>
  ($ as { session: { start: (i: never) => Promise<unknown> } }).session.start({
    cwd: '/work',
    surface: null,
    isInteractive: true,
  } as never)

const text = (v: unknown): string => JSON.stringify(v)

const jobOf = (store: Map<string, unknown>, id: string): JobRecord =>
  normalizeRecord(store.get(jobKey(id)), id) as JobRecord

describe('jobs', () => {
  test('a call records itself before the runner starts and updates when it ends', { timeoutMs: 10_000 }, async ($, on) => {
    const t = jobSetup(on as never, { ok: true, text: 'found it', sessionId: 'sid-1', turns: 2, ms: 10 })
    await startSession($ as never)
    const ran = await jobCall($ as never, 'mcp__delegate__delegate_flash', { task: 'find the parser bug' })
    expect(text(ran)).toContain('found it')
    // 启动那一刻 store 里已经有这条作业（宿主重启也丢不了）
    expect(Object.keys(t.seen[0] ?? {})).toHaveLength(1)
    const id = Object.keys(t.seen[0] ?? {})[0]?.replace('job:', '') ?? ''
    expect(id.startsWith('fg-')).toBe(true)
    const started = t.seen[0]?.[jobKey(id)] as JobRecord
    expect(started.status).toBe('running')
    expect(started.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(started.summary).toBe('find the parser bug')
    // 跑完：状态、agent id、轮数都写回去了
    const done = jobOf(t.store, id)
    expect(done.status).toBe('done')
    expect(done.sessionId).toBe('sid-1')
    expect(done.turns).toBe(2)
    expect(t.store.get('agent:sid-1')).toBe(id)
    expect((t.store.get('jobs') as Record<string, { status: string }>)['sid-1']?.status).toBe('done')
    // runner 拿到 jobId、stream 和生成好的 session id
    expect(t.runs[0]).toMatchObject({ jobId: id, stream: true, mode: 'read', ptc: 'only' })
    expect(String(t.runs[0]?.sessionId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('a resume passes --resume and no new session id', { timeoutMs: 10_000 }, async ($, on) => {
    const t = jobSetup(on as never, { ok: true, text: 'again', sessionId: 'sid-1', turns: 1, ms: 5 })
    await startSession($ as never)
    await jobCall($ as never, 'mcp__delegate__delegate_flash', { task: 'a' })
    await jobCall($ as never, 'mcp__delegate__delegate_flash', { task: 'b', resume: 'sid-1' })
    expect(t.runs[1]).toMatchObject({ resume: 'sid-1' })
    expect(t.runs[1]).not.toHaveProperty('sessionId')
  })

  test('a resume falls back to this session directory when the old one is gone', { timeoutMs: 10_000 }, async ($, on) => {
    const t = jobSetup(on as never, { ok: true, text: 'kept going', sessionId: 'sid-2', turns: 1, ms: 5 })
    await startSession($ as never)
    // 一条旧作业，目录已经不在了
    t.store.set('job:fg-old', {
      jobId: 'fg-old',
      sessionId: 'sid-2',
      tier: 'flash',
      model: 'm',
      cwd: '/gone',
      mode: 'read',
      ptc: 'only',
      background: false,
      status: 'done',
      at: 1,
      summary: 'old',
    })
    t.store.set('agent:sid-2', 'fg-old')
    const ran = await jobCall($ as never, 'mcp__delegate__delegate_flash', { task: 'continue', resume: 'sid-2' })
    expect(text(ran)).toContain('kept going')
    expect(t.runs[0]).toMatchObject({ resume: 'sid-2', cwd: '/work' })
    expect(text(ran)).not.toContain('cwd 不存在')
  })

  test('a gpt resume idle past the cold limit with a large context is held once', { timeoutMs: 10_000 }, async ($, on) => {
    const t = jobSetup(on as never, { ok: true, text: 'kept going', sessionId: 'sid-c', turns: 1, ms: 5 })
    await startSession($ as never)
    const old = (jobId: string, sessionId: string, tier: string) => {
      t.store.set(`job:${jobId}`, {
        jobId, sessionId, tier, model: 'm', cwd: '/work', mode: 'read', ptc: 'only',
        background: false, status: 'done', at: 1, endedAt: Date.now() - 4 * 3_600_000, summary: 'old',
      })
      t.store.set(`agent:${sessionId}`, jobId)
      const usage = { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 120_000, output_tokens: 10 } } }
      t.files.set(normPath(`${HOME}/.claude/delegate/jobs/${jobId}/events.jsonl`), `${JSON.stringify(usage)}\n`)
    }
    // GPT 结束时查额度也走 process.run，只数真正的派活。
    const dispatched = () => t.runs.filter(r => r.task !== undefined)
    old('fg-c', 'sid-c', 'gpt')
    const held = text(await jobCall($ as never, 'mcp__delegate__delegate_gpt', { task: 'continue', resume: 'sid-c' }))
    expect(held).toContain('提示缓存很可能已经过期')
    expect(dispatched()).toHaveLength(0)
    const again = text(await jobCall($ as never, 'mcp__delegate__delegate_gpt', { task: 'continue', resume: 'sid-c' }))
    expect(again).toContain('kept going')
    expect(dispatched()).toHaveLength(1)
    old('fg-d', 'sid-d', 'flash')
    const ds = text(await jobCall($ as never, 'mcp__delegate__delegate_flash', { task: 'continue', resume: 'sid-d' }))
    expect(ds).not.toContain('提示缓存')
    expect(dispatched()).toHaveLength(2)
  })

  test('delegate_list shows id, agent, tier, status, cwd and summary; filters by status', { timeoutMs: 10_000 }, async ($, on) => {
    const t = jobSetup(on as never, { ok: true, text: 'x', sessionId: 'sid-3', turns: 1, ms: 5 })
    await startSession($ as never)
    await jobCall($ as never, 'mcp__delegate__delegate_pro', { task: 'review the diff', cwd: '/proj', mode: 'work' })
    const listed = await jobCall($ as never, 'mcp__delegate__delegate_list', {})
    const body = text(listed)
    expect(body).toContain('共 1 个作业')
    expect(body).toContain('review the diff')
    expect(body).toContain('sid-3')
    expect(body).toContain('pro')
    expect(body).toContain('完成')
    expect(body).toContain('cwd /proj')
    const empty = await jobCall($ as never, 'mcp__delegate__delegate_list', { status: 'running' })
    expect(text(empty)).toContain('没有状态为')
    const bad = await jobCall($ as never, 'mcp__delegate__delegate_list', { status: 'nope' })
    expect(text(bad)).toContain('status 只能是')
    expect(t.registered).toContain('delegate_list')
  })

  test('delegate_status reads the runner status file and the tail of its events', { timeoutMs: 10_000 }, async ($, on) => {
    const files: Files = new Map()
    const t = jobSetup(on as never, { ok: true, text: 'x', sessionId: 'sid-4', turns: 1, ms: 5 }, { files })
    await startSession($ as never)
    await jobCall($ as never, 'mcp__delegate__delegate_flash', { task: 'look around' })
    const id = String(t.runs[0]?.jobId)
    t.files.set(
      `${ROOT}/${id}/status.json`,
      JSON.stringify({
        jobId: id,
        pid: 4242,
        childPid: 4243,
        sessionId: 'sid-4',
        phase: 'working',
        stream: true,
        turns: 3,
        lastTool: 'Bash',
        lastText: 'checking the parser',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    t.files.set(
      `${ROOT}/${id}/events.jsonl`,
      [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
        JSON.stringify({ type: 'result', result: 'half way', is_error: false }),
        '',
      ].join('\n'),
    )
    const status = await jobCall($ as never, 'mcp__delegate__delegate_status', { id })
    const body = text(status)
    expect(body).toContain('runner 阶段 working')
    expect(body).toContain('轮数：3')
    expect(body).toContain('最后工具：Bash')
    expect(body).toContain('checking the parser')
    expect(body).toContain('runner pid 4242')
    expect(body).toContain('用工具 Read')
    expect(body).toContain('result ok：half way')
    const missing = await jobCall($ as never, 'mcp__delegate__delegate_status', { id: 'nope' })
    expect(text(missing)).toContain('没有作业')
  })

  test('delegate_cancel writes the cancel file and returns the agent id', { timeoutMs: 10_000 }, async ($, on) => {
    const files: Files = new Map()
    const t = jobSetup(on as never, { ok: true, text: 'x', sessionId: 'sid-5', turns: 1, ms: 5 }, { files })
    await startSession($ as never)
    await jobCall($ as never, 'mcp__delegate__delegate_flash', { task: 'long one' })
    const id = String(t.runs[0]?.jobId)
    // 把它当成还在跑
    const rec = jobOf(t.store, id)
    t.store.set(jobKey(id), { ...rec, status: 'running', endedAt: undefined, turns: undefined })
    t.files.set(
      `${ROOT}/${id}/status.json`,
      JSON.stringify({ jobId: id, pid: 5150, phase: 'working', startedAt: rec.at, updatedAt: Date.now() }),
    )
    const out = await jobCall($ as never, 'mcp__delegate__delegate_cancel', { id })
    expect(t.files.has(`${ROOT}/${id}/cancel`)).toBe(true)
    expect(text(out)).toContain('已取消')
    expect(text(out)).toContain('sid-5')
    expect(jobOf(t.store, id).status).toBe('cancelled')
    // 进程已经没了，不该 taskkill
    expect(t.killed).toHaveLength(0)
    const again = await jobCall($ as never, 'mcp__delegate__delegate_cancel', { id })
    expect(text(again)).toContain('已经结束')
  })

  test('delegate_cancel falls back to taskkill on the pid it recorded', { timeoutMs: 10_000 }, async ($, on) => {
    const files: Files = new Map()
    const t = jobSetup(on as never, { ok: true, text: 'x', sessionId: 'sid-6', turns: 1, ms: 5 }, { files, alive: [5151] })
    await startSession($ as never)
    await jobCall($ as never, 'mcp__delegate__delegate_flash', { task: 'stuck' })
    const id = String(t.runs[0]?.jobId)
    const rec = jobOf(t.store, id)
    t.store.set(jobKey(id), { ...rec, status: 'running', endedAt: undefined })
    t.files.set(
      `${ROOT}/${id}/status.json`,
      JSON.stringify({ jobId: id, pid: 5151, phase: 'working', startedAt: rec.at, updatedAt: Date.now() }),
    )
    const out = await jobCall($ as never, 'mcp__delegate__delegate_cancel', { id })
    expect(t.killed[0]).toBe('taskkill /PID 5151 /T /F')
    expect(text(out)).toContain('已取消')
    expect(jobOf(t.store, id).status).toBe('cancelled')
  })

  test('delegate_cancel will not kill a pid whose start time does not match', { timeoutMs: 10_000 }, async ($, on) => {
    const files: Files = new Map()
    const t = jobSetup(on as never, { ok: true, text: 'x', sessionId: 'sid-7', turns: 1, ms: 5 }, { files, alive: [5152] })
    await startSession($ as never)
    await jobCall($ as never, 'mcp__delegate__delegate_flash', { task: 'hmm' })
    const id = String(t.runs[0]?.jobId)
    const rec = jobOf(t.store, id)
    t.store.set(jobKey(id), { ...rec, status: 'running', endedAt: undefined })
    // pid 是别人的（开始时间差了一小时）
    t.files.set(
      `${ROOT}/${id}/status.json`,
      JSON.stringify({ jobId: id, pid: 5152, phase: 'working', startedAt: rec.at - 3_600_000, updatedAt: Date.now() }),
    )
    const out = await jobCall($ as never, 'mcp__delegate__delegate_cancel', { id })
    expect(t.killed).toHaveLength(0)
    expect(text(out)).toContain('没有强杀')
  })

  test('delegate_send drops a message into the job inbox', { timeoutMs: 10_000 }, async ($, on) => {
    const files: Files = new Map()
    const t = jobSetup(on as never, { ok: true, text: 'x', sessionId: 'sid-8', turns: 1, ms: 5 }, { files })
    await startSession($ as never)
    await jobCall($ as never, 'mcp__delegate__delegate_flash', { task: 'watch the tests' })
    const id = String(t.runs[0]?.jobId)
    const rec = jobOf(t.store, id)
    t.store.set(jobKey(id), { ...rec, status: 'running', endedAt: undefined })
    t.files.set(
      `${ROOT}/${id}/status.json`,
      JSON.stringify({ jobId: id, pid: 6160, phase: 'working', stream: true, startedAt: rec.at, updatedAt: Date.now() }),
    )
    const out = await jobCall($ as never, 'mcp__delegate__delegate_send', { id, message: 'also check the parser' })
    const inbox = [...t.files.keys()].filter(k => k.startsWith(`${ROOT}/${id}/inbox/`))
    expect(inbox).toHaveLength(1)
    expect(JSON.parse(t.files.get(inbox[0] ?? '') ?? '{}').text).toBe('also check the parser')
    expect(text(out)).toContain('已送到')
    const empty = await jobCall($ as never, 'mcp__delegate__delegate_send', { id, message: '  ' })
    expect(text(empty)).toContain('不能为空')
    // 结束了的作业插不了话
    t.store.set(jobKey(id), { ...rec, status: 'done', endedAt: Date.now() })
    const late = await jobCall($ as never, 'mcp__delegate__delegate_send', { id, message: 'hi' })
    expect(text(late)).toContain('插不了话')
  })

  test('session.start marks a dead running job orphaned and re-sends a missed notification once', { timeoutMs: 10_000 }, async ($, on) => {
    const files: Files = new Map()
    const t = jobSetup(on as never, { ok: true, text: 'x' }, { files })
    const at = Date.now() - 60_000
    t.store.set('job:bg-dead', {
      jobId: 'bg-dead',
      sessionId: 'sid-dead',
      tier: 'flash',
      model: 'm',
      cwd: '/work',
      mode: 'read',
      ptc: 'only',
      background: true,
      status: 'running',
      at,
      summary: 'was still running',
    })
    t.store.set('job:bg-late', {
      jobId: 'bg-late',
      sessionId: 'sid-late',
      tier: 'gpt',
      model: 'gpt-6.1-sol',
      cwd: '/work',
      mode: 'work',
      ptc: 'only',
      background: true,
      status: 'done',
      at,
      turns: 4,
      summary: 'finished before the restart',
    })
    t.files.set(`${ROOT}/bg-dead/status.json`, JSON.stringify({ jobId: 'bg-dead', pid: 7777, phase: 'working', startedAt: at, updatedAt: at }))
    t.files.set(`${ROOT}/bg-late/result.json`, JSON.stringify({ ok: true, text: 'late finding', sessionId: 'sid-late', turns: 4 }))
    await startSession($ as never)
    expect(jobOf(t.store, 'bg-dead').status).toBe('orphaned')
    expect(t.submitted).toHaveLength(1)
    expect(t.submitted[0]).toContain('重启后补发')
    expect(t.submitted[0]).toContain('late finding')
    expect(t.submitted[0]).toContain('sid-late')
    expect(jobOf(t.store, 'bg-late').notified).toBe(true)
    // 再来一个会话：不重复补发
    await startSession($ as never)
    expect(t.submitted).toHaveLength(1)
  })

  test('a live job is left running by session.start', { timeoutMs: 10_000 }, async ($, on) => {
    const files: Files = new Map()
    const t = jobSetup(on as never, { ok: true, text: 'x' }, { files, alive: [8888] })
    const at = Date.now()
    t.store.set('job:bg-live', {
      jobId: 'bg-live',
      sessionId: 'sid-live',
      tier: 'flash',
      model: 'm',
      cwd: '/work',
      mode: 'read',
      ptc: 'only',
      background: true,
      status: 'running',
      at,
      summary: 'still working',
    })
    t.files.set(`${ROOT}/bg-live/status.json`, JSON.stringify({ jobId: 'bg-live', pid: 8888, phase: 'working', startedAt: at, updatedAt: at }))
    await startSession($ as never)
    expect(jobOf(t.store, 'bg-live').status).toBe('running')
    expect(t.submitted).toHaveLength(0)
  })
})

describe('job records', () => {
  test('uuid makes a v4-shaped id', () => {
    const id = uuid()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(uuid()).not.toBe(uuid())
  })

  test('summarize keeps one short line', () => {
    expect(summarize('  find\n the  bug ')).toBe('find the bug')
    expect(summarize('x'.repeat(300)).endsWith('…')).toBe(true)
    expect(summarize('x'.repeat(300)).length).toBe(101)
  })

  test('the jobs directory sits under the home directory', () => {
    expect(jobsRootOf('C:\\Users\\t')).toBe('C:/Users/t/.claude/delegate/jobs')
    expect(jobsRootOf('C:/Users/t/')).toBe('C:/Users/t/.claude/delegate/jobs')
    expect(jobsRootOf(undefined)).toBeUndefined()
  })

  test('readPaths are cleaned, de-duplicated and kept on the record', () => {
    expect(normalizeReadPaths([' C:/a/ ', 'c:/A', '', 'D:\\b\\', 7, null])).toEqual(['C:/a', 'D:\\b'])
    expect(normalizeReadPaths('C:/a')).toEqual([])
    expect(normalizeReadPaths(undefined)).toEqual([])
    expect(normalizeReadPaths(['C:/'])).toEqual(['C:'])
    const rec = normalizeRecord({ tier: 'pro', at: 5, readPaths: ['C:/ext/'] }, 'fg-2')
    expect(rec?.readPaths).toEqual(['C:/ext'])
    expect(normalizeRecord({ tier: 'pro', at: 5, readPaths: [] }, 'fg-3')).not.toHaveProperty('readPaths')
    expect(normalizeRecord({ tier: 'pro', at: 5 }, 'fg-4')).not.toHaveProperty('readPaths')
    // 进度里能看见额外目录
    const shown = formatStatus(rec, undefined, [], undefined, 5)
    expect(shown).toContain('额外可读目录：C:/ext')
  })

  test('a record survives garbage and fills what is missing', () => {
    expect(normalizeRecord(undefined, 'x')).toBeUndefined()
    const rec = normalizeRecord({ tier: 'pro', at: 5 }, 'fg-1')
    expect(rec).toMatchObject({ jobId: 'fg-1', tier: 'pro', mode: 'read', ptc: 'only', status: 'done', at: 5 })
    expect(normalizeStatus({ pid: 'x', turns: 2 })).toEqual({
      stream: false,
      turns: 2,
      lastTool: null,
      lastText: '',
    })
  })

  test('pid matching needs the same job and a close start time', () => {
    const rec = normalizeRecord({ jobId: 'a', at: 1_000_000 }, 'a') as JobRecord
    expect(pidMatches({ jobId: 'a', pid: 5, startedAt: 1_000_500 }, rec)).toBe(true)
    expect(pidMatches({ jobId: 'b', pid: 5, startedAt: 1_000_500 }, rec)).toBe(false)
    expect(pidMatches({ jobId: 'a', pid: 5, startedAt: 1_000_000 + 600_000 }, rec)).toBe(false)
    expect(pidMatches({ jobId: 'a', startedAt: 1_000_000 }, rec)).toBe(false)
    expect(pidMatches(undefined, rec)).toBe(false)
  })

  test('the list shows the state and how to pick the agent back up', () => {
    const now = Date.now()
    const rec = normalizeRecord(
      { jobId: 'bg-1', sessionId: 'sid-1', tier: 'flash', model: 'm', cwd: 'C:/p', mode: 'work', background: true, status: 'orphaned', at: now - 120_000, summary: 'fix the parser' },
      'bg-1',
    ) as JobRecord
    const out = formatList([rec], { now, limit: 10, filter: '', live: {} })
    expect(out).toContain('共 1 个作业')
    expect(out).toContain('bg-1')
    expect(out).toContain('已中断')
    expect(out).toContain('fix the parser')
    expect(out).toContain('resume "sid-1"')
    expect(spanOf(120_000)).toBe('2 分 0 秒')
    expect(formatStatus(undefined, undefined, [], undefined, now)).toContain('没有这条作业')
  })

  test('an event line reads like a sentence', () => {
    expect(eventLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }))).toBe('assistant 用工具 Bash')
    expect(eventLine(JSON.stringify({ type: 'result', result: 'done', is_error: false }))).toBe('result ok：done')
    expect(eventLine('not json')).toBe('not json')
  })
})

describe('live pane helpers', () => {
  const asst = (id: string, content: unknown[], usage: Record<string, number>) =>
    JSON.stringify({ type: 'assistant', message: { id, content, usage } })
  const lines = [
    asst('m1', [{ type: 'tool_use', name: 'mcp__ptc-run__run_code', input: { code: '// read\nawait tools.read({path:"a.py"})' } }], { input_tokens: 10, cache_read_input_tokens: 990, output_tokens: 40 }),
    asst('m1', [{ type: 'text', text: '先读  文件' }], { input_tokens: 10, cache_read_input_tokens: 990, output_tokens: 60 }),
    JSON.stringify({ type: 'sent', text: '顺便看 config.py' }),
    asst('m2', [{ type: 'tool_use', name: 'Bash', input: { command: 'pytest -q' } }], { input_tokens: 5, cache_read_input_tokens: 1995, output_tokens: 30 }),
    JSON.stringify({ type: 'result', is_error: false, result: '改好了' }),
    'not json',
  ]
  test('liveEvents keeps tools, text, your messages and the result in order', () => {
    expect(liveEvents(lines)).toEqual([
      { kind: 'tool', title: 'run_code', detail: 'await tools.read({path:"a.py"})' },
      { kind: 'text', title: '', detail: '先读 文件' },
      { kind: 'you', title: '', detail: '顺便看 config.py' },
      { kind: 'tool', title: 'Bash', detail: 'pytest -q' },
      { kind: 'end', title: '本轮结束', detail: '改好了' },
    ])
    expect(liveEvents(lines, 2).map(e => e.kind)).toEqual(['tool', 'end'])
  })
  test('thinking blocks show, thinking_tokens noise is skipped', () => {
    const t = [
      JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 }),
      asst('m9', [{ type: 'thinking', thinking: '先看  init.go' }], {}),
    ]
    expect(liveEvents(t)).toEqual([{ kind: 'think', title: '', detail: '先看 init.go' }])
  })
  test('usageOf counts each message once and takes the latest context', () => {
    expect(usageOf(lines)).toEqual({ context: 2000, output: 90 })
  })
  test('usageOf takes the real total from the result line (assistant lines carry 0)', () => {
    // 网关只给半成品事件 usage：assistant 行的 output_tokens 全是 0，总数只在 result 里。
    const zero = (id: string) => asst(id, [{ type: 'text', text: 'hi' }], { input_tokens: 700, output_tokens: 0 })
    const run = [zero('m1'), zero('m2'), JSON.stringify({ type: 'result', usage: { input_tokens: 700, output_tokens: 186_521 } })]
    expect(usageOf(run)).toEqual({ context: 700, output: 186_521 })
    // 没有 result 时仍是各条消息之和
    expect(usageOf([zero('m1'), zero('m2')])).toEqual({ context: 700, output: 0 })
    // 同一目录里更早一次运行留下的 result 不算，取最后一条
    const rerun = [
      JSON.stringify({ type: 'result', usage: { output_tokens: 44_816 } }),
      asst('m3', [{ type: 'text', text: 'again' }], { input_tokens: 900, output_tokens: 0 }),
      JSON.stringify({ type: 'result', usage: { output_tokens: 3_273 } }),
    ]
    expect(usageOf(rerun)).toEqual({ context: 900, output: 3_273 })
    // result 行没有 usage 或不是数字时退回各条消息之和
    const partial = [asst('m4', [], { input_tokens: 10, output_tokens: 40 }), JSON.stringify({ type: 'result' })]
    expect(usageOf(partial)).toEqual({ context: 10, output: 40 })
  })
  test('status.json carries the running output count, and garbage is dropped', () => {
    expect(normalizeStatus({ outputTokens: 12_345 })?.outputTokens).toBe(12_345)
    expect(normalizeStatus({ outputTokens: 'x' })).not.toHaveProperty('outputTokens')
    expect(normalizeStatus({ outputTokens: -1 })).not.toHaveProperty('outputTokens')
  })
  test('tokensOf', () => {
    expect([tokensOf(undefined), tokensOf(950), tokensOf(56789), tokensOf(1234567)]).toEqual(['–', '950', '57K', '1.2M'])
  })
})

describe('gpt quota', () => {
  test('normalizeQuota keeps windows and clamps percent', () => {
    const q = normalizeQuota({ ok: true, source: 'live', at: 5, plan: 'plus', windows: [{ label: '5 小时', used: 120, resetAt: 9 }, { label: 'bad' }] })
    expect(q).toEqual({ ok: true, source: 'live', at: 5, plan: 'plus', limitReached: false, windows: [{ label: '5 小时', used: 100, resetAt: 9 }] })
    expect(normalizeQuota({ ok: false, error: 'x' })).toEqual({ ok: false, error: 'x' })
    expect(normalizeQuota({ ok: true, windows: [] }).ok).toBe(false)
    expect(normalizeQuota(null).ok).toBe(false)
  })
  test('bar, color and reset text', () => {
    expect(barOf(50, 4)).toEqual(['━━', '──'])
    expect(barOf(0, 3)).toEqual(['', '───'])
    expect(barOf(1, 10)).toEqual(['━', '─────────'])
    expect([usedColor(10), usedColor(60), usedColor(90)]).toEqual(['success', 'warning', 'error'])
    const now = 0
    expect(resetIn(undefined, now)).toBe('')
    expect(resetIn(5 * 60_000, now)).toBe('5 分后重置')
    expect(resetIn(178 * 60_000, now)).toBe('2 时 58 分后重置')
    expect(resetIn((6 * 1440 + 22 * 60) * 60_000, now)).toBe('6 天 22 时后重置')
  })
})

// Exercise the mounted tree: invalid Button children or Select props fail here.
describe('CPA settings and transactional migration', () => {
  const wire = (on: never, legacy: boolean, fail: boolean) => {
    const raw = legacy ? { ...SEED, providers: [{ id: 'command', name: 'Command Code', url: 'https://example.test/v1/chat/completions', key: 'migration-test-secret' }] } : normalize(undefined)
    const store = new Map<string, unknown>([['cfg', raw]])
    let groups = [{ id: 'command', name: 'command', prefix: 'command', protocol: 'chat', baseUrl: 'https://example.test/v1', keyMask: '已设置（••••）', models: ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro', 'keep-existing'] }]
    const calls: { command: string; input: Record<string, unknown>; argv: string[] }[] = []
    const o = on as (name: string, fn: (_$: unknown, e: never) => unknown) => void
    o('store.get', (_$, e: { key: string }) => ({ value: store.get(e.key) }))
    o('store.set', (_$, e: { key: string; value: unknown }) => { store.set(e.key, e.value); return { value: undefined } })
    o('store.keys', () => ({ value: [...store.keys()] }))
    o('session.start', (_$, e: { cwd: string }) => ({ cwd: e.cwd }))
    o('command.register', (_$, e: { name: string }) => ({ value: { command: e.name } }))
    o('tool.register', (_$, e: { name: string }) => ({ value: { tool: 'mcp__delegate__' + e.name } }))
    o('env.get', () => ({ value: 'C:/Users/test' }))
    o('process.run', (_$, e: { argv: string[]; init?: { stdin?: string }; stdin?: string }) => {
      const input = JSON.parse(e.init?.stdin || e.stdin || '{}') as Record<string, unknown>
      const command = e.argv[2]
      calls.push({ command, input, argv: e.argv })
      let result: Record<string, unknown> = { ok: true }
      if (command === 'providers') result.providers = groups
      if (command === 'gpt-accounts') result.accounts = []
      if (command === 'fetch-models') result.models = ['new-one', 'new-two']
      if (command === 'save') {
        if (fail) result = { ok: false, error: 'simulated CPA failure' }
        else groups = groups.map(g => g.id === input.id ? { ...g, models: input.models as string[] } : g)
      }
      if (command === 'delete') groups = groups.filter(g => g.id !== input.id)
      return { value: { exitCode: result.ok ? 0 : 1, stdout: JSON.stringify(result), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    return { store, calls, raw }
  }
  const session = async ($: { session: { start: (v: never) => Promise<unknown> } }) => { await $.session.start({ cwd: '/work', surface: null, isInteractive: true } as never) }
  test('successful migration strips key once and merges existing CPA models', { timeoutMs: 10000 }, async ($, on) => {
    const t = wire(on as never, true, false)
    await session($)
    const saves = t.calls.filter(c => c.command === 'save')
    expect(saves).toHaveLength(1)
    expect(saves[0].input.models).toContain('keep-existing')
    expect(saves[0].argv.join(' ')).not.toContain('migration-test-secret')
    expect(JSON.stringify(t.store.get('cfg'))).not.toContain('migration-test-secret')
    await session($)
    expect(t.calls.filter(c => c.command === 'save')).toHaveLength(1)
  })
  test('failed migration leaves the legacy key and slots available for retry', { timeoutMs: 10000 }, async ($, on) => {
    const t = wire(on as never, true, true)
    await session($)
    expect(t.store.get('cfg')).toEqual(t.raw)
    expect(JSON.stringify(t.store.get('cfg'))).toContain('migration-test-secret')
  })
  test('pane Select saves immediately, fetched models require explicit selection, delete is confirmed', { timeoutMs: 20000 }, async ($, on) => {
    const t = wire(on as never, false, false)
    const ui = await $.ui.mount({ plugin: 'delegate', surface: 'terminal', component: 'Pane', requestId: 'delegate', props: { title: 'Delegate', focused: true } })
    expect(await ui.findAll({ type: 'Select' })).toHaveLength(4)
    await ui.select({ key: 'flash-effort', value: 'xhigh' })
    expect(normalize(t.store.get('cfg')).slots.flash?.effort).toBe('xhigh')
    await ui.press({ key: 'section-providers' })
    await ui.press({ key: 'edit-command' })
    await ui.press({ key: 'fetch-models' })
    expect(t.calls.filter(c => c.command === 'save').at(-1)?.input.models).not.toContain('new-one')
    await ui.press({ key: 'fetch-new-one' })
    await ui.press({ key: 'add-selected' })
    const models = t.calls.filter(c => c.command === 'save').at(-1)?.input.models
    expect(models).toContain('new-one')
    expect(models).not.toContain('new-two')
    await ui.press({ key: 'close-editor' })
    await ui.press({ key: 'delete-command' })
    expect(t.calls.filter(c => c.command === 'delete')).toHaveLength(0)
    await ui.press({ key: 'delete-command' })
    expect(t.calls.filter(c => c.command === 'delete')).toHaveLength(1)
    expect(normalize(t.store.get('cfg')).slots.flash).toBeNull()
    await ui.unmount()
  })
})


// ---- 多会话共用进程：作业归属和面板开关不能串 --------------------------------

describe('session scoping', () => {
  // 同一个进程服务多个会话：$.session.id() 会换成另一个会话的 id。
  const twoSessions = (on: never, reply: Record<string, unknown>) => {
    const t = jobSetup(on, reply)
    let sessionId = 'sess-A'
    const o = on as (name: string, fn: (_$: unknown, e: never) => unknown) => void
    o('session.id', () => ({ value: sessionId }))
    o('clock.after', () => ({ value: { cancel: () => undefined } }))
    o('clock.every', () => ({ value: { cancel: () => undefined } }))
    const mountLive = () =>
      ($: never) =>
        ($ as { ui: { mount: (i: never) => Promise<{ findAll: (q: never) => Promise<unknown[]>; press: (i: never) => Promise<unknown>; unmount: () => Promise<void> }> } }).ui.mount({
          plugin: 'delegate',
          surface: 'terminal',
          component: 'Pane',
          requestId: 'delegate-live',
          props: { title: '委派任务', isFocused: false },
        } as never)
    return { ...t, mountLive, switchTo: (id: string) => { sessionId = id } }
  }

  test('a job belongs to the session that started it, whichever session asks next', { timeoutMs: 30_000 }, async ($, on) => {
    const t = twoSessions(on as never, { ok: true, text: 'x', sessionId: 'sid-a', turns: 1, ms: 5 })
    await startSession($ as never)
    await jobCall($ as never, 'mcp__delegate__delegate_flash', { task: 'only for A' })
    const id = String(t.runs[0]?.jobId)
    expect(jobOf(t.store, id).owner).toBe('sess-A')
    // 另一个会话（同一进程）打开实时面板：A 的作业不算自己的
    t.switchTo('sess-B')
    const uiB = await t.mountLive()($ as never)
    expect((await uiB.findAll({ type: 'Text', text: /本会话还没有委派任务/ })).length).toBeGreaterThan(0)
    expect(await uiB.findAll({ type: 'Text', text: /only for A/ })).toHaveLength(0)
    await uiB.unmount()
    // 回到 A：作业又看得见了
    t.switchTo('sess-A')
    const uiA = await t.mountLive()($ as never)
    expect((await uiA.findAll({ type: 'Text', text: /only for A/ })).length).toBeGreaterThan(0)
    await uiA.unmount()
  })

  test('the 看全部 toggle is kept per session and defaults to this session only', { timeoutMs: 30_000 }, async ($, on) => {
    const t = twoSessions(on as never, { ok: true, text: 'x', sessionId: 'sid-b', turns: 1, ms: 5 })
    await startSession($ as never)
    const uiA = await t.mountLive()($ as never)
    // 新会话默认只看本会话
    expect(await uiA.findAll({ type: 'Button', text: /本会话/ })).toHaveLength(1)
    expect(await uiA.findAll({ type: 'Button', text: /全部会话/ })).toHaveLength(0)
    await uiA.press({ key: 'live-scope' })
    expect(t.store.get('liveAll:sess-A')).toBe(true)
    expect(await uiA.findAll({ type: 'Button', text: /全部会话/ })).toHaveLength(1)
    await uiA.unmount()
    // B 会话里打开面板：A 的选择不能漏过来
    t.switchTo('sess-B')
    const uiB = await t.mountLive()($ as never)
    expect(await uiB.findAll({ type: 'Button', text: /全部会话/ })).toHaveLength(0)
    expect(t.store.get('liveAll:sess-B')).toBeUndefined()
    await uiB.unmount()
  })
})

// ---- runner 结果：任务终态与实际模型 -----------------------------------------

describe('runner result', () => {
  test('TASK_TERMINAL parses completed', () => {
    expect(terminalOf('done\nTASK_TERMINAL: completed')).toBe('completed')
  })

  test('TASK_TERMINAL parses failed wrapped in markdown', () => {
    expect(terminalOf('**TASK_TERMINAL: failed**')).toBe('failed')
    expect(terminalOf('`TASK_TERMINAL: blocked`')).toBe('blocked')
    expect(terminalOf('**`TASK_TERMINAL:` failed**')).toBe('failed')
  })

  test('the last TASK_TERMINAL wins', () => {
    expect(terminalOf('TASK_TERMINAL: blocked\n…\nTASK_TERMINAL: completed')).toBe('completed')
    expect(terminalOf('TASK_TERMINAL: completed\nTASK_TERMINAL: failed')).toBe('failed')
  })

  test('no TASK_TERMINAL is null, not an empty string', () => {
    expect(terminalOf('all done, no marker')).toBeNull()
    expect(terminalOf('')).toBeNull()
    expect(terminalOf(undefined)).toBeNull()
  })

  test('models keep the first-seen order and drop repeats', () => {
    const models: string[] = []
    for (const model of ['m-a', 'm-b', 'm-a', 'm-c', 'm-b']) {
      addModel(models, { type: 'assistant', message: { model, content: [] } })
    }
    expect(models).toEqual(['m-a', 'm-b', 'm-c'])
    const none: string[] = []
    addModel(none, { type: 'assistant', message: { content: [] } })
    addModel(none, { type: 'assistant', message: { model: '  ', content: [] } })
    expect(none).toEqual([])
  })
})
