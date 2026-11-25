'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {MODEL_IDS}=require('./adapter.cjs');
const dir=process.env.CBG_WEB_DIR||path.join(os.homedir(),'.config','cloudbase-gateway','webui');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const secret=prefix=>prefix+crypto.randomBytes(32).toString('hex');
function fail(message,status=400){throw Object.assign(Error(message),{status,code:'invalid_request'})}
function atomic(file,data){
 const tmp=file+'.'+crypto.randomUUID();
 try{fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,file)}
 finally{try{fs.unlinkSync(tmp)}catch{}}
}
class WebStore{
 constructor(root=dir){
  this.root=root;fs.mkdirSync(root,{recursive:true,mode:0o700});fs.chmodSync(root,0o700);
  this.file=path.join(root,'state.json');
  try{this.data=JSON.parse(fs.readFileSync(this.file,'utf8'))}
  catch(e){if(e.code!=='ENOENT')throw e;this.data={version:1,adminKey:secret('cbg-admin-'),accounts:[],keys:[],models:MODEL_IDS.map(id=>({id,enabled:true})),settings:{maxConcurrent:4},totals:{requests:0,success:0,errors:0,input:0,output:0,usageKnown:0},logs:[]};this.save()}
  fs.chmodSync(this.file,0o600);
 }
 save(){atomic(this.file,this.data)}
 isAdmin(key){return typeof key==='string'&&crypto.timingSafeEqual(Buffer.from(sha(key)),Buffer.from(sha(this.data.adminKey)))}
 account(id){return this.data.accounts.find(a=>a.id===id)}
 publicAccount(a){
  const isWx=a.method==='wx_miniprogram',isScf=a.method==='scf_node_sdk';
  const channel=isScf?'cloudbase-scf-node-sdk':isWx?'wx-miniprogram-bridge':'legacy-web-sdk';
  return {id:a.id,name:a.name,env:a.env,region:a.region,username:a.username,method:a.method||'password',enabled:a.enabled,expiresAt:(isWx||isScf)?null:(a.session?.expiresAt||null),createdAt:a.createdAt,channel,hasSession:isScf?!!a.scfToken:isWx?true:!!a.session,appId:a.appId||null,bridgeTokenPrefix:a.bridgeTokenPrefix||null,endpoint:a.endpoint||null,tokenPrefix:a.tokenPrefix||null};
 }
 listAccounts(){return this.data.accounts.map(a=>this.publicAccount(a))}
 createScfAccount({name,env,region='ap-shanghai',endpoint,scfToken}){
  if(this.data.accounts.length>=20)fail('Maximum 20 accounts');
  if(this.data.accounts.some(x=>x.method==='scf_node_sdk'&&x.env===env&&x.name===name))fail('This SCF/CloudRun account already exists');
  const a={id:crypto.randomUUID(),name,env,region,username:new URL(endpoint).host,endpoint,scfToken,tokenPrefix:scfToken.slice(0,8),method:'scf_node_sdk',channel:'cloudbase-scf-node-sdk',enabled:true,createdAt:new Date().toISOString()};
  this.data.accounts.push(a);this.save();
  return this.publicAccount(a);
 }
 updateScfAccount(id,{endpoint,scfToken}){
  const a=this.account(id);
  if(!a||a.method!=='scf_node_sdk')fail('SCF/CloudRun account not found',404);
  if(endpoint){a.endpoint=endpoint;a.username=new URL(endpoint).host}
  if(scfToken){a.scfToken=scfToken;a.tokenPrefix=scfToken.slice(0,8)}
  this.save();
  return this.publicAccount(a);
 }
 createMiniprogramAccount({name,env,region='ap-shanghai',appId=''}){
  if(this.data.accounts.length>=20)fail('Maximum 20 accounts');
  if(this.data.accounts.some(x=>x.method==='wx_miniprogram'&&x.env===env&&x.name===name))fail('This miniprogram account already exists');
  const raw=secret('cbg-wx-');
  const a={id:crypto.randomUUID(),name,env,region,username:appId||'wx.cloud.extend.AI',appId:appId||'',method:'wx_miniprogram',channel:'wx-miniprogram-bridge',bridgeTokenHash:sha(raw),bridgeTokenPrefix:raw.slice(0,15),enabled:true,createdAt:new Date().toISOString()};
  this.data.accounts.push(a);this.save();
  return {...this.publicAccount(a),bridgeToken:raw};
 }
 rotateBridgeToken(id){
  const a=this.account(id);
  if(!a||a.method!=='wx_miniprogram')fail('Miniprogram account not found',404);
  const raw=secret('cbg-wx-');
  a.bridgeTokenHash=sha(raw);a.bridgeTokenPrefix=raw.slice(0,15);
  this.save();
  return {...this.publicAccount(a),bridgeToken:raw};
 }
 resolveBridgeToken(raw){
  if(typeof raw!=='string'||!raw||raw.length>200)return null;
  const h=Buffer.from(sha(raw));
  return this.data.accounts.find(a=>a.enabled&&a.method==='wx_miniprogram'&&typeof a.bridgeTokenHash==='string'&&a.bridgeTokenHash.length===h.length&&crypto.timingSafeEqual(Buffer.from(a.bridgeTokenHash),h))||null;
 }
 changeAccount(id,enabled){const a=this.account(id);if(!a)fail('Account not found',404);a.enabled=enabled;this.save()}
 removeAccount(id){if(!this.account(id))fail('Account not found',404);this.data.accounts=this.data.accounts.filter(a=>a.id!==id);this.data.keys=this.data.keys.filter(k=>k.accountId!==id);this.save()}
 publicKey(k){return {id:k.id,name:k.name,accountId:k.accountId,prefix:k.prefix,enabled:k.enabled,createdAt:k.createdAt,requests:k.requests||0,tokens:k.tokens||0}}
 keys(){return this.data.keys.map(k=>this.publicKey(k))}
 createKey(name,accountId){
  if(!this.account(accountId))fail('Choose an existing account');
  const raw=secret('sk-cbg-'),k={id:crypto.randomUUID(),name,accountId,prefix:raw.slice(0,15),hash:sha(raw),enabled:true,createdAt:new Date().toISOString(),requests:0,tokens:0};
  this.data.keys.push(k);this.save();return {...this.publicKey(k),key:raw};
 }
 resolveKey(raw){if(typeof raw!=='string'||raw.length>200)return null;const h=sha(raw);const k=this.data.keys.find(k=>k.enabled&&k.hash===h);const a=k&&this.account(k.accountId);return a?.enabled?{key:k,account:a}:null}
 changeKey(id,enabled){const k=this.data.keys.find(k=>k.id===id);if(!k)fail('Key not found',404);k.enabled=enabled;this.save()}
 removeKey(id){this.data.keys=this.data.keys.filter(k=>k.id!==id);this.save()}
 enabledModels(){return this.data.models.filter(m=>m.enabled).map(m=>m.id)}
 setModel(id,enabled){const m=this.data.models.find(m=>m.id===id);if(!m)fail('Unknown model',404);m.enabled=enabled;this.save()}
 setSettings(n){if(!Number.isInteger(n)||n<1||n>16)fail('Concurrency must be 1–16');this.data.settings.maxConcurrent=n;this.save()}
 record(event){
  const e={id:crypto.randomUUID(),at:new Date().toISOString(),accountId:event.accountId||null,keyId:event.keyId||null,model:event.model||null,stream:!!event.stream,status:event.status,code:event.code||null,category:event.category||null,upstreamStatus:event.upstreamStatus||null,ms:event.ms||0,usage:event.usage||null};
  this.data.logs.unshift(e);if(this.data.logs.length>500)this.data.logs.length=500;
  const t=this.data.totals;t.requests++;if(e.status==='ok')t.success++;else t.errors++;
  if(e.usage){t.input+=e.usage.prompt_tokens;t.output+=e.usage.completion_tokens;t.usageKnown++}
  const k=this.data.keys.find(k=>k.id===e.keyId);if(k){k.requests++;k.tokens+=e.usage?.total_tokens||0}
  this.save();
 }
}
module.exports={WebStore,dir,fail};
