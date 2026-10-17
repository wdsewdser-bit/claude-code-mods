import type { Register } from 'claude-code'

const RUNNER = __RUNNER__
const RG = __RG__
// The runner source is ~40KB, over the Windows 32K command-line limit, so it travels on stdin:
// line 1 = input JSON, rest = runner source. BOOT is the only thing passed on the command line.
const BOOT = 'const s=require("fs").readFileSync(0,"utf8"),k=s.indexOf("\\n");globalThis.__PTC_IN=s.slice(0,k);(0,eval)(s.slice(k+1))'
const NAME = 'mcp__ptc-run__run_code'

const DESC = [
  'Run a JavaScript async-function body in a sandbox that calls tools synchronously; only console.log output and the return value come back. Use for batch work (loops, grep+aggregate, edits).',
  'Paths: relative to cwd. On big trees give glob/grep a path or specific pattern. Errors carry .code/.nextAction and "[CODE]" prefix: INVALID_ARGUMENT NOT_FOUND NOT_UNIQUE STALE EXISTS POLICY_DENIED BUSY OUTPUT_LIMIT RG_UNAVAILABLE RESULT_UNKNOWN.',
  'tools.read({path,offset?,limit?}). tools.write({path,content}); tools.edit({path,old,new,all?}) (atomic; edit checks STALE).',
  'tools.glob({pattern?:string|string[],path?,sort?:"path"|"modified",details?,offset?,limit?=5000}) and tools.grep({pattern,path?,glob?,ignoreCase?,outputMode?:"content"|"files_with_matches"|"count",before?,after?,multiline?,offset?=0,limit?=500}) -> {items,total,complete,nextOffset} (ripgrep: .gitignore honoured; skips hidden, node_modules, target, .venv, files>2MB). glob items: path, or {path,size,mtime} with details. grep items: {file,line,text<=300} (+uncounted context:true rows), {file,count}, or paths.',
  'tools.replace({pattern(JS regex; lookaround, \\1, named groups ok),replacement($1 ok),path?,glob?,flags?,dryRun?,maxReplacements?}) -> {files,matches,changed,items:[{file,count}],dryRun}.',
  'tools.batch({action:"plan"|"run"|"resume"|"list",operations:[{op:"copy"|"move"|"remove",path,to?}],protect?:string[],root?,toRoot?,id?}): root-relative "/" paths (to is relative to toRoot if given: another dir/drive), <=512 ops, no overwrite, destination parent must exist, no links, protect untouched; preflighted first. plan only journals; run needs operations; resume takes only id (unknown items: checked, not redone); list shows jobs. -> {id,status:"completed"|"partial"|"failed"|"planned",done,failed,unknown,total,detailsRef}.',
  'tools.bash({command,cwd?,timeoutMs?})->{code,stdout,stderr}. await tools.parallel([{command,cwd?,timeoutMs?}],{concurrency?=4,<=16}) runs <=64 bash calls -> [{code,stdout,stderr,timedOut?}] in order.',
  'ref.put(v)->id; ref.page(id,{offset,limit,fields,equals,maxBytes=16384})->{total,offset,items,nextOffset,complete,omitted} (OUTPUT_LIMIT if one row exceeds maxBytes; also reads detailsRef); ref.release(id). Refs: per session, 24h. Output over ~6000 chars is saved as a ref and truncated.',
].join(' ')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'run_code',
      description: DESC,
      isDeferred: true,
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Body of an async function; use return and console.log.' },
          description: { type: 'string', description: 'One-line summary of what the program does.' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
        },
        required: ['code', 'description'],
      },
    })
    return next(e)
  })

  on('tool.call', { tool: NAME }, async ($, e) => {
    const input = e as unknown as { code: string; timeoutMs?: number }
    const cwd = await $.session.cwd()
    let scope = 'default'
    try {
      const sid = await $.session.id()
      if (typeof sid === 'string' && sid) scope = sid
    } catch {
      // keep the default scope
    }
    try {
      const r = await $.process.run(['node', '-e', BOOT], {
        cwd,
        stdin: JSON.stringify({ cwd, code: input.code, rg: RG, scope }) + '\n' + RUNNER,
        timeoutMs: input.timeoutMs ?? 120000,
      })
      const text = (r.stdout || '') + (r.stderr ? '\n[stderr] ' + r.stderr.slice(0, 2000) : '')
      return { result: [{ type: 'text', text }], isError: r.exitCode !== 0 } as never
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      const killed = /time(d)?[ -]?out|timeout|killed|exceed/i.test(msg)
      const note = killed
        ? '\n[RESULT_UNKNOWN] The program was killed at timeoutMs and may already have produced partial side effects (writes, edits, replace, batch). Inspect the files before retrying. For tools.batch, run tools.batch({action:"list"}) to find the job id (logs: <tmpdir>/cc-ptc/' + scope + '/jobs) and tools.batch({action:"resume", id}) to recover: unknown items are only checked, never redone.'
        : ''
      return { result: [{ type: 'text', text: 'run_code failed: ' + msg + note }], isError: true } as never
    }
  // Fail closed: if the hook itself throws or overruns, surface an error instead of silently skipping run_code.
  }).catch(async (_$, _e, next) => {
    return { result: [{ type: 'text', text: 'run_code hook failed: ' + String((next as { error?: unknown }).error ?? 'unknown error') + '\nThe program may or may not have started; inspect side effects before retrying.' }], isError: true } as never
  })
}
