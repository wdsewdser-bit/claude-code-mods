import { describe, expect, test } from 'claude-code/testing'

import {
  activityOf,
  MAX_LISTED_FILES,
  cut,
  filesOf,
  locate,
  pathKey,
  pathsToRead,
  relativePath,
  renderWorkset,
  snippetsOf,
} from '../hooks/lib/workset.ts'
import type { FileContent, FileState, OpenTask } from '../hooks/lib/workset.ts'
import { DEFAULTS } from '../hooks/lib/types.ts'
import type { Anchor, FileActivity, Snippet } from '../hooks/lib/types.ts'

const meta = (seq: number, window = 1, isError = false) => ({ seq, window, isError })

const act = (extra: Partial<FileActivity> = {}): FileActivity => ({
  path: 'C:\\repo\\a.ts',
  op: 'read',
  seq: 1,
  window: 1,
  isError: false,
  ...extra,
})

const anchor = (extra: Partial<Anchor> = {}): Anchor => ({
  path: 'C:\\repo\\a.ts',
  match: 'ONE',
  note: '改这里',
  ...extra,
})

const task = (taskId: string, anchors: readonly Anchor[]): OpenTask => ({ taskId, anchors })

const files = (rows: readonly (readonly [string, FileContent])[]): ReadonlyMap<string, FileContent> =>
  new Map<string, FileContent>(rows)

const FIVE = 'l1\nl2\nl3\nl4\nl5'

describe('pathKey', () => {
  test('folds the slash and the case of a Windows path', () => {
    expect(pathKey('C:\\Repo\\Src\\A.ts')).toBe(pathKey('c:/repo/src/a.ts'))
    expect(pathKey('C:\\repo\\src\\')).toBe('c:/repo/src')
    expect(pathKey('c:/repo/src')).toBe('c:/repo/src')
  })
})

describe('activityOf', () => {
  test('a Read carries the named line range', () => {
    expect(activityOf('Read', { file_path: 'C:\\a.ts', offset: 10, limit: 5 }, meta(3, 2))).toEqual({
      path: 'C:\\a.ts',
      op: 'read',
      seq: 3,
      window: 2,
      isError: false,
      startLine: 10,
      endLine: 14,
    })
  })

  test('a Read without an offset has no range, and a wrong type is no offset at all', () => {
    expect(activityOf('Read', { file_path: 'C:\\a.ts' }, meta(1))).toEqual({
      path: 'C:\\a.ts',
      op: 'read',
      seq: 1,
      window: 1,
      isError: false,
    })
    const spread = activityOf('Read', { file_path: 'C:\\a.ts', offset: 4 }, meta(1))
    expect(spread?.startLine).toBe(4)
    expect(spread?.endLine).toBeUndefined()
    const typed = activityOf('Read', { file_path: 'C:\\a.ts', offset: '10' }, meta(1))
    expect(typed?.startLine).toBeUndefined()
  })

  test('an Edit keeps the first non-blank line it wrote as the hint', () => {
    const edit = activityOf('Edit', { file_path: 'C:\\a.ts', new_string: '\n   \n  const x = 1  \nmore' }, meta(4))
    expect(edit).toEqual({ path: 'C:\\a.ts', op: 'edit', seq: 4, window: 1, isError: false, hint: 'const x = 1' })
    expect(activityOf('Edit', { file_path: 'C:\\a.ts', new_string: '\n  \t ' }, meta(5))?.hint).toBeUndefined()
    expect(activityOf('Edit', { file_path: 'C:\\a.ts' }, meta(6))?.hint).toBeUndefined()
  })

  test('a hint never runs past two hundred characters', () => {
    const long = 'x'.repeat(300)
    expect(activityOf('Edit', { file_path: 'C:\\a.ts', new_string: long }, meta(1))?.hint).toHaveLength(200)
  })

  test('Write, NotebookEdit, Grep and Glob each map to their op', () => {
    expect(activityOf('Write', { file_path: 'C:\\a.ts' }, meta(1))?.op).toBe('write')
    expect(activityOf('NotebookEdit', { notebook_path: 'C:\\a.ipynb' }, meta(2))).toEqual({
      path: 'C:\\a.ipynb',
      op: 'edit',
      seq: 2,
      window: 1,
      isError: false,
    })
    expect(activityOf('Grep', { path: 'C:\\repo' }, meta(3))?.op).toBe('search')
    expect(activityOf('Glob', { path: 'C:\\repo' }, meta(4))?.op).toBe('search')
  })

  test('a tool with no path, or none at all, leaves no activity', () => {
    expect(activityOf('Grep', { pattern: 'x' }, meta(1))).toBeNull()
    expect(activityOf('Grep', { path: '' }, meta(1))).toBeNull()
    expect(activityOf('Bash', { command: 'ls' }, meta(1))).toBeNull()
    expect(activityOf('Read', { file_path: 7 }, meta(1))).toBeNull()
    expect(activityOf('Edit', { file_path: null }, meta(1))).toBeNull()
    expect(activityOf('Write', {}, meta(1))).toBeNull()
    expect(activityOf('NotebookEdit', { file_path: 'C:\\a.ts' }, meta(1))).toBeNull()
  })
})

