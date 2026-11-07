import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSession } from '../hooks/lib/session.ts'
import { DEFAULTS } from '../hooks/lib/types.ts'
const expect = value => ({ toBe: expected => assert.equal(value, expected), toContain: expected => assert.ok(value.includes(expected), String(value)), toEqual: expected => assert.deepEqual(value, expected) })
const HANDOFF = '这是第 36 个窗口，上一个窗口的对话不在上下文里。\n旧会话交接正文'
const row = (seq, text, window = 36) => ({ seq, ts: 1000, window, uuid: '', role: 'user', isPerson: true, text })
const entry = (seq, task, status = 'in_progress') => ({ seq, ts: 1000, window: 36, task_id: task, title: task, status, text: '保留的进度', next_step: '继续检查', request_ref: 7552, evidence: [] })
const box = () => ({ files: new Map([
  ['/data/old/meta.json', JSON.stringify({ window: 36, seq: 7552 })],
  ['/data/old/handoff-w036.md', HANDOFF],
  ['/data/old/history-w036.jsonl', JSON.stringify(row(7552, '不要覆盖旧文件。旧历史关键词')) + '\n'],
  ['/data/old/ledger.jsonl', JSON.stringify(entry(150, '旧账本任务'))],
  ['/data/old/archive-001.jsonl', JSON.stringify(entry(1, '旧归档任务', 'done'))],
  ['/data/old/decisions.jsonl', ''],
]) })
test('dry-run writes nothing; apply backs up, references old state, and next switch is 40', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-lineage-'))
    try {
      const b = box()
      for (const [p, text] of b.files) {
        const target = path.join(temp, p.slice('/data/'.length))
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, text)
      }
      await fs.mkdir(path.join(temp, 'new'))
      const meta = JSON.stringify({ window: 3, seq: 35, ledgerSeq: 35, custom: 'preserve' })
      const ownLedger = JSON.stringify({ ...entry(35, '新账本任务'), window: 3, request_ref: 35 })
      await fs.writeFile(path.join(temp, 'new/meta.json'), meta)
      await fs.writeFile(path.join(temp, 'new/ledger.jsonl'), ownLedger)
      const ownHistory = JSON.stringify(row(35, '新历史不改', 3)) + '\n'
      await fs.writeFile(path.join(temp, 'new/history-w003.jsonl'), ownHistory)
      const extras = { 'held.json': '{"items":[]}', 'archive-001.jsonl': JSON.stringify(entry(1, '本地归档')), 'handoff-w003.md': '已有交接', 'events.jsonl': '{"window":2}\n' }
      for (const [name, text] of Object.entries(extras)) await fs.writeFile(path.join(temp, 'new', name), text)
      const script = path.resolve('scripts/migrate-lineage.mjs')
      const run = (apply = false) => spawnSync('node', [script, 'new', 'old', '--root', temp, ...(apply ? ['--apply'] : [])], { encoding: 'utf8' })
      const dry = run()
      expect(dry.status).toBe(0)
      expect(dry.stdout).toContain('DRY-RUN')
      expect(dry.stdout).toContain('下次换窗 40')
      expect(await fs.readFile(path.join(temp, 'new/meta.json'), 'utf8')).toBe(meta)
      expect((await fs.readdir(temp)).length).toBe(2)
      const applied = run(true)
      expect(applied.status).toBe(0)
      const names = await fs.readdir(temp)
      const backup = names.find(name => name.startsWith('new.bak-lineage-'))
      expect(backup !== undefined).toBe(true)
      expect(await fs.readFile(path.join(temp, backup, 'meta.json'), 'utf8')).toBe(meta)
      expect(await fs.readFile(path.join(temp, backup, 'ledger.jsonl'), 'utf8')).toBe(ownLedger)
      expect(await fs.readFile(path.join(temp, 'new/ledger.jsonl'), 'utf8')).toBe(ownLedger)
      expect(await fs.readFile(path.join(temp, 'new/history-w003.jsonl'), 'utf8')).toBe(ownHistory)
      for (const [name, text] of Object.entries(extras)) {
        expect(await fs.readFile(path.join(temp, 'new', name), 'utf8')).toBe(text)
        expect(await fs.readFile(path.join(temp, backup, name), 'utf8')).toBe(text)
      }
      const linked = JSON.parse(await fs.readFile(path.join(temp, 'new/meta.json'), 'utf8'))
      expect([linked.window, linked.seq, linked.custom]).toEqual([39, 35, 'preserve'])
      const io = {
        read: p => fs.readFile(p, 'utf8'),
        write: async (p, text) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, text) },
        list: p => fs.readdir(p), now: () => 2000,
      }
      const s = createSession(path.join(temp, 'new'), io, DEFAULTS)
      await s.ready()
      expect(s.window()).toBe(39)
      const handoff = await s.buildHandoff({ isMidTurn: false })
      expect(handoff).toContain('这是第 40 个窗口')
      expect(handoff).toContain('新账本任务')
      expect(handoff).toContain('旧账本任务')
      expect((await s.historyTool({ action: 'read', seq: 7552 })).result).toContain('旧会话')
      expect((await s.historyTool({ action: 'read', seq: 35 })).result).toContain('新历史不改')
      expect(run(true).status).toBe(0)
      expect((await fs.readdir(temp)).length).toBe(3)
      await s.commitSwitch({ trigger: 'migration-test', tokensBefore: 1000, handoffText: handoff })
      const nextRow = await s.record({ uuid: 'after-migration', role: 'tool', tool: 'Read', text: '迁移后的第一条' })
      await s.flush()
      expect([nextRow.seq, nextRow.window]).toEqual([36, 40])
      for (const [p, text] of b.files) expect(await fs.readFile(path.join(temp, p.slice('/data/'.length)), 'utf8')).toBe(text)
    } finally { await fs.rm(temp, { recursive: true, force: true }) }
  })
