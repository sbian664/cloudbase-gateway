'use strict';
const {summarizeError}=require('./upstream-error.cjs');
const DEFAULT_TIMEOUT=125000;
const PROBE_TIMEOUT=10000;

function normalizeEndpoint(raw){
 if(typeof raw!=='string'||!raw.trim()||raw.length>500)throw Object.assign(Error('Invalid SCF/CloudRun endpoint URL'),{status:400,code:'invalid_request'});
 let u;
 try{u=new URL(raw.trim())}catch{throw Object.assign(Error('Invalid SCF/CloudRun endpoint URL'),{status:400,code:'invalid_request'})}
 if(u.username||u.password||u.search||u.hash)throw Object.assign(Error('Endpoint URL must not include credentials, query, or hash'),{status:400,code:'invalid_request'});
 const loopback=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
 if(u.protocol!=='https:'&&!(u.protocol==='http:'&&loopback))throw Object.assign(Error('Endpoint URL must use https:// (or http://localhost for local testing)'),{status:400,code:'invalid_request'});
 let p=u.pathname.replace(/\/+$/,'');
 if(p.endsWith('/v1/chat/completions'))p=p.slice(0,-'/v1/chat/completions'.length);
 else if(p.endsWith('/v1'))p=p.slice(0,-'/v1'.length);
 return u.origin+p;
}

