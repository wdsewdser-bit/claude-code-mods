import type { Register } from 'claude-code'

const RUNNER = __RUNNER__
// Read-only mode (PTC_RUN_READONLY=1): the hook starts this broker instead of the runner; the broker runs the runner
// under the Node permission model and executes rg for it (see src/broker.js). The runner travels inside its input JSON.
const BROKER = __BROKER__
// The runner source is ~40KB, over the Windows 32K command-line limit, so it travels on stdin:
// line 1 = input JSON, rest = runner source. BOOT is the only thing passed on the command line.
const BOOT = 'const s=require("fs").readFileSync(0,"utf8"),k=s.indexOf("\\n");globalThis.__PTC_IN=s.slice(0,k);(0,eval)(s.slice(k+1))'
// Read dedup (see src/runner.js): the runner records which line ranges this conversation has already been shown, one
// file per session/agent in the scope dir. What is still valid is decided here, the way read-dedup does it: an earlier
// run_code result only counts while its tool_result is still in the Messages-API view of this conversation, so
// compaction, /clear and a ctx-mod window switch (which compacts) drop the record and every read returns its full text
// again. Anything unknown fails towards the full text: no record -> dedupReset. Module memory on purpose: a hot reload
// empties it, and an empty record only means one extra full read.
type DedupRun = { ids: { id: string; probe: string }[]; cut: boolean }
const dedupRuns = new Map<string, DedupRun>()
const DEDUP_MAX_IDS = 20
/** A short ASCII fragment of what a run_code result showed, to recognise that result in the context later. */
const dedupProbe = (text: string): string => {
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (t.length >= 6 && /^[\x20-\x7e]+$/.test(t)) return t.slice(0, 48)
  }
  const t = String(text).trim()
  return t.length >= 4 ? t.slice(0, 24) : ''
}
const DEDUP_CLEARED = /^\s*\[(old )?(tool )?(result|output|content)[^\]]{0,80}(cleared|removed|truncated|omitted|elided)/i
const dedupBlockText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
    .join('')
}
/** Whether every recorded run_code result is still in the conversation and still holds its text. */
const dedupStillLive = (messages: unknown, ids: { id: string; probe: string }[]): boolean => {
  if (!Array.isArray(messages)) return false
  const want = new Map(ids.map(i => [i.id, i.probe]))
  const ok = new Set<string>()
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const msg = m as { role?: unknown; content?: unknown }
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: unknown; tool_use_id?: unknown; is_error?: unknown; content?: unknown }
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string' || b.is_error === true) continue
      const probe = want.get(b.tool_use_id)
      if (probe === undefined) continue
      const text = dedupBlockText(b.content)
      if (text.trim() === '' || DEDUP_CLEARED.test(text)) continue
      if (probe === '' || text.includes(probe)) ok.add(b.tool_use_id)
    }
  }
  return ok.size === want.size
}
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
  'Run a JavaScript async-function body in a sandbox that calls tools synchronously; only console.log output and the return value come back. Use for batch work (loops, grep+aggregate, edits). timeoutMs is the whole-program timeout (default 300000 ms, max 600000). root:"D:/abs/dir" makes relative paths, path-less glob/grep and cwd-less bash use that existing absolute directory (tools.root exposes it).',
  'Paths: relative to cwd (or root). On big trees give glob/grep a path or specific pattern. Errors carry .code/.nextAction and "[CODE]" prefix: INVALID_ARGUMENT NOT_FOUND NOT_UNIQUE COUNT_MISMATCH STALE LOCKED EXISTS POLICY_DENIED BUSY OUTPUT_LIMIT RG_UNAVAILABLE RESULT_UNKNOWN.',
  'tools.read({path,offset?,limit?,numbered?,fresh?}) (numbered:true -> "N: text" lines with real line numbers; it always returns the file text itself, dedup never changes what the program sees). Dedup happens on the program output: a read result printed back unchanged (at least 300 chars) whose content this conversation already showed comes back as a one-line [read-dedup] note, and a changed file as a diff; filtered/partial/transformed prints are never touched, and fresh:true on a read turns dedup off for that program output (PTC_RUN_READ_DEDUP=0 turns it off everywhere). tools.revision({path}) -> 16-hex sha256 prefix of the file content; pass it as expectedRevision to tools.edit (or as {path: revision} to tools.replace) to get STALE and write nothing if the content changed since (works across run_code calls). tools.write({path,content}) (write/edit/replace results are capped at 32 MiB per file: over it nothing is written and OUTPUT_LIMIT is thrown); tools.edit({path,old,new,all?,expect?,expectedRevision?}) -> {replaced,lines} (atomic; the mtime STALE check still applies only if this same program read the file first; expectedRevision adds a cross-call content check; revision-guarded writes also take a cross-process lock (one writer at a time; LOCKED after ~2 s, a lock left by a crash is taken over after 30 s); with all:true pass expect:<count you mean to change>, a different count writes nothing and throws COUNT_MISMATCH).',
  'tools.glob({pattern?:string|string[],path?,sort?:"path"|"modified",details?,offset?,limit?=5000}) and tools.grep({pattern,path?,glob?,ignoreCase?,outputMode?:"content"|"files_with_matches"|"count",before?,after?,multiline?,offset?=0,limit?=500}) -> {items,total,complete,nextOffset} (ripgrep: .gitignore honoured; skips hidden, node_modules, target, .venv, files>2MB). glob items: path, or {path,size,mtime} with details. grep items: {file,line,text<=300} (+uncounted context:true rows), {file,count}, or paths.',
  'tools.replace({pattern(JS regex; lookaround, \\1, named groups ok),replacement($1 ok),path?,glob?,flags?,dryRun?,maxReplacements?,expect?,expectedRevision?}) -> {files,matches,changed,items:[{file,count,lines}],dryRun} (expect: total matches you mean to change; a different count writes nothing and throws COUNT_MISMATCH). Any write that changed several places is listed at the top of the output with its line numbers: check each one was intended.',
  'tools.batch({action:"plan"|"run"|"resume"|"list",operations:[{op:"copy"|"move"|"remove",path,to?}],protect?:string[],root?,toRoot?,id?}): root-relative "/" paths (to is relative to toRoot if given: another dir/drive), <=512 ops, no overwrite, destination parent must exist, no links, protect untouched; preflighted first. plan only journals; run needs operations; resume takes only id (unknown items: checked, not redone); list shows jobs. -> {id,status:"completed"|"partial"|"failed"|"planned",done,failed,unknown,total,detailsRef}.',
  'tools.bash({command,cwd?,timeoutMs?,env?,background?,promote?})->{code,stdout,stderr}; a foreground command that reaches timeoutMs is not killed but promoted to a background job: the call returns {code:null,timedOut:true,promoted:true,jobId,stdout,stderr} (output so far) and tools.job({id:jobId,wait?}) returns the final result; promote:false kills it on timeout instead. background:true returns {id} immediately, then tools.job({id,wait?,tailChars?=4000})->{done,code,stdout,stderr} (jobs survive run_code calls; 2h cap). await tools.parallel([{command,cwd?,timeoutMs?,env?}],{concurrency?=4,<=16}) runs <=64 bash calls -> [{code,stdout,stderr,timedOut?}] in order. Child processes default to PYTHONUTF8=1 and PYTHONIOENCODING=utf-8; an explicit env wins. tools.test({command,workdir?,timeoutMs?=300000,maxFailures?=10}) runs a test command through the same bash path -> {status:"passed"|"failed"|"error"|"timeout"|"unknown",exitCode,counts?,failures,tail?,error?,outputPath} (pytest/vitest/jest/node --test parsed conservatively): print that summary instead of piping test output; when status is "error", read error and tail, and outputPath is the path to the full output (read it with tools.read).',
  'ref.put(v)->id; ref.page(id,{offset,limit,fields,equals,maxBytes=16384})->{total,offset,items,nextOffset,complete,omitted} (OUTPUT_LIMIT if one row exceeds maxBytes; also reads detailsRef); ref.text(id,{from,to}) returns a slice of the saved text; ref.release(id). ref.store(key,value)->{key,bytes} / ref.load(key)->value|undefined: named JSON values kept per session for 24h, for results a later run_code needs (avoids reprinting or rerunning); key is 1-64 chars of [A-Za-z0-9_.-], value is JSON and at most 8 MB. Refs: per session, 24h. Output over ~8000 chars (or maxChars, <=50000) keeps about the first 70% and last 30% (cut on line boundaries); the marker names the omitted output lines and the exact ref.text(id,{from,to}) call that returns them',
]
const DESC = DESC_PARTS.join(' ')

