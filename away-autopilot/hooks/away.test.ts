import { test, expect, mock } from 'claude-code/testing'

import { DEFAULTS, NUDGE, SECTION, readConfig } from './register.ts'

const MIN = 60 * 1000
const done = (answer: string) => ({ answer, reason: 'answer' as const, durationMs: 1, isAborted: false, turnId: 't' })

function setup(on: Parameters<Parameters<typeof test>[1] & ((...a: any[]) => any)>[1]) {
  const clock = mock.clock(on)
  const nudges: string[] = []
  const statuses: (string | undefined)[] = []
  const tools: string[] = []
  on('prompt.submit', ($, e, next) => {
    if (e.origin.kind === 'plugin') nudges.push(e.text)
    return { text: e.text } as any
  })
  on('turn.complete', () => ({ text: '' }) as any)
  on('session.start', (_$, e) => e as any)
  on('ui.status', (_$, e: any) => {
    statuses.push(e.text)
    return { value: undefined } as any
  })
  on('tool.register', (_$, e: any) => {
    tools.push(e.name)
    return { value: { tool: e.name } } as any
  })
  on('prompt.compose', () => ({ sections: [] }))
  return { clock, nudges, statuses, tools }
}

test('5 分钟无回复后插入提示', async ($, on) => {
  const { clock, nudges } = setup(on)
  await $.turn.complete(done('选 A 还是 B？\n[待确认]'))
  await clock.advance(4 * MIN)
  expect(nudges).toHaveLength(0)
  await clock.advance(1 * MIN + 1)
  expect(nudges).toHaveLength(1)
  expect(nudges[0]).toContain('[away-autopilot]')
})

test('wrap_up 带 ask 时也触发', async ($, on) => {
  const { clock, nudges } = setup(on)
  on('tool.call', () => ({ result: 'ok' }) as any)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'r', ask: '选哪个？' } } as any)
  await $.turn.complete(done(''))
  await clock.advance(5 * MIN + 1)
  expect(nudges).toHaveLength(1)
})

test('wrap_up 不带 ask 不触发', async ($, on) => {
  const { clock, nudges } = setup(on)
  on('tool.call', () => ({ result: 'ok' }) as any)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', input: { recap: 'r' } } as any)
  await $.turn.complete(done('做完了'))
  await clock.advance(10 * MIN)
  expect(nudges).toHaveLength(0)
})

test('没有标记不触发', async ($, on) => {
  const { clock, nudges } = setup(on)
  await $.turn.complete(done('做完了。'))
  await clock.advance(10 * MIN)
  expect(nudges).toHaveLength(0)
})

test('用户回复取消计时', async ($, on) => {
  const { clock, nudges } = setup(on)
  await $.turn.complete(done('要继续吗？[待确认]'))
  await clock.advance(2 * MIN)
  await $.prompt.submit({ text: '继续', origin: { kind: 'composer' } } as any)
  await clock.advance(10 * MIN)
  expect(nudges).toHaveLength(0)
})

test('调用 pause 后不再推进，用户回来后恢复', async ($, on) => {
  const { clock, nudges } = setup(on)
  await $.session.start({ source: 'startup', cwd: '.' } as any)
  const r = await $.tool.call({ tool: 'mcp__away-autopilot__pause', input: { reason: '剩下的都要确认' } } as any)
  expect(JSON.stringify(r)).toContain('paused')
  await $.turn.complete(done('[待确认]'))
  await clock.advance(10 * MIN)
  expect(nudges).toHaveLength(0)
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as any)
  await $.turn.complete(done('[待确认]'))
  await clock.advance(5 * MIN + 1)
  expect(nudges).toHaveLength(1)
})

test('兜底上限 8 次', async ($, on) => {
  const { clock, nudges } = setup(on)
  for (let i = 0; i < 12; i++) {
    await $.turn.complete(done('[待确认]'))
    await clock.advance(5 * MIN + 1)
  }
  expect(nudges).toHaveLength(8)
})

