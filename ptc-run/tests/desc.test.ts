import { describe, expect, test } from 'claude-code/testing'
import { __test } from '../hooks/register'

// The host shows the model only about the first 4000 characters of a tool description, and the global library list
// leads it (descAppend, at most DESC_APPEND_MAX). These tests pin that budget and the words the compression must not
// lose: the examples, the tools.help pointer, and the two mechanisms that only kept one sentence each (read dedup, the
// bash timeout promotion). The full text behind every topic is tested for real in tests/desc-examples.test.mjs.

const withLongestPrefix = (base: string): number => __test.DESC_APPEND_MAX + 1 + base.length
const ROOTS = ['C:/Users/someone/work/extra-readable-directory-one', 'D:/another/extra/directory']

describe('the tool description fits the host budget', () => {
  test('every base description with the longest library prefix stays at 4000 characters or less', () => {
    expect(withLongestPrefix(__test.DESC)).toBeLessThanOrEqual(4000)
    expect(withLongestPrefix(__test.descRo(ROOTS))).toBeLessThanOrEqual(4000)
    expect(withLongestPrefix(__test.descRo([]))).toBeLessThanOrEqual(4000)
    expect(withLongestPrefix(__test.DESC_SHORT)).toBeLessThanOrEqual(4000)
    expect(withLongestPrefix(__test.descShortRo(ROOTS))).toBeLessThanOrEqual(4000)
  })

  test('the prefix itself never exceeds its cap', () => {
    expect((__test.SHORT_HELP + __test.LIB_HINT).length).toBeLessThanOrEqual(__test.DESC_APPEND_MAX)
  })

  test('the examples and the tools.help pointer are there', () => {
    expect(__test.DESC).toContain('Examples')
    expect(__test.DESC).toContain('tools.grep')
    expect(__test.DESC).toContain('lib.def')
    expect(__test.DESC).toContain('tools.help(topic)')
    expect(__test.DESC).toContain('tools.help() lists them')
  })

  test('read dedup and the bash timeout promotion keep one sentence each', () => {
    expect(__test.DESC).toContain('read-dedup')
    expect(__test.DESC).toContain('jobId')
    expect(__test.DESC).toContain('promoted')
    // and the mechanics stay reachable in full
    expect(__test.DESC).toContain('tools.help("read")')
    expect(__test.DESC).toContain('tools.help("bash")')
  })

  test('the error codes are all still listed', () => {
    for (const code of ['INVALID_ARGUMENT', 'NOT_FOUND', 'NOT_UNIQUE', 'COUNT_MISMATCH', 'STALE', 'LOCKED', 'EXISTS', 'POLICY_DENIED', 'BUSY', 'OUTPUT_LIMIT', 'RG_UNAVAILABLE', 'RESULT_UNKNOWN']) {
      expect(__test.DESC).toContain(code)
    }
  })

  test('the read-only description is compressed too, and shows a read-only example', () => {
    const ro = __test.descRo(ROOTS)
    expect(ro).toContain('READ-ONLY')
    expect(ro).toContain('tools.help(topic)')
    expect(ro).toContain('tools.grep')
    expect(ro).not.toContain('tools.replace')
    expect(ro).not.toContain('ref.store')
    expect(ro).toContain('Extra readable directories besides the working directory: ' + ROOTS.join(', '))
  })

  test('no part is an empty string and DESC is the parts joined by one space', () => {
    for (const part of __test.DESC_PARTS) expect(part.length).toBeGreaterThan(20)
    expect(__test.DESC).toBe(__test.DESC_PARTS.join(' '))
  })
})