// Short description for delegate's ptc-only mode: there the SDK declarations are already in the system prompt.
const DESC_SHORT = 'Run a JavaScript async-function body in a sandbox; the SDK bindings (tools.*) are declared in the system prompt. Only console.log output and the return value come back. timeoutMs defaults to 300000 (max 600000); root:"D:/abs/dir" changes the base directory for relative paths, glob/grep and bash.'

// Extra read-only directories come from the environment only (delegate's readPaths -> PTC_RUN_READ_ROOTS, separated
// the way PATH is: ';' on Windows, ':' elsewhere). They widen reads, never writes. Both separators are accepted, and a
// drive colon ("C:\dir" / "C:/dir") is not a separator, so the same string works on either platform.
const splitReadRoots = (raw: string): string[] => {
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    const driveColon = ch === ':' && /^[A-Za-z]$/.test(raw[i - 1] ?? '') && /[\\/]/.test(raw[i + 1] ?? '')
    if (ch === ';' || (ch === ':' && !driveColon)) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  parts.push(cur)
  return parts.map(s => s.trim()).filter(Boolean)
}
const rootsLine = (roots: string[]): string =>
  roots.length === 0 ? '' : ' Extra readable directories besides the working directory: ' + roots.join(', ') + '.'

// Read-only mode has no ref.store (it writes a file), so its ref sentence lists ref.load alone.
const refLineRo = (s: string): string => s.replace('ref.store(key,value)->{key,bytes} / ', '')

