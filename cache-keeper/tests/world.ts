import type { On, SessionRateLimit } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const usage = (read: number, write = 0, input = 3): Usage => ({
  input_tokens: input,
  output_tokens: 1,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

// The engine hands a path on resolved against the working directory, in the
// platform's spelling: files are kept by forward slashes and found by their tail.
const slashed = (path: string): string => path.replaceAll('\\', '/')

export const fileAt = (w: World, path: string): string | undefined => {
  const wanted = slashed(path)
  for (const [held, text] of w.files) {
    if (held === wanted || held.endsWith(wanted) || wanted.endsWith(held)) return text
  }

  return undefined
}

export const MODEL = 'claude-opus-5-5'
export const START = Date.parse('2026-10-06T00:00:00.000Z')

export type World = {
  clock: MockClock
  files: Map<string, string>
  store: Map<string, unknown>
  /** Prompts the mod sent to `$.model.fork`. */
  forks: string[]
  /** Prompts the mod submitted as turns. */
  submitted: string[]
  toasts: string[]
  logs: string[]
  status: (string | undefined)[]
  /** What the next forks answer with, in order; the last one repeats. */
  forkUsage: Usage[]
  /** The text the next forks answer with, in order; the last one repeats, and the default answers OK. */
  forkTexts: string[]
  limits: SessionRateLimit[]
  /** The context window's fill: none until the model has answered once. */
  contextTokens: number | undefined
  /** What the next `turn.step` answers with. */
  stepUsage: Usage
  /** The session's subagents, as `$.agent.list()` answers. */
  agents: { id: string; description: string; type: string; status: string }[]
  /** Messages the mod sent to agents: the recipient as spelled, and the text. */
  sent: { to: string; text: string }[]
  /** What `$.settings.read()` answers. */
  settings: Record<string, unknown>
}

/**
 * Everything beneath the mod, answered from memory: the clock, the store, the
 * environment, the file system, the session's own figures and the model.
 */
export const world = (
  on: On,
  env: Readonly<Record<string, string>> = {},
  sessionId = 'aaaaaaaa-1111',
): World => {
  const w: World = {
    clock: mock.clock(on, { now: START }),
    files: new Map(),
    store: new Map(),
    forks: [],
    submitted: [],
    toasts: [],
    logs: [],
    status: [],
    forkUsage: [usage(50_000)],
    forkTexts: ['OK'],
    limits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-06T05:00:00Z' }],
    contextTokens: undefined,
    stepUsage: usage(50_000, 200),
    agents: [],
    sent: [],
    settings: {},
  }
  mock.env(on, env)
  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('fs.write', (_$, e) => {
    w.files.set(slashed(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const text = fileAt(w, e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.list', (_$, e) => ({
    value: [...w.files.keys()]
      .filter(path => path.startsWith(`${slashed(e.path)}/`))
      .map(path => ({
        name: path.slice(slashed(e.path).length + 1),
        kind: 'file' as const,
        size: 0,
        mtimeMs: 0,
        isLink: false,
      })),
  }))
  on('process.run', () => ({ deny: 'no processes in tests' }))
  on('settings.read', () => ({ value: w.settings as never }))
  on('session.id', () => ({ value: sessionId }))
  on('session.model', () => ({ value: MODEL }))
  on('session.version', () => ({ value: { version: '2.1.288', base: '2.1.288' } }))
  on('session.usage', () => ({
    value: {
      startedAt: START,
      context: {
        window: 1_000_000,
        ...(w.contextTokens === undefined ? {} : { tokens: w.contextTokens }),
      },
      rateLimits: w.limits.map(limit => ({ ...limit })),
    },
  }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', (_$, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('model.fork', (_$, e) => {
    w.forks.push(e.prompt)
    const answer = w.forkUsage.length > 1 ? w.forkUsage.shift() : w.forkUsage[0]
    const text = w.forkTexts.length > 1 ? (w.forkTexts.shift() ?? 'OK') : (w.forkTexts[0] ?? 'OK')
    return { value: { isAnswered: true, text, usage: answer ?? usage(0) } }
  })

  on('agent.list', () => ({ value: w.agents.map(agent => ({ ...agent })) }))
  on('session.send', (_$, e) => {
    w.sent.push({ to: JSON.stringify(e.to), text: e.text })
    return { isDelivered: true }
  })
  on('prompt.submit', (_$, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('turn.step', async function* (_$, e) {
    const answered = { ...w.stepUsage, model: MODEL }
    w.contextTokens = 50_000
    yield { kind: 'stop', stopReason: 'end_turn', usage: answered }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'OK',
      toolUses: [],
      stopReason: 'end_turn',
      usage: answered,
    }
  })

  return w
}

/**
 * Records every value the mod writes under its own state, by key. A test opts in
 * with it: a module may register one hook per event, so `world` does not.
 */
export const watchState = (on: On): { key: string; value: unknown }[] => {
  const sets: { key: string; value: unknown }[] = []
  on('state.set', (_$, e, next) => {
    if (e.plugin === 'cache-keeper') sets.push({ key: e.key, value: e.value })

    return next(e)
  })

  return sets
}

export const boot = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/work', surface: null, isInteractive: true })
}

/** One whole main-thread turn of a single request, as the engine raises it. */
export const turn = async (
  $: Engine,
  turnId: string,
  text: string,
  agentId?: string,
): Promise<void> => {
  if (agentId === undefined) await $.turn.start({ text, turnId })
  const step = $.turn.step({
    turnId,
    index: 0,
    model: MODEL,
    effort: 'medium',
    messageCount: 1,
    ...(agentId === undefined ? {} : { agentId }),
  })
  for await (const chunk of step) void chunk
  await $.turn.complete({
    answer: 'OK',
    durationMs: 1,
    isAborted: false,
    turnId,
    reason: 'answer',
    ...(agentId === undefined ? {} : { agentId }),
  })
}

export const command = async ($: Engine, args: string): Promise<string> => {
  const ran = await $.command.run({
    command: 'cache-keeper',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  } as never)

  return ran.text ?? ''
}

export const events = (w: World): Record<string, unknown>[] =>
  [...w.files.entries()]
    .filter(([path]) => /\/raw\/events-/.test(path))
    .flatMap(([, text]) =>
      text
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>),
    )
