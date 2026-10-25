import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'delegate-cpa-test-'))
const keyFile=path.join(dir,'mgmt.key');fs.writeFileSync(keyFile,'fake-management-secret')
const state={'openai-compatibility':[{name:'other',prefix:'other','base-url':'https://other.example/v1',keys:[{'api-key':'fake-other-secret'}],models:[{name:'old',alias:'old'}]}],codex:[],claude:[]}
const writes=[];const upstream=[]
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');res.setHeader('Content-Type','application/json')
 if(url.pathname==='/health') return res.end('{}')
 if(url.pathname==='/v1/models') {upstream.push(req.headers);return res.end(JSON.stringify({data:[{id:'m1'},{id:'m2'},{id:'m1'}]}))}
 assert.equal(req.headers.authorization,'Bearer fake-management-secret')
 const family=url.pathname.split('/').at(-1)
 if(url.pathname.startsWith('/v8/management/config/api-keys/')) {
   res.setHeader('ETag','"version"')
   if(req.method==='GET') return res.end(JSON.stringify(state[family]))
   assert.equal(req.headers['if-match'],'"version"')
   let s='';for await(const c of req)s+=c
   state[family]=JSON.parse(s);writes.push({family,body:state[family]});return res.end('{"status":"ok"}')
 }
 if(url.pathname.endsWith('/credentials')) return res.end(JSON.stringify({files:[{name:'codex-one',provider:'codex',disabled:false,email:'test@example.test',access_token:'fake-oauth-token'},{name:'claude-other',provider:'claude'}]}))
 if(url.pathname.endsWith('/oauth/auth-url'))return res.end(JSON.stringify({url:'https://example.test/authorize',state:'fake-state'}))
 if(url.pathname.endsWith('/oauth/status'))return res.end('{"status":"wait"}')
 if(url.pathname.endsWith('/oauth/session')&&req.method==='DELETE')return res.end('{"status":"ok"}')
 res.statusCode=404;res.end('{}')
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const base='http://127.0.0.1:'+server.address().port
process.env.DELEGATE_CPA_BASE=base;process.env.DELEGATE_CPA_MGMT_KEY_FILE=keyFile
const {execute}=await import('../scripts/cpa-admin.mjs')
try {
 await test('CPA save preserves unrelated groups and declares all thinking levels',async()=>{
  await execute('save',{id:'sample',name:'Sample',protocol:'chat',baseUrl:base+'/v1',key:'fake-upstream-secret',models:['m1']})
  assert.equal(state['openai-compatibility'][0].name,'other')
  const g=state['openai-compatibility'][1]
  assert.equal(g.prefix,'sample');assert.deepEqual(g.models[0].thinking.levels,['low','medium','high','xhigh','max'])
 })
 await test('metadata view never exposes keys and empty key omission preserves keys',async()=>{
  await execute('save',{id:'sample',protocol:'chat',baseUrl:base+'/v1',models:['m1','m2']})
  const r=await execute('providers');assert.ok(!JSON.stringify(r).includes('fake-upstream-secret'));assert.ok(!JSON.stringify(r).includes('fake-other-secret'))
  assert.equal(r.providers.find(x=>x.id==='sample').keyMask,'已设置（••••）')
  assert.equal(state['openai-compatibility'][1].keys[0]['api-key'],'fake-upstream-secret')
 })
 await test('fetch-models returns choices without adding them',async()=>{
  const before=JSON.stringify(state);const r=await execute('fetch-models',{id:'sample'})
  assert.deepEqual(r.models,['m1','m2']);assert.equal(JSON.stringify(state),before)
  assert.equal(upstream.at(-1).authorization,'Bearer fake-upstream-secret')
 })
 await test('protocol changes retain key and remove only the original group',async()=>{
  await execute('save',{id:'sample',protocol:'responses',baseUrl:base+'/v1',models:['m2']})
  assert.deepEqual(state['openai-compatibility'].map(x=>x.name),['other']);assert.equal(state.codex[0].keys[0]['api-key'],'fake-upstream-secret')
  await execute('save',{id:'sample',protocol:'anthropic',baseUrl:base,models:['m2'],isCompat:true})
  assert.equal(state.codex.length,0);assert.equal(state.claude[0].models[0]['is-compat'],true)
  await execute('fetch-models',{id:'sample'});assert.equal(upstream.at(-1)['x-api-key'],'fake-upstream-secret');assert.equal(upstream.at(-1)['anthropic-version'],'2023-06-01')
 })
 await test('delete reads and writes just the matching family',async()=>{
  const count=writes.length;await execute('delete',{id:'sample'});assert.equal(state.claude.length,0);assert.equal(writes.length,count+1);assert.equal(state['openai-compatibility'].length,1)
 })
 await test('accounts are sanitized and OAuth sessions can be cancelled without switching accounts',async()=>{
  const r=await execute('gpt-accounts');assert.equal(r.accounts.length,1);assert.ok(!JSON.stringify(r).includes('fake-oauth-token'))
  const login=await execute('gpt-login-start');assert.ok(login.url);assert.equal((await execute('gpt-login-status',{state:login.state})).status,'wait');assert.ok((await execute('gpt-login-cancel',{state:login.state})).ok)
 })
 await test('invalid save input never mutates arrays',async()=>{
  const before=JSON.stringify(state);await assert.rejects(()=>execute('save',{id:'bad/id',protocol:'chat',baseUrl:base,models:[]}));assert.equal(JSON.stringify(state),before)
 })
 await test('CLI emits safe JSON for malformed stdin without echoing input',async()=>{
  const c=spawn(process.execPath,['scripts/cpa-admin.mjs','save'],{stdio:['pipe','pipe','pipe']});let out='';c.stdout.on('data',d=>out+=d);c.stderr.resume();c.stdin.end('{"key":"do-not-echo-this-secret"');const code=await new Promise(r=>c.on('close',r));assert.equal(code,1);assert.equal(JSON.parse(out).ok,false);assert.ok(!out.includes('do-not-echo-this-secret'))
 })
} finally { await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true}) }
