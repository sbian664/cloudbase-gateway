'use strict';
const {Worker}=require('node:worker_threads');
const path=require('node:path'),crypto=require('node:crypto');
class AccountWorker{
 constructor(account,onSession){
  this.account=account;this.pending=new Map();this.ready=false;this.dead=false;this.lastError=null;
  this.worker=new Worker(path.join(__dirname,'account-worker.cjs'),{workerData:{env:account.env,region:account.region,publishableKey:account.publishableKey,session:account.session}});
  this.worker.on('message',m=>{
   if(m.type==='session'){try{onSession(m.session);this.account.session=m.session}catch{this.lastError='session_save_failed';this.ready=false}return}
   const p=this.pending.get(m.id);if(!p)return;
   if(m.type==='chunk'){p.queue.push(m.event);p.wake?.();return}
   this.pending.delete(m.id);clearTimeout(p.timer);p.cleanup?.();
   if(m.type==='error'){p.error=Object.assign(Error('CloudBase operation failed'),{code:m.code});this.lastError=m.code}
   else p.result=m.result;
   p.done=true;p.wake?.();
  });
  this.worker.on('error',()=>this.crash());this.worker.on('exit',()=>this.crash());
 }
 crash(){
  this.dead=true;this.ready=false;this.lastError='worker_unavailable';
  for(const p of this.pending.values()){clearTimeout(p.timer);p.cleanup?.();p.error=Object.assign(Error('Account worker exited'),{code:'worker_unavailable'});p.done=true;p.wake?.()}
  this.pending.clear();
 }
 request(op,args={},signal){
  if(this.dead)throw Object.assign(Error('Account worker offline'),{code:'worker_unavailable'});
  const id=crypto.randomUUID(),p={queue:[],done:false,wake:null};
  const abort=()=>{try{this.worker.postMessage({type:'abort',id})}catch{}};
  const cleanup=()=>signal?.removeEventListener('abort',abort);p.cleanup=cleanup;
  p.timer=setTimeout(()=>{this.pending.delete(id);cleanup();abort();p.error=Object.assign(Error('Account operation timed out'),{code:'upstream_timeout'});p.done=true;p.wake?.()},130000);
  this.pending.set(id,p);
  try{this.worker.postMessage({id,op,...args})}catch(e){this.pending.delete(id);clearTimeout(p.timer);throw e}
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  p.abort=abort;
  return p;
 }
 async call(op,args={},signal){
  const p=this.request(op,args,signal);
  while(!p.done)await new Promise(r=>p.wake=r);
  if(p.error)throw p.error;
  return p.result;
 }
 async ensure(force=false){
  try{const s=await this.call('ensure',{force});this.ready=true;this.lastError=null;return s}
  catch(e){this.ready=false;this.lastError=e.code;throw e}
 }
 async *stream(input,signal){
  const p=this.request('stream',{input},signal);
  try{while(!p.done||p.queue.length){if(p.queue.length)yield p.queue.shift();else await new Promise(r=>p.wake=r)}if(p.error)throw p.error}
  finally{if(!p.done)p.abort()}
 }
 async close(){await this.worker.terminate()}
 state(){return {ready:this.ready&&!this.dead,connected:!this.dead,lastError:this.lastError}}
}
class AccountPool{
 constructor(store,{make=(a,fn)=>new AccountWorker(a,fn)}={}){this.store=store;this.make=make;this.workers=new Map();this.logins=new Map()}
 get(a){let w=this.workers.get(a.id);if(!w||w.dead){w=this.make(a,s=>this.store.updateSession(a.id,s));this.workers.set(a.id,w)}return w}
 newLogin(fields){
  if(this.store.data.accounts.length>=20)throw Object.assign(Error('Maximum 20 accounts'),{status:400});
  const {name,env,region,publishableKey,username,method='password'}=fields;
  const a={name,env,region,publishableKey,username,method,id:crypto.randomUUID(),createdAt:new Date().toISOString(),enabled:true};
  const w=this.make(a,s=>{a.session=s;if(this.store.account(a.id))this.store.updateSession(a.id,s)});
  return {a,w};
 }
 finishLogin(a,w,result){
  if(!a.session)throw Error('No session returned');
  if(result?.identity)a.identity=result.identity;
  if(this.store.data.accounts.length>=20||this.store.data.accounts.some(x=>x.env===a.env&&((a.identity&&x.identity===a.identity)||(x.username===a.username&&(x.method||'password')===a.method))))throw Object.assign(Error('Account already exists or account limit reached'),{status:409});
  this.store.addAccount(a);w.ready=true;this.workers.set(a.id,w);return this.store.publicAccount(a);
 }
 async login(fields){
  const {a,w}=this.newLogin(fields);
  try{
   const result=await w.call(a.method==='ticket'?'login_ticket':'login',a.method==='ticket'?{ticket:fields.ticket}:{username:fields.username,password:fields.password});
   return this.finishLogin(a,w,result);
  }catch(e){await w.close();throw e}
 }
 async begin(fields,redirect){
  if(this.logins.size>=4)throw Object.assign(Error('Too many pending logins'),{status:429});
  const {a,w}=this.newLogin(fields);const id=crypto.randomUUID(),state=crypto.randomBytes(32).toString('hex');
  const flow={a,w,state,attempts:0,busy:true};
  this.logins.set(id,flow);
  flow.timer=setTimeout(()=>this.cancel(id).catch(()=>{}),5*60*1000);flow.timer.unref();
  try{
   const otp=['sms','email'].includes(a.method);
   const result=await w.call(otp?'otp_start':'oauth_start',otp?{method:a.method,identity:a.username}:{provider:a.method,redirect,state});
   flow.busy=false;return {id,state,...result};
  }catch(e){await this.cancel(id);throw e}
 }
 async finish(id,value,state){
  const f=this.logins.get(id);
  if(!f||f.busy)throw Object.assign(Error('Login expired or busy'),{status:409});
  const otp=['sms','email'].includes(f.a.method);
  if(!otp&&state!==f.state)throw Object.assign(Error('Invalid OAuth state'),{status:400});
  if(++f.attempts>5){await this.cancel(id);throw Object.assign(Error('Too many attempts'),{status:429})}
  f.busy=true;
  try{
   const r=await f.w.call(otp?'otp_verify':'oauth_verify',otp?{token:value}:{code:value,state});
   const account=this.finishLogin(f.a,f.w,r);
   clearTimeout(f.timer);this.logins.delete(id);return account;
  }catch(e){if(!otp||f.a.session||f.attempts>=5)await this.cancel(id);else f.busy=false;throw e}
 }
 async cancel(id){const f=this.logins.get(id);if(f){this.logins.delete(id);clearTimeout(f.timer);await f.w.close()}}
 async close(id){const w=this.workers.get(id);if(w){this.workers.delete(id);await w.close()}}
 async closeAll(){await Promise.all([...this.workers.keys()].map(id=>this.close(id)).concat([...this.logins.keys()].map(id=>this.cancel(id))))}
 state(id){return this.workers.get(id)?.state()||{ready:false,connected:false,lastError:null}}
}
module.exports={AccountPool,AccountWorker};
