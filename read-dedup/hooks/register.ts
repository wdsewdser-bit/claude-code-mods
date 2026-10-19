import type { Register } from 'claude-code'

import { resultStillHolds, parseReadResult, stripGutter } from './lib/dedup.ts'
import { createStore, decide, noteEdit } from './lib/handler.ts'

// Module variable on purpose: a hot reload clears it, and an empty cache only means one extra full read (the safe direction).
const store = createStore()
/** tool_use_ids whose Read result was replaced: their host-added 1..N line gutter is stripped when the row is stored. */
const rewritten = new Set<string>()

/** Text of a tool_result block's content (string or text blocks). */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('')
}

export const register: Register = on => {
  // The host numbers a text Read result from startLine; on a rewritten result that gutter (1..N) is noise next to the real line numbers.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    try {
      if (rewritten.size === 0) return next(e)
      let changed = false
      const content = e.message.content.map(block => {
        if (block.type !== 'tool_result') return block
        const tid = block['tool_use_id']
        if (typeof tid !== 'string' || !rewritten.has(tid)) return block
        rewritten.delete(tid)
        const c = block['content']
        changed = true
        if (typeof c === 'string') return { ...block, content: stripGutter(c) }
        if (Array.isArray(c)) return { ...block, content: c.map(x => (x && typeof x === 'object' && x.type === 'text' && typeof x.text === 'string' ? { ...x, text: stripGutter(x.text) } : x)) }
        return block
      })
      return next(changed ? { ...e, message: { ...e.message, content } } : e)
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))

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

      if (e.tool_use_id) {
        rewritten.add(e.tool_use_id)
        while (rewritten.size > 200) rewritten.delete(rewritten.values().next().value as string)
      }
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
