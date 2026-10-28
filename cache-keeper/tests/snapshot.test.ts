import { describe, expect, test } from 'claude-code/testing'

import { LEDGER_SNAPSHOT_PROMPT, MAX_SNAPSHOT_ENTRIES, parseSnapshot } from '../hooks/lib/snapshot.ts'

const one = {
  task_id: 't1',
  title: '改解析器',
  status: 'in_progress',
  text: '改了一半',
  next_step: '跑测试',
}

describe('parseSnapshot', () => {
  test('reads a bare array of open tasks', () => {
    expect(parseSnapshot(JSON.stringify([one]))).toEqual([one])
  })

  test('reads an array wrapped in a json fence with words around it', () => {
    const answer = ['Here you go:', '```json', JSON.stringify([one]), '```', 'Anything else?'].join('\n')
    expect(parseSnapshot(answer)).toEqual([one])
  })

  test('reads an array with prose before and after it, fence or not', () => {
    const answer = `Sure: ${JSON.stringify([one])} — that is all.`
    expect(parseSnapshot(answer)).toEqual([one])
  })

  test('an empty array is an answer: nothing is open', () => {
    expect(parseSnapshot('[]')).toEqual([])
  })

  test('a damaged answer is no snapshot at all', () => {
    expect(parseSnapshot('I could not read the conversation.')).toBeNull()
    expect(parseSnapshot('[{"task_id": "t1", ')).toBeNull()
    expect(parseSnapshot('')).toBeNull()
  })

  test('an item missing a field, or with a status the ledger has no use for, is dropped alone', () => {
    const answer = JSON.stringify([
      one,
      { task_id: 't2', title: '没有正文', status: 'in_progress' },
      { task_id: 't3', title: '已做完', status: 'done', text: '做完了' },
      { task_id: 't4', title: '受阻', status: 'blocked', text: '缺权限' },
      'not an object',
    ])
    expect(parseSnapshot(answer)).toEqual([one, { task_id: 't4', title: '受阻', status: 'blocked', text: '缺权限' }])
  })

  test('at most eight entries are kept', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ ...one, task_id: `t${index}` }))
    expect(parseSnapshot(JSON.stringify(many))).toHaveLength(MAX_SNAPSHOT_ENTRIES)
  })

  test('the prompt asks for the array and for no tool', () => {
    expect(LEDGER_SNAPSHOT_PROMPT).toContain('JSON array')
    expect(LEDGER_SNAPSHOT_PROMPT).toContain('next_step')
    expect(LEDGER_SNAPSHOT_PROMPT).toContain('Call no tools')
  })
})
