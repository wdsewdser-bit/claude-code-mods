import { describe, expect, test } from 'claude-code/testing'

import { assemble, openingOf, renderActions, renderAgents, renderCoverage, renderLoadReason, renderTools, rewriteOf } from '../hooks/lib/handoff.ts'
import { DEFAULTS, estimateTokens } from '../hooks/lib/types.ts'

const HOME = '## 最近的用户请求\n[#12] 把登录页的按钮改成蓝色\n## 进行中的任务\n- login-btn：下一步改 Button.tsx'
const ACTIONS = [
  { seq: 40, tool: 'Read', path: 'src/Button.tsx', isError: false, head: '1\texport const Button' },
  { seq: 41, tool: 'Edit', path: 'src/Button.tsx', isError: true, head: 'String not found' },
]

describe('renderAgents', () => {
  test('is empty with no agents, lists running ones first, and caps the list', () => {
    expect(renderAgents([])).toBe('')

    const many = Array.from({ length: 13 }, (_, i) => ({
      id: `a${i}`,
      type: 'worker',
      description: `任务${i}`,
      state: i === 12 ? 'running' : 'idle',
    }))
    const text = renderAgents(many)
    expect(text).toContain('## 子代理')
    expect(text.split('\n')[1]).toBe('- a12（worker，running）：任务12')
    expect(text).toContain('另有 1 个未列出，用 ListAgents 查看')
    expect(text).toContain('要继续某个子代理（已结束的也可以），用 SendMessage 发给它的 id')
  })

  test('puts the ended ones last and keeps the order the caller gave the rest in', () => {
    const text = renderAgents([
      { id: 'ended-new', type: 'worker', description: '新的那个', state: '已结束' },
      { id: 'idle-1', type: 'worker', description: '闲着的', state: 'idle' },
      { id: 'run-1', type: 'worker', description: '在跑的', state: 'running' },
      { id: 'ended-old', type: 'worker', description: '旧的那个', state: '已结束' },
    ])
    expect(text.split('\n').slice(1, 5)).toEqual([
      '- run-1（worker，running）：在跑的',
      '- idle-1（worker，idle）：闲着的',
      '- ended-new（worker，已结束）：新的那个',
      '- ended-old（worker，已结束）：旧的那个',
    ])
  })
})

describe('renderTools', () => {
  test('is empty with no tools, and otherwise names each one with its calls and what its load rewrote', () => {
    expect(renderTools([])).toBe('')

    const text = renderTools([
      { name: 'mcp__computer-use__*', calls: 56, rebuilt: 117_386 },
      { name: 'WebFetch', calls: 6, rebuilt: 8_200 },
    ])
    expect(text.split('\n')[0]).toBe('## 加载时会重建缓存的延迟工具')
    expect(text).toContain('- mcp__computer-use__*（上个窗口调用 56 次；上次加载后重写了约 11.7 万 token）')
    expect(text).toContain('- WebFetch（上个窗口调用 6 次；上次加载后重写了约 8200 token）')
    expect(text).toContain('在第一步就用一次 ToolSearch 加载它')
    expect(text).toContain('其他延迟工具随用随加载，不必提前。')
  })

  test('spells a rewrite under ten thousand as a plain count, and from ten thousand on in tenths of 万', () => {
    expect(renderTools([{ name: 'A', calls: 1, rebuilt: 9_999 }])).toContain('约 9999 token')
    expect(renderTools([{ name: 'A', calls: 1, rebuilt: 10_000 }])).toContain('约 1.0 万 token')
    expect(renderTools([{ name: 'A', calls: 1, rebuilt: 115_000 }])).toContain('约 11.5 万 token')
  })
})

describe('renderLoadReason', () => {
  test('nothing held back says nothing; one group is loaded by “它”, several by “它们”', () => {
    expect(renderLoadReason([])).toBe('')
    expect(renderLoadReason(['mcp__computer-use__*'])).toBe(
      '## 这次换窗口的原因\n换窗口是为了加载 mcp__computer-use__*：第一步先用一次 ToolSearch 加载它，再继续账本里的下一步。',
    )
    expect(renderLoadReason(['A', 'B'])).toContain('换窗口是为了加载 A、B：第一步先用一次 ToolSearch 加载它们')
  })

  test('the reason sits before the loaded tools and is never cut from the handoff', () => {
    const text = assemble(
      {
        window: 2,
        home: '## 当前请求\n抓图',
        loadReason: renderLoadReason(['mcp__computer-use__*']),
        tools: renderTools([{ name: 'mcp__computer-use__*', calls: 1, rebuilt: 117_386 }]),
        workset: `## 文件工作集\n${'很长的一行 '.repeat(2_000)}`,
        actions: [],
        isMidTurn: false,
      },
      DEFAULTS,
    )
    expect(text).toContain('## 这次换窗口的原因')
    expect(text.indexOf('## 这次换窗口的原因')).toBeLessThan(text.indexOf('## 加载时会重建缓存的延迟工具'))
  })

  test('rewriteOf is the one spelling of a rewrite count the handoff uses', () => {
    expect(rewriteOf(117_386)).toBe('约 11.7 万')
    expect(rewriteOf(9_999)).toBe('约 9999')
  })
})

