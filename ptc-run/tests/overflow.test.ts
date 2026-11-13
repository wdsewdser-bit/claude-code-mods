import { describe, expect, test } from 'claude-code/testing'
import { __test, register } from '../hooks/register'

// Feature 3: the Bash output cap. The arithmetic is pure (__test.bashClip); the hook side is driven with a fake $,
// whose $.fs.write stands for the file under ~/.claude/ptc-run/overflow/ and whose $.process.run stands for the prune.

type Handler = { name: string; opts?: unknown; fn: (...a: unknown[]) => unknown }

const wire = (env: Record<string, string> = {}, options: Record<string, unknown> = {}, listSize = 0, writeFails = false) => {
  const handlers: Handler[] = []
  const on = (name: string, a: unknown, b?: unknown) => {
    const fn = (typeof a === 'function' ? a : b) as (...x: unknown[]) => unknown
    handlers.push({ name, opts: typeof a === 'function' ? undefined : a, fn })
    const chain = { catch: () => chain }
    return chain
  }
  ;(register as unknown as (o: unknown, opt: unknown) => void)(on, options)
  const writes: { path: string; text: string }[] = []
  const runs: { argv: string[]; stdin: string }[] = []
  const $ = {
    env: { get: async (n: string) => env[n] },
    session: { cwd: async () => 'C:/work/proj', id: async () => 'sid-ov', messages: async () => [] },
    tool: { register: async () => ({}), call: async (v: unknown) => v },
    fs: {
      write: async (path: string, text: string) => {
        if (writeFails) throw new Error('EACCES: denied')
        writes.push({ path, text })
      },
      list: async () => Array.from({ length: listSize }, (_, i) => ({ name: 'bash-' + i + '.txt', mtimeMs: i })),
    },
    process: {
      run: async (argv: string[], init: { stdin?: string }) => {
        runs.push({ argv, stdin: String(init?.stdin ?? '') })
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    ui: { log: () => undefined },
    agent: { list: async () => [] },
  }
  const start = async () => {
    const h = handlers.find(x => x.name === 'session.start')
    if (h === undefined) throw new Error('no session.start')
    await h.fn($, { cwd: 'C:/work/proj' }, async () => ({}))
  }
  const bash = async (result: Record<string, unknown>, agentId?: string) => {
    const h = handlers.find(x => x.name === 'tool.call' && JSON.stringify(x.opts) === '{"tool":"Bash"}')
    if (h === undefined) throw new Error('no Bash handler')
    return (await h.fn($, { tool: 'Bash', command: 'x', agentId }, async () => ({ result }))) as { result?: Record<string, unknown>; deny?: unknown }
  }
  return { start, bash, writes, runs }
}

const big = (n: number) => 'x'.repeat(n)

describe('bash output cap: the arithmetic', () => {
  test('60% of the cap at the head, 30% at the tail, the rest counted', () => {
    const clip = __test.bashClip(big(10000), 8000)
    expect(clip?.head.length).toBe(4800)
    expect(clip?.tail.length).toBe(2400)
    expect(clip?.omitted).toBe(2800)
  })

  test('within the cap, or with the cap off, nothing is clipped', () => {
    expect(__test.bashClip(big(8000), 8000)).toBeUndefined()
    expect(__test.bashClip(big(9000), 0)).toBeUndefined()
    expect(__test.bashClip(big(9000), -1)).toBeUndefined()
  })

  test('the marker names the count and the file', () => {
    expect(__test.clipMarker(2800, 'C:/h/x.txt')).toContain('省略 2800 字符')
    expect(__test.clipMarker(2800, 'C:/h/x.txt')).toContain('C:/h/x.txt')
  })
})

describe('bash output cap: the hook', () => {
  test('an over-cap result keeps its head and tail, and the whole text lands in a file', { timeoutMs: 20000 }, async () => {
    const t = wire({ USERPROFILE: 'C:/home' })
    await t.start()
    const text = big(10000)
    const out = await t.bash({ stdout: text, stderr: '' })
    const shown = String(out.result?.['stdout'] ?? '')
    expect(shown.startsWith(text.slice(0, 4800))).toBe(true)
    expect(shown.endsWith(text.slice(-2400))).toBe(true)
    expect(shown).toContain('省略 2800 字符')
    expect(shown).toContain('C:/home/.claude/ptc-run/overflow/bash-')
    expect(out.result?.['stderr']).toBe('')
    expect(t.writes.length).toBe(1)
    expect(t.writes[0]?.text).toBe(text)
    expect(/\/overflow\/bash-[a-z0-9]+-[a-z0-9]+\.txt$/.test(String(t.writes[0]?.path))).toBe(true)
  })

  test('stderr counts towards the cap too and is folded into the shown text', { timeoutMs: 20000 }, async () => {
    const t = wire({ USERPROFILE: 'C:/home' })
    await t.start()
    const out = await t.bash({ stdout: big(6000), stderr: 'y'.repeat(6000) })
    const shown = String(out.result?.['stdout'] ?? '')
    expect(t.writes[0]?.text.length).toBe(12001) // stdout + the newline that joins stderr
    expect(shown.length).toBeLessThan(9000)
  })

  test('a result under the cap is handed through untouched', { timeoutMs: 20000 }, async () => {
    const t = wire({ USERPROFILE: 'C:/home' })
    await t.start()
    const out = await t.bash({ stdout: 'short', stderr: '' })
    expect(out.result?.['stdout']).toBe('short')
    expect(t.writes.length).toBe(0)
  })

  test('PTC_RUN_BASH_MAX=0 turns it off, a smaller cap trims sooner', { timeoutMs: 20000 }, async () => {
    const off = wire({ USERPROFILE: 'C:/home', PTC_RUN_BASH_MAX: '0' })
    await off.start()
    const keep = await off.bash({ stdout: big(20000), stderr: '' })
    expect(String(keep.result?.['stdout']).length).toBe(20000)
    expect(off.writes.length).toBe(0)
    const small = wire({ USERPROFILE: 'C:/home', PTC_RUN_BASH_MAX: '100' })
    await small.start()
    const cut = await small.bash({ stdout: big(1000), stderr: '' })
    expect(String(cut.result?.['stdout']).length).toBeLessThan(300)
    expect(small.writes.length).toBe(1)
  })

  test('bashMaxChars from the options works the same way', { timeoutMs: 20000 }, async () => {
    const t = wire({ USERPROFILE: 'C:/home' }, { bashMaxChars: 1000 })
    await t.start()
    const out = await t.bash({ stdout: big(5000), stderr: '' })
    expect(String(out.result?.['stdout']).length).toBeLessThan(1300)
    expect(t.writes[0]?.text.length).toBe(5000)
  })

  test('past 200 files the oldest are pruned by a node child', { timeoutMs: 20000 }, async () => {
    const t = wire({ USERPROFILE: 'C:/home' }, {}, 201)
    await t.start()
    await t.bash({ stdout: big(9000), stderr: '' })
    expect(t.runs.length).toBe(1)
    expect(t.runs[0]?.argv[0]).toBe('node')
    expect(JSON.parse(t.runs[0]?.stdin ?? '{}')).toEqual({ dir: 'C:/home/.claude/ptc-run/overflow', keep: 200 })
  })

  test('at 200 files nothing is pruned', { timeoutMs: 20000 }, async () => {
    const t = wire({ USERPROFILE: 'C:/home' }, {}, 200)
    await t.start()
    await t.bash({ stdout: big(9000), stderr: '' })
    expect(t.runs.length).toBe(0)
  })

  test('a write that fails leaves the result alone', { timeoutMs: 20000 }, async () => {
    const t = wire({ USERPROFILE: 'C:/home' }, {}, 0, true)
    await t.start()
    const out = await t.bash({ stdout: big(9000), stderr: '' })
    expect(String(out.result?.['stdout']).length).toBe(9000)
  })

  test('no home directory means no file, so the result stays whole', { timeoutMs: 20000 }, async () => {
    const t = wire()
    await t.start()
    const out = await t.bash({ stdout: big(9000), stderr: '' })
    expect(String(out.result?.['stdout']).length).toBe(9000)
    expect(t.writes.length).toBe(0)
  })
})
