import type { Register } from 'claude-code'

const RUNNER = __RUNNER__
const RG = __RG__
// Read-only mode (PTC_RUN_READONLY=1): the hook starts this broker instead of the runner; the broker runs the runner
// under the Node permission model and executes rg for it (see src/broker.js). The runner travels inside its input JSON.
const BROKER = __BROKER__
// The runner source is ~40KB, over the Windows 32K command-line limit, so it travels on stdin:
// line 1 = input JSON, rest = runner source. BOOT is the only thing passed on the command line.
const BOOT = 'const s=require("fs").readFileSync(0,"utf8"),k=s.indexOf("\\n");globalThis.__PTC_IN=s.slice(0,k);(0,eval)(s.slice(k+1))'
const NAME = 'mcp__ptc-run__run_code'
// On an outer timeout the runner has already been killed, so the hook reads the streaming log and write-op journal it
// left in the session scope dir. The reader is a separate node process because this hook has no fs access.
const PARTIAL_READER = 'const fs=require("fs"),path=require("path"),os=require("os");' +
  'const a=JSON.parse(fs.readFileSync(0,"utf8"));' +
  'const scope=String(a.scope||"default").replace(/[^A-Za-z0-9_.-]/g,"_").replace(/^\\.+/,"_").slice(0,80)||"default";' +
  'const d=path.join(os.tmpdir(),"cc-ptc",scope);' +
  'const base="run-"+String(a.logName).replace(/[^A-Za-z0-9_-]/g,"_").slice(0,64);' +
  'let out="",ops="";try{out=fs.readFileSync(path.join(d,base+".log"),"utf8")}catch{}' +
  'try{ops=fs.readFileSync(path.join(d,base+".log.ops"),"utf8")}catch{}' +
  'const head=a.head,tail=a.tail;' +
  'const clip=(s)=>s.length<=head+tail?s:s.slice(0,head)+"…[省略 "+(s.length-head-tail)+" 字]…"+s.slice(-tail);' +
  'const seen=new Map();for(const l of ops.split("\\n")){if(!l)continue;try{const o=JSON.parse(l);const k=o.op+"\\u0000"+o.path;seen.set(k,(seen.get(k)||0)+1)}catch{}}' +
  'const rows=[...seen].map(([k,n])=>{const i=k.indexOf("\\u0000");return "- "+k.slice(0,i)+" "+k.slice(i+1)+(n>1?" ×"+n:"")});' +
  'process.stdout.write(JSON.stringify({out:clip(out),ops:rows.length?"本程序已生效的写操作：\\n"+rows.slice(0,50).join("\\n"):"本程序已生效的写操作：无"}))'

