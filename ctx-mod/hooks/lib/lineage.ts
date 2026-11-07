// Pure lineage helpers: filesystem access is injected, predecessors are read-only.
export type Lineage = {
  sessionId: string
  lastWindow: number
  lastSeq: number
  mode: 'reference'
  /** Existing local windows were not renamed by migration. */
  windowOffset?: number
}
export type LineageIo = {
  read: (path: string) => Promise<string>
  directories?: (path: string) => Promise<readonly string[]>
}
export const safeSessionId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id)
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
export const lineageFrom = (value: unknown): Lineage | null => {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (!safeSessionId(raw.sessionId) || !count(raw.lastWindow) || raw.lastWindow < 1 || !count(raw.lastSeq)) return null
  if (raw.mode !== 'reference' || (raw.windowOffset !== undefined && !count(raw.windowOffset))) return null
  return raw as Lineage
}
const readMeta = async (dir: string, io: LineageIo): Promise<Record<string, unknown> | null> => {
  try {
    const raw: unknown = JSON.parse(await io.read(dir + '/meta.json'))
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  } catch { return null }
}
export const linkTo = async (root: string, sessionId: string, io: LineageIo): Promise<Lineage | null> => {
  if (!safeSessionId(sessionId)) return null
  const meta = await readMeta(root + '/' + sessionId, io)
  if (meta === null || !count(meta.window) || meta.window < 1 || !count(meta.seq)) return null
  return { sessionId, lastWindow: meta.window, lastSeq: meta.seq, mode: 'reference' }
}
/** Newline conventions are equivalent; only exterior whitespace is ignored. */
export const normalizeHandoff = (text: string): string => text.replace(/\r\n?/g, '\n').trim()
/** The physical transcript starts with metadata; tool-result-only user rows are not prompts. */
export const firstTranscriptUser = (transcript: string): string | undefined => {
  for (const line of transcript.split('\n')) {
    let raw: Record<string, unknown>
    try { raw = JSON.parse(line) } catch { continue }
    if (raw === null || raw.type !== 'user' || raw.isMeta === true) continue
    const message = raw.message as { content?: unknown } | undefined
    const content = message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) continue
    const texts = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text)
    if (texts.length > 0) return texts.join('\n')
  }
  return undefined
}
export const detectLineage = async (dir: string, firstUser: string, io: LineageIo): Promise<Lineage | null> => {
  const text = normalizeHandoff(firstUser)
  const match = /^这是第\s*(\d+)\s*个窗口，上一个窗口的对话不在上下文里/.exec(text)
  const cut = dir.lastIndexOf('/')
  if (match === null || cut < 0 || io.directories === undefined) return null
  const root = dir.slice(0, cut)
  const own = dir.slice(cut + 1)
  const window = Number(match[1])
  if (!Number.isSafeInteger(window) || window < 1) return null
  const name = 'handoff-w' + String(window).padStart(3, '0') + '.md'
  let names: readonly string[]
  try { names = await io.directories(root) } catch { return null }
  let found: Lineage | null = null
  for (const id of [...new Set(names)].sort()) {
    if (id === own || !safeSessionId(id)) continue
    try {
      // Only this window's handoff is probed, not its histories or other handoffs.
      if (normalizeHandoff(await io.read(root + '/' + id + '/' + name)) !== text) continue
      const link = await linkTo(root, id, io)
      if (link === null || link.lastWindow < window) continue
      // Identical copies cannot safely be attributed to one predecessor.
      if (found !== null) return null
      found = link
    } catch { /* Missing or unreadable candidate: ordinary new session. */ }
  }
  return found
}
