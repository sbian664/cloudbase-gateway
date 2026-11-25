'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {LoginFlow,METHODS}=require('../lib/login-methods.cjs');
const {AccountPool}=require('../lib/account-pool.cjs');
const {WebStore}=require('../lib/web-store.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const session={access_token:'fixture-access',refresh_token:'fixture-refresh',user:{id:'fixture-user'}};
const result={data:{session},error:null};
function fixture(){
 const events=[];const auth={
 signInWithPassword:async p=>{events.push(['password',p]);return result},
 signInWithCustomTicket:async f=>{events.push(['ticket',await f()]);return result},
 signInWithOtp:async p=>{events.push(['otp',p]);return {data:{verifyOtp:async q=>{events.push(['verify',q]);return q.token==='123456'?result:{error:{code:'bad_otp'}}}}}},
 genProviderRedirectUri:async p=>{events.push(['redirect',p]);return {uri:'https://example.org/authorize'}},
 grantProviderToken:async p=>{events.push(['exchange',p]);return {provider_token:'fixture-provider-token'}},
 signInWithProvider:async p=>{events.push(['provider',p]);return {}},
 signInWithIdToken:async p=>{events.push(['idtoken',p]);return result},
 getSession:async()=>result};
 const manager={auth,store:s=>{events.push(['store',s]);}};
 return {flow:new LoginFlow(manager),events};
}
test('password and signed custom ticket use official SDK and common session path',async()=>{
 const {flow,events}=fixture();await flow.password('user','fixture-password');await flow.ticket('issued-ticket');
 assert.deepEqual(events.map(e=>e[0]),['password','store','ticket','store']);assert.equal(events[2][1],'issued-ticket');
});
for(const method of ['sms','email'])test(method+' OTP: existing user, code verification and rejection',async()=>{
 const {flow,events}=fixture();const identity=method==='sms'?'+8613800000000':'fixture@example.org';
 await flow.startOtp(method,identity);assert.equal(events[0][1].options.shouldCreateUser,false);
 await assert.rejects(flow.verifyOtp('000000'),e=>e.code==='bad_otp');
 await flow.verifyOtp('123456');assert.equal(events.at(-1)[0],'store');
 await assert.rejects(flow.verifyOtp('123456'));
});
for(const provider of ['wx_open','google','github','apple'])test(provider+' OAuth: same redirect, state check and one-use exchange',async()=>{
 const {flow,events}=fixture(),redirect='http://127.0.0.1:8788/admin';
 assert.equal((await flow.startOAuth(provider,redirect,'fixture-state')).url,'https://example.org/authorize');
 await assert.rejects(flow.verifyOAuth('code','bad-state'),e=>e.code==='invalid_state');
 assert.equal(events.length,1);
 await flow.verifyOAuth('code','fixture-state');assert.equal(events[1][1].provider_redirect_uri,redirect);
 assert.equal(events[2][0],provider==='wx_open'?'provider':'idtoken');
 assert.equal(events.at(-1)[0],'store');await assert.rejects(flow.verifyOAuth('code','fixture-state'));
});
test('native-only identity cannot start an OAuth flow',async()=>{
 const {flow}=fixture();assert.equal(METHODS.find(m=>m.id==='wx_assistant').supported,false);await assert.rejects(flow.startOAuth('wx_assistant','http://localhost','state'));
});
test('pending login lifecycle, account session only and cancellation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cbg-login-flow-'));const store=new WebStore(dir);
 let closed=0;
 const pool=new AccountPool(store,{make:(a,persist)=>({async call(op,args){
  if(op==='otp_start')return {sent:true};
  if(op==='oauth_start')return {url:'https://example.org'};
  if(op==='otp_verify'&&args.token!=='123456')throw Error('Invalid code');
  if(op==='otp_verify'||op==='oauth_verify'){persist({access_token:'fixture-token',refresh_token:'fixture-refresh',expiresAt:Date.now()+10000});return {identity:'uid-'+a.method}}
  throw Error('Unexpected op');
 },async close(){closed++}})});
 try{
  const base={name:'Fixture',env:'test-env',region:'ap-shanghai',publishableKey:'test-key',username:'fixture@example.org'};
  const otp=await pool.begin({...base,method:'email'},'http://localhost:8788/admin');
  await assert.rejects(pool.finish(otp.id,'000000'));
  const account=await pool.finish(otp.id,'123456');assert.equal(account.method,'email');
  await assert.rejects(pool.finish(otp.id,'123456'));
  const social=await pool.begin({...base,name:'OAuth fixture',method:'github'},'http://localhost:8788/admin');
  await assert.rejects(pool.finish(social.id,'code','wrong'));
  const socialAccount=await pool.finish(social.id,'code',social.state);assert.equal(socialAccount.method,'github');
  const extra=await pool.begin({...base,method:'google'},'http://localhost:8788/admin');
  await pool.cancel(extra.id);assert.equal(closed,1);
  const text=fs.readFileSync(store.file,'utf8');assert.ok(!text.includes('123456')&&!text.includes(social.state));
 }finally{await pool.closeAll();fs.rmSync(dir,{recursive:true,force:true})}
});
