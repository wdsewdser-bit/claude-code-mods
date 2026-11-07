import { describe, expect, test } from 'claude-code/testing'
import { createSession } from '../hooks/lib/session.ts'
import type { Io, ImportedMessage } from '../hooks/lib/session.ts'
import { DEFAULTS } from '../hooks/lib/types.ts'
import { detectLineage, firstTranscriptUser } from '../hooks/lib/lineage.ts'

const HANDOFF = '这是第 36 个窗口，上一个窗口的对话不在上下文里。\n旧会话交接正文\n不要修改前驱。'
const message = (text = HANDOFF): ImportedMessage => ({ role: 'user', text, toolUses: [] })
const row = (seq: number, text: string, window = 36) => ({ seq, ts: 1000, window, uuid: '', role: 'user', isPerson: true, text })
const entry = (seq: number, task: string, status = 'in_progress') => ({ seq, ts: 1000, window: 36, task_id: task, title: task, status, text: '保留的进度', next_step: '继续检查', request_ref: 7552, evidence: [] })
const box = () => {
  const files = new Map<string, string>([
    ['/data/old/meta.json', JSON.stringify({ window: 36, seq: 7552 })],
    ['/data/old/handoff-w036.md', HANDOFF],
    ['/data/old/history-w036.jsonl', JSON.stringify(row(7552, '不要覆盖旧文件。旧历史关键词，没有匹配时也保留原文。')) + '\n' + JSON.stringify(row(7551, '禁止运行旧命令。')) + '\n' + JSON.stringify(row(1, '旧同号正文')) + '\n'],
    ['/data/old/ledger.jsonl', JSON.stringify(entry(150, '旧账本任务'))],
    ['/data/old/archive-001.jsonl', JSON.stringify(entry(1, '旧归档任务', 'done'))],
    ['/data/old/decisions.jsonl', JSON.stringify({ seq: 7551, ts: 1000, window: 36 })],
  ])
  const reads: string[] = []
  const writes: string[] = []
  const io: Io = {
    read: async p => { reads.push(p); if (!files.has(p)) throw Error('ENOENT'); return files.get(p)! },
    write: async (p, text) => { writes.push(p); files.set(p, text) },
    now: () => 2000,
    list: async p => [...files.keys()].filter(k => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')).map(k => k.slice(p.length + 1)),
    directories: async p => [...new Set([...files.keys()].filter(k => k.startsWith(p + '/')).map(k => k.slice(p.length + 1).split('/')[0]))],
  }
  return { files, io, reads, writes }
}

describe('session lineage detection', () => {
  test('physical transcript skips metadata, compact boundary and tool-only rows', () => {
    const transcript = [
      { type: 'custom-title', customTitle: '交接文档审阅' },
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'user', isMeta: true, message: { content: '元数据' } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'not a prompt' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: HANDOFF }] } },
      { type: 'user', message: { content: '后续请求' } },
    ].map(row => JSON.stringify(row)).join('\n')
    expect(firstTranscriptUser(transcript)).toBe(HANDOFF)
  })
  test('physical first user prevents a later API-tail handoff from falsely linking', async () => {
    const b = box()
    const s = createSession('/data/new', { ...b.io, firstUser: async () => '最初的普通用户请求' }, DEFAULTS)
    await s.importMessages([message()])
    await s.flush()
    expect(s.window()).toBe(1)
    expect(JSON.parse(b.files.get('/data/new/meta.json')!).lineage).toBe(undefined)
  })
  test('matches only the numbered handoff, ignoring exterior whitespace and newline convention', async () => {
    const b = box()
    b.files.set('/data/noise/handoff-w035.md', HANDOFF)
    const link = await detectLineage('/data/new', ' \r\n' + HANDOFF.replaceAll('\n', '\r\n') + '\r\n ', b.io)
    expect(link).toEqual({ sessionId: 'old', lastWindow: 36, lastSeq: 7552, mode: 'reference' })
    expect(b.reads.every(p => p.endsWith('handoff-w036.md') || p.endsWith('meta.json'))).toBe(true)
  })
  test('misses different text, a non-handoff opening, and a missing candidate without errors', async () => {
    for (const text of ['你好', HANDOFF + '不是原文', HANDOFF.replace('36', '35')]) {
      const b = box()
      expect(await detectLineage('/data/new', text, b.io)).toBe(null)
    }
  })
  test('an ambiguous copy and an unreadable data root are not guessed', async () => {
    const b = box()
    b.files.set('/data/copy/handoff-w036.md', HANDOFF)
    b.files.set('/data/copy/meta.json', JSON.stringify({ window: 36, seq: 7552 }))
    expect(await detectLineage('/data/new', HANDOFF, b.io)).toBe(null)
    expect(await detectLineage('/data/new', HANDOFF, { ...b.io, directories: async () => { throw Error('denied') } })).toBe(null)
  })
  test('initial import links window 37, preserves local numbering, and old numbers remain readable', async () => {
    const b = box()
    const old = [...b.files.entries()]
    const session = createSession('/data/new', b.io, DEFAULTS)
    await session.ready()
    expect(await session.importMessages([message(), message('新同号消息')])).toBe(2)
    expect(session.window()).toBe(37)
    await session.flush()
    const meta = JSON.parse(b.files.get('/data/new/meta.json')!)
    expect(meta.lineage.lastSeq).toBe(7552)
    expect(meta.lineage.lastWindow).toBe(36)
    expect(meta.seq).toBe(2)
    expect((await session.historyTool({ action: 'read', seq: 7552 })).result).toContain('旧会话 old')
    expect((await session.historyTool({ action: 'read', seq: 7552 })).result).toContain('旧历史关键词')
    expect((await session.historyTool({ action: 'read', seq: 1 })).result).toContain(HANDOFF)
    expect((await session.historyTool({ action: 'read', seq: 1, session_id: 'old' })).result).toContain('旧同号正文')
    expect((await session.historyTool({ action: 'search', query: '旧历史关键词' })).result).toContain('#7552')
    expect((await session.historyTool({ action: 'read', seq: 7552, session_id: 'new' })).isError).toBe(true)
    expect((await session.ledgerRead({ view: 'archive:1' })).result).toContain('旧归档任务')
    const next = await session.record({ uuid: 'new-result', role: 'tool', tool: 'Read', text: '新结果：没有匹配也算有效命中' })
    expect([next.seq, next.window]).toEqual([3, 37])
    const localHit = await session.historyTool({ action: 'search', query: '新结果' })
    expect(localHit.result).toContain('#3 w37')
    expect(localHit.result).not.toContain('旧会话')
    const handoff = await session.buildHandoff({ isMidTurn: false })
    expect(handoff).toContain('这是第 38 个窗口')
    expect(handoff).toContain('旧账本任务')
    expect(handoff).toContain('旧会话 old')
    expect(handoff).toContain('旧归档')
    expect(handoff).toContain('不要覆盖旧文件')
    const decisionSection = handoff.split('## 用户已定决策')[1]?.split('\n## ')[0] ?? ''
    expect(decisionSection).toContain('不要覆盖旧文件')
    expect(decisionSection).not.toContain('禁止运行旧命令')
    expect((await session.ledgerRead({ view: 'archive:1', session_id: 'old' })).result).toContain('旧归档任务')
    await session.commitSwitch({ trigger: 'test', tokensBefore: 1000, handoffText: handoff })
    await session.flush()
    const reload = createSession('/data/new', b.io, DEFAULTS)
    await reload.ready()
    expect(reload.window()).toBe(38)
    expect((await reload.historyTool({ action: 'read', seq: 7552 })).result).toContain('旧历史关键词')
    expect(old.every(([p, text]) => b.files.get(p) === text)).toBe(true)
    expect(b.writes.every(p => p.startsWith('/data/new/'))).toBe(true)
  })
  test('only the first user message is considered and existing meta never relinks', async () => {
    for (const withMeta of [false, true]) {
      const b = box()
      if (withMeta) b.files.set('/data/new/meta.json', JSON.stringify({ window: 3, seq: 0 }))
      const session = createSession('/data/new', b.io, DEFAULTS)
      await session.importMessages(withMeta ? [message()] : [message('普通请求'), message()])
      await session.flush()
      expect(JSON.parse(b.files.get('/data/new/meta.json')!).lineage).toBe(undefined)
      expect(session.window()).toBe(withMeta ? 3 : 1)
    }
  })
  test('cycles in hand-written lineage terminate without writing predecessors', async () => {
    const b = box()
    b.files.set('/data/new/meta.json', JSON.stringify({ window: 1, seq: 0, lineage: { sessionId: 'old', lastWindow: 36, lastSeq: 7552, mode: 'reference' } }))
    b.files.set('/data/old/meta.json', JSON.stringify({ window: 36, seq: 7552, lineage: { sessionId: 'new', lastWindow: 1, lastSeq: 0, mode: 'reference' } }))
    const s = createSession('/data/new', b.io, DEFAULTS)
    expect((await s.buildHandoff({ isMidTurn: false })).length > 0).toBe(true)
    expect(b.writes.length).toBe(0)
  })
})

