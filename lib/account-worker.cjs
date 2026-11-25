'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {AuthManager}=require('./auth.cjs');
const {CloudAdapter}=require('./adapter.cjs');
const {LoginFlow}=require('./login-methods.cjs');
const cfg=workerData;
const auth=new AuthManager(cfg,{persist:c=>parentPort.postMessage({type:'session',session:c.session})});
const adapter=new CloudAdapter(auth),running=new Map(),login=new LoginFlow(auth);
parentPort.on('message',async m=>{
 if(m.type==='abort'){running.get(m.id)?.abort();return}
 const ctl=new AbortController();running.set(m.id,ctl);
 const send=(type,data)=>parentPort.postMessage({id:m.id,type,...data});
 try{
  let result;
  switch(m.op){
   case 'login':result=await login.password(m.username,m.password);break;
   case 'login_ticket':result=await login.ticket(m.ticket);break;
   case 'otp_start':result=await login.startOtp(m.method,m.identity);break;
   case 'otp_verify':result=await login.verifyOtp(m.token);break;
   case 'oauth_start':result=await login.startOAuth(m.provider,m.redirect,m.state);break;
   case 'oauth_verify':result=await login.verifyOAuth(m.code,m.state);break;
   case 'ensure':await auth.ensure(!!m.force);result=auth.state();break;
   case 'generate':result=await adapter.generate(m.input,ctl.signal);break;
   case 'stream':for await(const event of adapter.stream(m.input,ctl.signal))send('chunk',{event});break;
   case 'logout':await auth.ensure();{const r=await auth.auth.signOut();if(r?.error)throw Object.assign(Error('Sign out failed'),{code:r.error.code})}result=true;break;
   default:throw Error('Unknown worker operation');
  }
  send('done',{result});
 }catch(e){send('error',{code:typeof e.code==='string'?e.code:'upstream_error'})}
 finally{running.delete(m.id)}
});
