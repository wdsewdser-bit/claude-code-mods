// What of a request's prefix the transcript actually shows. The engine does
// not write the system prompt, the tool list or the plugin set as such; it
// writes attachments that carry them (prompt_snapshot, the deferred-tool
// record and deltas, MCP instruction deltas, the skill listing). This module
// turns those into stable hashes so a cache miss can be attributed to a
// prefix change that was observed, instead of guessed at.
//
// A hash is a short, stable digest, not a security primitive: 16 hex digits
// of two independent 32-bit hashes. Equal text always gives equal hashes;
// different text gives different hashes with overwhelming probability.

type Row = Record<string, unknown>

const isRecord = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

/** JSON with object keys sorted, so equal values always spell the same. */
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys
      .map(key => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`
  }
  const json = JSON.stringify(value)
  return json === undefined ? 'null' : json
}

/** 16 hex digits: FNV-1a and djb2, both 32-bit. */
export const digest = (input: string): string => {
  let a = 0x811c9dc5
  let b = 5381
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    a ^= code
    a = Math.imul(a, 0x01000193)
    b = Math.imul(b, 33) ^ code
  }
  return (
    (a >>> 0).toString(16).padStart(8, '0') +
    (b >>> 0).toString(16).padStart(8, '0')
  )
}

export type ToolHashBasis = 'definitions' | 'names' | 'none'
export type PluginHashBasis = 'mcp+skills' | 'mcp' | 'skills' | 'none'

/** The prefix as it stood just before one request. Null means: not visible. */
export type PrefixSnapshot = {
  /** Hash of prompt_snapshot.systemPrompt, and its total character count. */
  systemPromptHash: string | null
  systemPromptChars: number | null
  /** The Claude Code version that wrote the snapshot, when the row had one. */
  systemPromptVersion: string | null
  /** Hash of the deferred tool set (names, and definitions when recorded). */
  toolListHash: string | null
  toolNames: string[] | null
  toolHashBasis: ToolHashBasis
  /** Hash of the MCP-server set and the skill listing, as a plugin proxy. */
  pluginSetHash: string | null
  pluginSetBasis: PluginHashBasis
  mcpServers: string[] | null
  skills: string[] | null
  claudeCodeVersion: string | null
}

type PrefixState = PrefixSnapshot & {
  /** name -> stable serialisation of its last recorded definition. */
  toolDefinitions: Map<string, string>
  /** Null until a record or delta names tools at all. */
  toolNamesSet: Set<string> | null
  mcpSet: Set<string> | null
  skillSet: Set<string> | null
  systemPrompt: string[] | null
}

export const initialPrefix = (): PrefixState => ({
  systemPromptHash: null,
  systemPromptChars: null,
  systemPromptVersion: null,
  toolListHash: null,
  toolNames: null,
  toolHashBasis: 'none',
  pluginSetHash: null,
  pluginSetBasis: 'none',
  mcpServers: null,
  skills: null,
  claudeCodeVersion: null,
  toolDefinitions: new Map(),
  toolNamesSet: null,
  mcpSet: null,
  skillSet: null,
  systemPrompt: null,
})

const cloneSet = (set: Set<string> | null): Set<string> | null =>
  set === null ? null : new Set(set)

const namesOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((one): one is string => typeof one === 'string' && one !== '')
    : []

const recomputeTools = (state: PrefixState): void => {
  if (state.toolNamesSet === null) {
    state.toolListHash = null
    state.toolNames = null
    state.toolHashBasis = 'none'
    return
  }
  const names = [...state.toolNamesSet].sort()
  state.toolNames = names
  if (state.toolDefinitions.size > 0) {
    const definitions = names
      .filter(name => state.toolDefinitions.has(name))
      .map(name => [name, state.toolDefinitions.get(name)] as const)
    state.toolListHash = digest(stable({ names, definitions }))
    state.toolHashBasis = 'definitions'
  } else {
    state.toolListHash = digest(stable({ names }))
    state.toolHashBasis = 'names'
  }
}

const recomputePlugins = (state: PrefixState): void => {
  const mcp = state.mcpSet === null ? null : [...state.mcpSet].sort()
  const skills = state.skillSet === null ? null : [...state.skillSet].sort()
  state.mcpServers = mcp
  state.skills = skills
  if (mcp === null && skills === null) {
    state.pluginSetHash = null
    state.pluginSetBasis = 'none'
    return
  }
  state.pluginSetHash = digest(stable({ mcp: mcp ?? [], skills: skills ?? [] }))
  state.pluginSetBasis =
    mcp !== null && skills !== null
      ? 'mcp+skills'
      : mcp !== null
        ? 'mcp'
        : 'skills'
}

/**
 * Folds one transcript row into the prefix state. Only attachment rows and
 * the version field matter; every other row leaves the state unchanged.
 */
export const applyPrefixRow = (state: PrefixState, row: Row): PrefixState => {
  if (typeof row.version === 'string' && row.version !== '') {
    state.claudeCodeVersion = row.version
  }
  const attachment = isRecord(row.attachment) ? row.attachment : undefined
  if (attachment === undefined) return state
  const type = text(attachment.type)

  if (type === 'prompt_snapshot') {
    const prompt = attachment.systemPrompt
    if (Array.isArray(prompt) && prompt.every(one => typeof one === 'string')) {
      state.systemPrompt = prompt as string[]
      state.systemPromptHash = digest(stable(prompt))
      state.systemPromptChars = (prompt as string[]).reduce(
        (total, part) => total + part.length,
        0,
      )
      state.systemPromptVersion = text(row.version)
    }
    return state
  }

  if (type === 'deferred_tools_record') {
    const entries = Array.isArray(attachment.entries) ? attachment.entries : []
    state.toolNamesSet ??= new Set()
    state.toolDefinitions = new Map()
    for (const entry of entries) {
      if (!isRecord(entry)) continue
      const name = text(entry.name)
      if (name === null) continue
      state.toolNamesSet.add(name)
      state.toolDefinitions.set(name, stable(entry))
    }
    recomputeTools(state)
    return state
  }

  if (type === 'deferred_tools_delta') {
    state.toolNamesSet ??= new Set()
    for (const name of namesOf(attachment.addedNames)) state.toolNamesSet.add(name)
    for (const name of namesOf(attachment.readdedNames)) state.toolNamesSet.add(name)
    for (const name of namesOf(attachment.removedNames)) state.toolNamesSet.delete(name)
    for (const name of namesOf(attachment.wireHiddenNames)) {
      state.toolNamesSet.delete(name)
    }
    recomputeTools(state)
    return state
  }

  if (type === 'mcp_instructions_delta') {
    state.mcpSet = cloneSet(state.mcpSet) ?? new Set()
    for (const name of namesOf(attachment.addedNames)) state.mcpSet.add(name)
    for (const name of namesOf(attachment.removedNames)) state.mcpSet.delete(name)
    recomputePlugins(state)
    return state
  }

  if (type === 'skill_listing') {
    state.skillSet = new Set(namesOf(attachment.names))
    recomputePlugins(state)
  }

  return state
}

/** A copy safe to keep after later rows have changed the running state. */
export const prefixSnapshot = (state: PrefixState): PrefixSnapshot => ({
  systemPromptHash: state.systemPromptHash,
  systemPromptChars: state.systemPromptChars,
  systemPromptVersion: state.systemPromptVersion,
  toolListHash: state.toolListHash,
  toolNames: state.toolNames === null ? null : [...state.toolNames],
  toolHashBasis: state.toolHashBasis,
  pluginSetHash: state.pluginSetHash,
  pluginSetBasis: state.pluginSetBasis,
  mcpServers: state.mcpServers === null ? null : [...state.mcpServers],
  skills: state.skills === null ? null : [...state.skills],
  claudeCodeVersion: state.claudeCodeVersion,
})
