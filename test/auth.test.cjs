'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {AuthManager}=require('../lib/auth.cjs');
const session=(n)=>({access_token:'access-'+n,refresh_token:'refresh-'+n,expires_in:7200});
const ok=s=>({data:{session:s},error:null});
function setup(saved){
 let current=null,refreshes=0,restores=0,writes=0;
 const a={signInWithPassword:async({username,password})=>{assert.equal(username,'test');assert.equal(password,'password');current=session(1);return ok(current)},getSession:async()=>ok(current),setSession:async(s)=>{restores++;current={...s,expires_in:7200};return ok(current)},refreshSession:async()=>{refreshes++;current=session(refreshes+10);return ok(current)},signOut:async()=>({error:null})};
 const cfg={env:'offline',region:'ap-shanghai',publishableKey:'placeholder',...(saved?{session:saved}:{})};
 const manager=new AuthManager(cfg,{createApp:()=>({auth:a}),persist:()=>{writes++}});
 return {manager,cfg,stats:()=>({refreshes,restores,writes})};
}
test('login persists session but not password',async()=>{
 const {manager,cfg,stats}=setup();await manager.login('test','password');assert.equal(cfg.session.access_token,'access-1');assert.equal(stats().writes,1);assert.ok(!JSON.stringify(cfg).includes('password'));
});
test('restore and reuse a session',async()=>{
 const {manager,stats}=setup({...session(1),expiresAt:Date.now()+7200000});
 await manager.ensure();await manager.ensure();assert.equal(stats().restores,1);assert.equal(stats().refreshes,0);assert.equal(manager.state().ready,true);
});
test('expired session refresh is single-flight',async()=>{
 const {manager,stats,cfg}=setup({...session(1),expiresAt:Date.now()-1});
 await Promise.all(Array.from({length:6},()=>manager.ensure()));
 assert.equal(stats().refreshes,1);assert.equal(cfg.session.refresh_token,'refresh-11');
});

test('real Node SDK initializes with its required receiver, without network calls',()=>{
 const {execFileSync}=require('node:child_process');
 execFileSync(process.execPath,['-e',`
  const assert=require('node:assert/strict');
  const {AuthManager}=require('./lib/auth.cjs');
  const manager=new AuthManager({env:'offline-test-env',region:'ap-shanghai',publishableKey:'offline-test-placeholder'},{persist:()=>{throw Error('Unexpected persistence')}});
  assert.equal(typeof manager.auth.signInWithPassword,'function');
  assert.equal(typeof manager.auth.getSession,'function');
  assert.equal(typeof manager.app.ai().createModel('cloudbase').generateText,'function');
  process.exit(0);
 `],{cwd:require('node:path').resolve(__dirname,'..'),timeout:5000});
});
