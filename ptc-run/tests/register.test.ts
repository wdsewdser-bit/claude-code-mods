import { describe, expect, test } from 'claude-code/testing'

// The hook is the only place that reads the environment, so this file tests it: PTC_RUN_READ_ROOTS (delegate's
// readPaths) must reach the broker payload as an array of absolute directories, and the read-only description must
// say what is readable. The broker itself (permissions, rg) is covered by broker.test.mjs, which runs it for real.

type Handler = (_$: unknown, e: never) => unknown

const wire = (
  $: never,
  on: never,
  env: Record<string, string>,
  opts: { ro?: boolean; dsh?: boolean; cwd?: string } = {},
) => {
  const o = on as (name: string, fn: Handler) => void
  const registered: Record<string, unknown>[] = []
  const payloads: Record<string, unknown>[] = []
  o('session.start', (_$, e: { cwd: string }) => ({ cwd: e.cwd }))
  o('session.id', () => ({ value: 'sid-readroots' }))
  o('session.cwd', () => ({ value: opts.cwd ?? 'C:/work/proj' }))
  // the engine hands env.get the variable's name
  o('env.get', (_$, e: { name?: string }) => ({ value: env[String(e.name)] }))
  o('tool.register', (_$, e: Record<string, unknown>) => {
    registered.push(e)
    return { value: { tool: 'mcp__ptc-run__run_code' } }
  })
  o('process.run', (_$, e: { argv?: string[]; init?: { stdin?: string }; stdin?: string }) => {
    const raw = String(e.init?.stdin ?? e.stdin ?? '')
    const first = raw.slice(0, raw.indexOf('\n') === -1 ? raw.length : raw.indexOf('\n'))
    try { payloads.push(JSON.parse(first)) } catch { payloads.push({ unparsed: true }) }
    return { value: { exitCode: 0, stdout: 'ok', stderr: '' } }
  })
  const engine = $ as unknown as {
    session: { start: (v: never) => Promise<unknown> }
    tool: { call: (v: never) => Promise<unknown> }
  }
  const start = async () => {
    await engine.session.start({ cwd: opts.cwd ?? 'C:/work/proj', surface: null, isInteractive: true } as never)
    return String(registered[0]?.description ?? '')
  }
  const call = () => engine.tool.call({ tool: 'mcp__ptc-run__run_code', code: 'return 1', description: 'x' } as never)
  return { start, call, payloads, registered }
}

describe('read-only extra read roots (PTC_RUN_READ_ROOTS)', () => {
  test('absolute directories reach the broker payload, PATH-separated, drive letters intact', { timeoutMs: 20_000 }, async ($, on) => {
    const t = wire($ as never, on as never, { PTC_RUN_READONLY: '1', PTC_RUN_READ_ROOTS: 'C:/ext/one;D:/ext/two' })
    await t.start()
    await t.call()
    expect(t.payloads[0]?.readRoots).toEqual(['C:/ext/one', 'D:/ext/two'])
  })

  test('a colon separator works too, and a drive colon is not a separator', { timeoutMs: 20_000 }, async ($, on) => {
    const t = wire($ as never, on as never, { PTC_RUN_READONLY: '1', PTC_RUN_READ_ROOTS: 'C:/ext/one:D:/ext/two' })
    await t.start()
    await t.call()
    expect(t.payloads[0]?.readRoots).toEqual(['C:/ext/one', 'D:/ext/two'])
  })

  test('relative and empty entries are dropped', { timeoutMs: 20_000 }, async ($, on) => {
    const t = wire($ as never, on as never, { PTC_RUN_READONLY: '1', PTC_RUN_READ_ROOTS: ' ;C:/ext/one;; ' })
    await t.start()
    await t.call()
    expect(t.payloads[0]?.readRoots).toEqual(['C:/ext/one'])
  })

  test('no variable means no extra roots', { timeoutMs: 20_000 }, async ($, on) => {
    const t = wire($ as never, on as never, { PTC_RUN_READONLY: '1' })
    await t.start()
    await t.call()
    expect(t.payloads[0]?.readRoots).toEqual([])
  })

  test('the roots are ignored outside read-only mode', { timeoutMs: 20_000 }, async ($, on) => {
    const t = wire($ as never, on as never, { PTC_RUN_READ_ROOTS: 'C:/ext/one' })
    await t.start()
    await t.call()
    expect(t.payloads[0]?.readRoots).toEqual([])
  })

  test('the read-only description names the extra directories', { timeoutMs: 20_000 }, async ($, on) => {
    const t = wire($ as never, on as never, { PTC_RUN_READONLY: '1', PTC_RUN_READ_ROOTS: 'C:/ext/one;D:/ext/two' })
    const desc = await t.start()
    expect(desc).toContain('READ-ONLY')
    expect(desc).toContain('Extra readable directories besides the working directory: C:/ext/one, D:/ext/two')
    expect(desc).toContain('only files under the working directory and the extra readable directories')
  })

  test('the short read-only description names them too', { timeoutMs: 20_000 }, async ($, on) => {
    const t = wire($ as never, on as never, { PTC_RUN_READONLY: '1', PTC_RUN_SDK_IN_PROMPT: '1', PTC_RUN_READ_ROOTS: 'C:/ext/one' })
    const desc = await t.start()
    expect(desc).toContain('read-only sandbox')
    expect(desc).toContain('C:/ext/one')
    expect(desc).toContain('Extra readable directories besides the working directory: C:/ext/one')
  })

  test('without extra roots the description says nothing about them', { timeoutMs: 20_000 }, async ($, on) => {
    const t = wire($ as never, on as never, { PTC_RUN_READONLY: '1' })
    const desc = await t.start()
    expect(desc).toContain('READ-ONLY')
    expect(desc).not.toContain('Extra readable directories')
  })
})