describe('filesOf', () => {
  test('merges two spellings of one file and counts reads and edits', () => {
    const rows = filesOf([
      act({ seq: 1, op: 'read', path: 'C:\\Repo\\A.ts' }),
      act({ seq: 2, op: 'edit', path: 'c:/repo/a.ts' }),
      act({ seq: 3, op: 'read', path: 'C:\\repo\\A.ts' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      path: 'C:\\repo\\A.ts',
      lastOp: 'read',
      lastSeq: 3,
      reads: 2,
      edits: 1,
      lastReadSeq: 3,
      lastEditSeq: 2,
      isEditedSinceRead: false,
    })
  })

  test('a write counts as an edit', () => {
    const rows = filesOf([act({ seq: 1, op: 'write' })])
    expect(rows[0]?.edits).toBe(1)
    expect(rows[0]?.isEditedSinceRead).toBe(true)
  })

  test('a failed call and a search say nothing about the file', () => {
    expect(filesOf([act({ seq: 1, isError: true })])).toHaveLength(0)
    expect(filesOf([act({ seq: 1, op: 'search', path: 'C:\\repo' })])).toHaveLength(0)
    const rows = filesOf([act({ seq: 1 }), act({ seq: 9, op: 'search' }), act({ seq: 10, isError: true })])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.lastSeq).toBe(1)
  })

  test('only an edit newer than the last read marks the file as changed', () => {
    const readOnly = filesOf([act({ seq: 2, op: 'read' })])
    expect(readOnly[0]?.isEditedSinceRead).toBe(false)
    const editedAfter = filesOf([act({ seq: 2, op: 'read' }), act({ seq: 5, op: 'edit' })])
    expect(editedAfter[0]?.isEditedSinceRead).toBe(true)
    const readAfter = filesOf([
      act({ seq: 2, op: 'edit' }),
      act({ seq: 5, op: 'read' }),
      act({ seq: 6, op: 'edit' }),
      act({ seq: 9, op: 'read' }),
    ])
    expect(readAfter[0]?.isEditedSinceRead).toBe(false)
  })

  test('rows run newest first, and a window can be picked out', () => {
    const rows = [
      act({ seq: 2, op: 'edit', path: 'C:\\r\\a.ts' }),
      act({ seq: 5, op: 'read', path: 'C:\\r\\b.ts' }),
      act({ seq: 9, op: 'read', path: 'C:\\r\\c.ts', window: 2 }),
    ]
    expect(filesOf(rows).map(row => row.path)).toEqual(['C:\\r\\c.ts', 'C:\\r\\b.ts', 'C:\\r\\a.ts'])
    expect(filesOf(rows, 1).map(row => row.path)).toEqual(['C:\\r\\b.ts', 'C:\\r\\a.ts'])
    expect(filesOf(rows, 3)).toHaveLength(0)
  })
})

describe('locate', () => {
  test('a unique match reports the line it starts on', () => {
    expect(locate('a\nb\nc', 'b')).toEqual({ kind: 'ok', line: 2 })
    expect(locate('a\nb\nc', 'a\nb')).toEqual({ kind: 'ok', line: 1 })
    expect(locate('a\nb\nc', 'c')).toEqual({ kind: 'ok', line: 3 })
  })

  test('no match, and a match that is not the only one', () => {
    expect(locate('a\nb', 'z')).toEqual({ kind: 'no-match' })
    expect(locate('', 'a')).toEqual({ kind: 'no-match' })
    expect(locate('a\nb\na', 'a')).toEqual({ kind: 'ambiguous', count: 2 })
  })

  test('an empty match is never a match', () => {
    expect(locate('a\nb', '')).toEqual({ kind: 'no-match' })
  })

  test('a file saved with CRLF is found by a match written with LF', () => {
    expect(locate('x\r\ny\r\nz', 'y')).toEqual({ kind: 'ok', line: 2 })
    expect(locate('x\r\ny\r\nz', 'x\r\ny')).toEqual({ kind: 'ok', line: 1 })
  })
})

describe('cut', () => {
  test('takes the lines around the anchor, each with its number', () => {
    expect(cut(FIVE, 3, 1)).toEqual({ startLine: 2, endLine: 4, text: '2\tl2\n3\tl3\n4\tl4' })
  })

  test('a cut near either edge stops at the file', () => {
    expect(cut(FIVE, 1, 2)).toEqual({ startLine: 1, endLine: 3, text: '1\tl1\n2\tl2\n3\tl3' })
    expect(cut(FIVE, 5, 2)).toEqual({ startLine: 3, endLine: 5, text: '3\tl3\n4\tl4\n5\tl5' })
    expect(cut(FIVE, 2, 0)).toEqual({ startLine: 2, endLine: 2, text: '2\tl2' })
  })

  test('the newline that ends the file does not count as a line', () => {
    expect(cut('a\nb\n', 2, 4)).toEqual({ startLine: 1, endLine: 2, text: '1\ta\n2\tb' })
    expect(cut('a\n\n', 1, 2)).toEqual({ startLine: 1, endLine: 2, text: '1\ta\n2\t' })
  })

  test('CRLF is shown as one line break', () => {
    expect(cut('x\r\ny\r\nz', 2, 1)).toEqual({ startLine: 1, endLine: 3, text: '1\tx\n2\ty\n3\tz' })
  })

  test('a line past the end of the file is pulled back to the last line', () => {
    expect(cut('a\nb', 9, 2)).toEqual({ startLine: 1, endLine: 2, text: '1\ta\n2\tb' })
    expect(cut(FIVE, 40, 1)).toEqual({ startLine: 4, endLine: 5, text: '4\tl4\n5\tl5' })
  })

  test('a line number that is not a number reads as the first line', () => {
    expect(cut('a\nb', Number.NaN, 1)).toEqual({ startLine: 1, endLine: 2, text: '1\ta\n2\tb' })
    expect(cut('a\nb', Number.POSITIVE_INFINITY, 1)).toEqual({ startLine: 1, endLine: 2, text: '1\ta\n2\tb' })
    expect(cut('a\nb', -7, 1)).toEqual({ startLine: 1, endLine: 2, text: '1\ta\n2\tb' })
  })

  test('a negative or unknown around never widens the slice', () => {
    expect(cut('a\nb', 2, -5)).toEqual({ startLine: 2, endLine: 2, text: '2\tb' })
    expect(cut('a\nb', 2, Number.NaN)).toEqual({ startLine: 2, endLine: 2, text: '2\tb' })
  })

  test('an empty file has nothing to cut', () => {
    expect(cut('', 9, 2)).toEqual({ startLine: 1, endLine: 0, text: '' })
  })
})

describe('pathsToRead', () => {
  test('anchor files come first, then the hint files of an anchor-less task', () => {
    const tasks = [task('T1', [anchor({ path: 'C:\\repo\\a.ts' })]), task('T2', [])]
    const activities = [
      act({ seq: 5, op: 'edit', path: 'c:\\repo\\b.ts', hint: 'b' }),
      act({ seq: 6, op: 'edit', path: 'c:\\repo\\c.ts', hint: 'c' }),
      act({ seq: 7, op: 'edit', path: 'c:\\repo\\d.ts', hint: 'd' }),
      act({ seq: 8, op: 'edit', path: 'c:\\repo\\e.ts', hint: 'e' }),
    ]
    expect(pathsToRead(tasks, activities)).toEqual([
      'C:\\repo\\a.ts',
      'c:\\repo\\e.ts',
      'c:\\repo\\d.ts',
      'c:\\repo\\c.ts',
    ])
  })

  test('a file already wanted by an anchor is not listed twice', () => {
    const tasks = [task('T1', [anchor({ path: 'C:\\Repo\\B.ts' })]), task('T2', [])]
    const activities = [act({ seq: 5, op: 'edit', path: 'c:/repo/b.ts', hint: 'b' })]
    expect(pathsToRead(tasks, activities)).toEqual(['C:\\Repo\\B.ts'])
  })

  test('no anchor-less task means no hint files at all', () => {
    const tasks = [task('T1', [anchor({ path: 'C:\\repo\\a.ts' })])]
    const activities = [act({ seq: 5, op: 'edit', path: 'c:\\repo\\b.ts', hint: 'b' })]
    expect(pathsToRead(tasks, activities)).toEqual(['C:\\repo\\a.ts'])
  })

  test('a damaged anchor list cannot throw, and the sound anchor is still read', () => {
    const messy = [
      null,
      'not a task',
      { taskId: 'T1', anchors: { 0: { path: 'C:\\repo\\x.ts', match: 'x' } } },
      { taskId: 'T2', anchors: 'nope' },
      {
        taskId: 'T3',
        anchors: [null, 7, 'text', { path: 'C:\\repo\\y.ts' }, { match: 'two' }, { path: '', match: 'two' }],
      },
      { taskId: 'T4', anchors: [{ path: 'C:\\repo\\a.ts', match: 'two' }] },
    ] as unknown as readonly OpenTask[]

    let paths: string[] = []
    expect(() => {
      paths = pathsToRead(messy, [])
    }).not.toThrow()
    expect(paths).toEqual(['C:\\repo\\a.ts'])
  })

  test('only the window named is searched, and only successful edits with a hint count', () => {
    const tasks = [task('T1', [])]
    const activities = [
      act({ seq: 5, op: 'edit', path: 'c:\\repo\\b.ts', hint: 'b', window: 1 }),
      act({ seq: 9, op: 'edit', path: 'c:\\repo\\c.ts', hint: 'c', window: 2 }),
      act({ seq: 10, op: 'edit', path: 'c:\\repo\\d.ts', hint: 'd', window: 2, isError: true }),
      act({ seq: 11, op: 'edit', path: 'c:\\repo\\e.ts', window: 2 }),
      act({ seq: 12, op: 'write', path: 'c:\\repo\\f.ts', window: 2 }),
    ]
    expect(pathsToRead(tasks, activities, 2)).toEqual(['c:\\repo\\c.ts'])
  })
})

describe('snippetsOf', () => {
  const config = { ...DEFAULTS, snippetLines: 1 }

  test('an anchor that still resolves becomes numbered text', () => {
    const out = snippetsOf(
      {
        tasks: [task('T1', [anchor({ path: 'C:\\repo\\a.ts', match: 'three' })])],
        files: files([['c:/repo/a.ts', 'one\ntwo\nthree\nfour\nfive']]),
        activities: [],
      },
      config,
    )
    expect(out).toEqual([
      {
        path: 'C:\\repo\\a.ts',
        taskId: 'T1',
        note: '改这里',
        startLine: 2,
        text: '2\ttwo\n3\tthree\n4\tfour',
      },
    ])
  })

  test('the line number is the one the file has now, not the one it had when it was read', () => {
    const out = snippetsOf(
      {
        tasks: [task('T1', [anchor({ path: 'C:\\repo\\a.ts', match: 'three' })])],
        files: files([['c:/repo/a.ts', 'added\nmore\none\ntwo\nthree']]),
        activities: [act({ seq: 7, op: 'read', path: 'C:\\repo\\a.ts' })],
      },
      { ...DEFAULTS, snippetLines: 0 },
    )
    expect(out).toEqual([
      { path: 'C:\\repo\\a.ts', taskId: 'T1', note: '改这里', startLine: 5, text: '5\tthree' },
    ])
  })

  test('a file that is gone, or missing from what was read, is a re-read', () => {
    const out = snippetsOf(
      {
        tasks: [
          task('T1', [anchor({ path: 'C:\\repo\\a.ts' })]),
          task('T2', [anchor({ path: 'C:\\repo\\b.ts' })]),
        ],
        files: files([['c:/repo/b.ts', { missing: true }]]),
        activities: [act({ seq: 9, op: 'read', path: 'C:\\repo\\a.ts' })],
      },
      config,
    )
    expect(out).toEqual([
      { path: 'C:\\repo\\a.ts', taskId: 'T1', note: '改这里', needsRead: '文件不存在或没有读到', lastSeq: 9 },
      { path: 'C:\\repo\\b.ts', taskId: 'T2', note: '改这里', needsRead: '文件不存在或没有读到' },
    ])
  })

  test('a file too large to carry says so, and a failed read is not the last one', () => {
    const out = snippetsOf(
      {
        tasks: [task('T1', [anchor({ path: 'C:\\repo\\a.ts' })])],
        files: files([['c:/repo/a.ts', { tooLarge: true }]]),
        activities: [act({ seq: 9, op: 'read', path: 'C:\\repo\\a.ts', isError: true })],
      },
      config,
    )
    expect(out[0]).toEqual({
      path: 'C:\\repo\\a.ts',
      taskId: 'T1',
      note: '改这里',
      needsRead: '文件太大，没有取片段',
    })
  })

  test('a stale anchor is never guessed at', () => {
    const out = snippetsOf(
      {
        tasks: [
          task('T1', [anchor({ path: 'C:\\repo\\a.ts', match: 'gone' })]),
          task('T2', [anchor({ path: 'C:\\repo\\a.ts', match: 'one' })]),
        ],
        files: files([['c:/repo/a.ts', 'one\ntwo\none']]),
        activities: [],
      },
      config,
    )
    expect(out).toEqual([
      { path: 'C:\\repo\\a.ts', taskId: 'T1', note: '改这里', needsRead: '在文件里找不到锚点原文' },
      { path: 'C:\\repo\\a.ts', taskId: 'T2', note: '改这里', needsRead: '锚点原文出现了 2 次，无法唯一定位' },
    ])
  })

  test('the same anchor twice in one task is taken once', () => {
    const out = snippetsOf(
      {
        tasks: [task('T1', [anchor({ match: 'two' }), anchor({ match: 'two' })])],
        files: files([['c:/repo/a.ts', 'one\ntwo\nthree']]),
        activities: [],
      },
      { ...DEFAULTS, snippetLines: 0 },
    )
    expect(out).toHaveLength(1)
  })

  const budgetTasks = [task('T1', [anchor({ match: 'aaa', note: 'A' })]), task('T2', [anchor({ path: 'C:\\repo\\b.ts', match: 'ddd', note: 'B' })])]
  const budgetFiles = files([
    ['c:/repo/a.ts', 'aaa\nbbb'],
    ['c:/repo/b.ts', 'ccc\nddd'],
  ])

  test('a snippet past the budget is turned into a re-read instead', () => {
    const out = snippetsOf(
      { tasks: budgetTasks, files: budgetFiles, activities: [] },
      { ...DEFAULTS, snippetLines: 0, snippetTokens: 3 },
    )
    expect(out).toEqual([
      { path: 'C:\\repo\\a.ts', taskId: 'T1', note: 'A', startLine: 1, text: '1\taaa' },
      { path: 'C:\\repo\\b.ts', taskId: 'T2', note: 'B', needsRead: '超出片段预算' },
    ])
  })

  test('the first snippet is kept even when it alone is over budget', () => {
    const out = snippetsOf(
      { tasks: budgetTasks, files: budgetFiles, activities: [] },
      { ...DEFAULTS, snippetLines: 0, snippetTokens: 1 },
    )
    expect(out[0]).toEqual({ path: 'C:\\repo\\a.ts', taskId: 'T1', note: 'A', startLine: 1, text: '1\taaa' })
    expect(out[1]?.needsRead).toBe('超出片段预算')
  })

  test('a task with no anchor falls back to the spots its last edits touched', () => {
    const activities = [act({ seq: 4, op: 'edit', path: 'C:\\repo\\f.ts', hint: 'two' })]
    const out = snippetsOf(
      {
        tasks: [task('T0', []), task('T1', [])],
        files: files([['c:/repo/f.ts', 'one\ntwo\nthree']]),
        activities,
      },
      { ...DEFAULTS, snippetLines: 0 },
    )
    expect(out).toEqual([
      { path: 'C:\\repo\\f.ts', taskId: 'T0', note: '最近改动的位置', startLine: 2, text: '2\ttwo' },
    ])
  })

  test('a task whose anchors are not a list is treated as anchor-less, not as a crash', () => {
    const messy = [
      { taskId: 'T1', anchors: { 0: { path: 'C:\\repo\\a.ts', match: 'two' } } },
      { taskId: 'T2', anchors: [null, 7, 'text', { path: 'C:\\repo\\a.ts' }, { match: 'two' }, { path: '', match: 'two' }] },
      { taskId: 'T3', anchors: [{ path: 'C:\\repo\\a.ts', match: 'two' }] },
    ] as unknown as readonly OpenTask[]

    let out: Snippet[] = []
    expect(() => {
      out = snippetsOf(
        { tasks: messy, files: files([['c:/repo/a.ts', 'one\ntwo\nthree']]), activities: [] },
        { ...DEFAULTS, snippetLines: 0 },
      )
    }).not.toThrow()
    expect(out).toEqual([
      { path: 'C:\\repo\\a.ts', taskId: 'T3', note: '', startLine: 2, text: '2\ttwo' },
    ])
  })

  test('an anchor with a note that is not text still gives its snippet', () => {
    const weird = {
      taskId: 'T1',
      anchors: [{ path: 'C:\\repo\\a.ts', match: 'two', note: 42 }],
    } as unknown as OpenTask
    const out = snippetsOf(
      { tasks: [weird], files: files([['c:/repo/a.ts', 'one\ntwo\nthree']]), activities: [] },
      { ...DEFAULTS, snippetLines: 0 },
    )
    expect(out).toEqual([{ path: 'C:\\repo\\a.ts', taskId: 'T1', note: '', startLine: 2, text: '2\ttwo' }])
  })

  test('a hint that no longer resolves leaves nothing behind', () => {
    const activities = [act({ seq: 4, op: 'edit', path: 'C:\\repo\\f.ts', hint: 'moved away' })]
    const out = snippetsOf(
      {
        tasks: [task('T0', [])],
        files: files([['c:/repo/f.ts', 'one\ntwo']]),
        activities,
      },
      config,
    )
    expect(out).toHaveLength(0)
  })
})

describe('renderWorkset', () => {
  const rows: FileState[] = [
    {
      path: 'C:\\repo\\a.ts',
      lastOp: 'edit',
      lastSeq: 12,
      reads: 2,
      edits: 1,
      lastReadSeq: 4,
      lastEditSeq: 12,
      isEditedSinceRead: true,
    },
    {
      path: 'C:\\repo\\b.ts',
      lastOp: 'read',
      lastSeq: 7,
      reads: 3,
      edits: 0,
      lastReadSeq: 7,
      isEditedSinceRead: false,
    },
  ]

  const snippets: Snippet[] = [
    { path: 'C:\\repo\\a.ts', taskId: 'T1', note: '改这里', startLine: 40, text: '40\tconst x = 1' },
    { path: 'C:\\repo\\b.ts', taskId: 'T2', note: '写下一步', needsRead: '在文件里找不到锚点原文', lastSeq: 7 },
  ]

  test('lists the working set and then the places to edit', () => {
    const text = renderWorkset(rows, snippets)
    expect(text).toContain('【文件工作集】')
    expect(text).toContain('C:\\repo\\a.ts · 读 2 次/改 1 次 · 最后活动 #12 · 改后未重读')
    expect(text).toContain('C:\\repo\\b.ts · 读 3 次/改 0 次 · 最后活动 #7')
    expect(text.split('\n')[2]).not.toContain('改后未重读')
    expect(text).toContain('【待改位置】')
    expect(text).toContain('- 任务 T1 · C:\\repo\\a.ts:40 · 改这里')
    expect(text).toContain('```\n40\tconst x = 1\n```')
    expect(text).toContain('需重读：在文件里找不到锚点原文')
    expect(text).toContain('（上次读取见 #7）')
  })

  test('an empty switch says so and leaves out the second section', () => {
    expect(renderWorkset([], [])).toBe('【文件工作集】\n本窗口没有读写过文件')
  })

  test('a re-read with no history behind it keeps the note short', () => {
    const text = renderWorkset([], [
      { path: 'C:\\repo\\a.ts', taskId: 'T1', note: '改这里', needsRead: '文件太大，没有取片段' },
    ])
    expect(text).toContain('- 任务 T1 · C:\\repo\\a.ts · 改这里 · 需重读：文件太大，没有取片段')
    expect(text).not.toContain('上次读取见')
  })

  test('with a working directory the paths inside it are shown relative, and the row data is not touched', () => {
    const before = JSON.stringify([rows, snippets])
    const text = renderWorkset(rows, snippets, new Map(), 'c:/Repo/')
    expect(text).toContain('路径相对工作目录 c:/Repo/')
    expect(text).toContain('\na.ts · 读 2 次/改 1 次 · 最后活动 #12 · 改后未重读')
    expect(text).toContain('- 任务 T1 · a.ts:40 · 改这里')
    expect(text).toContain('- 任务 T2 · b.ts · 写下一步 · 需重读：在文件里找不到锚点原文')
    expect(text).not.toContain('C:\\repo\\')
    expect(JSON.stringify([rows, snippets])).toBe(before)
  })

  test('a path outside the directory, or no directory at all, keeps the absolute path', () => {
    expect(renderWorkset(rows, snippets, new Map(), 'D:\\other')).toContain('C:\\repo\\a.ts · 读 2 次')
    expect(renderWorkset(rows, snippets, new Map(), 'D:\\other')).not.toContain('路径相对工作目录')
    expect(renderWorkset(rows, snippets)).toContain('C:\\repo\\a.ts · 读 2 次')
  })

  test('relativePath cuts only at a directory boundary and keeps case on POSIX', () => {
    expect(relativePath('/work/src/a.ts', '/work')).toBe('src/a.ts')
    expect(relativePath('/workshop/a.ts', '/work')).toBe('/workshop/a.ts')
    expect(relativePath('/work', '/work')).toBe('/work')
    expect(relativePath('/Work/a.ts', '/work')).toBe('/Work/a.ts')
    expect(relativePath('C:\\Repo\\src\\a.ts', 'c:\\repo')).toBe('src\\a.ts')
    expect(relativePath('src/a.ts', '/work')).toBe('src/a.ts')
    expect(relativePath('/work/a.ts', undefined)).toBe('/work/a.ts')
  })

  test('only thirty files are listed, the rest are counted', () => {
    const many: FileState[] = Array.from({ length: MAX_LISTED_FILES + 5 }, (_, i) => ({
      path: `C:\\repo\\f${i}.ts`,
      lastOp: 'read' as const,
      lastSeq: 100 - i,
      reads: 1,
      edits: 0,
      lastReadSeq: 100 - i,
      isEditedSinceRead: false,
    }))
    const text = renderWorkset(many, [])
    expect(text).toContain('另有 5 个')
    expect(text).not.toContain(`f${MAX_LISTED_FILES}.ts`)
    expect(text).toContain(`f${MAX_LISTED_FILES - 1}.ts`)
  })
})
