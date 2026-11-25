#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const readline=require('node:readline');
const {Writable}=require('node:stream');
const {AuthManager,readConfig,saveConfig,clearConfig,publicState,root}=require('./lib/auth.cjs');
const {CloudAdapter}=require('./lib/adapter.cjs');
const {createGateway}=require('./lib/server.cjs');
const cmd=process.argv[2]||'help';
const flag=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]};
const port=Number(flag('--port')||process.env.CBG_PORT||8787);
function config(){const c=readConfig();if(!c)throw Error('Run cloudbase-gateway login first');return c}
function acquire(){
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const lock=path.join(root,'session.lock');
 for(let attempt=0;attempt<2;attempt++){
  try{
   const fd=fs.openSync(lock,'wx',0o600);
   fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);
   let released=false;return ()=>{if(!released){released=true;try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock)}catch{}}};
  }catch(e){
   if(e.code!=='EEXIST')throw e;
   let pid;try{pid=Number(fs.readFileSync(lock,'utf8'))}catch{throw Error('Session lock is being created; retry later')}
   if(!Number.isInteger(pid)||pid<=0)throw Error('Invalid session lock; inspect '+lock);
   try{process.kill(pid,0);throw Error('Another gateway or auth command is running (PID '+pid+')')}catch(x){if(x.code!=='ESRCH')throw x;}
   fs.unlinkSync(lock);
  }
 }
 throw Error('Unable to acquire session lock');
}
async function ask(label,hidden=false){
 if(!process.stdin.isTTY)throw Error('Login requires an interactive terminal');
 // readline must own the visible prompt, otherwise its line refresh erases it.
 // Secret input is handled by a muted output stream; the prompt stays visible.
 const output=hidden?new Writable({write(chunk,enc,cb){cb()}}):process.stdout;
 const rl=readline.createInterface({input:process.stdin,output,terminal:true,historySize:0});
 if(hidden)process.stdout.write(label+' (hidden) ');
 let onClose;
 try{return await new Promise((resolve,reject)=>{
   rl.once('SIGINT',()=>reject(Error('Cancelled')));
   onClose=()=>reject(Error('Input closed'));
   rl.once('close',onClose);
   rl.question(hidden?'':label,answer=>{rl.removeListener('close',onClose);resolve(answer)});
 })}
 finally{if(onClose)rl.removeListener('close',onClose);rl.close();if(hidden)process.stdout.write('\n')}
}
async function main(){
 if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Port must be an integer from 1024 to 65535');
 if(cmd==='help'||cmd==='--help'||cmd==='-h'){console.log('CloudBase Gateway 0.1.0\nUsage: cloudbase-gateway login | start [--port 8787] | status | refresh | logout | key\nOfficial Web SDK only; Web-channel authorization and billing apply.');return}
 if(cmd==='status'){
  try{const r=await fetch('http://127.0.0.1:'+port+'/healthz',{signal:AbortSignal.timeout(4000)});console.log(JSON.stringify(await r.json(),null,2));process.exitCode=r.ok?0:1;return}catch{}
  console.log(JSON.stringify({gateway:'offline',...publicState(readConfig())},null,2));return;
 }
 if(cmd==='key'){
  if(!process.stdout.isTTY)throw Error('Print key only in an interactive terminal');
  console.log(config().apiKey);return;
 }
 if(!['login','start','refresh','logout'].includes(cmd))throw Error('Unknown command; use help');
 const release=acquire();
 if(cmd==='start'){
  try{
   const cfg=config();const auth=new AuthManager(cfg);
   await auth.ensure();const server=createGateway({auth,adapter:new CloudAdapter(auth),apiKey:cfg.apiKey,log:x=>console.log(new Date().toISOString(),JSON.stringify(x))});
   server.on('error',e=>{console.error('Gateway failed:',e.code||'server_error');release();process.exit(1)});
   server.listen(port,'127.0.0.1',()=>{console.log('CloudBase Gateway 0.1.0');console.log('Endpoint: http://127.0.0.1:'+port+'/v1');console.log('Channel: official Web SDK | Session: ready');console.log('API key: run cloudbase-gateway key in another terminal');console.log('RSS: '+(process.memoryUsage().rss/1048576).toFixed(1)+' MiB')});
   const interval=setInterval(()=>auth.ensure().catch(()=>{}),60000);interval.unref();
   let stopping=false;
   function stop(){if(stopping)return;stopping=true;clearInterval(interval);server.close(()=>{release();process.exit(0)});setTimeout(()=>{release();process.exit(0)},5000).unref()}
   process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('exit',release);
  }catch(e){release();throw e}
  return;
 }
 try{
  if(cmd==='login'){
   const old=readConfig();
   console.log('CloudBase Gateway | 登录向导（共 5 步，密钥和密码不回显）');
   const env=(await ask('[1/5] Environment ID'+(old?.env?' ['+old.env+']':'')+': ')).trim()||old?.env;
   const region=(await ask('[2/5] Region ['+(old?.region||'ap-shanghai')+']: ')).trim()||old?.region||'ap-shanghai';
   const publishableKey=(await ask('[3/5] CloudBase Publishable Key (not server API Key): ',true)).trim();
   const username=(await ask('[4/5] CloudBase username: ')).trim();const password=await ask('[5/5] Password: ',true);
   if(!env||!publishableKey||!username||!password)throw Error('Required fields missing');
   const cfg={env,region,publishableKey,apiKey:old?.apiKey||'sk-cbg-'+crypto.randomBytes(32).toString('hex')};
   const auth=new AuthManager(cfg);
   await auth.login(username,password);console.log(JSON.stringify(auth.state(),null,2));return;
  }
  if(cmd==='logout'&&process.argv.includes('--local')){clearConfig();console.log('Local session removed; remote session was not revoked.');return;}
  const auth=new AuthManager(config());
  if(cmd==='refresh'){await auth.ensure(true);console.log(JSON.stringify(auth.state(),null,2))}
  if(cmd==='logout'){await auth.logout();console.log('Signed out; local session removed.')}
 }finally{release()}
}
main().then(()=>{
 if(cmd!=='start')process.exit(process.exitCode||0);
}).catch(e=>{
 console.error('Error:',e.code||'operation_failed',String(e.message||'').replace(/Bearer\s+\S+/gi,'Bearer [redacted]'));
 process.exit(1);
});
