'use strict';
const METHODS=[
 {id:'password',name:'用户名密码',group:'常规登录',supported:true},
 {id:'sms',name:'短信验证码',group:'常规登录',supported:true},
 {id:'email',name:'邮箱验证码',group:'常规登录',supported:true},
 {id:'wx_open',name:'微信开放平台',group:'社交登录',supported:true,oauth:true},
 {id:'google',name:'Google Web 端',group:'社交登录',supported:true,oauth:true},
 {id:'github',name:'GitHub Web 端',group:'社交登录',supported:true,oauth:true},
 {id:'apple',name:'Apple',group:'社交登录',supported:true,oauth:true},
 {id:'ticket',name:'自定义登录',group:'社交登录',supported:true},
 {id:'wx_assistant',name:'微信云服务助手小程序',group:'社交登录',supported:false,reason:'需要微信小程序原生身份，非 Web OAuth 身份源'}
];
function check(r){if(r?.error||r?.error_code)throw Object.assign(Error('Authentication failed'),{code:r.error?.code||r.error_code||'auth_error'});return r}
function session(r){const s=check(r)?.data?.session;if(!s?.access_token||!s?.refresh_token)throw Object.assign(Error('No session'),{code:'login_required'});return s}
class LoginFlow{
 constructor(manager){this.manager=manager;this.auth=manager.auth;this.pending=null}
 async complete(r){const s=session(r);this.manager.store(s);const u=s.user||r.data?.user;return {identity:u?.id||u?.uid||null}}
 async password(username,password){return this.complete(await this.auth.signInWithPassword({username,password}))}
 async ticket(ticket){return this.complete(await this.auth.signInWithCustomTicket(async()=>ticket))}
 async startOtp(method,identity){
  const r=check(await this.auth.signInWithOtp({[method==='sms'?'phone':'email']:identity,options:{shouldCreateUser:false}}));
  if(typeof r?.data?.verifyOtp!=='function')throw Error('No OTP verification callback');
  this.pending={kind:'otp',verify:r.data.verifyOtp};return {sent:true}
 }
 async verifyOtp(token){if(this.pending?.kind!=='otp')throw Error('No active OTP flow');const result=await this.complete(await this.pending.verify({token}));this.pending=null;return result}
 async startOAuth(provider,redirect,state){
  if(!METHODS.some(m=>m.id===provider&&m.oauth))throw Error('Unsupported OAuth provider');
  const r=check(await this.auth.genProviderRedirectUri({provider_id:provider,provider_redirect_uri:redirect,state}));
  let url;try{url=new URL(r.uri)}catch{url=new URL(decodeURIComponent(r.uri))}if(url.protocol!=='https:'||url.username||url.password)throw Error('Invalid OAuth redirect');
  this.pending={kind:'oauth',provider,redirect,state};return {url:url.href}
 }
 async verifyOAuth(code,state){
  const p=this.pending;if(p?.kind!=='oauth'||p.state!==state)throw Object.assign(Error('Invalid OAuth state'),{code:'invalid_state'});
  this.pending=null;
  const r=check(await this.auth.grantProviderToken({provider_id:p.provider,provider_redirect_uri:p.redirect,provider_code:code}));
  if(!r.provider_token)throw Error('No provider token');
  if(p.provider==='wx_open'){
   check(await this.auth.signInWithProvider({provider_token:r.provider_token}));
   return this.complete(await this.auth.getSession());
  }
  return this.complete(await this.auth.signInWithIdToken({token:r.provider_token}));
 }
}
module.exports={METHODS,LoginFlow};
