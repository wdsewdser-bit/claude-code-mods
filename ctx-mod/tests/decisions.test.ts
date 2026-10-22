import { describe, expect, test } from 'claude-code/testing'

import { extractDecisions, MAX_DECISION_CHARS, renderDecisions } from '../hooks/lib/decisions.ts'
import type { HistoryRecord } from '../hooks/lib/types.ts'

const at = (seq: number): number => 1_700_000_000_000 + seq * 1_000

const person = (seq: number, text: string, window = 1): HistoryRecord => ({
  seq,
  uuid: `p${seq}`,
  ts: at(seq),
  window,
  role: 'user',
  isPerson: true,
  text,
})

const assistant = (seq: number, text: string, window = 1): HistoryRecord => ({
  seq,
  uuid: `a${seq}`,
  ts: at(seq),
  window,
  role: 'assistant',
  text,
})

const texts = (rows: readonly HistoryRecord[]): string[] => extractDecisions(rows).map(decision => decision.text)

describe('extractDecisions', () => {
  test('takes the sentences that state a rule and leaves the rest', () => {
    expect(
      texts([
        person(1, '把按钮改成蓝色。以后一律用 pnpm。这里先跑一遍再提交。界面挺好看的。'),
        person(2, '不要动 vite.config。'),
      ]),
    ).toEqual(['把按钮改成蓝色。', '以后一律用 pnpm。', '这里先跑一遍再提交。', '不要动 vite.config。'])
  })

  test('leaves out questions, whether or not they name something to change', () => {
    expect(
      texts([
        person(1, '这个怎么改？'),
        person(2, '按钮要不要改成蓝色？'),
        person(3, '用 pnpm 吗'),
        person(4, '不要用 npm 行不行'),
        person(5, '还是用 pnpm 吧？'),
      ]),
    ).toEqual([])
  })

  test('keeps a constraint that ends in a question mark but asks nothing', () => {
    // No asking opener and no asking ending: the mark alone does not make it a question.
    expect(texts([person(1, '不要再改样式了？不，改吧')])).toEqual(['不要再改样式了？'])
  })

  test('names the reply a short answer answered, and drops a bare answer with nothing to answer', () => {
    const answered = extractDecisions([
      person(1, '把按钮改成蓝色'),
      assistant(2, '改好了。要不要顺手把悬停色也换掉？'),
      person(3, '可以'),
    ])
    expect(answered.map(decision => decision.text)).toEqual(['把按钮改成蓝色', '可以'])
    expect(answered[1]?.answered?.seq).toBe(2)
    const section = renderDecisions(answered, 3_000)
    expect(section).toContain('- [#3] ')
    expect(section).toContain('  - 回复的是助手 [#2]：改好了。要不要顺手把悬停色也换掉？')

    // Nothing came before it: "可以" alone does not say what was settled.
    expect(texts([person(1, '可以')])).toEqual([])
    expect(texts([person(1, '确认。')])).toEqual([])
  })


  test('does not read "对比" as the answer "对", nor a trailing 吗 as a decision', () => {
    expect(texts([person(1, '对比一下我们现在')])).toEqual([])
    expect(texts([person(2, '我们的 work 现在默认是 ptc only 了吗 我上次看见别的')])).toEqual([])
    // A one-character assent says something only when there is a question it answers.
    expect(texts([person(3, '对')])).toEqual([])
    const answered = extractDecisions([assistant(4, '这样改可以吗？'), person(5, '对')])
    expect(answered.map(decision => decision.text)).toEqual(['对'])
    expect(answered[0]?.answered?.seq).toBe(4)
  })

  test('takes a purpose stated without a marker, and a number settled with a softener', () => {
    expect(texts([person(1, '我们这个是用来仿造 dsh 的 ptc 模式')])).toEqual(['我们这个是用来仿造 dsh 的 ptc 模式'])
    expect(texts([person(2, '99有点危险 95吧')])).toEqual(['99有点危险 95吧'])
  })

  test('carries a choice the person made as an answer', () => {
    const rows = [
      assistant(1, '两套方案：1 直接改 Button.tsx，2 加一层包装。选哪套？'),
      person(2, '选 1'),
    ]
    const decisions = extractDecisions(rows)
    expect(decisions.map(decision => decision.text)).toEqual(['选 1'])
    expect(decisions[0]?.answered?.seq).toBe(1)
  })

  test('says each decision once, at the last time it was said', () => {
    const decisions = extractDecisions([
      person(1, '以后一律用 pnpm。'),
      person(5, '以后一律用  pnpm'),
    ])
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.seq).toBe(5)
  })

  test('reads every window and keeps the decisions in the order they were made', () => {
    const decisions = extractDecisions([
      person(4, '必须跑全量测试。', 3),
      person(1, '不要动 vite.config。', 1),
      person(9, '默认用中文回答。', 7),
    ])
    expect(decisions.map(decision => [decision.seq, decision.window, decision.text])).toEqual([
      [1, 1, '不要动 vite.config。'],
      [4, 3, '必须跑全量测试。'],
      [9, 7, '默认用中文回答。'],
    ])
  })

  test('ignores rows that are not the person\'s own, and the engine\'s reminder block', () => {
    expect(
      texts([
        { seq: 1, uuid: 'd1', ts: at(1), window: 1, role: 'user', door: 'delivery', text: '后台通知：不要用 npm' },
        person(2, '<system-reminder>会话开始时注入的一段话，不要当真</system-reminder>\n\n以后一律用 pnpm。'),
      ]),
    ).toEqual(['以后一律用 pnpm。'])
  })

  test('leaves out a document the person pasted for review', () => {
    const text = [
      '<pasted_content id="x">',
      '应该把 read_many 从 P0 降级。',
      '统一 Outcome 契约、查询快照：改动面大。',
      '</pasted_content>',
      '',
      '不用发布，我是给 gpt 审查的。',
    ].join('\n')
    expect(texts([person(1, text)])).toEqual(['不用发布，我是给 gpt 审查的。'])
  })

  test('takes at most three decisions from one message', () => {
    const long = '不要用 npm。不要用 yarn。不要用 pnpm。不要用 bun。必须用 node。'
    expect(texts([person(1, long)])).toEqual(['不要用 npm。', '不要用 yarn。', '不要用 pnpm。'])
  })


  test('reads an answer that trails off with a particle', () => {
    const rows = [
      assistant(1, '两套方案：1 直接改 Button.tsx，2 加一层包装。选哪套？'),
      person(2, '1+2吧'),
    ]
    const decisions = extractDecisions(rows)
    expect(decisions.map(decision => decision.text)).toEqual(['1+2吧'])
    expect(decisions[0]?.answered?.seq).toBe(1)
    // A bare "可以呗" with nothing to answer still says nothing.
    expect(texts([person(3, '可以呗')])).toEqual([])
  })

  test('keeps a list item that states a rule, and drops only headings and table rows', () => {
    expect(
      texts([person(1, '清单：\n- 不要用 npm。\n1. 以后一律用 pnpm。\n## 标题\n| 项 | 值 |')]),
    ).toEqual(['不要用 npm。', '以后一律用 pnpm。'])
  })

  test('takes a need stated without a prohibition', () => {
    expect(
      texts([
        person(1, '已做决定还得要能清理 因为有时候可能会又反悔'),
        person(2, '就先离线分析吧 我周额度现在就剩5了'),
        person(3, 'read 模式真正只给 Read/Grep/Glob，并把推理强度做成可配置。'),
        person(4, '直接用1h就行了 没必要再浪费额度了'),
      ]),
    ).toEqual([
      '已做决定还得要能清理 因为有时候可能会又反悔',
      '就先离线分析吧 我周额度现在就剩5了',
      'read 模式真正只给 Read/Grep/Glob，并把推理强度做成可配置。',
      '直接用1h就行了 没必要再浪费额度了',
    ])
  })

  test('leaves out what the person took back', () => {
    const rows = [person(1, '不要用 npm。'), person(2, '必须跑全量测试。')]
    expect(extractDecisions(rows).map(decision => decision.seq)).toEqual([1, 2])
    expect(extractDecisions(rows, new Set([1])).map(decision => decision.seq)).toEqual([2])
  })

  test('clips a very long sentence and points at its row', () => {
    const long = `不要${'x'.repeat(MAX_DECISION_CHARS + 50)}。`
    const decisions = extractDecisions([person(1, long)])
    expect(decisions[0]?.text.length).toBeLessThan(long.length)
    expect(decisions[0]?.text).toContain('……（原文更长，用 history 读 #1）')
  })
})

