'use strict';
const fs=require('node:fs'),path=require('node:path');
const {fail}=require('./web-store.cjs');
const {normalizeEndpoint}=require('./scf-adapter.cjs');
const WEBUI_CHANNELS=[
 {id:'scf_node_sdk',name:'CloudBase 云函数 / 云托管 (@cloudbase/node-sdk)',group:'云端 Node SDK',supported:true,scf:true},
 {id:'wx_miniprogram',name:'微信小程序原生 (wx.cloud.extend.AI)',group:'小程序原生',supported:true,bridge:true}
];
const files={'/':['index.html','text/html; charset=utf-8'],'/admin':['index.html','text/html; charset=utf-8'],'/admin/':['index.html','text/html; charset=utf-8'],'/assets/dashboard.css':['dashboard.css','text/css; charset=utf-8'],'/assets/dashboard.js':['dashboard.js','application/javascript; charset=utf-8']};
const base=path.join(__dirname,'..','web');
const safeCode=e=>typeof e?.code==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(e.code)?e.code:'operation_failed';
function json(res,status,data){if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data))}}
async function body(req){
 if(!String(req.headers['content-type']||'').startsWith('application/json'))fail('Expected application/json',415);
 let n=0;const parts=[];for await(const c of req){n+=c.length;if(n>32768)fail('Request too large',413);parts.push(c)}
 try{return JSON.parse(Buffer.concat(parts))}catch{fail('Invalid JSON')}
}
function field(b,k,max){if(typeof b?.[k]!=='string'||!b[k].trim()||b[k].length>max)fail('Invalid '+k);return b[k].trim()}
function boolean(b){if(typeof b?.enabled!=='boolean')fail('enabled must be boolean');return b.enabled}
function createAdmin({store,scf=null,bridge=null,port,getActive=()=>0}){
 const allowedHosts=new Set(['127.0.0.1:'+port,'localhost:'+port]);
 const sameOrigin=req=>!req.headers.origin||allowedHosts.has(req.headers.origin.replace(/^http:\/\//,''));
 const bridgeUrlFor=req=>'ws://'+req.headers.host+'/bridge/wx';
 const runtimeOf=a=>{
  if(a.method==='wx_miniprogram')return bridge?.state(a.id)||{ready:false,connected:false,lastError:null,activeRequests:0,clientInfo:null};
  if(a.method==='scf_node_sdk')return scf?.state(a.id)||{ready:false,connected:false,verified:false,lastCheckedAt:null,latencyMs:null,lastError:null,upstreamModels:null};
  return {ready:false,connected:false,lastError:'legacy_channel_removed'};
 };
 return async(req,res,p)=>{
  if(!allowedHosts.has(req.headers.host)||!sameOrigin(req)){json(res,403,{error:'Local requests only'});return true}
  const asset=files[p];
  if(asset&&req.method==='GET'){
   try{const bytes=fs.readFileSync(path.join(base,asset[0]));res.writeHead(200,{'content-type':asset[1],'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(bytes)}
   catch{json(res,500,{error:'WebUI asset missing'})}return true
  }
  if(!p.startsWith('/admin/api/'))return false;
  if(!store.isAdmin(String(req.headers.authorization||'').replace(/^Bearer /,''))){json(res,401,{error:'Invalid administrator key'});return true}
  try{
   if(p==='/admin/api/overview'&&req.method==='GET'){
    const accounts=store.listAccounts().map(a=>({...a,runtime:runtimeOf(a)}));
    const logs=store.data.logs;
    const recent=logs.filter(x=>x.status==='ok').map(x=>x.ms).sort((a,b)=>a-b);
    const percentile=q=>recent.length?recent[Math.ceil(recent.length*q)-1]:null;
    json(res,200,{version:'0.4.0-dev',loginMethods:WEBUI_CHANNELS,accounts,keys:store.keys(),models:store.data.models,settings:store.data.settings,totals:store.data.totals,logs,active:getActive(),rssMiB:Math.round(process.memoryUsage().rss/1048576*10)/10,uptimeSec:Math.floor(process.uptime()),latency:{p50:percentile(.5),p95:percentile(.95)},channel:'scf-and-miniprogram',bridgeUrl:bridgeUrlFor(req)});return true;
   }
   if(req.method!=='POST'){json(res,404,{error:'Not found'});return true}
   const b=await body(req);
   if(p==='/admin/api/accounts/add'){
    if(store.data.accounts.length>=20)fail('Maximum 20 accounts');
    const method=b?.method||'scf_node_sdk';
    if(method==='scf_node_sdk'){
     const name=field(b,'name',80),env=field(b,'env',120);
     const region=typeof b?.region==='string'&&b.region.trim()?b.region.trim().slice(0,60):'ap-shanghai';
     const endpoint=normalizeEndpoint(field(b,'endpoint',500));
     const scfToken=field(b,'scfToken',512);
     let probeState=null;
     if(scf&&b?.skipVerify!==true){
      probeState=await scf.probe({endpoint,scfToken});
     }
     const created=store.createScfAccount({name,env,region,endpoint,scfToken});
     if(scf&&probeState)scf.setState(created.id,probeState);
     json(res,201,{...created,runtime:runtimeOf(created)});return true;
    }
    if(method==='wx_miniprogram'){
     const name=field(b,'name',80),env=field(b,'env',120);
     const region=typeof b?.region==='string'&&b.region.trim()?b.region.trim().slice(0,60):'ap-shanghai';
     const appId=typeof b?.appId==='string'&&b.appId.trim()?b.appId.trim().slice(0,64):'';
     const created=store.createMiniprogramAccount({name,env,region,appId});
     json(res,201,{...created,bridgeUrl:bridgeUrlFor(req)});return true;
    }
    fail('仅支持「CloudBase 云函数 / 云托管 (scf_node_sdk)」与「微信小程序原生 (wx_miniprogram)」渠道',400);
   }
   if(p==='/admin/api/accounts/update-scf'){
    if(getActive())fail('Wait for active requests to finish',409);
    const id=field(b,'id',80);
    const existing=store.account(id);
    if(!existing||existing.method!=='scf_node_sdk')fail('SCF/CloudRun account not found',404);
    const endpoint=typeof b?.endpoint==='string'&&b.endpoint.trim()?normalizeEndpoint(b.endpoint):existing.endpoint;
    const scfToken=typeof b?.scfToken==='string'&&b.scfToken.trim()?b.scfToken.trim():existing.scfToken;
    if(scfToken.length>512)fail('Invalid scfToken');
    let probeState=null;
    if(scf&&b?.skipVerify!==true){
     probeState=await scf.probe({id,endpoint,scfToken});
    }
    const updated=store.updateScfAccount(id,{endpoint,scfToken});
    if(scf&&probeState)scf.setState(id,probeState);
    json(res,200,{...updated,runtime:runtimeOf(updated)});return true;
   }
   if(p==='/admin/api/accounts/rotate-bridge-token'){
    const id=field(b,'id',80);
    const updated=store.rotateBridgeToken(id);
    bridge?.disconnect(id,'token_rotated');
    json(res,200,{...updated,bridgeUrl:bridgeUrlFor(req)});return true;
   }
   if(p==='/admin/api/accounts/refresh'){
    const a=store.account(field(b,'id',80));if(!a)fail('Account not found',404);
    if(a.method==='scf_node_sdk'){
     if(!scf)fail('SCF runtime unavailable',503);
     const st=await scf.probe(a);
     json(res,200,{ok:true,runtime:st});return true;
    }
    if(a.method==='wx_miniprogram'){
     const st=bridge?.state(a.id)||{ready:false,connected:false};
     if(!st.connected)fail('小程序桥接尚未连接，请在微信开发者工具中打开并连接桥接页面',503);
     json(res,200,{ok:true,runtime:st});return true;
    }
    fail('旧版 Web SDK 渠道已移除，请改用云函数/云托管或小程序原生渠道',400);
   }
   if(p==='/admin/api/accounts/toggle'){
    const id=field(b,'id',80),enabled=boolean(b);
    store.changeAccount(id,enabled);
    if(!enabled)bridge?.disconnect(id,'account_disabled');
    json(res,200,{ok:true});return true;
   }
   if(p==='/admin/api/accounts/remove'){
    const id=field(b,'id',80);if(getActive())fail('Wait for active requests to finish',409);
    store.changeAccount(id,false);bridge?.disconnect(id,'account_removed');scf?.forget(id);store.removeAccount(id);json(res,200,{ok:true});return true;
   }
   if(p==='/admin/api/keys/create'){json(res,201,store.createKey(field(b,'name',80),field(b,'accountId',80)));return true}
   if(p==='/admin/api/keys/toggle'){store.changeKey(field(b,'id',80),boolean(b));json(res,200,{ok:true});return true}
   if(p==='/admin/api/keys/remove'){store.removeKey(field(b,'id',80));json(res,200,{ok:true});return true}
   if(p==='/admin/api/models/toggle'){store.setModel(field(b,'id',100),boolean(b));json(res,200,{ok:true});return true}
   if(p==='/admin/api/settings'){store.setSettings(b?.maxConcurrent);json(res,200,{ok:true});return true}
   json(res,404,{error:'Not found'});
  }catch(e){json(res,e.status||502,{error:e.status?e.message:'CloudBase operation failed ('+safeCode(e)+')',code:safeCode(e)})}
  return true;
 };
}
module.exports={createAdmin};
