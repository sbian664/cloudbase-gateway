'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sdk = require('@cloudbase/js-sdk');
const root = process.env.CBG_CONFIG_DIR || path.join(os.homedir(), '.config', 'cloudbase-gateway');
const filename = path.join(root, 'config.json');
function secureDir(){fs.mkdirSync(root,{recursive:true,mode:0o700});fs.chmodSync(root,0o700);}
function readConfig(){try{return JSON.parse(fs.readFileSync(filename,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function saveConfig(cfg){
 secureDir();const tmp=filename+'.'+crypto.randomUUID();
 try{fs.writeFileSync(tmp,JSON.stringify(cfg,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,filename);}
 finally{try{fs.unlinkSync(tmp)}catch{}}
}
function clearConfig(){try{fs.unlinkSync(filename)}catch(e){if(e.code!=='ENOENT')throw e}}
function authError(r){if(r?.error)throw Object.assign(new Error(r.error.message||'CloudBase authentication failed'),{code:r.error.code||'auth_error'});}
function sessionOf(r){authError(r);const s=r?.data?.session;if(!s?.access_token||!s?.refresh_token)throw Object.assign(new Error('No valid session; run login again'),{code:'login_required'});return s;}
function jwtExpiry(token){try{const data=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));return Number(data.exp)>0?Number(data.exp)*1000:null}catch{return null}}
function capture(s,old){const expiresAt=jwtExpiry(s.access_token)||(old?.access_token===s.access_token&&old.expiresAt?old.expiresAt:Date.now()+Number(s.expires_in||7200)*1000);return {access_token:s.access_token,refresh_token:s.refresh_token,expiresAt};}
function publicState(cfg){return {authenticated:!!cfg?.session?.access_token,environment:cfg?.env||null,region:cfg?.region||null,expiresAt:cfg?.session?.expiresAt?new Date(cfg.session.expiresAt).toISOString():null,channel:'official-web-sdk'};}
class AuthManager{
 constructor(cfg,{createApp=(options)=>sdk.init(options),persist=saveConfig}={}){
  this.cfg=cfg;this.persist=persist;
  this.app=createApp({env:cfg.env,region:cfg.region,accessKey:cfg.publishableKey,persistence:'none',auth:{detectSessionInUrl:false},timeout:30000});
  this.auth=typeof this.app.auth?.signInWithPassword==='function'?this.app.auth:this.app.auth({persistence:'none'});
  this.ready=false;this.inflight=null;this.lastError=null;
 }
 store(s){this.cfg.session=capture(s,this.cfg.session);this.persist(this.cfg);this.ready=true;this.lastError=null;return s}
 async login(username,password){const s=sessionOf(await this.auth.signInWithPassword({username,password}));return this.store(s)}
 async restore(){
  if(!this.cfg.session)throw Object.assign(new Error('Run login first'),{code:'login_required'});
  const {access_token,refresh_token,expiresAt}=this.cfg.session;
  const r=expiresAt>Date.now()+120000?await this.auth.setSession({access_token,refresh_token}):await this.auth.refreshSession(refresh_token);
  return this.store(sessionOf(r));
 }
 async ensure(force=false){
  if(this.inflight)return this.inflight;
  this.inflight=(async()=>{
    try{
      if(!this.ready)await this.restore();
      const s=sessionOf(await this.auth.getSession());
      const next=capture(s,this.cfg.session);
      if(s.access_token!==this.cfg.session.access_token||s.refresh_token!==this.cfg.session.refresh_token)this.store(s);
      if(force||next.expiresAt<=Date.now()+120000)return this.store(sessionOf(await this.auth.refreshSession(s.refresh_token)));
      this.lastError=null;return s;
    }catch(e){this.ready=false;this.lastError=e.code||'auth_error';throw e}
  })().finally(()=>{this.inflight=null});
  return this.inflight;
 }
 async sync(){if(!this.ready)return;try{const s=sessionOf(await this.auth.getSession());if(s.access_token!==this.cfg.session?.access_token||s.refresh_token!==this.cfg.session?.refresh_token)this.store(s)}catch{this.ready=false;this.lastError='session_sync_failed'}}
 state(){return {...publicState(this.cfg),ready:this.ready&&this.cfg.session?.expiresAt>Date.now(),lastError:this.lastError}}
 async logout(){if(this.cfg.session){await this.ensure();authError(await this.auth.signOut())}clearConfig();this.ready=false}
}
module.exports={AuthManager,readConfig,saveConfig,clearConfig,publicState,root};
