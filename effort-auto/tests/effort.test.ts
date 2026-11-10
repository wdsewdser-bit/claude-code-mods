// The pure rules: the configuration, the two texts the model reads, the per
// request decision and the raise, the error run, and what counts as a failed
// tool result. No engine here.

import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULT_STEPS,
  DEFAULTS,
  ERROR_REMINDER,
  bashExitOf,
  configOf,
  decide,
  failureOf,
  fresh,
  isRaise,
  noteFailure,
  noteSuccess,
  raise,
  rank,
  rulesOf,
} from '../hooks/lib/effort.ts'

describe('configOf', () => {
  test('with nothing set, the plugin is off and the defaults hold', () => {
    expect(configOf(undefined, {})).toEqual(DEFAULTS)
  })

  test("the manifest's values are read", () => {
    const config = configOf({ enabled: true, maxRaises: 2, maxHighSteps: 7, logPath: '/tmp/steps.jsonl' }, {})
    expect(config).toEqual({ enabled: true, maxRaises: 2, maxHighSteps: 7, logPath: '/tmp/steps.jsonl' })
  })

  test('the environment overrides the manifest', () => {
    const config = configOf(
      { enabled: false, maxRaises: 9, maxHighSteps: 9, logPath: '/a.jsonl' },
      {
        EFFORT_AUTO: '1',
        EFFORT_AUTO_MAX_RAISES: '2',
        EFFORT_AUTO_MAX_HIGH_STEPS: '3',
        EFFORT_AUTO_LOG: '/b.jsonl',
      },
    )
    expect(config).toEqual({ enabled: true, maxRaises: 2, maxHighSteps: 3, logPath: '/b.jsonl' })
  })

  test('a value that names no number is ignored rather than fatal', () => {
    const config = configOf({ enabled: true, maxRaises: 'many', maxHighSteps: 0 }, { EFFORT_AUTO_MAX_RAISES: 'lots' })
    expect(config.maxRaises).toBe(DEFAULTS.maxRaises)
    expect(config.maxHighSteps).toBe(1)
  })

  test('the on/off words are understood, and a word that is neither leaves the manifest value', () => {
    expect(configOf(undefined, { EFFORT_AUTO: 'on' }).enabled).toBe(true)
    expect(configOf(undefined, { EFFORT_AUTO: 'TRUE' }).enabled).toBe(true)
    expect(configOf({ enabled: true }, { EFFORT_AUTO: 'off' }).enabled).toBe(false)
    expect(configOf({ enabled: true }, { EFFORT_AUTO: 'maybe' }).enabled).toBe(true)
  })
})

describe('the texts the model reads', () => {
  const config = { maxRaises: 4, maxHighSteps: 5 }

  test('the rules are the whole set, every raise and every way down', () => {
    const rules = rulesOf(config)
    for (const clause of [
      '主会话专属思考档位',
      '默认常驻 low',
      '升到 medium：',
      '升到 high：',
      '降回 low：',
      // medium
      '需要判断范围、拆包、选模型或选档位时',
      '验收子代理的结果、判断算不算完成或要不要打回时',
      '工具报错，或结果与预期不符、需要判断原因时',
      '向用户给出建议或结论之前（方案取舍、是否提交）',
      // high
      '根因不明，且已经试过一次没解决',
      '架构、数据库/迁移、并发、权限、正式版等改错代价高的决定',
      '用户要深入分析，或问题本身有争议、需要权衡',
      // low
      '判断已经做出、进入执行步骤（派活、记台账、读文件、跑命令、改已定内容）',
      '升档时声明的 steps 用完',
      '新一轮开始（自动）',
      // the call and its two caps
      'effort { level: "medium" | "high" | "xhigh", steps: 3, reason: "一句话理由" }',
      'steps 默认 3',
      'high 及以上一次最多 5 步',
      '每轮最多 4 次升档',
    ]) {
      expect(rules).toContain(clause)
    }
  })

  test('both caps follow the configuration', () => {
    const tight = rulesOf({ maxRaises: 2, maxHighSteps: 7 })
    expect(tight).toContain('high 及以上一次最多 7 步')
    expect(tight).toContain('每轮最多 2 次升档')
    expect(tight).not.toContain('最多 5 步')
    expect(tight).not.toContain('4 次升档')
    // The text is the tool's description as it stands at session.start, so a
    // looser setting reads differently in every clause that names a cap.
    expect(rulesOf({ maxRaises: 9, maxHighSteps: 3 })).toContain('high 及以上一次最多 3 步；每轮最多 9 次升档')
  })

  test('the reminder names the false alarms it wants weighed first', () => {
    expect(ERROR_REMINDER).toContain('连续两次工具报错')
    expect(ERROR_REMINDER).toContain('不需要升档')
    for (const falseAlarm of ['权限确认被拒', '退出码为 0', '预期中的文件不存在', '超时后重试成功', '用户中断']) {
      expect(ERROR_REMINDER).toContain(falseAlarm)
    }
  })
})

describe('levels', () => {
  test('rank orders low to xhigh, and only medium, high and xhigh may be asked for', () => {
    expect(rank('low')).toBeLessThan(rank('medium'))
    expect(rank('medium')).toBeLessThan(rank('high'))
    expect(rank('high')).toBeLessThan(rank('xhigh'))
    expect(isRaise('low')).toBe(false)
    expect(isRaise('medium')).toBe(true)
    expect(isRaise('xhigh')).toBe(true)
  })
})