describe('handoff', () => {
  test('carries the opening, the home page, the working set and the actions in that order', () => {
    const text = assemble(
      { window: 3, home: HOME, workset: '## 文件工作集\n- src/Button.tsx', actions: ACTIONS, isMidTurn: false },
      DEFAULTS,
    )
    const at = ['第 3 个窗口', '把登录页的按钮改成蓝色', '## 文件工作集', '## 最近的动作'].map(part =>
      text.indexOf(part),
    )
    expect(at.every(index => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(text).toContain('#41 Edit src/Button.tsx（失败）')
  })

  test('carries the previous reply between the home page and the working set', () => {
    const text = assemble(
      {
        window: 2,
        home: HOME,
        lastReply: '改好了，用的是调色板里的蓝。',
        workset: '## 文件工作集\n- src/Button.tsx',
        actions: ACTIONS,
        isMidTurn: false,
      },
      DEFAULTS,
    )
    const at = ['## 最近的用户请求', '## 上一次助手的最后回复', '## 文件工作集', '## 最近的动作'].map(part =>
      text.indexOf(part),
    )
    expect(at.every(index => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(text).toContain('改好了，用的是调色板里的蓝。')
  })

  test('leaves the reply section out when there is nothing to carry', () => {
    const without = assemble(
      { window: 2, home: HOME, workset: '## 文件工作集\n- src/Button.tsx', actions: [], isMidTurn: false },
      DEFAULTS,
    )
    expect(without).not.toContain('上一次助手的最后回复')

    const blank = assemble(
      { window: 2, home: HOME, lastReply: '   ', workset: '', actions: [], isMidTurn: false },
      DEFAULTS,
    )
    expect(blank).not.toContain('上一次助手的最后回复')
  })

  test('over the cap it cuts the working set but never the home page or the reply', () => {
    const snippet = [
      '### login-btn src/Button.tsx:10',
      '```',
      ...Array.from({ length: 400 }, (_, i) => `${i + 1}\tconst value${i} = ${i}`),
      '```',
    ].join('\n')
    const config = { ...DEFAULTS, handoffTokens: 900 }
    const text = assemble(
      {
        window: 2,
        home: HOME,
        lastReply: '结论是改用严格模式。',
        workset: `## 待改位置\n${snippet}`,
        actions: ACTIONS,
        isMidTurn: true,
      },
      config,
    )
    expect(estimateTokens(text)).toBeLessThanOrEqual(900)
    expect(text).toContain('把登录页的按钮改成蓝色')
    expect(text).toContain('结论是改用严格模式。')
    expect(text).not.toContain('## 最近的动作')
    expect(text).toContain('其余片段已省略')
  })

  test('carries the agent section between the home page and the working set', () => {
    const withAgents = assemble(
      {
        window: 2,
        home: HOME,
        lastReply: '结论是改用严格模式。',
        agents: '## 子代理\n- a1（worker，running）：改 hooks',
        workset: '## 文件工作集\n- src/Button.tsx',
        actions: ACTIONS,
        isMidTurn: false,
      },
      DEFAULTS,
    )
    const at = ['## 最近的用户请求', '## 上一次助手的最后回复', '## 子代理', '## 文件工作集'].map(part =>
      withAgents.indexOf(part),
    )
    expect(at.every(index => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)

    const without = assemble(
      { window: 2, home: HOME, workset: '## 文件工作集', actions: [], isMidTurn: false },
      DEFAULTS,
    )
    expect(without).not.toContain('## 子代理')
  })

  test('over the cap it keeps the agent section while cutting the working set', () => {
    const snippet = Array.from({ length: 400 }, (_, i) => `${i + 1}\tconst value${i} = ${i}`).join('\n')
    const text = assemble(
      {
        window: 2,
        home: HOME,
        agents: '## 子代理\n- a1（worker，running）：改 hooks',
        workset: `## 待改位置\n${snippet}`,
        actions: ACTIONS,
        isMidTurn: false,
      },
      { ...DEFAULTS, handoffTokens: 900 },
    )
    expect(estimateTokens(text)).toBeLessThanOrEqual(900)
    expect(text).toContain('a1（worker，running）')
  })

  test('carries the rebuilt-load tools between the subagents and the working set, and leaves them out when empty', () => {
    const tools = renderTools([{ name: 'WebFetch', calls: 6, rebuilt: 20_000 }])
    const withTools = assemble(
      {
        window: 2,
        home: HOME,
        lastReply: '结论是改用严格模式。',
        agents: '## 子代理\n- a1（worker，running）：改 hooks',
        tools,
        workset: '## 文件工作集\n- src/Button.tsx',
        actions: ACTIONS,
        isMidTurn: false,
      },
      DEFAULTS,
    )
    const at = ['## 子代理', '## 加载时会重建缓存的延迟工具', '## 文件工作集'].map(part => withTools.indexOf(part))
    expect(at.every(index => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)

    const without = assemble(
      { window: 2, home: HOME, tools: renderTools([]), workset: '## 文件工作集', actions: [], isMidTurn: false },
      DEFAULTS,
    )
    expect(without).not.toContain('加载时会重建缓存的延迟工具')
  })

  test('over the cap it keeps the loaded tools while cutting the working set', () => {
    const snippet = Array.from({ length: 400 }, (_, i) => `${i + 1}\tconst value${i} = ${i}`).join('\n')
    const text = assemble(
      {
        window: 2,
        home: HOME,
        tools: renderTools([{ name: 'mcp__computer-use__*', calls: 56, rebuilt: 117_386 }]),
        workset: `## 待改位置\n${snippet}`,
        actions: ACTIONS,
        isMidTurn: false,
      },
      { ...DEFAULTS, handoffTokens: 900 },
    )
    expect(estimateTokens(text)).toBeLessThanOrEqual(900)
    expect(text).toContain('- mcp__computer-use__*（上个窗口调用 56 次；上次加载后重写了约 11.7 万 token）')
    expect(text).toContain('其余片段已省略')
  })

  test('tells a model cut mid-turn to go on without waiting', () => {
    expect(openingOf(2, true)).toContain('不要等待新的指示')
    expect(openingOf(2, false)).toContain('先用一句话复述')
    expect(renderActions([])).toBe('')
  })

  test('over the cap it drops the actions, then cuts the working set, never the home page', () => {
    const snippet = ['### login-btn src/Button.tsx:10', '```', ...Array.from({ length: 400 }, (_, i) => `${i + 1}\tconst value${i} = ${i}`), '```'].join('\n')
    const config = { ...DEFAULTS, handoffTokens: 900 }
    const text = assemble(
      { window: 2, home: HOME, workset: `## 待改位置\n${snippet}`, actions: ACTIONS, isMidTurn: true },
      config,
    )
    expect(estimateTokens(text)).toBeLessThanOrEqual(900)
    expect(text).toContain('把登录页的按钮改成蓝色')
    expect(text).toContain('下一步改 Button.tsx')
    expect(text).not.toContain('## 最近的动作')
    expect(text).toContain('其余片段已省略')
    expect(text.split('\n').filter(line => line.startsWith('```')).length % 2).toBe(0)
  })
})


describe('the part of the work the ledger does not cover', () => {
  const tail = { steps: 12, from: 640, to: 655, entrySeq: 27 }

  test('names the last ledger entry and the uncovered stretch, or says there was no ledger', () => {
    expect(renderCoverage(tail)).toBe(
      '## 账本没覆盖到的部分\n最近一次记账（#L27）之后还有 12 个工具结果没有记进账本（#640–#655）。它们的结论账本里没有：最近的那些列在“最近的动作”里，需要细节时用 history 按编号读原文，不要凭印象继续。',
    )
    expect(renderCoverage({ ...tail, entrySeq: null })).toBe(
      '## 账本没覆盖到的部分\n上个窗口里没有记过账，有 12 个工具结果（#640–#655）只在历史里。开工前先用 history 读最近的用户请求和这些结果，不要凭印象继续。',
    )
  })

  test('says nothing when no step is uncovered', () => {
    expect(renderCoverage({ steps: 0, from: null, to: null, entrySeq: 27 })).toBe('')
  })

  test('sits before the working set and survives the cut that drops the actions', () => {
    const snippet = ['```', ...Array.from({ length: 400 }, (_, i) => `${i + 1}\tconst value${i} = ${i}`), '```'].join('\n')
    const coverage = renderCoverage(tail)
    const input = { window: 2, home: HOME, coverage, workset: `## 待改位置\n${snippet}`, actions: ACTIONS, isMidTurn: true }
    const whole = assemble(input, DEFAULTS)
    expect(whole.indexOf('## 账本没覆盖到的部分')).toBeGreaterThan(-1)
    expect(whole.indexOf('## 账本没覆盖到的部分')).toBeLessThan(whole.indexOf('## 待改位置'))

    const cut = assemble(input, { ...DEFAULTS, handoffTokens: 900 })
    expect(estimateTokens(cut)).toBeLessThanOrEqual(900)
    expect(cut).not.toContain('## 最近的动作')
    expect(cut).toContain(coverage)
  })
})
