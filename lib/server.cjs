'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const {once}=require('node:events');
const {MODEL_IDS,validate}=require('./adapter.cjs');
const safeCode=e=>typeof e?.code==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(e.code)?e.code:'upstream_error';
const json=(res,status,data)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}};
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function errorResponse(res,status,message,code){json(res,status,{error:{message,type:status===401?'authentication_error':status===429?'rate_limit_error':status>=500?'server_error':'invalid_request_error',code}})}
async function readBody(req){let size=0;const parts=[];for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Object.assign(Error('Request exceeds 1 MiB'),{status:413,code:'body_too_large'});parts.push(chunk)}try{return JSON.parse(Buffer.concat(parts))}catch{throw Object.assign(Error('Invalid JSON'),{status:400,code:'invalid_json'})}}
function validUsage(u){return u&&['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isFinite(u[k])&&u[k]>=0)?u:undefined}
function createGateway({auth,adapter,apiKey,maxConcurrent=4,log=()=>{}}){
 if(!apiKey||apiKey.length<24)throw Error('Missing gateway API key');
 let active=0,lastSuccess=null,lastError=null;
 const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(req.method==='GET'&&pathname==='/livez')return json(res,200,{status:'ok'});
  if(req.method==='GET'&&['/healthz','/readyz'].includes(pathname)){
   try{await auth.ensure();return json(res,200,{status:'ready',channel:'official-web-sdk',active,auth:auth.state(),lastSuccess,lastError,upstream:'not actively probed'})}
   catch(e){return json(res,503,{status:'not_ready',channel:'official-web-sdk',active,auth:auth.state(),error:safeCode(e),lastSuccess,lastError})}
  }
  if(!equal(req.headers.authorization,'Bearer '+apiKey))return errorResponse(res,401,'Invalid gateway API key','invalid_api_key');
  if(req.method==='GET'&&pathname==='/v1/models')return json(res,200,{object:'list',data:MODEL_IDS.map(id=>({id,object:'model',created:0,owned_by:'cloudbase'}))});
  if(req.method!=='POST'||pathname!=='/v1/chat/completions')return errorResponse(res,404,'Endpoint not supported','not_found');
  if(active>=maxConcurrent)return errorResponse(res,429,'Gateway concurrency limit reached','busy');
  active++;const start=Date.now();const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),125000);
  res.on('close',()=>{if(!res.writableEnded)controller.abort()});
  let input,streaming=false;
  try{
   const body=await readBody(req);input=validate(body);
   await auth.ensure();
   const common={id:'chatcmpl-'+crypto.randomUUID(),created:Math.floor(Date.now()/1000),model:input.model};
   if(!body.stream){
    const r=await adapter.generate(input,controller.signal);
    if(!controller.signal.aborted)json(res,200,{...common,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:r.text},finish_reason:r.finish||'stop'}],...(validUsage(r.usage)?{usage:r.usage}:{})});
   }else{
    const gen=adapter.stream(input,controller.signal)[Symbol.asyncIterator]();
    // Wait for the upstream's first event so auth/network errors can return HTTP status.
    try{
     let event=await gen.next();
     if(controller.signal.aborted)throw Error('Request cancelled');
     res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});
     streaming=true;
     async function emit(data){
      if(controller.signal.aborted||res.destroyed)throw Error('Request cancelled');
      if(!res.write('data: '+JSON.stringify(data)+'\n\n'))await Promise.race([once(res,'drain'),once(res,'close')]);
     }
     const chunk=(delta,finish=null)=>({...common,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:finish}]});
     await emit(chunk({role:'assistant'}));
     let finish='stop',usage;
     while(!event.done){
      const v=event.value;if(v.text)await emit(chunk({content:v.text}));
      if(v.finish)finish=v.finish;if(v.usage)usage=validUsage(v.usage);
      event=await gen.next();
     }
     await emit(chunk({},finish));
     if(body.stream_options?.include_usage&&usage)await emit({...common,object:'chat.completion.chunk',choices:[],usage});
     res.end('data: [DONE]\n\n');
    }finally{await gen.return?.()}
   }
   if(controller.signal.aborted)throw Error('Request cancelled');
   lastSuccess=new Date().toISOString();lastError=null;
   log({model:input.model,stream:!!body.stream,status:'ok',ms:Date.now()-start});
  }catch(e){
   const code=safeCode(e);
   const status=e.status||(controller.signal.aborted?504:(['login_required','auth_error'].includes(code)?503:502));
   const message=e.status?e.message:status===504?'Upstream request cancelled or timed out':status===503?'CloudBase session not ready; check login':'CloudBase SDK request failed ('+code+')';
   lastError={code,at:new Date().toISOString()};
   if(streaming){if(!res.destroyed&&!res.writableEnded){res.write('data: '+JSON.stringify({error:{message,type:'server_error',code}})+'\n\n');res.end()}}
   else errorResponse(res,status,message,code);
   log({model:input?.model,stream:streaming,status:'error',code,ms:Date.now()-start});
  }finally{clearTimeout(timer);active--}
 });
 server.requestTimeout=130000;server.headersTimeout=15000;
 return server;
}
module.exports={createGateway};