test('system prompt 加入约定', async ($, on) => {
  setup(on)
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)
  expect(r.sections.some(s => s.id === 'away-autopilot')).toBe(true)
})
// The 0.1.0 texts, verbatim: the default configuration must not change them.
const OLD_NUDGE = `[away-autopilot] 用户 5 分钟未回复，可能没空。请自行决定下一步：
- 可以直接做：只读操作、无副作用的操作、可回滚的本地改动、确认收益明显大于副作用的操作。
- 需要重启 Claude Code 才能验证的改动：用 \`claude -p\`（mod 加 \`--plugin-dir <目录>\`）起新进程直接测试，不要等用户重启。
- 不要做：git commit/push、发送消息、删除数据、改生产或共享配置、花钱，这些留给用户回来确认。
- 做完后汇报你替用户做了哪个选择、为什么、怎么回滚。
- 如果剩下的都必须用户确认、或继续推进不值得，调用 mcp__away-autopilot__pause 停下等待。`
const OLD_SECTION = `# 离开模式（away-autopilot）
当你停下来等用户确认（选 A/B、是否继续、是否执行某操作）时，在回复末尾单独写一行 [待确认]。
用户 5 分钟没回复时会收到 [away-autopilot] 提示，届时按提示自行决定；判断应该停下等用户时，调用 mcp__away-autopilot__pause。`

test('默认配置下提示文本与 0.1.0 逐字相同', async ($, on) => {
  const { clock, nudges, statuses } = setup(on)
  expect(NUDGE).toBe(OLD_NUDGE)
  expect(SECTION).toBe(OLD_SECTION)
  await $.turn.complete(done('[待确认]'))
  expect(statuses).toContain('离开模式：5 分钟无回复将自动推进')
  await clock.advance(5 * MIN + 1)
  expect(nudges).toEqual([OLD_NUDGE])
})

test('idleMinutes=1：1 分钟后触发，文本用 1 分钟', { options: { idleMinutes: 1 } }, async ($, on) => {
  const { clock, nudges, statuses } = setup(on)
  await $.turn.complete(done('[待确认]'))
  expect(statuses).toContain('离开模式：1 分钟无回复将自动推进')
  await clock.advance(59_000)
  expect(nudges).toHaveLength(0)
  await clock.advance(2_000)
  expect(nudges).toHaveLength(1)
  expect(nudges[0]).toContain('[away-autopilot] 用户 1 分钟未回复')
})

test('idleMinutes=0.5：非整数分钟显示一位小数', { options: { idleMinutes: 0.5 } }, async ($, on) => {
  const { clock, nudges, statuses } = setup(on)
  await $.turn.complete(done('[待确认]'))
  expect(statuses).toContain('离开模式：0.5 分钟无回复将自动推进')
  await clock.advance(29_000)
  expect(nudges).toHaveLength(0)
  await clock.advance(2_000)
  expect(nudges).toHaveLength(1)
  expect(nudges[0]).toContain('用户 0.5 分钟未回复')
})

test('maxAutoNudges=0 不自动推进', { options: { maxAutoNudges: 0 } }, async ($, on) => {
  const { clock, nudges, statuses } = setup(on)
  for (let i = 0; i < 3; i += 1) {
    await $.turn.complete(done('[待确认]'))
    await clock.advance(10 * MIN)
  }
  expect(nudges).toHaveLength(0)
  expect(statuses.some(text => typeof text === 'string' && text.includes('自动推进'))).toBe(false)
})

test('越界或非法的配置回退默认', () => {
  expect(readConfig({ idleMinutes: 999 }).idleMinutes).toBe(DEFAULTS.idleMinutes)
  expect(readConfig({ idleMinutes: 0.1 }).idleMinutes).toBe(DEFAULTS.idleMinutes)
  expect(readConfig({ idleMinutes: 'x' }).idleMinutes).toBe(DEFAULTS.idleMinutes)
  expect(readConfig({ maxAutoNudges: 51 }).maxAutoNudges).toBe(DEFAULTS.maxAutoNudges)
  expect(readConfig({ maxAutoNudges: -1 }).maxAutoNudges).toBe(DEFAULTS.maxAutoNudges)
  expect(readConfig({ maxAutoNudges: 'x' }).maxAutoNudges).toBe(DEFAULTS.maxAutoNudges)
  expect(readConfig({ enabled: 'yes' }).enabled).toBe(DEFAULTS.enabled)
  expect(readConfig({ idleMinutes: 1.5 }).idleMinutes).toBe(1.5)
  expect(readConfig({ maxAutoNudges: 0 }).maxAutoNudges).toBe(0)
  expect(readConfig(undefined)).toEqual(DEFAULTS)
})

test('enabled=false：不注册 pause、不加提示段、不起定时器', { options: { enabled: false } }, async ($, on) => {
  const { clock, nudges, statuses, tools } = setup(on)
  await $.session.start({ source: 'startup', cwd: '.' } as any)
  expect(tools.includes('pause')).toBe(false)
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)
  expect(r.sections.some(s => s.id === 'away-autopilot')).toBe(false)
  await $.turn.complete(done('[待确认]'))
  await clock.advance(20 * MIN)
  expect(nudges).toHaveLength(0)
  expect(statuses).toHaveLength(0)
})
