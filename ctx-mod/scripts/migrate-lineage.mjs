#!/usr/bin/env node
// Node 24+ (native TypeScript stripping). Stop the target session before --apply.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { linkTo, lineageFrom, safeSessionId } from '../hooks/lib/lineage.ts'

export async function migrateLineage({ root, sessionId, predecessorId, apply = false, log = console.log }) {
  if (!safeSessionId(sessionId) || !safeSessionId(predecessorId) || sessionId === predecessorId) throw new Error('需要两个不同的合法会话 id')
  root = path.resolve(root)
  const target = path.join(root, sessionId)
  const metaPath = path.join(target, 'meta.json')
  const text = await fs.readFile(metaPath, 'utf8')
  const meta = JSON.parse(text)
  if (!Number.isSafeInteger(meta.window) || meta.window < 1 || !Number.isSafeInteger(meta.seq) || meta.seq < 0) throw new Error('新会话 meta 的 window / seq 无效')
  const io = { read: file => fs.readFile(file, 'utf8') }
  const link = await linkTo(root.replaceAll('\\', '/'), predecessorId, io)
  if (link === null) throw new Error('前驱 meta 缺失或无效')
  const existing = lineageFrom(meta.lineage)
  if (meta.lineage !== undefined) {
    if (existing?.sessionId === predecessorId) { log('已链接同一前驱；不重复迁移，不再增加窗口号。'); return { changed: false } }
    throw new Error('已存在其他或无效的前驱链接，拒绝覆盖')
  }
  const seen = new Set([sessionId])
  let id = predecessorId
  for (let depth = 0; ; depth++) {
    if (seen.has(id) || depth >= 16) throw new Error('前驱链循环或超过 16 层')
    seen.add(id)
    const old = JSON.parse(await fs.readFile(path.join(root, id, 'meta.json'), 'utf8'))
    if (old.lineage === undefined) break
    const next = lineageFrom(old.lineage)
    if (next === null) throw new Error('前驱链损坏')
    id = next.sessionId
  }
  const nextWindow = meta.window + link.lastWindow
  if (!Number.isSafeInteger(nextWindow)) throw new Error('窗口号溢出')
  const nextMeta = { ...meta, window: nextWindow, lineage: { ...link, windowOffset: link.lastWindow } }
  log((apply ? 'APPLY' : 'DRY-RUN') + ': ' + sessionId + ' <- ' + predecessorId)
  log('只写新会话 meta.json；以只读引用并入旧账本、决策撤销记录和归档，不复制或修改旧目录。')
  log('旧历史最后编号 #' + link.lastSeq + '；保留本会话 #' + meta.seq + ' 及全部数据；同号用 session_id 指定旧 id。')
  log('窗口 ' + meta.window + ' -> ' + nextWindow + '；下次换窗 ' + (nextWindow + 1) + '；已有历史文件和行内窗口号不重写。')
  log('应用前须停止目标会话，应用后重启；将先完整备份新会话目录。')
  if (!apply) return { changed: false, nextMeta }
  // Refuse links/junctions: neither backup nor apply may follow a redirected target.
  for (const p of [root, target, metaPath]) if ((await fs.lstat(p)).isSymbolicLink()) throw new Error('拒绝符号链接路径')
  if (await fs.readFile(metaPath, 'utf8') !== text) throw new Error('目标 meta 已变化，请停止会话后重试')
  const backup = target + '.bak-lineage-' + new Date().toISOString().replaceAll(':', '-')
  await fs.cp(target, backup, { recursive: true, force: false, errorOnExist: true, dereference: false })
  // Check again after the backup, before replacing just the target metadata.
  if (await fs.readFile(metaPath, 'utf8') !== text) throw new Error('备份期间目标 meta 已变化；未写入迁移')
  const temp = metaPath + '.lineage-' + process.pid + '.tmp'
  await fs.writeFile(temp, JSON.stringify(nextMeta), { flag: 'wx' })
  await fs.rename(temp, metaPath)
  log('备份：' + backup)
  return { changed: true, backup, nextMeta }
}

export async function main(args = process.argv.slice(2)) {
  const ids = []
  let root = path.join(os.homedir(), '.claude', 'ctx-mod')
  let apply = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true
    else if (args[i] === '--root' && args[i + 1]) root = args[++i]
    else if (args[i].startsWith('--')) throw new Error('未知参数：' + args[i])
    else ids.push(args[i])
  }
  if (ids.length !== 2) throw new Error('用法: node scripts/migrate-lineage.mjs <新会话id> <前驱id> [--root <数据根目录>] [--apply]')
  return migrateLineage({ root, sessionId: ids[0], predecessorId: ids[1], apply })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