// Read-only mode descriptions: only the read-side bindings are advertised.
const descRo = (roots: string[]): string =>
  [
    'Run a JavaScript async-function body in a READ-ONLY sandbox that calls tools synchronously; only console.log output and the return value come back. Use for batch reading, grep+aggregate and summaries. timeoutMs defaults to 300000 (max 600000); root:"D:/abs/dir" changes the base directory for relative paths and glob/grep.',
    'Read-only mode: tools.write/edit/replace/batch/bash/parallel/job throw POLICY_DENIED, the program itself cannot write files or start processes (fs writes and child_process are blocked), and only files under the working directory and the extra readable directories (if any) can be read or searched; anything else fails with an access error.' + rootsLine(roots),
    DESC_PARTS[1], DESC_PARTS[2].split('. tools.write')[0] + '.', DESC_PARTS[3], refLineRo(DESC_PARTS[7]),
  ].join(' ')
const descShortRo = (roots: string[]): string =>
  'Run a JavaScript async-function body in a read-only sandbox (no file writes, no commands, reads only under the working directory and the extra readable directories, if any); the SDK bindings (tools.*) are declared in the system prompt. Only console.log output and the return value come back.' + rootsLine(roots)

// ---------- options and the environment's own switches ----------
type PtcConfig = { nudgeAfter: number; bashMaxChars: number }
const DEFAULTS: PtcConfig = { nudgeAfter: 2, bashMaxChars: 8000 }
const numOf = (v: unknown, fallback: number): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.trunc(Number(v))
  return fallback
}
/** PTC_RUN_NUDGE / PTC_RUN_BASH_MAX: a whole number (0 turns the feature off); anything else is ignored. */
const envNum = (raw: string | undefined): number | undefined => {
  const t = (raw ?? '').trim()
  return /^\d+$/.test(t) ? Number(t) : undefined
}
const configOf = (options: Readonly<Record<string, unknown>>, nudge: string | undefined, bash: string | undefined): PtcConfig => {
  const out: PtcConfig = {
    nudgeAfter: Math.max(0, numOf(options['nudgeAfter'], DEFAULTS.nudgeAfter)),
    bashMaxChars: Math.max(0, numOf(options['bashMaxChars'], DEFAULTS.bashMaxChars)),
  }
  const n = envNum(nudge)
  if (n !== undefined) out.nudgeAfter = n
  const b = envNum(bash)
  if (b !== undefined) out.bashMaxChars = b
  return out
}

