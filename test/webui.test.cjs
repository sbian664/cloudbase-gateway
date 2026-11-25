'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{once}=require('node:events');
const {WebStore}=require('../lib/web-store.cjs');
const {ScfPool}=require('../lib/scf-adapter.cjs');
const {WxBridge}=require('../lib/wx-bridge.cjs');
const {createAdmin}=require('../lib/admin.cjs');
const {createGateway}=require('../lib/server.cjs');

const fixtureUsage={prompt_tokens:4,completion_tokens:7,total_tokens:11};
const scfToken='scf-bridge-secret-token-123456';

async function startFakeScf(){
 let activeToken=scfToken;
 const srv=http.createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/healthz'){
   res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify({status:'ok',env:'test-env',models:['hy3','hy4','hy4-flash']}));
   return;
  }
  if(req.headers.authorization!=='Bearer '+activeToken){
   res.writeHead(401,{'content-type':'application/json'});
   res.end(JSON.stringify({error:{message:'Unauthorized',code:'invalid_api_key'}}));
   return;
  }
  const chunks=[];for await(const c of req)chunks.push(c);
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(body.stream){
   res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8'});
   res.write('data: '+JSON.stringify({choices:[{delta:{content:'fixture '}}]})+'\n\n');
   res.write('data: '+JSON.stringify({choices:[{delta:{content:'answer'},finish_reason:'stop'}],usage:fixtureUsage})+'\n\n');
   res.end('data: [DONE]\n\n');
  }else{
   res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify({choices:[{index:0,message:{role:'assistant',content:'fixture answer'},finish_reason:'stop'}],usage:fixtureUsage}));
  }
 });
 srv.listen(0,'127.0.0.1');await once(srv,'listening');
 return {
  url:'http://127.0.0.1:'+srv.address().port,
  setToken(t){activeToken=t},
  close:async()=>{srv.closeAllConnections();await new Promise(r=>srv.close(r))}
 };
}

async function fixture(fn){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cbg-webui-test-'));
 const store=new WebStore(root),scf=new ScfPool(),bridge=new WxBridge({store,heartbeatMs:60000,staleMs:120000});
 const upstream=await startFakeScf();
 let admin;
 const server=createGateway({
  resolveKey(raw){
   const r=store.resolveKey(raw);if(!r)return null;
   if(r.account.method==='scf_node_sdk')return scf.route(r.account,r.key.id);
   if(r.account.method==='wx_miniprogram')return bridge.route(r.account,r.key.id);
   return null;
  },
  handleAdmin:(...a)=>admin(...a),
  getModels:()=>store.enabledModels(),
  getHealth:()=>({status:'ready'}),
  log:e=>store.record(e)
 });
 bridge.attach(server);
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
 admin=createAdmin({store,scf,bridge,port});
 const base='http://127.0.0.1:'+port;
 const request=(p,b,k=store.data.adminKey,other={})=>fetch(base+p,{headers:{Authorization:'Bearer '+k,...(b===undefined?{}:{'Content-Type':'application/json'}),...other},...(b===undefined?{}:{method:'POST',body:JSON.stringify(b)})});
 const account={method:'scf_node_sdk',name:'Fixture SCF',env:'test-env',region:'ap-shanghai',endpoint:upstream.url,scfToken};
 try{await fn({store,scf,bridge,upstream,account,base,request,port})}
 finally{bridge.closeAll();await upstream.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})}
}

test('admin key isolation, localhost host validation, CSP, no credentials in overview',()=>fixture(async({request,store,base})=>{
 assert.equal((await request('/admin/api/overview',undefined,'wrong')).status,401);
 assert.equal((await request('/admin/api/overview',undefined,store.data.adminKey,{Origin:'https://other.invalid'})).status,403);
 const page=await fetch(base+'/');assert.match(await page.text(),/CloudBase/);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 const r=await request('/admin/api/overview');assert.equal(r.status,200);
 const text=await r.text();
 assert.ok(!text.includes(store.data.adminKey));
 const json=JSON.parse(text);
 assert.deepEqual(json.loginMethods.map(m=>m.id),['scf_node_sdk','wx_miniprogram']);
}));