const DESC_PARTS = [
  'Run a JavaScript async-function body in a sandbox that calls tools synchronously; only console.log output and the return value come back. Use for batch work (loops, grep+aggregate, edits). timeoutMs is the whole-program timeout (default 300000 ms, max 1800000). root:"D:/abs/dir" makes relative paths, path-less glob/grep and cwd-less bash use that existing absolute directory (tools.root exposes it).',
  'Paths: relative to cwd (or root). On big trees give glob/grep a path or specific pattern. Errors carry .code/.nextAction and "[CODE]" prefix: INVALID_ARGUMENT NOT_FOUND NOT_UNIQUE COUNT_MISMATCH STALE LOCKED EXISTS POLICY_DENIED BUSY OUTPUT_LIMIT RG_UNAVAILABLE RESULT_UNKNOWN.',
  'tools.read({path,offset?,limit?,numbered?}) (numbered:true -> "N: text" lines with real line numbers). tools.revision({path}) -> 16-hex sha256 prefix of the file content; pass it as expectedRevision to tools.edit (or as {path: revision} to tools.replace) to get STALE and write nothing if the content changed since (works across run_code calls). tools.write({path,content}) (write/edit/replace results are capped at 32 MiB per file: over it nothing is written and OUTPUT_LIMIT is thrown); tools.edit({path,old,new,all?,expect?,expectedRevision?}) -> {replaced,lines} (atomic; the mtime STALE check still applies only if this same program read the file first; expectedRevision adds a cross-call content check; revision-guarded writes also take a cross-process lock (one writer at a time; LOCKED after ~2 s, a lock left by a crash is taken over after 30 s); with all:true pass expect:<count you mean to change>, a different count writes nothing and throws COUNT_MISMATCH).',
  'tools.glob({pattern?:string|string[],path?,sort?:"path"|"modified",details?,offset?,limit?=5000}) and tools.grep({pattern,path?,glob?,ignoreCase?,outputMode?:"content"|"files_with_matches"|"count",before?,after?,multiline?,offset?=0,limit?=500}) -> {items,total,complete,nextOffset} (ripgrep: .gitignore honoured; skips hidden, node_modules, target, .venv, files>2MB). glob items: path, or {path,size,mtime} with details. grep items: {file,line,text<=300} (+uncounted context:true rows), {file,count}, or paths.',
  'tools.replace({pattern(JS regex; lookaround, \\1, named groups ok),replacement($1 ok),path?,glob?,flags?,dryRun?,maxReplacements?,expect?,expectedRevision?}) -> {files,matches,changed,items:[{file,count,lines}],dryRun} (expect: total matches you mean to change; a different count writes nothing and throws COUNT_MISMATCH). Any write that changed several places is listed at the top of the output with its line numbers: check each one was intended.',
  'tools.batch({action:"plan"|"run"|"resume"|"list",operations:[{op:"copy"|"move"|"remove",path,to?}],protect?:string[],root?,toRoot?,id?}): root-relative "/" paths (to is relative to toRoot if given: another dir/drive), <=512 ops, no overwrite, destination parent must exist, no links, protect untouched; preflighted first. plan only journals; run needs operations; resume takes only id (unknown items: checked, not redone); list shows jobs. -> {id,status:"completed"|"partial"|"failed"|"planned",done,failed,unknown,total,detailsRef}.',
  'tools.bash({command,cwd?,timeoutMs?,env?,background?,promote?})->{code,stdout,stderr}; a foreground command that reaches timeoutMs is not killed but promoted to a background job: the call returns {code:null,timedOut:true,promoted:true,jobId,stdout,stderr} (output so far) and tools.job({id:jobId,wait?}) returns the final result; promote:false kills it on timeout instead. background:true returns {id} immediately, then tools.job({id,wait?,tailChars?=4000})->{done,code,stdout,stderr} (jobs survive run_code calls; 2h cap). await tools.parallel([{command,cwd?,timeoutMs?,env?}],{concurrency?=4,<=16}) runs <=64 bash calls -> [{code,stdout,stderr,timedOut?}] in order. Child processes default to PYTHONUTF8=1 and PYTHONIOENCODING=utf-8; an explicit env wins. tools.test({command,workdir?,timeoutMs?=300000,maxFailures?=10}) runs a test command through the same bash path -> {status:"passed"|"failed"|"error"|"timeout"|"unknown",exitCode,counts?,failures,tail?,error?,outputPath} (pytest/vitest/jest/node --test parsed conservatively): print that summary instead of piping test output; when status is "error", read error and tail, and outputPath is the path to the full output (read it with tools.read).',
  'ref.put(v)->id; ref.page(id,{offset,limit,fields,equals,maxBytes=16384})->{total,offset,items,nextOffset,complete,omitted} (OUTPUT_LIMIT if one row exceeds maxBytes; also reads detailsRef); ref.text(id,{from,to}) returns a slice of the saved text; ref.release(id). Refs: per session, 24h. Output over ~8000 chars (or maxChars, <=50000) keeps about the first 70% and last 30% (cut on line boundaries); the marker names the omitted output lines and the exact ref.text(id,{from,to}) call that returns them',
]
const DESC = DESC_PARTS.join(' ')