// ---------- feature 1: the single-step reminder (main session only, per turn) ----------
// One model request is one unit, however many tools it calls. A request counts as a single step when exactly one of
// Bash/Read/Grep/Glob went out and no run_code and no dispatch did; side tools (ctx-mod, ccd_turn, effort-auto,
// ToolSearch) neither count nor break the streak. run_code, a dispatch or two or more execution tools reset it.
type NudgeUse = { tool: string }
type NudgeState = { streak: number; lastAt: number; lastStep: string | null }
const newNudgeState = (): NudgeState => ({ streak: 0, lastAt: 0, lastStep: null })
const NUDGE_EXEC = new Set(['Bash', 'Read', 'Grep', 'Glob'])
const RUN_CODE_NAME = 'mcp__ptc-run__run_code'
const isDispatchTool = (tool: string): boolean =>
  tool === 'Agent' || tool === 'Task' || tool === 'SendMessage' || tool.startsWith('mcp__delegate__')
const nudgeText = (n: number): string =>
  'ptc-run：已连续 ' + n + ' 次单步调用。把接下来能预见的步骤写进一个 run_code 程序（依赖上一步结果的用 if 判断），一次做完；重复出现的流程用 lib.def 登记。'
const resetNudge = (s: NudgeState): void => {
  s.streak = 0
  s.lastAt = 0
}
/** One request's answer, after the fact: the reminder it earns, if any. */
const observeNudge = (s: NudgeState, uses: readonly NudgeUse[], after: number, stepKey?: string): string | undefined => {
  if (!(after > 0)) return undefined
  if (stepKey !== undefined) {
    if (s.lastStep === stepKey) return undefined
    s.lastStep = stepKey
  }
  const names = uses.map(u => u.tool)
  if (names.some(isDispatchTool) || names.includes(RUN_CODE_NAME)) {
    resetNudge(s)
    return undefined
  }
  const exec = names.filter(t => NUDGE_EXEC.has(t)).length
  if (exec > 1) {
    resetNudge(s)
    return undefined
  }
  if (exec !== 1) return undefined // bookkeeping and everything else: neither counted nor cleared
  s.streak += 1
  if (s.streak >= after && (s.lastAt === 0 || s.streak - s.lastAt >= 4)) {
    s.lastAt = s.streak
    return nudgeText(s.streak)
  }
  return undefined
}
/** The tool uses of a turn.step result, however the engine spells them. */
const usesOfResult = (result: unknown): NudgeUse[] => {
  const held = (result as { toolUses?: unknown } | null | undefined)?.toolUses
  if (!Array.isArray(held)) return []
  const out: NudgeUse[] = []
  for (const item of held) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const name = typeof row['tool'] === 'string' ? row['tool'] : typeof row['name'] === 'string' ? row['name'] : undefined
    if (name !== undefined) out.push({ tool: name })
  }
  return out
}

// ---------- feature 3: the Bash output cap ----------
// Over the cap the head (60% of it) and the tail (30%) stay, the middle becomes one marker line naming the file that
// holds the whole text. Main session and subagents alike; a Bash result the host already spilled is left alone.
type BashClip = { head: string; tail: string; omitted: number }
const bashClip = (text: string, max: number): BashClip | undefined => {
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return undefined
  const headLen = Math.floor(max * 0.6)
  const tailLen = Math.floor(max * 0.3)
  return { head: text.slice(0, headLen), tail: text.slice(text.length - tailLen), omitted: text.length - headLen - tailLen }
}
const clipMarker = (omitted: number, file: string): string => '\n…[省略 ' + omitted + ' 字符，全文在 ' + file + ']…\n'
const OVERFLOW_KEEP = 200
const OVERFLOW_PRUNE = 'const fs=require("fs"),path=require("path");const a=JSON.parse(fs.readFileSync(0,"utf8"));' +
  'let rows=[];try{for(const n of fs.readdirSync(a.dir)){if(!/^bash-.*\\.txt$/.test(n))continue;try{const s=fs.statSync(path.join(a.dir,n));if(s.isFile())rows.push([s.mtimeMs,n])}catch{}}}catch{}' +
  'rows.sort((x,y)=>x[0]-y[0]);const cut=rows.length-a.keep;for(let i=0;i<cut;i++){try{fs.unlinkSync(path.join(a.dir,rows[i][1]))}catch{}}'
