// 缓存保活的转发：Claude Code → 这里 → CPA（Anthropic /v1/messages）。
// 请求原样转发，流式响应边收边转（不等收完）；每个 POST /v1/messages 的请求体存成
// <root>/<jobId>.json（只留最后一次），并顺手从响应里读出 usage 一并记下 ——
// 文件里没有 headers、没有 request id、没有任何 key。
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  keepaliveRootOf,
  jobIdOf,
  mergeSessionUsage,
  mergeUsage,
  sessionPathOf,
  sessionRecordOf,
  usageFromEvent,
  writeSession,
} from './keepalive-lib.mjs'

// 请求体是整段 JSON（几十 KB 到几 MB），留一个上限防止把内存写爆。
const MAX_REQUEST_BYTES = 64 * 1024 * 1024

const isMessagesPath = url => {
  const p = String(url ?? '').split('?')[0]

  return p === '/v1/messages' || p.endsWith('/v1/messages')
}

/** 从响应里嗅用量：SSE 逐行解析 data:，普通 JSON 在结束时整段解析。 */
const createUsageSniffer = onUsage => {
  let rest = ''
  let raw = ''
  let usage = null
  let sawSse = false
  const apply = payload => {
    const u = usageFromEvent(payload)
    if (u !== undefined) usage = mergeUsage(usage, u)
  }
  const sniffer = chunk => {
    const text = chunk.toString('utf8')
    if (!sawSse) raw += text
    rest += text
    let i
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i).trim()
      rest = rest.slice(i + 1)
      if (!line.startsWith('data:')) continue
      sawSse = true
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      try {
        apply(JSON.parse(payload))
      } catch {}
    }
  }
  sniffer.end = () => {
    const tail = rest.trim()
    if (!sawSse && tail !== '') {
      try {
        apply(JSON.parse(tail.startsWith('data:') ? tail.slice(5).trim() : tail))
      } catch {}
    }
    if (usage !== null) {
      try {
        onUsage(usage)
      } catch {}
    }
  }

  return sniffer
}

const forward = (ctx, req, res, body, attempt = 0) => {
  const headers = { ...req.headers }
  delete headers.host
  if (body.length > 0 || req.headers['content-length'] !== undefined) headers['content-length'] = String(body.length)
  const send = {
    protocol: ctx.base.protocol,
    hostname: ctx.base.hostname,
    port: ctx.base.port || undefined,
    method: req.method,
    path: ctx.basePath + String(req.url ?? '/'),
    headers,
  }
  const mod = ctx.base.protocol === 'https:' ? https : http
  const up = mod.request(send, upRes => {
    if (res.headersSent || res.destroyed) {
      upRes.resume()

      return
    }
    res.writeHead(upRes.statusCode ?? 502, upRes.headers)
    const sniffer = createUsageSniffer(usage => ctx.onUsage?.(usage))
    // 先嗅用量再 pipe：两边都挂在 data 上，pipe 负责背压，嗅探只看不改。
    upRes.on('data', chunk => sniffer(chunk))
    upRes.on('end', () => sniffer.end())
    upRes.on('error', () => {
      try {
        res.destroy()
      } catch {}
    })
    upRes.pipe(res)
  })
  up.on('error', () => {
    // 转发出错就降级为直连 CPA：同一个目标再打一次（body 已经在手上），还失败才让请求失败。
    if (attempt === 0 && !res.headersSent) {
      forward(ctx, req, res, body, 1)

      return
    }
    if (!res.headersSent) {
      const payload = JSON.stringify({ type: 'error', error: { type: 'keepalive_proxy_error', message: 'keepalive 转发失败' } })
      res.writeHead(502, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
      res.end(payload)
    } else {
      try {
        res.destroy()
      } catch {}
    }
  })
  up.setTimeout(600_000, () => {
    try {
      up.destroy(new Error('upstream timeout'))
    } catch {}
  })
  if (body.length > 0) up.write(body)
  up.end()
}

/**
 * 起一个本地转发，返回 { url, port, close }。
 * target 是 CPA 的 base url（和 cpaEnv 给 ANTHROPIC_BASE_URL 的一样）；jobId 决定文件名。
 */
export const startKeepaliveProxy = ({ target, jobId, root = keepaliveRootOf(), port = 0, host = '127.0.0.1' } = {}) =>
  new Promise((resolve, reject) => {
    let base
    try {
      base = new URL(String(target ?? ''))
    } catch (e) {
      reject(new Error('keepalive: bad target url'))

      return
    }
    const id = jobIdOf(jobId)
    if (id === '') {
      reject(new Error('keepalive: a jobId is required'))

      return
    }
    const basePath = base.pathname.replace(/\/+$/, '')
    const ctx = {
      base,
      basePath,
      onUsage: usage => {
        try {
          mergeSessionUsage(root, id, usage)
        } catch {}
      },
    }
    const save = bodyBuffer => {
      try {
        const body = JSON.parse(bodyBuffer.toString('utf8'))
        writeSession(root, sessionRecordOf({ jobId: id, body }))
      } catch {
        // 不是 JSON（或半截）：这一条不记，下次真实请求会覆盖
      }
    }
    const server = http.createServer((req, res) => {
      const chunks = []
      let bytes = 0
      let tooBig = false
      req.on('data', chunk => {
        bytes += chunk.length
        if (bytes > MAX_REQUEST_BYTES) tooBig = true
        if (!tooBig) chunks.push(chunk)
      })
      req.on('error', () => {})
      req.on('end', () => {
        if (tooBig) {
          const payload = JSON.stringify({ type: 'error', error: { type: 'keepalive_proxy_error', message: 'request body too large' } })
          res.writeHead(413, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
          res.end(payload)

          return
        }
        const body = Buffer.concat(chunks)
        if (isMessagesPath(req.url) && String(req.method ?? '').toUpperCase() === 'POST') save(body)
        forward(ctx, req, res, body)
      })
    })
    server.on('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      resolve({
        url: `http://${host}:${addr.port}`,
        port: addr.port,
        root,
        jobId: id,
        close: () =>
          new Promise(done => {
            try {
              server.closeAllConnections?.()
            } catch {}
            server.close(() => done())
            setTimeout(done, 1000) // 还有 keep-alive 连接挂着时别拖住进程退出
          }),
      })
    })
  })

// 手动起一个转发（调试用）：node keepalive-proxy.mjs <jobId> <cpa base url>
const here = path.dirname(fileURLToPath(import.meta.url))
const invokedDirectly = () => {
  try {
    return process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.join(here, 'keepalive-proxy.mjs')
  } catch {
    return false
  }
}

export const proxyMain = async argv => {
  const [jobId, target] = argv
  if (!jobId || !target) {
    process.stderr.write('usage: node keepalive-proxy.mjs <jobId> <cpa base url>\n')
    process.exit(2)
  }
  const proxy = await startKeepaliveProxy({ jobId, target })
  process.stdout.write(JSON.stringify({ ok: true, url: proxy.url, file: sessionPathOf(proxy.root, proxy.jobId) }) + '\n')
}

if (invokedDirectly()) {
  proxyMain(process.argv.slice(2)).catch(e => {
    process.stderr.write(String(e?.message ?? e) + '\n')
    process.exit(1)
  })
}