function validUsage(u){
 return u&&['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isFinite(u[k])&&u[k]>=0)
  ?{prompt_tokens:u.prompt_tokens,completion_tokens:u.completion_tokens,total_tokens:u.total_tokens}
  :undefined;
}

async function parseErrorBody(res){
 try{
  const text=await res.text();
  try{
   const j=JSON.parse(text);
   return j?.error||{message:text.slice(0,200)};
  }catch{return {message:text.slice(0,200)}}
 }catch{return {}}
}

class ScfPool{
 constructor({fetchImpl=fetch,requestTimeoutMs=DEFAULT_TIMEOUT,probeTimeoutMs=PROBE_TIMEOUT}={}){
  this.fetch=fetchImpl;
  this.requestTimeoutMs=requestTimeoutMs;
  this.probeTimeoutMs=probeTimeoutMs;
  this.states=new Map();
 }
 state(id){
  return this.states.get(id)||{ready:false,connected:false,verified:false,lastCheckedAt:null,latencyMs:null,lastError:null,upstreamModels:null};
 }
 isAvailable(account){
  if(!account||account.method!=='scf_node_sdk'||!account.endpoint||!account.scfToken)return false;
  const st=this.states.get(account.id);
  return st?st.ready:true;
 }
 forget(id){this.states.delete(id)}
 setState(id,patch){
  const next={...this.state(id),...patch};
  this.states.set(id,next);
  return next;
 }
 async probe(account){
  const endpoint=normalizeEndpoint(account.endpoint);
  const started=Date.now();
  try{
   const res=await this.fetch(endpoint+'/healthz',{
    method:'GET',
    headers:account.scfToken?{authorization:'Bearer '+account.scfToken}:{},
    signal:AbortSignal.timeout(this.probeTimeoutMs)
   });
   const latencyMs=Date.now()-started;
   if(!res.ok){
    const err=Object.assign(Error('SCF/CloudRun health check failed (HTTP '+res.status+')'),{code:res.status===401?'scf_unauthorized':'scf_unreachable',upstreamStatus:res.status,category:res.status===401?'authorization':'network'});
    if(account.id)this.setState(account.id,{ready:false,connected:false,verified:true,lastCheckedAt:new Date().toISOString(),latencyMs,lastError:err.code});
    throw err;
   }
   let data={};
   try{data=await res.json()}catch{}
   const st={
    ready:true,
    connected:true,
    verified:true,
    lastCheckedAt:new Date().toISOString(),
    latencyMs,
    lastError:null,
    upstreamEnv:typeof data.env==='string'?data.env:null,
    upstreamModels:Array.isArray(data.models)?data.models.slice(0,32):null
   };
   if(account.id)this.setState(account.id,st);
   return st;
  }catch(e){
   if(e.code==='scf_unauthorized'||e.code==='scf_unreachable')throw e;
   const diag=summarizeError(e);
   const code=diag.category==='timeout'?'upstream_timeout':'scf_unreachable';
   if(account.id)this.setState(account.id,{ready:false,connected:false,verified:true,lastCheckedAt:new Date().toISOString(),latencyMs:Date.now()-started,lastError:code});
   throw Object.assign(Error('Cannot reach CloudBase SCF/CloudRun endpoint'),{code,category:'network'});
  }
 }
 async ensure(account){
  if(!account?.endpoint||!account?.scfToken)throw Object.assign(Error('SCF/CloudRun endpoint or token missing'),{code:'scf_not_configured',category:'authorization'});
  return this.state(account.id);
 }
 buildBody(input,stream){
  const body={model:input.model,messages:input.messages,stream};
  if(input.temperature!==undefined)body.temperature=input.temperature;
  if(input.top_p!==undefined)body.top_p=input.top_p;
  if(stream)body.stream_options={include_usage:true};
  return body;
 }
 async requestUpstream(account,input,stream,signal){
  const endpoint=normalizeEndpoint(account.endpoint);
  const combined=signal
   ?AbortSignal.any([signal,AbortSignal.timeout(this.requestTimeoutMs)])
   :AbortSignal.timeout(this.requestTimeoutMs);
  let res;
  try{
   res=await this.fetch(endpoint+'/v1/chat/completions',{
    method:'POST',
    headers:{
     authorization:'Bearer '+account.scfToken,
     'content-type':'application/json',
     ...(stream?{accept:'text/event-stream'}:{})
    },
    body:JSON.stringify(this.buildBody(input,stream)),
    signal:combined
   });
  }catch(e){
   const diag=summarizeError(e);
   const code=signal?.aborted?'request_cancelled':diag.category==='timeout'?'upstream_timeout':'scf_unreachable';
   if(!signal?.aborted)this.setState(account.id,{ready:false,connected:false,lastError:code});
   throw Object.assign(Error('CloudBase SCF/CloudRun request failed'),{code,category:diag.category==='unknown'?'network':diag.category});
  }
  if(!res.ok){
   const errObj=await parseErrorBody(res);
   const diag=summarizeError({...errObj,status:res.status});
   const code=res.status===401?'scf_unauthorized':(diag.code==='upstream_error'?'scf_upstream_error':diag.code);
   if(res.status===401||res.status>=500)this.setState(account.id,{ready:false,connected:false,lastError:code});
   throw Object.assign(Error('CloudBase SCF/CloudRun returned HTTP '+res.status),{code,upstreamStatus:res.status,category:res.status===401?'authorization':diag.category});
  }
  return res;
 }
 async generate(account,input,signal){
  const started=Date.now();
  const res=await this.requestUpstream(account,input,false,signal);
  let data;
  try{data=await res.json()}catch{throw Object.assign(Error('Invalid JSON from SCF/CloudRun bridge'),{code:'sdk_response',category:'sdk_response'})}
  const choice=Array.isArray(data?.choices)?data.choices[0]:null;
  const msg=choice?.message;
  if(typeof msg?.content!=='string')throw Object.assign(Error('SCF/CloudRun bridge returned no text'),{code:'sdk_response',category:'sdk_response'});
  this.setState(account.id,{ready:true,connected:true,verified:true,lastCheckedAt:new Date().toISOString(),latencyMs:Date.now()-started,lastError:null});
  return {
   text:msg.content,
   ...(typeof msg.reasoning_content==='string'&&msg.reasoning_content?{reasoning:msg.reasoning_content}:{}),
   finish:choice.finish_reason||'stop',
   usage:validUsage(data.usage)
  };
 }
 async *stream(account,input,signal){
  const started=Date.now();
  const res=await this.requestUpstream(account,input,true,signal);
  const ct=String(res.headers?.get('content-type')||'').toLowerCase();
  if(!ct.includes('text/event-stream')||!res.body){
   throw Object.assign(Error('SCF/CloudRun bridge did not return text/event-stream'),{code:'sdk_response',category:'sdk_response'});
  }
  const reader=res.body.getReader();
  const decoder=new TextDecoder();
  let buf='',finish='stop',usage,sawEvent=false;
  try{
   while(true){
    const {done,value}=await reader.read();
    if(done)break;
    if(signal?.aborted)throw Object.assign(Error('Request cancelled'),{code:'request_cancelled',category:'timeout'});
    buf+=decoder.decode(value,{stream:true});
    const lines=buf.split(/\r?\n/);
    buf=lines.pop()||'';
    for(const rawLine of lines){
     const line=rawLine.trim();
     if(!line||!line.startsWith('data:'))continue;
     const payload=line.slice(5).trim();
     if(!payload)continue;
     if(payload==='[DONE]'){
      this.setState(account.id,{ready:true,connected:true,verified:true,lastCheckedAt:new Date().toISOString(),latencyMs:Date.now()-started,lastError:null});
      yield {finish,usage};
      return;
     }
     let parsed;
     try{parsed=JSON.parse(payload)}catch{continue}
     if(parsed?.error){
      const diag=summarizeError(parsed.error);
      throw Object.assign(Error('Upstream stream error'),{code:diag.code,category:diag.category});
     }
     sawEvent=true;
     if(parsed.usage)usage=validUsage(parsed.usage)||usage;
     const choice=Array.isArray(parsed.choices)?parsed.choices[0]:null;
     const delta=choice?.delta;
     if(choice?.finish_reason)finish=choice.finish_reason;
     const ev={};
     if(typeof delta?.reasoning_content==='string'&&delta.reasoning_content)ev.reasoning=delta.reasoning_content;
     if(typeof delta?.content==='string'&&delta.content)ev.text=delta.content;
     if(ev.text||ev.reasoning)yield ev;
    }
   }
   const tail=buf.trim();
   if(tail.startsWith('data:')){
    const payload=tail.slice(5).trim();
    if(payload&&payload!=='[DONE]'){
     try{
      const parsed=JSON.parse(payload);
      if(parsed.usage)usage=validUsage(parsed.usage)||usage;
      const choice=Array.isArray(parsed.choices)?parsed.choices[0]:null;
      if(choice?.finish_reason)finish=choice.finish_reason;
      if(typeof choice?.delta?.content==='string'&&choice.delta.content)yield {text:choice.delta.content};
     }catch{}
    }
   }
   if(!sawEvent)throw Object.assign(Error('Empty stream from SCF/CloudRun bridge'),{code:'sdk_response',category:'sdk_response'});
   this.setState(account.id,{ready:true,connected:true,verified:true,lastCheckedAt:new Date().toISOString(),latencyMs:Date.now()-started,lastError:null});
   yield {finish,usage};
  }finally{
   try{await reader.cancel()}catch{}
  }
 }
 route(account,keyId){
  return {
   auth:{ensure:()=>this.ensure(account)},
   adapter:{
    generate:(input,signal)=>this.generate(account,input,signal),
    stream:(input,signal)=>this.stream(account,input,signal)
   },
   accountId:account.id,
   keyId
  };
 }
}
module.exports={ScfPool,normalizeEndpoint};