test('add SCF account, bind key, route completion, persist metrics and redact secrets',()=>fixture(async({request,store,account})=>{
 const r=await request('/admin/api/accounts/add',account);assert.equal(r.status,201);const a=await r.json();
 assert.equal(a.channel,'cloudbase-scf-node-sdk');assert.ok(!a.scfToken);assert.equal(a.runtime.ready,true);
 const k=await(await request('/admin/api/keys/create',{name:'fixture',accountId:a.id})).json();assert.ok(k.key);assert.ok(!fs.readFileSync(store.file,'utf8').includes(k.key));
 const response=await request('/v1/chat/completions',{model:'hy4',messages:[{role:'user',content:'fixture'}]},k.key);
 assert.equal(response.status,200);assert.equal((await response.json()).choices[0].message.content,'fixture answer');
 const data=await(await request('/admin/api/overview')).json();assert.equal(data.totals.requests,1);assert.equal(data.totals.input,4);assert.equal(data.keys[0].tokens,11);assert.ok(!JSON.stringify(data).includes(scfToken));
 assert.equal(fs.statSync(store.file).mode&0o777,0o600);
 const again=new WebStore(store.root);assert.equal(again.data.totals.requests,1);
}));

test('SSE accounting, model switches, disable account and remove keys',()=>fixture(async({request,store,account})=>{
 const a=await(await request('/admin/api/accounts/add',account)).json();
 const k=await(await request('/admin/api/keys/create',{name:'fixture',accountId:a.id})).json();
 const body={model:'hy4',messages:[{role:'user',content:'fixture'}],stream:true,stream_options:{include_usage:true}};
 const r=await request('/v1/chat/completions',body,k.key);assert.equal(r.status,200);assert.match(await r.text(),/\[DONE\]/);assert.equal(store.data.totals.output,7);
 assert.equal((await request('/admin/api/models/toggle',{id:'hy4',enabled:false})).status,200);
 assert.equal((await request('/v1/chat/completions',body,k.key)).status,400);
 const list=await(await request('/v1/models',undefined,k.key)).json();assert.ok(!list.data.some(m=>m.id==='hy4'));
 await request('/admin/api/accounts/toggle',{id:a.id,enabled:false});assert.equal((await request('/v1/models',undefined,k.key)).status,401);
 await request('/admin/api/accounts/remove',{id:a.id});assert.equal(store.data.accounts.length,0);assert.equal(store.data.keys.length,0);
}));

test('admin mutation validation, rejects legacy web sdk methods, independent credentials',()=>fixture(async({request,store,account})=>{
 assert.equal((await request('/admin/api/accounts/add',{method:'password',name:'old',env:'e',region:'ap-shanghai',publishableKey:'k',username:'u',password:'p'})).status,400);
 const a=await(await request('/admin/api/accounts/add',account)).json();
 const k=await(await request('/admin/api/keys/create',{name:'fixture',accountId:a.id})).json();
 assert.equal((await request('/admin/api/overview',undefined,k.key)).status,401);
 assert.equal((await request('/v1/models',undefined,store.data.adminKey)).status,401);
 assert.equal((await request('/admin/api/settings',{maxConcurrent:100})).status,400);
 assert.equal((await request('/admin/api/settings',{maxConcurrent:2})).status,200);
 assert.equal(store.data.settings.maxConcurrent,2);
 assert.equal((await request('/admin/api/accounts/add',account)).status,400);
}));

test('update-scf rotates endpoint/token without replacing bound API keys',()=>fixture(async({request,store,upstream,account})=>{
 const a=await(await request('/admin/api/accounts/add',account)).json();
 const key=await(await request('/admin/api/keys/create',{name:'fixture',accountId:a.id})).json();
 upstream.setToken('rotated-token-999');
 const failed=await request('/v1/chat/completions',{model:'hy4',messages:[{role:'user',content:'hi'}]},key.key);
 assert.equal(failed.status,502);
 assert.equal((await failed.json()).error.code,'scf_unauthorized');
 const upd=await request('/admin/api/accounts/update-scf',{id:a.id,endpoint:upstream.url+'/v1',scfToken:'rotated-token-999'});
 assert.equal(upd.status,200);
 assert.equal(store.data.keys.length,1);assert.equal(store.data.keys[0].id,key.id);
 const ok=await request('/v1/chat/completions',{model:'hy4',messages:[{role:'user',content:'hi'}]},key.key);
 assert.equal(ok.status,200);
}));
