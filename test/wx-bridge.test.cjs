'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{once}=require('node:events');
const {WebStore}=require('../lib/web-store.cjs');
const {WxBridge}=require('../lib/wx-bridge.cjs');
const {createAdmin}=require('../lib/admin.cjs');
const {createGateway}=require('../lib/server.cjs');

// Minimal RFC6455 masked client for deterministic testing across Node >= 20
function encodeClientFrame(opcode,payload){
 const buf=Buffer.isBuffer(payload)?payload:Buffer.from(String(payload||''),'utf8');
 const mask=crypto.randomBytes(4);
 const len=buf.length;
 let header;
 if(len<126){header=Buffer.allocUnsafe(2);header[0]=0x80|opcode;header[1]=0x80|len}
 else if(len<=65535){header=Buffer.allocUnsafe(4);header[0]=0x80|opcode;header[1]=0x80|126;header.writeUInt16BE(len,2)}
 else{header=Buffer.allocUnsafe(10);header[0]=0x80|opcode;header[1]=0x80|127;header.writeBigUInt64BE(BigInt(len),2)}
 const masked=Buffer.allocUnsafe(len);
 for(let i=0;i<len;i++)masked[i]=buf[i]^mask[i&3];
 return Buffer.concat([header,mask,masked]);
}
function connectWs({port,pathName='/bridge/wx',token,useHeader=false}){
 return new Promise((resolve,reject)=>{
  const socket=net.connect(port,'127.0.0.1');
  const key=crypto.randomBytes(16).toString('base64');
  let upgraded=false,buf=Buffer.alloc(0);
  const queue=[],waiters=[],closeWaiters=[];
  const client={
   closed:false,
   sendJson(obj){socket.write(encodeClientFrame(0x1,JSON.stringify(obj)))},
   nextJson(timeoutMs=3000){
    if(queue.length)return Promise.resolve(queue.shift());
    return new Promise((res,rej)=>{
     const t=setTimeout(()=>rej(Error('Timed out waiting for WS message')),timeoutMs);
     waiters.push(v=>{clearTimeout(t);res(v)});
    });
   },
   waitClose(timeoutMs=3000){
    if(this.closed)return Promise.resolve();
    return new Promise((res,rej)=>{
     const t=setTimeout(()=>rej(Error('Timed out waiting for WS close')),timeoutMs);
     closeWaiters.push(()=>{clearTimeout(t);res()});
    });
   },
   close(){if(!socket.destroyed)socket.end(encodeClientFrame(0x8,Buffer.alloc(0)))}
  };
  const deliver=msg=>{
   if(waiters.length)waiters.shift()(msg);
   else queue.push(msg);
  };
  const parseFrames=()=>{
   while(buf.length>=2){
    const b0=buf[0],b1=buf[1],opcode=b0&0x0f;
    let len=b1&0x7f,offset=2;
    if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);offset=4}
    else if(len===127){if(buf.length<10)return;len=Number(buf.readBigUInt64BE(2));offset=10}
    if(buf.length<offset+len)return;
    const payload=buf.subarray(offset,offset+len);
    buf=buf.subarray(offset+len);
    if(opcode===0x1)deliver(JSON.parse(payload.toString('utf8')));
    else if(opcode===0x9)socket.write(encodeClientFrame(0xA,payload));
    else if(opcode===0x8)socket.end();
   }
  };
  socket.on('connect',()=>{
   const urlPath=useHeader||!token?pathName:`${pathName}?token=${encodeURIComponent(token)}`;
   const headers=[
    `GET ${urlPath} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...(useHeader&&token?[`Authorization: Bearer ${token}`]:[]),
    '\r\n'
   ].join('\r\n');
   socket.write(headers);
  });
  socket.on('data',chunk=>{
   buf=Buffer.concat([buf,chunk]);
   if(!upgraded){
    const idx=buf.indexOf('\r\n\r\n');
    if(idx<0)return;
    const head=buf.subarray(0,idx).toString('utf8');
    buf=buf.subarray(idx+4);
    const status=Number(head.split(' ')[1]);
    if(status!==101){socket.destroy();reject(Object.assign(Error('Upgrade failed: '+status),{status}));return}
    upgraded=true;
    resolve(client);
   }
   parseFrames();
  });
  socket.on('close',()=>{client.closed=true;while(closeWaiters.length)closeWaiters.shift()()});
  socket.on('error',e=>{if(!upgraded)reject(e)});
 });
}

async function fixture(fn){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cbg-wxbridge-test-'));
 const store=new WebStore(root),bridge=new WxBridge({store,heartbeatMs:60000,staleMs:120000});
 let admin;
 const server=createGateway({
  resolveKey(raw){
   const r=store.resolveKey(raw);if(!r)return null;
   if(r.account.method==='wx_miniprogram')return bridge.route(r.account,r.key.id);
   return null;
  },
  handleAdmin:(...a)=>admin(...a),
  getModels:()=>store.enabledModels(),
  getHealth:()=>{
   const enabled=store.listAccounts().filter(a=>a.enabled);
   const ready=enabled.some(a=>a.method==='wx_miniprogram'&&bridge.state(a.id).connected);
   return {status:ready?'ready':'not_ready',channel:'scf-and-miniprogram'};
  },
  log:e=>store.record(e)
 });
 bridge.attach(server);
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port;
 admin=createAdmin({store,bridge,port});
 const base='http://127.0.0.1:'+port;
 const req=(p,b,k=store.data.adminKey)=>fetch(base+p,{headers:{Authorization:'Bearer '+k,...(b===undefined?{}:{'Content-Type':'application/json'})},...(b===undefined?{}:{method:'POST',body:JSON.stringify(b)})});
 try{await fn({store,bridge,base,port,req})}
 finally{bridge.closeAll();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})}
}

test('create miniprogram account, reject bad WS auth, return 503 when offline, route non-stream & SSE when online',()=>fixture(async({store,base,port,req})=>{
 // Create miniprogram account without publishableKey/password
 const createdRes=await req('/admin/api/accounts/add',{method:'wx_miniprogram',name:'成长计划主账号',env:'cloud1-growth-123',appId:'wx1234567890abcdef'});
 assert.equal(createdRes.status,201);
 const created=await createdRes.json();
 assert.ok(created.bridgeToken.startsWith('cbg-wx-'));
 assert.equal(created.channel,'wx-miniprogram-bridge');
 assert.ok(!fs.readFileSync(store.file,'utf8').includes(created.bridgeToken),'raw bridge token must not be persisted');
 const overview1=await(await req('/admin/api/overview')).json();
 assert.ok(!JSON.stringify(overview1).includes(created.bridgeToken));
 assert.equal(overview1.accounts[0].runtime.connected,false);

 // Reject invalid WS upgrade
 await assert.rejects(connectWs({port,token:'wrong-token'}),e=>e.status===401);
 await assert.rejects(connectWs({port,pathName:'/other',token:created.bridgeToken}),e=>e.status===404);

 // Bind API key; offline returns 503 bridge_offline
 const key=(await(await req('/admin/api/keys/create',{name:'cursor-key',accountId:created.id})).json()).key;
 const offlineRes=await req('/v1/chat/completions',{model:'hy4-flash',messages:[{role:'user',content:'hi'}]},key);
 assert.equal(offlineRes.status,503);
 assert.equal((await offlineRes.json()).error.code,'bridge_offline');
 assert.equal((await fetch(base+'/readyz')).status,503);

 // Connect mini program WS client
 const ws=await connectWs({port,token:created.bridgeToken,useHeader:true});
 const welcome=await ws.nextJson();
 assert.equal(welcome.type,'welcome');
 assert.equal(welcome.env,'cloud1-growth-123');
 ws.sendJson({type:'hello',appId:'wx1234567890abcdef',env:'cloud1-growth-123',libVersion:'3.15.1',platform:'devtools'});
 const welcome2=await ws.nextJson();
 assert.equal(welcome2.type,'welcome');
 assert.equal((await fetch(base+'/readyz')).status,200);
 const overview2=await(await req('/admin/api/overview')).json();
 assert.equal(overview2.accounts[0].runtime.connected,true);
 assert.equal(overview2.accounts[0].runtime.clientInfo.libVersion,'3.15.1');

 // 1) Non-streaming completion + reasoning + usage
 const usage={prompt_tokens:10,completion_tokens:15,total_tokens:25};
 const nonStreamPromise=req('/v1/chat/completions',{model:'hy4-flash',messages:[{role:'user',content:'你好'}],temperature:0.5},key);
 const m1=await ws.nextJson();
 assert.equal(m1.type,'generate');
 assert.equal(m1.env,'cloud1-growth-123');
 assert.equal(m1.input.model,'hy4-flash');
 assert.equal(m1.input.temperature,0.5);
 ws.sendJson({type:'result',id:m1.id,text:'来自 wx.cloud.extend.AI 的回复',reasoning:'思考步骤',finish:'stop',usage});
 const nonStreamRes=await nonStreamPromise;
 assert.equal(nonStreamRes.status,200);
 const nonStreamJson=await nonStreamRes.json();
 assert.equal(nonStreamJson.choices[0].message.content,'来自 wx.cloud.extend.AI 的回复');
 assert.equal(nonStreamJson.choices[0].message.reasoning_content,'思考步骤');
 assert.deepEqual(nonStreamJson.usage,usage);

 // 2) Streaming SSE + concurrent second request
 const pA=req('/v1/chat/completions',{model:'hy3',messages:[{role:'user',content:'流式A'}],stream:true,stream_options:{include_usage:true}},key);
 const pB=req('/v1/chat/completions',{model:'hy4',messages:[{role:'user',content:'并行B'}],stream:false},key);
 const reqA=await ws.nextJson();
 const reqB=await ws.nextJson();
 const [streamReq,genReq]=reqA.type==='stream'?[reqA,reqB]:[reqB,reqA];
 assert.equal(streamReq.type,'stream');
 assert.equal(genReq.type,'generate');

 ws.sendJson({type:'chunk',id:streamReq.id,reasoning:'想一下'});
 ws.sendJson({type:'chunk',id:streamReq.id,text:'第一段'});
 ws.sendJson({type:'result',id:genReq.id,text:'并行结果B',finish:'stop',usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}});
 ws.sendJson({type:'chunk',id:streamReq.id,text:'第二段'});
 ws.sendJson({type:'done',id:streamReq.id,finish:'stop',usage:{prompt_tokens:5,completion_tokens:8,total_tokens:13}});

 const [resA,resB]=await Promise.all([pA,pB]);
 assert.equal(resA.status,200);
 assert.equal(resB.status,200);
 assert.equal((await resB.json()).choices[0].message.content,'并行结果B');
 const sseText=await resA.text();
 const events=sseText.split('\n\n').filter(Boolean).map(x=>x.slice(6));
 assert.equal(events.at(-1),'[DONE]');
 const parsed=events.slice(0,-1).map(JSON.parse);
 assert.equal(parsed.flatMap(e=>e.choices).map(c=>c.delta.reasoning_content||'').join(''),'想一下');
 assert.equal(parsed.flatMap(e=>e.choices).map(c=>c.delta.content||'').join(''),'第一段第二段');
 assert.equal(parsed.at(-1).usage.total_tokens,13);
 assert.equal(store.data.totals.requests,4);
 assert.equal(store.data.totals.success,3);
 assert.equal(store.data.totals.errors,1);
 assert.equal(store.data.totals.input,17);
 assert.equal(store.data.totals.output,26);

 ws.close();
 await ws.waitClose();
}));

test('rotating bridge token disconnects old client and invalidates old token',()=>fixture(async({port,req})=>{
 const created=await(await req('/admin/api/accounts/add',{method:'wx_miniprogram',name:'旋转测试',env:'env-rotate'})).json();
 const ws1=await connectWs({port,token:created.bridgeToken});
 await ws1.nextJson();

 const rotatedRes=await req('/admin/api/accounts/rotate-bridge-token',{id:created.id});
 assert.equal(rotatedRes.status,200);
 const rotated=await rotatedRes.json();
 assert.notEqual(rotated.bridgeToken,created.bridgeToken);
 await ws1.waitClose();

 // Old token rejected, new token accepted
 await assert.rejects(connectWs({port,token:created.bridgeToken}),e=>e.status===401);
 const ws2=await connectWs({port,token:rotated.bridgeToken});
 const w=await ws2.nextJson();
 assert.equal(w.type,'welcome');

 // Disabling account disconnects active bridge
 const toggleRes=await req('/admin/api/accounts/toggle',{id:created.id,enabled:false});
 assert.equal(toggleRes.status,200);
 await ws2.waitClose();
}));

test('bridge error event and unexpected disconnect fail in-flight requests cleanly',()=>fixture(async({port,req})=>{
 const created=await(await req('/admin/api/accounts/add',{method:'wx_miniprogram',name:'异常测试',env:'env-err'})).json();
 const key=(await(await req('/admin/api/keys/create',{name:'err-key',accountId:created.id})).json()).key;
 const ws=await connectWs({port,token:created.bridgeToken});
 await ws.nextJson();

 // Upstream wx.cloud.extend.AI error before first chunk -> 502
 const errPromise=req('/v1/chat/completions',{model:'hy3',messages:[{role:'user',content:'fail'}],stream:true},key);
 const m1=await ws.nextJson();
 ws.sendJson({type:'error',id:m1.id,code:'quota_exceeded',message:'额度不足'});
 const errRes=await errPromise;
 assert.equal(errRes.status,502);
 const errBody=await errRes.json();
 assert.equal(errBody.error.code,'quota_exceeded');

 // Unexpected disconnect during in-flight request -> 503 bridge_disconnected
 const dropPromise=req('/v1/chat/completions',{model:'hy3',messages:[{role:'user',content:'drop'}]},key);
 await ws.nextJson();
 ws.close();
 await ws.waitClose();
 const dropRes=await dropPromise;
 assert.equal(dropRes.status,503);
 assert.equal((await dropRes.json()).error.code,'bridge_disconnected');
}));