/** The person's home directory, from the environment (the mod runtime has no os module). Undefined: no overflow dir. */
const homeOf = async ($: unknown): Promise<string | undefined> => {
  // A noun is called at the call site and never bound to a variable (the engine refuses that), so each lookup stands
  // on its own here.
  try {
    const up = await ($ as { env: { get: (name: string) => Promise<string | undefined> } }).env.get('USERPROFILE')
    if (typeof up === 'string' && up.trim() !== '') return up.trim().replace(/[\\/]+$/, '')
  } catch {
    // fall through to HOME
  }
  try {
    const home = await ($ as { env: { get: (name: string) => Promise<string | undefined> } }).env.get('HOME')
    if (typeof home === 'string' && home.trim() !== '') return home.trim().replace(/[\\/]+$/, '')
  } catch {
    // no env: no home directory, so no overflow file
  }
  return undefined
}
/** Writes one overflow file; undefined when it could not be written (the caller then leaves the result alone). */
const writeOverflow = async ($: unknown, text: string): Promise<string | undefined> => {
  const home = await homeOf($)
  if (home === undefined) return undefined
  const dir = home + '/.claude/ptc-run/overflow'
  const file = dir + '/bash-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.txt'
  await ($ as { fs: { write: (p: string, t: string) => Promise<void> } }).fs.write(file, text)
  // Past 200 files the oldest go; $.fs has no delete, so a node child does that (only when the directory is that full).
  try {
    const entries = await ($ as { fs: { list: (p?: string) => Promise<readonly { name: string }[]> } }).fs.list(dir)
    if (entries.length > OVERFLOW_KEEP) {
      await ($ as { process: { run: (argv: string[], opts: { stdin: string; timeoutMs: number }) => Promise<unknown> } }).process.run(
        ['node', '-e', OVERFLOW_PRUNE],
        { stdin: JSON.stringify({ dir, keep: OVERFLOW_KEEP }), timeoutMs: 10000 },
      )
    }
  } catch {
    // pruning is best effort; the file itself is written
  }
  return file
}

// ---------- what the tool description starts with ----------
// It leads rather than trails: the host shows the model only about the first 2000 characters of a
// tool description, and at the end this part was cut off and never seen.
const DESC_APPEND_MAX = 450
const SHORT_HELP = ' Shorthand: tools.sh(command,{tail?=60,cwd?,timeoutMs?})->{code,text} (last lines of stdout+stderr); tools.peek(path,pattern,{context?=2,limit?=20})->matching lines with real line numbers.'
const LIB_HINT = ' 重复用到的多步流程用 lib.def 登记成快捷函数，之后一次调用；lib.help() 看全部。'
const LIB_REMAINDER = ' 其余用 lib.help()'
type LibDoc = { name: string; doc: string }
const descAppend = (entries: readonly LibDoc[]): string => {
  const base = SHORT_HELP + LIB_HINT
  if (entries.length === 0) return base
  const room = Math.max(0, DESC_APPEND_MAX - base.length)
  let listing = ' 全局库：'
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e === undefined) continue
    const piece = (i > 0 ? '；' : '') + e.name + (e.doc ? ' — ' + e.doc : '')
    const last = i === entries.length - 1
    const budget = last ? room : room - LIB_REMAINDER.length
    if (listing.length + piece.length <= budget) {
      listing += piece
      continue
    }
    const keep = Math.max(0, room - LIB_REMAINDER.length - listing.length)
    if (keep > 0) listing += piece.slice(0, keep)
    return base + listing + LIB_REMAINDER
  }
  return base + listing
}
/** The GLOBAL library's functions, read once when the tool is registered (the project one stays out of the prefix). */
const readLibDocs = async ($: unknown): Promise<LibDoc[]> => {
  try {
    let file = ''
    const custom = await ($ as { env: { get: (name: string) => Promise<string | undefined> } }).env.get('PTC_RUN_LIB')
    if (typeof custom === 'string' && custom.trim() !== '') file = custom.trim()
    else {
      const home = await homeOf($)
      if (home === undefined) return []
      file = home + '/.claude/ptc-run/lib.js'
    }
    const raw = await ($ as { fs: { read: (p: string) => Promise<string | { base64: string }> } }).fs.read(file)
    if (typeof raw !== 'string') return []
    const data = JSON.parse(raw) as { functions?: Record<string, { doc?: unknown }> }
    const fns = data.functions
    if (fns === null || typeof fns !== 'object') return []
    const out: LibDoc[] = []
    for (const name of Object.keys(fns)) {
      if (name === 'help' || name === 'def') continue
      const row = fns[name]
      out.push({ name, doc: row !== undefined && typeof row.doc === 'string' ? row.doc : '' })
    }
    return out
  } catch {
    return []
  }
}

