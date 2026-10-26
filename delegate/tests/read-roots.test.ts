import { describe, expect, test } from 'claude-code/testing'

import { readRootsEnv, readRootsOf, readRootsPromptArg } from '../scripts/read-roots.mjs'

// delegate -> ptc-run: job.readPaths becomes PTC_RUN_READ_ROOTS in the child's environment, plus a prompt line.
describe('read paths for the read-only sandbox', () => {
  test('only read + ptc:only carries them, trimmed and de-duplicated', () => {
    const job = { readPaths: [' C:/ext/one ', 'C:/ext/one', '', 'D:/ext/two'] }
    expect(readRootsOf(job, true)).toEqual(['C:/ext/one', 'D:/ext/two'])
    expect(readRootsOf(job, false)).toEqual([])
    expect(readRootsOf({}, true)).toEqual([])
    expect(readRootsOf({ readPaths: 'C:/ext/one' }, true)).toEqual([])
    expect(readRootsOf({ readPaths: [42, null, 'C:/ext/one'] }, true)).toEqual(['C:/ext/one'])
  })

  test('the environment variable is PATH-separated, empty when there is nothing', () => {
    expect(readRootsEnv([], ';')).toBe('')
    expect(readRootsEnv(['C:/ext/one'], ';')).toBe('C:/ext/one')
    expect(readRootsEnv(['C:/ext/one', 'D:/ext/two'], ';')).toBe('C:/ext/one;D:/ext/two')
    expect(readRootsEnv(['/a/one', '/b/two'], ':')).toBe('/a/one:/b/two')
  })

  test('the prompt line is one argument, and absent without roots', () => {
    expect(readRootsPromptArg([])).toEqual([])
    const arg = readRootsPromptArg(['C:/ext/one', 'D:/ext/two'])
    expect(arg).toHaveLength(2)
    expect(arg[0]).toBe('--append-system-prompt')
    expect(arg[1]).toContain('Extra readable directories')
    expect(arg[1]).toContain('C:/ext/one, D:/ext/two')
  })
})
