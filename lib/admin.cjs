'use strict';
const fs=require('node:fs'),path=require('node:path');
const {fail}=require('./web-store.cjs');
const {METHODS}=require('./login-methods.cjs');
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
function createAdmin({store,pool,port,getActive=()=>0}){
 let adding=false;const otpSent=new Map();
 const allowedHosts=new Set(['127.0.0.1:'+port,'localhost:'+port]);
 const sameOrigin=req=>!req.headers.origin||allowedHosts.has(req.headers.origin.replace(/^http:\/\//,''));
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
    const accounts=store.listAccounts().map(a=>({...a,runtime:pool.state(a.id)}));
    const logs=store.data.logs;
    const recent=logs.filter(x=>x.status==='ok').map(x=>x.ms).sort((a,b)=>a-b);
    const percentile=q=>recent.length?recent[Math.ceil(recent.length*q)-1]:null;
    json(res,200,{version:'0.2.0-dev',loginMethods:METHODS,accounts,keys:store.keys(),models:store.data.models,settings:store.data.settings,totals:store.data.totals,logs,active:getActive(),rssMiB:Math.round(process.memoryUsage().rss/1048576*10)/10,uptimeSec:Math.floor(process.uptime()),latency:{p50:percentile(.5),p95:percentile(.95)},channel:'official-web-sdk'});return true;
   }
   if(req.method!=='POST'){json(res,404,{error:'Not found'});return true}
   const b=await body(req);
   if(p==='/admin/api/accounts/add'||p==='/admin/api/accounts/begin'){
    if(adding)fail('Another login is in progress',409);
    if(store.data.accounts.length>=20)fail('Maximum 20 accounts');
    const method=b?.method||'password',spec=METHODS.find(m=>m.id===method&&m.supported);
    if(!spec)fail('Unsupported authentication method');
    const a={method,name:field(b,'name',80),env:field(b,'env',120),region:field(b,'region',60),publishableKey:field(b,'publishableKey',4096)};
    a.username=spec.oauth||method==='ticket'?a.name:field(b,'username',128);
    if(method==='sms'&&a.region!=='ap-shanghai')fail('SMS login is only supported in ap-shanghai');
    if(method==='sms'&&!/^\+[1-9]\d{6,14}$/.test(a.username.replace(/ /g,'')))fail('Use international phone format, e.g. +8613800000000');
    if(method==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.username))fail('Invalid email address');
    if(store.data.accounts.some(x=>x.env===a.env&&x.username===a.username&&(x.method||'password')===method))fail('This account already exists');
    adding=true;
    try{
     if(p.endsWith('/add')){
      if(method==='password')a.password=typeof b?.password==='string'&&b.password.length<=2048&&b.password.length?b.password:fail('Invalid password');
      else if(method==='ticket')a.ticket=field(b,'ticket',16000);
      else fail('Use the challenge login flow');
      json(res,201,await pool.login(a));
     }else{
      if(!spec.oauth&&!['sms','email'].includes(method))fail('Unsupported challenge login');
      if(!spec.oauth){const k=a.env+'|'+method+'|'+a.username;const now=Date.now();for(const [k,t] of otpSent)if(now-t>60000)otpSent.delete(k);if(otpSent.has(k))fail('Please wait 60 seconds before resending',429);otpSent.set(k,now);}
      json(res,200,await pool.begin(a,'http://'+req.headers.host+'/admin'));
     }
    }finally{adding=false}return true;
   }
   if(p==='/admin/api/accounts/verify'){
    const id=field(b,'id',80),value=field(b,'value',4096);
    json(res,201,await pool.finish(id,value,typeof b.state==='string'?b.state:null));return true;
   }
   if(p==='/admin/api/accounts/cancel'){await pool.cancel(field(b,'id',80));json(res,200,{ok:true});return true}
   if(p==='/admin/api/accounts/refresh'){
    const a=store.account(field(b,'id',80));if(!a)fail('Account not found',404);
    if(getActive())fail('Wait for active requests to finish',409);
    await pool.get(a).ensure(true);json(res,200,{ok:true});return true;
   }
   if(p==='/admin/api/accounts/toggle'){store.changeAccount(field(b,'id',80),boolean(b));json(res,200,{ok:true});return true}
   if(p==='/admin/api/accounts/remove'){
    const id=field(b,'id',80);if(getActive())fail('Wait for active requests to finish',409);
    // Remove local authorization only. The user can revoke remote sessions separately.
    store.changeAccount(id,false);await pool.close(id);store.removeAccount(id);json(res,200,{ok:true});return true
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