const messageOf = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem))
/** A log that fails must never become the failure. */
const debug = ($: unknown, text: string): void => {
  try {
    ;($ as { ui: { log: (t: string, o: { to: string }) => void } }).ui.log('ptc-run: ' + text, { to: 'debug' })
  } catch {
    // logging is best effort
  }
}

/** The session's own settings: the plugin options, then the environment's switches. */
let cfg: PtcConfig = DEFAULTS
let nudgeState: NudgeState = newNudgeState()
/** The reminder the last main-session request earned, waiting for its batch to end. */
let pendingRemind: string | undefined

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Readonly<Record<string, unknown>>
  on('session.start', async ($, e, next) => {
    const sdkInPrompt = (await $.env.get('PTC_RUN_SDK_IN_PROMPT')) === '1'
    const ro = (await $.env.get('PTC_RUN_READONLY')) === '1'
    const roRoots = ro ? splitReadRoots((await $.env.get('PTC_RUN_READ_ROOTS')) || '') : []
    cfg = configOf(opts, await $.env.get('PTC_RUN_NUDGE'), await $.env.get('PTC_RUN_BASH_MAX'))
    nudgeState = newNudgeState()
    pendingRemind = undefined
    debug($, 'nudgeAfter=' + cfg.nudgeAfter + ' bashMaxChars=' + cfg.bashMaxChars)
    // The global library's function list, read once here, is appended to the description; the rest of the
    // description is untouched so the cache prefix every session shares stays what it was.
    const baseDesc = ro ? (sdkInPrompt ? descShortRo(roRoots) : descRo(roRoots)) : sdkInPrompt ? DESC_SHORT : DESC
    await $.tool.register({
      name: 'run_code',
      description: descAppend(await readLibDocs($)).trimStart() + ' ' + baseDesc,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '一句中文，说明这个程序要做什么（显示给用户看，写在 code 之前）。' },
          code: { type: 'string', description: 'Body of an async function; use return and console.log.' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000, description: '整个程序的超时毫秒数，默认 300000，最大 600000；程序内 bash 的 timeoutMs 不能超过它' },
          root: { type: 'string', description: '可选：已存在的绝对目录。设置后程序内的相对路径、grep/glob 的默认目录、未指定 cwd 的 bash 都以它为基准，程序里可用 tools.root 读取；不设置则沿用会话 cwd。' },
          maxChars: {
            type: 'integer',
            minimum: 1000,
            maximum: 50000,
            description: 'Output cap in chars (default 8000). Over it the first 70% and last 30% are kept, the middle is saved as a ref (ref.text(id,{from,to})), and a truncation hint is printed.',
          },
        },
        required: ['description', 'code'],
      },
    })
    return next(e)
  })

  // Compaction (also what ctx-mod's window switch uses) and /clear end the conversation view these records rest on.
  on('session.compact', async ($, e, next) => {
    dedupRuns.clear()
    return next(e)
  }).catch(($, e, next) => next(e))

  // A person's own message starts a new turn: the single-step count is per turn, so it starts over here.
  on('prompt.submit', async ($, e, next) => {
    resetNudge(nudgeState)
    pendingRemind = undefined
    return next(e)
  }).catch(($, e, next) => next(e))

  // Feature 1: one model request, after its answer is known. Only the main session is counted: a subagent's steps are
  // its own business. Nothing here can throw into the engine.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      if (e.agentId === undefined) {
        const remind = observeNudge(nudgeState, usesOfResult(result), cfg.nudgeAfter, String(e.turnId) + ':' + String(e.index))
        if (remind !== undefined) pendingRemind = remind
      }
    } catch (error) {
      debug($, 'turn.step: ' + messageOf(error))
    }
    return result
  })

  // The reminder rides on the batch that ends the request: one line of context, nothing refused.
  on('classic.PostToolBatch', async ($, e, next) => {
    const main = e.agent_id === undefined
    const inject = main ? pendingRemind : undefined
    if (main) pendingRemind = undefined
    const result = await next(e)
    if (inject === undefined) return result
    try {
      const held = (result ?? {}) as { additionalContext?: readonly string[] }
      const contexts = Array.isArray(held.additionalContext) ? held.additionalContext : []
      debug($, 'remind streak=' + nudgeState.streak)
      return { ...held, additionalContext: [...contexts, inject] }
    } catch (error) {
      debug($, 'PostToolBatch: ' + messageOf(error))
      return result
    }
  }).catch(($, e, next) => next(e))

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
    // Extra directories the read-only sandbox may read and search (delegate's readPaths), from the environment only.
    // The broker drops the ones that are missing or not absolute, so a stale entry never fails the run.
    const readRoots = ro ? splitReadRoots((await $.env.get('PTC_RUN_READ_ROOTS')) || '') : []
    let scope = 'default'
    // The session id also names the session-level library the runner loads. Without one there is none: the runner then
    // loads only the global library, and lib.def's default scope refuses with a hint to pass {scope:'global'}.
    let sessionId: string | undefined
    try {
      const sid = await $.session.id()
      if (typeof sid === 'string' && sid) {
        scope = sid
        sessionId = sid
      }
    } catch {
      // keep the default scope
    }
    // Read dedup: one record per session AND agent, so the main loop, every subagent and every delegate job (its own
    // session id) keep separate ones. dedupReset wipes the record when the earlier results are gone from the context.
    const dedupOn = ((await $.env.get('PTC_RUN_READ_DEDUP')) || '').trim() !== '0'
    const dedupTag = agentId ? 'agent-' + String(agentId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48) : 'main'
    const dedupKey = scope + '|' + dedupTag
    let dedupLive = false
    if (dedupOn) {
      const prev = dedupRuns.get(dedupKey)
      if (prev && prev.ids.length > 0 && !prev.cut) {
        try {
          const messages = agentId === undefined
            ? await $.session.messages({ as: 'api' })
            : await $.session.messages({ as: 'api', agentId } as never)
          dedupLive = dedupStillLive(messages, prev.ids)
        } catch {
          dedupLive = false
        }
      }
    }
    /** Records this call's own result as the newest thing the model has seen (its content backs the next dedup). */
    const noteDedup = (text: string) => {
      if (!dedupOn) return
      const id = (e as unknown as { tool_use_id?: string }).tool_use_id
      if (typeof id !== 'string' || id === '') {
        dedupRuns.delete(dedupKey) // no id: nothing to check the next call against -> start over
        return
      }
      const cur = dedupRuns.get(dedupKey)
      const ids = cur && !cur.cut ? cur.ids : []
      const next = [...ids, { id, probe: dedupProbe(text) }]
      // Dropping the oldest ids would make the next liveness check blind to them: cut the record and start over.
      dedupRuns.set(dedupKey, next.length > DEDUP_MAX_IDS ? { ids: [], cut: true } : { ids: next, cut: false })
    }
    const timeoutMs = Math.min(Math.max(Math.trunc(input.timeoutMs ?? 300000), 1000), 600000)
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
    // The host caps process.run (600 s as of 2.1.319) and rejects a larger timeout at once; only an
    // error that came near the deadline is a timeout, anything sooner is reported as itself.
    let startedAt = Date.now()
    try {
      // ripgrep lives in this mod's own directory: the engine hands it over as `$.plugin.root` (a property,
      // absolute). A host without that field (or an unusual root) simply omits the field below, and the runner/broker
      // fall back to PTC_RUN_RG, the installed skills path and PATH -- the generated hook never bakes a path in.
      const pluginRoot = $.plugin.root
      const bundledRg = typeof pluginRoot === 'string' && pluginRoot !== '' ? pluginRoot.replace(/[\\/]+$/, '') + '/bin/rg.exe' : undefined
      const payload = { cwd, code: input.code, ...(bundledRg ? { rg: bundledRg } : {}), scope, sessionId, dsh, root: input.root, roRoots, readRoots, logName, dshReadLimit, dedup: dedupOn, dedupTag, dedupReset: !dedupLive, maxChars: input.maxChars ? Math.min(Math.max(Math.trunc(input.maxChars), 1000), 50000) : dsh ? 50000 : undefined }
      startedAt = Date.now()
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
        const partialTextOut = partialText(partial) + extra
        noteDedup(partialTextOut)
        return { result: [{ type: 'text', text: partialTextOut }], isError: true } as never
      }
      const text = (r.stdout || '') + (r.stderr ? '\n[stderr] ' + r.stderr.slice(0, 2000) : '')
      noteDedup(text)
      return { result: [{ type: 'text', text }], isError: r.exitCode !== 0 } as never
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      // The host reports its own timeout as e.g. "$.process.run(node) aborted: still running after 4000ms".
      const killed = Date.now() - startedAt >= timeoutMs * 0.9 && /time(d)?[ -]?out|timeout|killed|exceed|abort|still running/i.test(msg)
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

  // Feature 3: a Bash result over the cap keeps head (60%) and tail (30%); the middle becomes one marker naming the
  // file with the whole text, under ~/.claude/ptc-run/overflow/. Main session and subagents alike. Any failure leaves
  // the result exactly as it was.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (!(cfg.bashMaxChars > 0)) return r
      if (r.deny !== undefined || r.isError === true) return r
      const res = r.result as Record<string, unknown> | null
      if (res === null || typeof res !== 'object') return r
      if (res['isImage'] === true || res['interrupted'] === true) return r
      if (res['persistedOutputPath'] !== undefined || res['rawOutputPath'] !== undefined) return r
      const out = typeof res['stdout'] === 'string' ? res['stdout'] : ''
      const err = typeof res['stderr'] === 'string' ? res['stderr'] : ''
      const text = out + (err !== '' ? (out !== '' && !out.endsWith('\n') ? '\n' : '') + err : '')
      const clip = bashClip(text, cfg.bashMaxChars)
      if (clip === undefined) return r
      const where = await writeOverflow($, text)
      if (where === undefined) {
        debug($, 'bash overflow: no home directory, the result was left alone')
        return r
      }
      debug($, 'bash overflow: ' + text.length + ' chars -> ' + where)
      // Only the result, never the object the hook got: `ref`/`text` on that one would make core reuse the messages
      // it already made, and the model would read the untruncated text (read-dedup answers the same way).
      return { result: { ...res, stdout: clip.head + clipMarker(clip.omitted, where) + clip.tail, stderr: '' }, context: r.context } as typeof r
    } catch (error) {
      debug($, 'tool.call Bash: ' + messageOf(error))
      return r
    }
  }).catch(($, e, next) => next(e))
}

// What the tests drive directly: the hooks need an engine, these do not.
export const __test = {
  configOf,
  newNudgeState,
  observeNudge,
  resetNudge,
  nudgeText,
  usesOfResult,
  bashClip,
  clipMarker,
  descAppend,
  DEFAULTS,
  SHORT_HELP,
  LIB_HINT,
  LIB_REMAINDER,
  DESC_APPEND_MAX,
}
