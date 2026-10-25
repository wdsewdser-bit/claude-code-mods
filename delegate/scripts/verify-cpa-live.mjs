// Explicit local verification; never called by hooks. No secrets on stdout.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { execute } from './cpa-admin.mjs'
const home=os.homedir()
const mode=process.argv[2]
if(mode==='oauth') {
 const r=await execute('gpt-login-start')
 try {console.log(JSON.stringify({ok:!!r.url&&!!r.state,urlReceived:typeof r.url==='string',stateReceived:!!r.state}))}
 finally {await execute('gpt-login-cancel',{state:r.state});console.log(JSON.stringify({cancelled:true}))}
} else if(mode==='run') {
 const effort=process.argv[3]||undefined
 const jobId='cpa-verify-'+(effort||'work')+'-'+Date.now()
 const job={jobId,model:process.env.VERIFY_MODEL||'workbuddy/deepseek-v4.1-flash',task:effort?'Reply with exactly OK. Do not use tools.':'Read hooks/lib/config.ts using run_code and tools.read. Then in a SECOND SEPARATE run_code tool call read types/index.d.ts. Finally answer in one short Chinese sentence describing these two files. Do not modify any files.',cwd:process.cwd(),mode:'work',stream:true,effort,maxTurns:8,timeoutMs:180000}
 const child=spawn(process.execPath,['scripts/run-delegate.mjs'],{stdio:['pipe','pipe','pipe'],windowsHide:true})
 child.stdin.end(JSON.stringify(job));let out='';child.stdout.on('data',d=>out+=d);child.stderr.resume()
 const exitCode=await new Promise(r=>child.on('close',r))
 let result;try{result=JSON.parse(out.trim().split('\n').at(-1))}catch{result={ok:false,error:'No JSON'}}
 const eventFile=path.join(home,'.claude/delegate/jobs',jobId,'events.jsonl')
 const events=fs.existsSync(eventFile)?fs.readFileSync(eventFile,'utf8').split('\n').filter(Boolean).flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}}):[]
 const tools=events.filter(e=>e.type==='assistant').flatMap(e=>(e.message?.content||[]).filter(b=>b.type==='tool_use').map(b=>b.name))
 const messageUsage=events.filter(e=>e.type==='assistant').map(e=>e.message?.usage)
 console.log(JSON.stringify({exitCode,jobId,result,toolCalls:tools,streamUsage:messageUsage}))
 if(!result.ok) process.exitCode=1
} else throw new Error('oauth | run [max|off]')