// Short description for delegate's ptc-only mode: there the SDK declarations are already in the system prompt.
const DESC_SHORT = 'Run a JavaScript async-function body in a sandbox; the SDK bindings (tools.*) are declared in the system prompt. Only console.log output and the return value come back. timeoutMs defaults to 300000 (max 1800000); root:"D:/abs/dir" changes the base directory for relative paths, glob/grep and bash.'

// Read-only mode descriptions: only the read-side bindings are advertised.
const DESC_RO = [
  'Run a JavaScript async-function body in a READ-ONLY sandbox that calls tools synchronously; only console.log output and the return value come back. Use for batch reading, grep+aggregate and summaries. timeoutMs defaults to 300000 (max 1800000); root:"D:/abs/dir" changes the base directory for relative paths and glob/grep.',
  'Read-only mode: tools.write/edit/replace/batch/bash/parallel/job throw POLICY_DENIED, the program itself cannot write files or start processes (fs writes and child_process are blocked), and only files under the working directory can be read or searched.',
  DESC_PARTS[1], DESC_PARTS[2].split('. tools.write')[0] + '.', DESC_PARTS[3], DESC_PARTS[7],
].join(' ')
const DESC_SHORT_RO = 'Run a JavaScript async-function body in a read-only sandbox (no file writes, no commands, reads only under the working directory); the SDK bindings (tools.*) are declared in the system prompt. Only console.log output and the return value come back.'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const sdkInPrompt = (await $.env.get('PTC_RUN_SDK_IN_PROMPT')) === '1'
    const ro = (await $.env.get('PTC_RUN_READONLY')) === '1'
    await $.tool.register({
      name: 'run_code',
      description: ro ? (sdkInPrompt ? DESC_SHORT_RO : DESC_RO) : sdkInPrompt ? DESC_SHORT : DESC,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Body of an async function; use return and console.log.' },
          description: { type: 'string', description: 'One-line summary of what the program does.' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 1800000, description: '整个程序的超时毫秒数，默认 300000，最大 1800000；程序内 bash 的 timeoutMs 不能超过它' },
          root: { type: 'string', description: '可选：已存在的绝对目录。设置后程序内的相对路径、grep/glob 的默认目录、未指定 cwd 的 bash 都以它为基准，程序里可用 tools.root 读取；不设置则沿用会话 cwd。' },
          maxChars: {
            type: 'integer',
            minimum: 1000,
            maximum: 50000,
            description: 'Output cap in chars (default 8000). Over it the first 70% and last 30% are kept, the middle is saved as a ref (ref.text(id,{from,to})), and a truncation hint is printed.',
          },
        },
        required: ['code', 'description'],
      },
    })
    return next(e)
  })

  on('tool.call', { tool: NAME }, async ($, e) => {
    const input = e as unknown as { code: string; timeoutMs?: number; maxChars?: number; root?: string }
    const cwd = await $.session.cwd()
    const dsh = (await $.env.get('PTC_RUN_SDK_IN_PROMPT')) === '1'
    let ro = (await $.env.get('PTC_RUN_READONLY')) === '1'
    // Read-only agent types (reviewer / oracle / researcher by default) always get the read-only broker, whatever the
    // session's own mode. Fail closed: a subagent call whose type cannot be resolved is treated as read-only.
    const agentId = (e as unknown as { agentId?: string }).agentId
    if (!ro && agentId) {
      const roTypes = ((await $.env.get('PTC_RUN_RO_AGENTS')) || 'reviewer,oracle,researcher').split(',').map(s => s.trim()).filter(Boolean)
      try {
        const me = (await $.agent.list()).find(a => a.id === agentId)
        ro = !me || roTypes.includes(me.type)
      } catch {
        ro = true
      }
    }
    // Extra directories a read-only root may point into (besides the session cwd), from the environment only.
    const roRoots = ro ? ((await $.env.get('PTC_RUN_RO_ROOTS')) || '').split(';').map(s => s.trim()).filter(Boolean) : []
    let scope = 'default'
    try {
      const sid = await $.session.id()
      if (typeof sid === 'string' && sid) scope = sid
    } catch {
      // keep the default scope
    }
    const timeoutMs = Math.min(Math.max(Math.trunc(input.timeoutMs ?? 300000), 1000), 1800000)
    const readLimitRaw = ((await $.env.get('PTC_RUN_DSH_READ_LIMIT')) || '').trim()
    const dshReadLimit = /^\d+$/.test(readLimitRaw) && Number(readLimitRaw) > 0 ? Number(readLimitRaw) : undefined
    const logName = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    const readPartial = async () => {
      try {
        const pr = await $.process.run(['node', '-e', PARTIAL_READER], {
          cwd,
          stdin: JSON.stringify({ scope, logName, head: 4000, tail: 4000 }),
          timeoutMs: 15000,
        })
        return pr.stdout || ''
      } catch {
        return ''
      }
    }
    const partialText = (body: string) => {
      let parsed: { out?: string; ops?: string } = {}
      try { parsed = JSON.parse(body) } catch { /* keep empty */ }
      const ops = parsed.ops || '本程序已生效的写操作：未知（无法读取写操作日志）'
      return '[RESULT_UNKNOWN] 程序在 ' + (timeoutMs / 1000) + ' 秒超时被终止，以下是已打印的输出（前 4000 字 + 后 4000 字）' +
        (ro ? '\n（只读模式：不会修改项目文件）' : '') + '\n' + ops + '\n' + (parsed.out || '（无输出）')
    }
    try {
      const payload = { cwd, code: input.code, rg: RG, scope, dsh, root: input.root, roRoots, logName, dshReadLimit, maxChars: input.maxChars ? Math.min(Math.max(Math.trunc(input.maxChars), 1000), 50000) : dsh ? 50000 : undefined }
      const r = await $.process.run(['node', '-e', BOOT], {
        cwd,
        stdin: ro
          ? JSON.stringify({ ...payload, timeoutMs, boot: BOOT, runner: RUNNER }) + '\n' + BROKER
          : JSON.stringify(payload) + '\n' + RUNNER,
        timeoutMs,
      })
      if (r.exitCode === 124 || r.exitCode === 137) {
        const partial = await readPartial()
        const extra = r.stdout ? '\n' + r.stdout.slice(0, 2000) : ''
        return { result: [{ type: 'text', text: partialText(partial) + extra }], isError: true } as never
      }
      const text = (r.stdout || '') + (r.stderr ? '\n[stderr] ' + r.stderr.slice(0, 2000) : '')
      return { result: [{ type: 'text', text }], isError: r.exitCode !== 0 } as never
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      // The host reports its own timeout as e.g. "$.process.run(node) aborted: still running after 4000ms".
      const killed = /time(d)?[ -]?out|timeout|killed|exceed|abort|still running/i.test(msg)
      if (killed) {
        const partial = await readPartial()
        return { result: [{ type: 'text', text: partialText(partial) }], isError: true } as never
      }
      const note = ro
        ? '\n[RESULT_UNKNOWN] Read-only mode never changes project files.'
        : '\n[RESULT_UNKNOWN] The program may already have produced partial side effects (writes, edits, replace, batch). Inspect the files before retrying. For tools.batch, run tools.batch({action:"list"}) to find the job id (logs: <tmpdir>/cc-ptc/' + scope + '/jobs) and tools.batch({action:"resume", id}) to recover: unknown items are only checked, never redone.'
      return { result: [{ type: 'text', text: 'run_code failed: ' + msg + note }], isError: true } as never
    }
  // Fail closed: if the hook itself throws or overruns, surface an error instead of silently skipping run_code.
  }).catch(async (_$, _e, next) => {
    return { result: [{ type: 'text', text: 'run_code hook failed: ' + String((next as { error?: unknown }).error ?? 'unknown error') + '\nThe program may or may not have started; inspect side effects before retrying.' }], isError: true } as never
  })
}
