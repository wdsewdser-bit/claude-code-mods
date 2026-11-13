import { describe, expect, test } from 'claude-code/testing'
import { __test, register } from '../hooks/register'

// The tool description may only grow at its end: the rest of it is the cache prefix every session shares. The appended
// part lists the GLOBAL library (the session one stays out of the prefix), and it is at most 600 characters.

type Handler = { name: string; opts?: unknown; fn: (...a: unknown[]) => unknown }

const startWith = async (libText: string | undefined, env: Record<string, string> = { USERPROFILE: 'C:/home' }, options: Record<string, unknown> = {}) => {
  const handlers: Handler[] = []
  const on = (name: string, a: unknown, b?: unknown) => {
    const fn = (typeof a === 'function' ? a : b) as (...x: unknown[]) => unknown
    handlers.push({ name, opts: typeof a === 'function' ? undefined : a, fn })
    const chain = { catch: () => chain }
    return chain
  }
  ;(register as unknown as (o: unknown, opt: unknown) => void)(on, options)
  const registered: Record<string, unknown>[] = []
  const reads: string[] = []
  const $ = {
    env: { get: async (n: string) => env[n] },
    session: { cwd: async () => 'C:/work/proj', id: async () => 'sid-doc', messages: async () => [] },
    tool: { register: async (spec: Record<string, unknown>) => { registered.push(spec); return {} } },
    fs: {
      read: async (p: string) => {
        reads.push(p)
        if (libText === undefined) throw new Error('ENOENT')
        return libText
      },
    },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    ui: { log: () => undefined },
    agent: { list: async () => [] },
  }
  const h = handlers.find(x => x.name === 'session.start')
  if (h === undefined) throw new Error('no session.start')
  await h.fn($, { cwd: 'C:/work/proj' }, async () => ({}))
  return { desc: String(registered[0]?.['description'] ?? ''), reads }
}

const lib = (fns: Record<string, string>) =>
  JSON.stringify({ version: 1, functions: Object.fromEntries(Object.entries(fns).map(([k, v]) => [k, { source: '(tools) => 1', doc: v }])) })

describe('the appended description', () => {
  test('with no library it is only the short help, and stays under 600 characters', () => {
    const add = __test.descAppend([])
    expect(add).toBe(__test.SHORT_HELP + __test.LIB_HINT)
    expect(add).toContain('tools.sh')
    expect(add).toContain('tools.peek')
    expect(add).toContain('lib.def')
    expect(add.length).toBeLessThanOrEqual(__test.DESC_APPEND_MAX)
  })

  test('the global function list is added, marked as the global library', () => {
    const add = __test.descAppend([{ name: 'check', doc: '跑测试' }, { name: 'ship', doc: '提交并推送' }])
    expect(add).toContain('全局库')
    expect(add).toContain('check — 跑测试')
    expect(add).toContain('ship — 提交并推送')
    expect(add.length).toBeLessThanOrEqual(__test.DESC_APPEND_MAX)
  })

  test('a long list is cut and points at lib.help()', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: 'fn' + i, doc: 'd'.repeat(30) + i }))
    const add = __test.descAppend(many)
    expect(add).toContain('其余用 lib.help()')
    expect(add.length).toBeLessThanOrEqual(__test.DESC_APPEND_MAX)
  })
})

describe('the description the tool is registered with', () => {
  test('the base is untouched and the global list is at the very end', { timeoutMs: 20000 }, async () => {
    const t = await startWith(lib({ check: '跑测试', ship: '提交并推送' }))
    const i = t.desc.indexOf(' Shorthand: tools.sh')
    expect(i).toBeGreaterThan(1000)
    const base = t.desc.slice(0, i)
    expect(base.startsWith('Run a JavaScript async-function body in a sandbox')).toBe(true)
    expect(base.endsWith('that returns them')).toBe(true)
    expect(t.desc.slice(i)).toContain('check — 跑测试')
    expect(t.desc.length - i).toBeLessThanOrEqual(__test.DESC_APPEND_MAX)
  })

  test('the global file is the one read, once', { timeoutMs: 20000 }, async () => {
    const t = await startWith(lib({ check: 'x' }))
    expect(t.reads).toEqual(['C:/home/.claude/ptc-run/lib.js'])
  })

  test('PTC_RUN_LIB names the global file instead', { timeoutMs: 20000 }, async () => {
    const t = await startWith(lib({ check: 'x' }), { PTC_RUN_LIB: 'D:/libs/lib.js' })
    expect(t.reads).toEqual(['D:/libs/lib.js'])
    expect(t.desc).toContain('check — x')
  })

  test('a missing library adds no list and never fails', { timeoutMs: 20000 }, async () => {
    const t = await startWith(undefined)
    expect(t.desc.endsWith(__test.SHORT_HELP + __test.LIB_HINT)).toBe(true)
    expect(t.desc).not.toContain('全局库：')
  })

  test('a broken library adds no list either', { timeoutMs: 20000 }, async () => {
    const t = await startWith('not json at all')
    expect(t.desc.endsWith(__test.SHORT_HELP + __test.LIB_HINT)).toBe(true)
  })

  test('session-level names never reach the description', { timeoutMs: 20000 }, async () => {
    // only the global file is read, so a name that exists solely in a session library cannot appear
    const t = await startWith(lib({ check: '跑测试' }))
    expect(t.desc).not.toContain('sessiononly')
    expect(t.reads.length).toBe(1)
  })
})
