import type { Register } from 'claude-code'

import { contextHasResults, parseReadResult, stripGutter } from './lib/dedup.ts'
import { parseBashOutput, parseBashRead } from './lib/bash.ts'
import { createStore, decide, noteEdit } from './lib/handler.ts'

// Module variable on purpose: a hot reload clears it, and an empty cache only means one extra full read (the safe direction).
const store = createStore()
/** tool_use_ids whose Read result was replaced: their host-added 1..N line gutter is stripped when the row is stored. */
const rewritten = new Set<string>()

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
        return Array.isArray(messages) && contextHasResults(messages, ids, store.probes)
      }

      const d = await decide(store, { id: e.tool_use_id, agentId: e.agentId, filePath: e.file_path }, parsed, live)
      try {
        $.ui.log(`read-dedup: ${d.note} (${e.file_path}) saved=${d.savedChars} total=${store.savedChars}`, { to: 'debug' })
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

  // A Bash command that is one plain file read (cat / sed -n 'a,bp' / head -n N, optionally behind cd DIR &&)
  // shares the Read cache: an unchanged same-range hit gets the same stub a Read would get, everything else
  // runs as usual and is only recorded. Any part the parser does not fully understand -> run as usual.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (r.deny !== undefined || r.isError === true) return r
      const args = e as { command?: unknown; run_in_background?: unknown }
      if (args.run_in_background === true || typeof args.command !== 'string') return r
      // $.session.cwd() is the session's directory; a subagent may run elsewhere, so its relative paths are not ours.
      if (e.agentId !== undefined) return r
      if (!/^\s*(?:cd|cat|sed|head)(?:\s|$)/.test(args.command)) return r
      const res = r.result as Record<string, unknown> | null
      if (res === null || typeof res !== 'object') return r
      const stderr = res['stderr']
      if (stderr !== undefined && (typeof stderr !== 'string' || stderr.trim() !== '')) return r
      if (res['interrupted'] === true || res['isImage'] === true) return r
      if (res['backgroundTaskId'] !== undefined || res['backgroundedByUser'] === true) return r
      if (res['backgroundedByTurnAbort'] === true || res['backgroundedToDeliverMessage'] === true) return r
      if (res['backgroundCwdHint'] !== undefined || res['ghRateLimitHint'] !== undefined) return r
      if (res['persistedOutputPath'] !== undefined || res['rawOutputPath'] !== undefined) return r
      if (res['timedOutAfterMs'] !== undefined || res['returnCodeInterpretation'] !== undefined) return r
      if (res['staleReadFileStateHint'] !== undefined) return r
      if (Array.isArray(res['structuredContent']) && res['structuredContent'].length > 0) return r

      const cmd = parseBashRead(args.command, await $.session.cwd())
      if (cmd === undefined) return r
      const parsed = parseBashOutput(cmd, res['stdout'])
      if (parsed === undefined) return r

      const live = async (ids: string[]): Promise<boolean> => {
        const messages = await $.session.messages({ as: 'api' })
        return Array.isArray(messages) && contextHasResults(messages, ids, store.probes)
      }
      const d = await decide(store, { id: e.tool_use_id, agentId: e.agentId, filePath: parsed.filePath }, parsed, live, { onlySame: true })
      try {
        $.ui.log('read-dedup(bash): ' + d.note + ' (' + parsed.filePath + ') saved=' + d.savedChars + ' total=' + store.savedChars, { to: 'debug' })
      } catch {
        /* logging is best effort */
      }
      if (d.content === undefined) return r
      return { result: { ...res, stdout: d.content, stderr: '' }, context: r.context } as typeof r
    } catch {
      return r
    }
  }).catch(($, e, next) => next(e))
}
