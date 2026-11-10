// 作业目录里的诊断日志：状态/日志写入失败时记一行，免得面板停住却没有任何线索。
// 写日志本身绝不能抛（runner 是后台守护进程，抛异常会让整个作业挂掉）；同一个 where 最多记
// ERROR_NOTE_LIMIT 次，之后只在内存里计数——Windows 上 status.json 被面板短暂占用时会连续失败。
import fs from 'node:fs'

export const ERROR_NOTE_LIMIT = 5
const MAX_MESSAGE = 300

const messageOf = err => {
  const message = err && typeof err.message === 'string' ? err.message : String(err)
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE)
}

/** file：日志文件（通常是作业目录下的 errors.log）。返回 (where, err) => 该 where 的累计次数。 */
export function createErrorNote(file, { limit = ERROR_NOTE_LIMIT, now = Date.now } = {}) {
  const seen = new Map() // where -> { written, total, capNoted }
  const append = line => {
    try { fs.appendFileSync(file, line + '\n') } catch {}
  }
  const noteError = (where, err) => {
    try {
      const key = String(where)
      let s = seen.get(key)
      if (s === undefined) { s = { written: 0, total: 0, capNoted: false }; seen.set(key, s) }
      s.total += 1
      if (s.written >= limit) {
        if (!s.capNoted) {
          s.capNoted = true
          append(`${new Date(now()).toISOString()} ${key}: 同类错误已达 ${limit} 次，之后只计数（累计 ${s.total} 次）`)
        }
      } else {
        s.written += 1
        append(`${new Date(now()).toISOString()} ${key}: ${messageOf(err)}`)
      }
      return s.total
    } catch {
      return 0
    }
  }
  noteError.countOf = where => seen.get(String(where))?.total ?? 0
  return noteError
}
