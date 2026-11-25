'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events'),{Readable}=require('node:stream'),path=require('node:path');
const {ScfPool,normalizeEndpoint}=require('../lib/scf-adapter.cjs');
const {createGateway}=require('../lib/server.cjs');
const scfBridge=require(path.resolve(__dirname,'../scf-bridge/server.js'));

test('normalizeEndpoint strips /v1 suffix and validates protocol',()=>{
 assert.equal(normalizeEndpoint('https://demo.service.tcloudbase.com/ai-bridge/v1/'), 'https://demo.service.tcloudbase.com/ai-bridge');
 assert.equal(normalizeEndpoint('https://demo.service.tcloudbase.com/v1/chat/completions'), 'https://demo.service.tcloudbase.com');
 assert.equal(normalizeEndpoint('http://127.0.0.1:9000/ai/'), 'http://127.0.0.1:9000/ai');
 assert.throws(()=>normalizeEndpoint('http://example.com/ai'),/https/);
 assert.throws(()=>normalizeEndpoint('https://user:pass@example.com/ai'),/credentials/);
});

test('end-to-end: gateway ScfPool -> real cloudbase-scf-bridge -> mock Node SDK (non-stream & SSE)',async t=>{
 const bridgeToken='e2e-bridge-token-xyz';
 const bridgeSrv=scfBridge.createServer({
  token:bridgeToken,
  env:'env-e2e',
  pathPrefix:'/ai-bridge',
  complete(payload){
   if(payload.stream){
    return Readable.from([
     'data: {"choices":[{"delta":{"reasoning_content":"分析中"}}]}\n\n',
     'data: {"choices":[{"delta":{"content":"来自云函数"}}]}\n\n',
     'data: {"choices":[{"delta":{"content":" Hy4"},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":4,"total_tokens":10}}\n\ndata: [DONE]\n\n',
    ]);
   }
   return {
    choices:[{index:0,message:{role:'assistant',content:'同步 Hy4 回复',reasoning_content:'思考'},finish_reason:'stop'}],
    usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}
   };
  }
 });
 bridgeSrv.listen(0,'127.0.0.1');await once(bridgeSrv,'listening');
 t.after(()=>{bridgeSrv.closeAllConnections();bridgeSrv.close()});

 const scf=new ScfPool();
 const account={id:'acc-1',method:'scf_node_sdk',env:'env-e2e',endpoint:`http://127.0.0.1:${bridgeSrv.address().port}/ai-bridge`,scfToken:bridgeToken};
 const probe=await scf.probe(account);
 assert.equal(probe.ready,true);
 assert.equal(probe.upstreamEnv,'env-e2e');

 const apiKey='sk-test-'+'b'.repeat(32);
 const gw=createGateway({
  resolveKey:raw=>raw===apiKey?scf.route(account,'key-1'):null,
  getHealth:()=>({status:'ready'})
 });
 gw.listen(0,'127.0.0.1');await once(gw,'listening');
 t.after(()=>{gw.closeAllConnections();gw.close()});
 const gwUrl=`http://127.0.0.1:${gw.address().port}`;

 // Non-stream
 const r1=await fetch(gwUrl+'/v1/chat/completions',{
  method:'POST',
  headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},
  body:JSON.stringify({model:'hy4',messages:[{role:'user',content:'测试'}],stream:false})
 });
 assert.equal(r1.status,200);
 const j1=await r1.json();
 assert.equal(j1.choices[0].message.content,'同步 Hy4 回复');
 assert.equal(j1.choices[0].message.reasoning_content,'思考');
 assert.equal(j1.usage.total_tokens,8);

 // Stream SSE
 const r2=await fetch(gwUrl+'/v1/chat/completions',{
  method:'POST',
  headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},
  body:JSON.stringify({model:'hy4',messages:[{role:'user',content:'流式测试'}],stream:true,stream_options:{include_usage:true}})
 });
 assert.equal(r2.status,200);
 const events=(await r2.text()).split('\n\n').filter(Boolean).map(x=>x.slice(6));
 assert.equal(events.at(-1),'[DONE]');
 const parsed=events.slice(0,-1).map(JSON.parse);
 assert.equal(parsed.flatMap(e=>e.choices).map(c=>c.delta.reasoning_content||'').join(''),'分析中');
 assert.equal(parsed.flatMap(e=>e.choices).map(c=>c.delta.content||'').join(''),'来自云函数 Hy4');
 assert.equal(parsed.at(-1).usage.total_tokens,10);
});
