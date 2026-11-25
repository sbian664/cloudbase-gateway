'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {createGateway}=require('../lib/server.cjs');
const key='sk-test-'+ 'a'.repeat(32);
const auth={ensure:async()=>({}),state:()=>({ready:true}),sync:async()=>{}};
const usage={prompt_tokens:3,completion_tokens:2,total_tokens:5};
const fixture={generate:async()=>({text:'Hello world',usage,finish:'stop'}),async *stream(){yield{text:'Hello '};yield{text:'world'};yield{finish:'stop',usage}}};
const body={model:'hy3',messages:[{role:'user',content:'hello'}]};
async function withServer(fn,overrides={}){
 const server=createGateway({auth,adapter:fixture,apiKey:key,...overrides});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url='http://127.0.0.1:'+server.address().port;
 const send=(p,data,headers={})=>fetch(url+p,{method:'POST',headers:{'authorization':'Bearer '+key,'content-type':'application/json',...headers},body:JSON.stringify(data)});
 try{await fn(url,send)}finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
}
test('health and liveness distinguish authentication failure',async()=>withServer(async u=>{
 assert.equal((await fetch(u+'/livez')).status,200);
 assert.equal((await fetch(u+'/readyz')).status,503);
},{auth:{ensure:async()=>{throw Object.assign(Error('expired'),{code:'login_required'})},state:()=>({ready:false})}}));
test('authentication and model listing',async()=>withServer(async u=>{
 assert.equal((await fetch(u+'/v1/models')).status,401);
 const r=await fetch(u+'/v1/models',{headers:{authorization:'Bearer '+key}});
 assert.equal(r.status,200);assert.ok((await r.json()).data.some(x=>x.id==='hy3'));
}));
test('nonstream text completion and usage',async()=>withServer(async(u,send)=>{
 const r=await send('/v1/chat/completions',body);assert.equal(r.status,200);
 const j=await r.json();assert.equal(j.object,'chat.completion');assert.equal(j.choices[0].message.content,'Hello world');assert.deepEqual(j.usage,usage)
}));
test('streaming SSE role, text, finish, usage, DONE',async()=>withServer(async(u,send)=>{
 const r=await send('/v1/chat/completions',{...body,stream:true,stream_options:{include_usage:true}});
 assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/event-stream/);
 const events=(await r.text()).split('\n\n').filter(Boolean).map(x=>x.slice(6));
 assert.equal(events.at(-1),'[DONE]');const j=events.slice(0,-1).map(JSON.parse);
 assert.equal(j[0].choices[0].delta.role,'assistant');
 assert.equal(j.flatMap(e=>e.choices).map(c=>c.delta.content||'').join(''),'Hello world');
 assert.equal(j.at(-2).choices[0].finish_reason,'stop');assert.deepEqual(j.at(-1).usage,usage);
}));
test('input validation and unsupported arguments',async()=>withServer(async(u,send)=>{
 for(const b of [{...body,model:'invalid'},{...body,messages:[]},{...body,tools:[]},{...body,max_tokens:16},{...body,stream:'true'}]){
  const r=await send('/v1/chat/completions',b);assert.equal(r.status,400);
 }
 assert.equal((await send('/v1/responses',body)).status,404);
}));
test('upstream failure before first stream chunk returns 502',async()=>withServer(async(u,send)=>{
 const r=await send('/v1/chat/completions',{...body,stream:true});
 assert.equal(r.status,502);assert.equal((await r.json()).error.code,'upstream_error');
},{adapter:{...fixture,async *stream(){throw Error('upstream failed')}}}));
test('midstream error does not falsely send DONE',async()=>withServer(async(u,send)=>{
 const r=await send('/v1/chat/completions',{...body,stream:true});const text=await r.text();
 assert.match(text,/hello/);assert.match(text,/"error"/);assert.doesNotMatch(text,/\[DONE\]/);
},{adapter:{...fixture,async *stream(){yield{text:'hello'};throw Error('interrupted')}}}));
test('concurrency limit',async()=>{
 let release,entered;const wait=new Promise(r=>release=r);const started=new Promise(r=>entered=r);
 await withServer(async(u,send)=>{
 const a=send('/v1/chat/completions',body);await started;
 try{const r=await send('/v1/chat/completions',body);assert.equal(r.status,429)}finally{release()}
 assert.equal((await a).status,200);
 },{maxConcurrent:1,adapter:{...fixture,generate:async()=>{entered();await wait;return fixture.generate()}}});
});
