'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{once}=require('node:events');
const {WebStore}=require('../lib/web-store.cjs');
const {createAdmin}=require('../lib/admin.cjs');
const {createGateway}=require('../lib/server.cjs');
const {AccountPool}=require('../lib/account-pool.cjs');
const fakeSession={access_token:'fixture-access',refresh_token:'fixture-refresh',expiresAt:Date.now()+7200000};
const fixtureUsage={prompt_tokens:4,completion_tokens:7,total_tokens:11};
function fakeWorker(a,persist){
 return {ready:false,dead:false,state(){return {ready:this.ready,connected:true}},async call(op,args){
  if(op==='login'){assert.equal(args.password,'fixture-password');persist({...fakeSession});this.ready=true;return {ready:true}}
  if(op==='generate')return {text:'fixture answer',usage:fixtureUsage};
  throw Error('unexpected operation');
 },async ensure(){this.ready=true;return {ready:true}},async *stream(){yield{text:'fixture '};yield{text:'answer'};yield{finish:'stop',usage:fixtureUsage}},async close(){this.dead=true}};
}
async function fixture(fn){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cbg-webui-test-')),store=new WebStore(root),pool=new AccountPool(store,{make:fakeWorker});
 let admin;
 const server=createGateway({resolveKey:raw=>{const r=store.resolveKey(raw);if(!r)return null;const w=pool.get(r.account);return{auth:w,adapter:{generate:i=>w.call('generate',{input:i}),stream:(i,s)=>w.stream(i,s)},accountId:r.account.id,keyId:r.key.id}},handleAdmin:(...a)=>admin(...a),getModels:()=>store.enabledModels(),getHealth:()=>({status:'ready'}),log:e=>store.record(e)});
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
 admin=createAdmin({store,pool,port});
 const base='http://127.0.0.1:'+port;
 const request=(p,b,k=store.data.adminKey,other={})=>fetch(base+p,{headers:{Authorization:'Bearer '+k,...(b===undefined?{}:{'Content-Type':'application/json'}),...other},...(b===undefined?{}:{method:'POST',body:JSON.stringify(b)})});
 try{await fn({store,pool,base,request,port})}finally{await pool.closeAll();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})}
}
const account={name:'Fixture account',env:'test-env',region:'ap-shanghai',publishableKey:'fixture-publishable',username:'tester',password:'fixture-password'};
test('admin key isolation, localhost host validation, CSP, no credentials in overview',()=>fixture(async({request,store,base})=>{
 assert.equal((await request('/admin/api/overview',undefined,'wrong')).status,401);
 assert.equal((await request('/admin/api/overview',undefined,store.data.adminKey,{Origin:'https://other.invalid'})).status,403);
 const page=await fetch(base+'/');assert.match(await page.text(),/CloudBase Gateway/);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 const r=await request('/admin/api/overview');assert.equal(r.status,200);assert.ok(!(await r.text()).includes(store.data.adminKey));
}));
test('add account, bind key, route completion, persist metrics and redact session',()=>fixture(async({request,store})=>{
 const r=await request('/admin/api/accounts/add',account);assert.equal(r.status,201);const a=await r.json();
 assert.ok(a.hasSession);assert.ok(!a.session);assert.ok(!a.password);assert.ok(!fs.readFileSync(store.file,'utf8').includes(account.password));
 const k=await(await request('/admin/api/keys/create',{name:'fixture',accountId:a.id})).json();assert.ok(k.key);assert.ok(!fs.readFileSync(store.file,'utf8').includes(k.key));
 const response=await request('/v1/chat/completions',{model:'hy3',messages:[{role:'user',content:'fixture'}]},k.key);
 assert.equal(response.status,200);assert.equal((await response.json()).choices[0].message.content,'fixture answer');
 const data=await(await request('/admin/api/overview')).json();assert.equal(data.totals.requests,1);assert.equal(data.totals.input,4);assert.equal(data.keys[0].tokens,11);assert.ok(!JSON.stringify(data).includes('fixture-refresh'));
 assert.equal(fs.statSync(store.file).mode&0o777,0o600);
 const again=new WebStore(store.root);assert.equal(again.data.totals.requests,1);
}));
test('SSE accounting, model switches, disable account and remove keys',()=>fixture(async({request,store})=>{
 const a=await(await request('/admin/api/accounts/add',account)).json();
 const k=await(await request('/admin/api/keys/create',{name:'fixture',accountId:a.id})).json();
 const body={model:'hy3',messages:[{role:'user',content:'fixture'}],stream:true,stream_options:{include_usage:true}};
 const r=await request('/v1/chat/completions',body,k.key);assert.equal(r.status,200);assert.match(await r.text(),/\[DONE\]/);assert.equal(store.data.totals.output,7);
 assert.equal((await request('/admin/api/models/toggle',{id:'hy3',enabled:false})).status,200);
 assert.equal((await request('/v1/chat/completions',body,k.key)).status,400);
 const list=await(await request('/v1/models',undefined,k.key)).json();assert.ok(!list.data.some(m=>m.id==='hy3'));
 await request('/admin/api/accounts/toggle',{id:a.id,enabled:false});assert.equal((await request('/v1/models',undefined,k.key)).status,401);
 await request('/admin/api/accounts/remove',{id:a.id});assert.equal(store.data.accounts.length,0);assert.equal(store.data.keys.length,0);
}));
test('admin mutation validation and independent management credentials',()=>fixture(async({request,store})=>{
 const a=await(await request('/admin/api/accounts/add',account)).json();
 const k=await(await request('/admin/api/keys/create',{name:'fixture',accountId:a.id})).json();
 assert.equal((await request('/admin/api/overview',undefined,k.key)).status,401);
 assert.equal((await request('/v1/models',undefined,store.data.adminKey)).status,401);
 assert.equal((await request('/admin/api/settings',{maxConcurrent:100})).status,400);
 assert.equal((await request('/admin/api/settings',{maxConcurrent:2})).status,200);
 assert.equal(store.data.settings.maxConcurrent,2);
 assert.equal((await request('/admin/api/accounts/add',account)).status,400);
}));

test('real account worker initializes SDK and isolates local session state without network',async()=>{
 const {AccountWorker}=require('../lib/account-pool.cjs');
 const a=new AccountWorker({env:'offline-test-env',region:'ap-shanghai',publishableKey:'offline-fixture'},()=>{throw Error('Unexpected session')});
 const b=new AccountWorker({env:'offline-test-env',region:'ap-shanghai',publishableKey:'offline-fixture'},()=>{throw Error('Unexpected session')});
 try{
  assert.notEqual(a.worker.threadId,b.worker.threadId);
  await assert.rejects(a.ensure(),e=>e.code==='login_required');
  await assert.rejects(b.ensure(),e=>e.code==='login_required');
  assert.equal(a.ready,false);assert.equal(b.ready,false);
 }finally{await Promise.all([a.close(),b.close()])}
});
