// CPA administration. Secrets enter via stdin only; stdout is always sanitized JSON.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const home = os.homedir()
const base = process.env.DELEGATE_CPA_BASE || 'http://127.0.0.1:8317'
const families = { chat: 'openai-compatibility', responses: 'codex', anthropic: 'claude' }
const secrets = []
const scrub = value => {
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/token|secret|api.key/i.test(k)).map(([k,v]) => [k,scrub(v)]))
  if (typeof value === 'string') for (const s of secrets) if(s) value = value.split(s).join('[REDACTED]')
  return value
}
let ready
async function ensure() {
  if (!ready) ready = (async () => {
    try { await fetch(base + '/health', { signal: AbortSignal.timeout(1500) }); return } catch {}
    const r = spawnSync(process.env.DELEGATE_CPA_PYTHON || 'python', ['-I', process.env.DELEGATE_CPA_ENSURE || path.join(home,'tools','cliproxyapi','ensure_cpa.py'),'--print-env'], {encoding:'utf8',windowsHide:true,timeout:90000})
    if (r.error || r.status !== 0) throw new Error('CPA 启动失败；请检查本机 CPA 日志')
  })()
  await ready
}
async function request(route, method='GET', body, etag) {
  await ensure()
  const key = fs.readFileSync(process.env.DELEGATE_CPA_MGMT_KEY_FILE || path.join(home,'.claude','delegate','cpa-mgmt.key'),'utf8').trim()
  secrets.push(key)
  const r = await fetch(base+'/v8/management'+route,{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',...(etag?{'If-Match':etag}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)})
  if (!r.ok) { const e=new Error('CPA '+method+' '+route.split('?')[0]+' HTTP '+r.status); e.status=r.status; throw e }
  const t=await r.text()
  return {data:t?JSON.parse(t):{},etag:r.headers.get('etag')}
}
async function family(protocol) {
  try { const r=await request('/config/api-keys/'+families[protocol]); return {...r,data:Array.isArray(r.data)?r.data:[]} }
  catch(e) { if(e.status===404) return {data:[],etag:undefined}; throw e }
}
async function groups() {
  return (await Promise.all(Object.keys(families).map(async protocol => (await family(protocol)).data.map(group=>({protocol,group}))))).flat()
}
const view = ({protocol,group:g}) => ({id:g.name || g.prefix,name:g.name || g.prefix,prefix:g.prefix || g.name,protocol,baseUrl:g['base-url']||'',keyMask:g.keys?.some(k=>k['api-key'])?'已设置（••••）':'未设置',models:(g.models||[]).map(m=>m.name)})
// A file lock serializes delegate writers; If-Match also detects external edits.
async function locked(fn) {
 const lock=path.join(home,'.claude','delegate','cpa-admin.lock'); let fd
 try { fd=fs.openSync(lock,'wx') } catch { throw new Error('另一个 CPA 写入正在执行；请稍后重试（崩溃后可移除 cpa-admin.lock）') }
 try { return await fn() } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}
async function replace(protocol, transform) {
 const r=await family(protocol)
 const arr=transform(r.data)
 await request('/config/api-keys/'+families[protocol],'PUT',arr,r.etag)
}
export async function execute(command, input={}, arg='') {
 if(input.key) secrets.push(input.key)
 if(command==='providers') return {ok:true,providers:(await groups()).map(view)}
 // chat 协议的新模型默认 is-compat：不开时 CPA 会丢掉客户端回传的空签名 thinking，模型看不到自己的历史推理。
 if(command==='save') return locked(async()=>{
   const {id,name=id,protocol,baseUrl}=input
   if(!/^[a-zA-Z0-9_-]+$/.test(id||'') || !String(name).trim() || !families[protocol]) throw new Error('无效的 id / 名称 / 协议')
   const u=new URL(baseUrl); if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash) throw new Error('无效的 base-url')
   if(!Array.isArray(input.models)||input.models.some(m=>typeof m!=='string'||!m.trim())) throw new Error('models 必须是模型 ID 数组')
   const all=await groups(); const old=all.find(x=>x.group.name===id || x.group.prefix===id)
   const g={...(old?.group||{}),name:id,prefix:id,'base-url':baseUrl.replace(/\/$/,''),keys:input.key===undefined?old?.group.keys||[]:[{'api-key':input.key}],models:[...new Set(input.models)].map(m=>{const prev=old?.group.models?.find(x=>x.name===m);return {...prev,name:m,alias:m,thinking:{levels:['low','medium','high','xhigh','max']},...(input.isCompat!==undefined?{'is-compat':!!input.isCompat}:protocol==='chat'&&prev?.['is-compat']===undefined?{'is-compat':true}:{})}})}
   if(!g.keys.some(k=>k['api-key'])) throw new Error('新增供应商需要 key')
   await replace(protocol, arr=>[...arr.filter(x=>x.name!==id && x.prefix!==id),g])
   if(old && old.protocol!==protocol) { try { await replace(old.protocol,arr=>arr.filter(x=>x.name!==id && x.prefix!==id)) } catch { throw new Error('新协议已保存，旧协议删除失败；请刷新并重试') } }
   return {ok:true,provider:{...view({protocol,group:g}),name}}
 })
 if(command==='delete') return locked(async()=>{const id=input.id||arg;const all=await groups();for(const protocol of new Set(all.filter(x=>x.group.name===id||x.group.prefix===id).map(x=>x.protocol))) await replace(protocol,a=>a.filter(x=>x.name!==id&&x.prefix!==id));return {ok:true}})
 if(command==='fetch-models') {
   const found=(await groups()).find(x=>x.group.name===(input.id||arg)||x.group.prefix===(input.id||arg)); if(!found) throw new Error('没有这个供应商')
   const {protocol,group:g}=found;const key=g.keys?.find(k=>k['api-key'])?.['api-key'];if(!key) throw new Error('供应商没有 key');secrets.push(key)
   const r=await fetch(g['base-url'].replace(/\/$/,'')+(protocol==='anthropic'?'/v1/models':'/models'),{headers:protocol==='anthropic'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(30000)})
   if(!r.ok) throw new Error('上游模型列表 HTTP '+r.status)
   const data=await r.json();return {ok:true,models:[...new Set((data.data||data.models||[]).map(m=>typeof m==='string'?m:m.id).filter(x=>typeof x==='string'))]}
 }
 // new-api 风格的用量接口：GET {base-url}/dashboard/billing/usage，Bearer key，{total_usage} 单位是美分。
 // key 只在脚本内部读取并使用，返回值里只有金额。
 if(command==='gpt-usage') {
   const found=(await groups()).find(x=>x.group.name===(input.id||arg)||x.group.prefix===(input.id||arg)); if(!found) throw new Error('没有这个供应商')
   const key=found.group.keys?.find(k=>k['api-key'])?.['api-key']; if(!key) throw new Error('供应商没有 key')
   secrets.push(key)
   const baseUrl=String(found.group['base-url']||'').replace(/\/$/,''); if(!baseUrl) throw new Error('供应商没有 base-url')
   const r=await fetch(baseUrl+'/dashboard/billing/usage',{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(15000)})
   if(!r.ok) throw new Error('用量接口 HTTP '+r.status)
   const data=await r.json();const total=Number(data?.total_usage)
   if(!Number.isFinite(total)) throw new Error('用量接口没有 total_usage')
   return {ok:true,usedCents:Math.round(total*100)/100}
 }
 if(command==='gpt-login-start') return {ok:true,...(await request('/oauth/auth-url?provider=codex')).data}
 if(command==='gpt-login-status') return {ok:true,...(await request('/oauth/status?state='+encodeURIComponent(input.state||arg))).data}
 if(command==='gpt-login-cancel') return {ok:true,...(await request('/oauth/session?state='+encodeURIComponent(input.state||arg),'DELETE')).data}
 if(command==='gpt-accounts'||command==='gpt-use') {
   const d=(await request('/credentials')).data
   const accounts=(Array.isArray(d)?d:d.files||d.credentials||[]).filter(a=>a.provider==='codex'||a.type==='codex')
   if(command==='gpt-accounts') return {ok:true,accounts:accounts.map(a=>({name:a.name,email:a.email,disabled:a.disabled,status:a.status}))}
   const target=accounts.find(a=>a.name===(input.name||arg));if(!target) throw new Error('没有这个 Codex 账号')
   // Enable target first: a failure must never leave all accounts disabled.
   await request('/credentials/status','PATCH',{name:target.name,disabled:false})
   for(const a of accounts) if(a.name!==target.name&&!a.disabled) await request('/credentials/status','PATCH',{name:a.name,disabled:true})
   return {ok:true}
 }
 throw new Error('未知子命令')
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 let s='';for await(const chunk of process.stdin) s+=chunk
 let input
 try { input=s.trim()?JSON.parse(s):{} } catch { console.log(JSON.stringify({ok:false,error:'stdin 必须是有效 JSON'}));process.exit(1) }
 try { const result=await execute(process.argv[2],input,process.argv[3]); console.log(JSON.stringify(scrub(result))) }
 catch(e) { console.log(JSON.stringify({ok:false,error:scrub(e.message)}));process.exitCode=1 }
}
