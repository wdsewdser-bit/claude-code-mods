import type { Register } from 'claude-code'

import { resultStillHolds, parseReadResult } from './lib/dedup.ts'
import { createStore, decide, noteEdit } from './lib/handler.ts'

// Module variable on purpose: a hot reload clears it, and an empty cache only means one extra full read (the safe direction).
const store = createStore()

/** Text of a tool_result block's content (string or text blocks). */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('')
}

export const register: Register = on => {
  // Model edits reset the escape hatch: Read(omitted) -> Edit -> Read must give the diff, not the full text.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (r.deny === undefined && r.isError !== true) {
        const a = e as { file_path?: unknown; notebook_path?: unknown }
        noteEdit(store, e.agentId, a.file_path ?? a.notebook_path)
      }
    } catch {
      /* best effort */
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (r.deny !== undefined || r.isError === true) return r
      const parsed = parseReadResult(r.result)
      if (parsed === undefined) return r

      // Plan A: an earlier Read result counts as "still in the context" only if its tool_result block is in the
      // Messages-API form of the current conversation (post-compaction / post-/clear / post-ctx-mod window switch).
      const live = async (ids: string[]): Promise<boolean> => {
        const messages = e.agentId === undefined ? await $.session.messages({ as: 'api' }) : await $.session.messages({ as: 'api', agentId: e.agentId })
        if (!Array.isArray(messages)) return false
        const want = new Set(ids)
        const ok = new Set<string>()
        for (const m of messages) {
          if (m.role !== 'user' || !Array.isArray(m.content)) continue
          for (const block of m.content) {
            if (block.type !== 'tool_result') continue
            const tid = block['tool_use_id']
            if (typeof tid !== 'string' || !want.has(tid) || block['is_error'] === true) continue
            if (resultStillHolds(blockText(block['content']), store.probes.get(tid) ?? '')) ok.add(tid)
          }
        }
        return ok.size === want.size
      }

      const d = await decide(store, { id: e.tool_use_id, agentId: e.agentId, filePath: e.file_path }, parsed, live)
      try {
        $.ui.log(`read-dedup: ${d.note} (${e.file_path})`, { to: 'debug' })
      } catch {
        /* logging is best effort */
      }
      if (d.content === undefined) return r

      const res = r.result as { file: Record<string, unknown> }
      return {
        result: {
          ...res,
          file: { ...res.file, content: d.content, numLines: d.content.split('\n').length, startLine: 1 },
        },
        context: r.context,
      } as typeof r
    } catch {
      return r
    }
  }).catch(($, e, next) => next(e))
}
