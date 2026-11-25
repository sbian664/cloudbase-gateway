#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {WebStore,dir}=require('./lib/web-store.cjs');
const {ScfPool}=require('./lib/scf-adapter.cjs');
const {WxBridge}=require('./lib/wx-bridge.cjs');
const {createAdmin}=require('./lib/admin.cjs');
const {createGateway}=require('./lib/server.cjs');
const cmd=process.argv[2]||'start';
const pi=process.argv.indexOf('--port'),port=Number(pi<0?8788:process.argv[pi+1]);
function lock(root){
 const file=path.join(root,'web.lock');
 for(let i=0;i<2;i++){try{
  fs.writeFileSync(file,String(process.pid),{flag:'wx',mode:0o600});
  return ()=>{try{if(fs.readFileSync(file,'utf8')===String(process.pid))fs.unlinkSync(file)}catch{}};
 }catch(e){
  if(e.code!=='EEXIST')throw e;
  const pid=Number(fs.readFileSync(file,'utf8'));if(!Number.isInteger(pid)||pid<=0)throw Error('Invalid process lock');
  try{process.kill(pid,0);throw Error('WebUI is already running')}catch(x){if(x.code!=='ESRCH')throw x}
  fs.unlinkSync(file);
 }}
 throw Error('Could not acquire lock');
}
async function main(){
 if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
 const store=new WebStore();
 if(cmd==='admin-key'){
  if(!process.stdout.isTTY)throw Error('Run admin-key in your local interactive terminal');
  console.log(store.data.adminKey);return
 }
 if(cmd!=='start')throw Error('Usage: node web.cjs start [--port 8788] | admin-key');
 const release=lock(dir),scf=new ScfPool(),bridge=new WxBridge({store});let active=0;
 const manage=createAdmin({store,scf,bridge,port,getActive:()=>active});
 const server=createGateway({
  resolveKey(raw){
   const r=store.resolveKey(raw);if(!r)return null;
   if(r.account.method==='scf_node_sdk')return scf.route(r.account,r.key.id);
   if(r.account.method==='wx_miniprogram')return bridge.route(r.account,r.key.id);
   return {
    auth:{ensure:async()=>{throw Object.assign(Error('Legacy Web SDK channel is removed'),{code:'legacy_channel_removed',category:'authorization'})}},
    adapter:{},
    accountId:r.account.id,
    keyId:r.key.id
   };
  },
  handleAdmin:async(req,res,p)=>manage(req,res,p),
  getModels:()=>store.enabledModels(),
  getHealth:()=>{
   const enabled=store.data.accounts.filter(a=>a.enabled);
   const scfReady=enabled.filter(a=>a.method==='scf_node_sdk'&&scf.isAvailable(a)).length;
   const wxReady=enabled.filter(a=>a.method==='wx_miniprogram'&&bridge.state(a.id).connected).length;
   return {status:(scfReady||wxReady)?'ready':'not_ready',channel:'scf-and-miniprogram',accounts:enabled.length,scfReady,wxBridgeConnected:wxReady,upstream:'not actively probed'};
  },
  maxConcurrent:()=>store.data.settings.maxConcurrent,
  log:e=>{try{store.record(e)}catch{console.error('Unable to save request metrics')}console.log(JSON.stringify({model:e.model,status:e.status,ms:e.ms,code:e.code}))}
 });
 bridge.attach(server);
 // Count inference HTTP requests for safe management operations.
 server.prependListener('request',(req,res)=>{
  if(req.method==='POST'&&req.url?.split('?')[0]==='/v1/chat/completions'){active++;res.once('close',()=>active--)}
 });
 let stopping=false;
 async function stop(){if(stopping)return;stopping=true;bridge.closeAll();server.close();release();process.exit(0)}
 server.on('error',async e=>{console.error('WebUI error:',e.code||'server_error');await stop()});
 process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('exit',release);
 server.listen(port,'127.0.0.1',()=>console.log('CloudBase Gateway WebUI: http://127.0.0.1:'+port+'/admin\nAdmin key: node web.cjs admin-key\nChannels: CloudBase SCF/CloudRun (@cloudbase/node-sdk) + WeChat Mini Program WS Bridge (ws://127.0.0.1:'+port+'/bridge/wx)'));
}
main().catch(e=>{console.error('Error:',e.message);process.exitCode=1});