describe('decide', () => {
  test('a new turn opens on medium, then rests at low, and says so once', () => {
    const first = decide(fresh())
    expect(first.effort).toBe('medium')
    expect(first.source).toBe('reset')
    const second = decide(first.state)
    expect(second.effort).toBe('low')
    expect(second.source).toBe('default')
  })

  test('a raise lasts its steps, then the level falls back with "expire"', () => {
    const raised = raise(fresh(), { level: 'high', steps: 2 }, { maxRaises: 4, maxHighSteps: 5 })
    expect(raised.ok).toBe(true)
    const held = raised.ok ? raised.state : fresh()
    const first = decide(held)
    expect(first.effort).toBe('high')
    expect(first.source).toBe('tool')
    const second = decide(first.state)
    expect(second.effort).toBe('high')
    expect(second.source).toBe('tool')
    const third = decide(second.state)
    expect(third.effort).toBe('low')
    expect(third.source).toBe('expire')
    const fourth = decide(third.state)
    expect(fourth.effort).toBe('low')
    expect(fourth.source).toBe('default')
  })
})

describe('raise', () => {
  test('steps default to three, and a raise says how long it lasts', () => {
    const outcome = raise(fresh(), { level: 'medium' }, { maxRaises: 4, maxHighSteps: 5 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.steps).toBe(DEFAULT_STEPS)
    expect(outcome.held).toBe(false)
    expect(outcome.state.override).toEqual({ level: 'medium', remaining: 3 })
    expect(outcome.state.raises).toBe(1)
  })

  test('high and above are held at five steps, medium is not', () => {
    const high = raise(fresh(), { level: 'high', steps: 20 }, { maxRaises: 4, maxHighSteps: 5 })
    expect(high.ok && high.steps).toBe(5)
    expect(high.ok && high.held).toBe(true)
    const xhigh = raise(fresh(), { level: 'xhigh', steps: 20 }, { maxRaises: 4, maxHighSteps: 5 })
    expect(xhigh.ok && xhigh.steps).toBe(5)
    const medium = raise(fresh(), { level: 'medium', steps: 20 }, { maxRaises: 4, maxHighSteps: 5 })
    expect(medium.ok && medium.steps).toBe(20)
    expect(medium.ok && medium.held).toBe(false)
  })

  test('the turn stops accepting raises after its limit, and says why', () => {
    const config = { maxRaises: 4, maxHighSteps: 5 }
    let state = fresh()
    for (let index = 0; index < 4; index += 1) {
      const outcome = raise(state, { level: 'medium', steps: 1 }, config)
      expect(outcome.ok).toBe(true)
      // The request each raise was for, which spends its single step.
      state = decide(outcome.state).state
    }
    const refused = raise(state, { level: 'high', steps: 1 }, config)
    expect(refused.ok).toBe(false)
    expect(refused.state.source).toBe('cap')
    expect(refused.state.override).toBeUndefined()
    const after = decide(refused.state)
    expect(after.effort).toBe('low')
    expect(after.source).toBe('cap')
  })

  test('the reason is kept for the log', () => {
    const outcome = raise(fresh(), { level: 'high', reason: '根因不明' }, { maxRaises: 4, maxHighSteps: 5 })
    expect(outcome.ok && outcome.state.override?.reason).toBe('根因不明')
  })
})

describe('the run of tool failures', () => {
  test('the first failure only counts; the second asks for the reminder', () => {
    const first = noteFailure(fresh())
    expect(first.remind).toBe(false)
    expect(first.state.errors).toBe(1)
    const second = noteFailure(first.state)
    expect(second.remind).toBe(true)
    expect(second.state.remind).toBe(true)
    const third = noteFailure(second.state)
    expect(third.remind).toBe(false)
    expect(noteSuccess(third.state).errors).toBe(0)
  })

  test('no failure ever changes the level by itself', () => {
    const state = noteFailure(noteFailure({ ...fresh(), source: 'default' }).state).state
    const decision = decide(state)
    expect(decision.effort).toBe('low')
    expect(decision.state.remind).toBe(false)
  })
})

describe('failureOf', () => {
  test("the engine's isError counts, whatever the tool", () => {
    expect(failureOf('Read', { result: 'ENOENT', isError: true })).toBe(true)
    expect(failureOf('Read', { result: 'ok' })).toBe(false)
  })

  test('a Bash that exited non-zero counts, from its record or its text', () => {
    expect(failureOf('Bash', { result: { exitCode: 2 } })).toBe(true)
    expect(failureOf('Bash', { result: { exit_code: 1 }, text: 'nope' })).toBe(true)
    expect(failureOf('Bash', { result: 'done', text: 'Exit code 127' })).toBe(true)
    expect(failureOf('Bash', { result: { exitCode: 0 }, text: 'fine' })).toBe(false)
    expect(bashExitOf({ result: { exitCode: 3 } })).toBe(3)
    expect(bashExitOf({ result: 'no code here' })).toBeUndefined()
  })

  test('a non-zero code in another tool is not a failure, and a refusal is not either', () => {
    expect(failureOf('Read', { result: { exitCode: 2 } })).toBe(false)
    expect(failureOf('Read', { deny: 'the person said no' })).toBe(false)
  })
})