describe('renderDecisions', () => {
  test('is empty when the person settled nothing', () => {
    expect(renderDecisions([], 3_000)).toBe('')
  })

  test('names the section, then each decision with its row number and time', () => {
    const text = renderDecisions(extractDecisions([person(1, '不要动 vite.config。')]), 3_000)
    expect(text.split('\n')[0]).toBe('## 用户已定决策')
    expect(text).toContain(`- [#1] ${new Date(at(1)).toISOString()} 不要动 vite.config。`)
    expect(text).not.toContain('已省略')
  })

  test('drops the oldest decisions past the budget and says how many', () => {
    const rows = Array.from({ length: 20 }, (_, index) => person(index + 1, `不要用方案${index}。`))
    const text = renderDecisions(extractDecisions(rows), 300)
    expect(text.length).toBeLessThanOrEqual(300)
    expect(text).toContain('不要用方案19。')
    expect(text).not.toContain('不要用方案0。')
    const omitted = Number(/已省略 (\d+) 条/.exec(text)?.[1])
    const kept = text.split('\n').filter(line => line.startsWith('- [#')).length
    expect(kept + omitted).toBe(20)
    expect(omitted).toBeGreaterThan(0)
  })

  test('never drops the last two windows for budget, even when older ones go', () => {
    const rows = [
      person(1, '不要用方案一。', 1),
      person(2, '不要用方案二。', 2),
      person(3, '不要用方案三。', 3),
      person(4, '不要用方案四。', 4),
      person(5, '不要用方案五。', 5),
    ]
    const text = renderDecisions(extractDecisions(rows), 250, 4)
    expect(text).toContain('不要用方案四。')
    expect(text).toContain('不要用方案五。')
    expect(text).not.toContain('不要用方案一。')
    expect(text).toContain('已省略')
    // Those two alone are over the ceiling: then, and only then, the oldest goes.
    const tight = renderDecisions(extractDecisions(rows), 150, 4)
    expect(tight).toContain('不要用方案五。')
    expect(tight).not.toContain('不要用方案四。')
  })

  test('tells the model how to take a decision back', () => {
    const text = renderDecisions(extractDecisions([person(1, '不要用 npm。')]), 3_000)
    expect(text).toContain('后面的优先')
    expect(text).toContain('decision_revoke')
  })

  test('keeps the newest decision even when it alone is over the budget', () => {
    const long = `不要${'x'.repeat(MAX_DECISION_CHARS)}。`
    const text = renderDecisions(extractDecisions([person(1, long), person(2, '必须跑测试。')]), 10)
    expect(text).toContain('必须跑测试。')
    expect(text).not.toContain('不要' + 'x'.repeat(20))
    expect(text).toContain('已省略 1 条')
  })
})
