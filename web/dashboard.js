'use strict';
const $=id=>document.getElementById(id);
const text=(id,v)=>{$(id).textContent=v??'—'};
const number=x=>Number(x||0).toLocaleString('zh-CN');
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTime=x=>x?new Date(x).toLocaleString('zh-CN',{hour12:false}):'—';
const duration=x=>x==null?'—':x<1000?x+' ms':(x/1000).toFixed(2)+' s';
const pageNames={overview:['运行概览','掌握本地 API 网关的运行与使用情况。'],channels:['渠道管理','管理已实现的官方上游与认证方式。'],accounts:['账号管理','连接你的 CloudBase 用户账号并管理会话。'],keys:['API Keys','为客户端签发独立访问密钥。'],models:['模型管理','控制网关公开的候选模型。'],logs:['请求日志','检查真实请求结果、耗时及用量。'],settings:['系统设置','管理运行参数和本地安全策略。']};
let admin=sessionStorage.getItem('cbg-admin')||'',state=null,view='overview',polling=false;
const api=async(path,payload)=>{
 const options={headers:{Authorization:'Bearer '+admin},cache:'no-store'};
 if(payload!==undefined){options.method='POST';options.headers['Content-Type']='application/json';options.body=JSON.stringify(payload)}
 const response=await fetch('/admin/api/'+path,options);
 const data=await response.json();
 if(response.status===401){signOut();throw Error('管理密钥无效或已退出')}
 if(!response.ok)throw Error(data.error||'请求失败：'+response.status);
 return data;
};
function signOut(){admin='';state=null;sessionStorage.removeItem('cbg-admin');$('shell').hidden=true;$('login-screen').hidden=false;$('admin-key').value='';for(const d of document.querySelectorAll('dialog[open]'))d.close()}
function notify(message,bad=false){text('notice',message);$('notice').classList.toggle('bad',bad);$('notice').hidden=false}
function navigate(name){if(!pageNames[name])return;view=name;for(const item of document.querySelectorAll('[data-view]')){item.classList.toggle('active',item.dataset.view===name);item.setAttribute('aria-current',item.dataset.view===name?'page':'false')}for(const el of document.querySelectorAll('.view'))el.hidden=el.id!=='view-'+name;text('title',pageNames[name][0]);text('subtitle',pageNames[name][1]);text('crumb',name.toUpperCase());$('notice').hidden=true;if(state)render()}
const empty=(n,msg)=>'<tr><td class="empty" colspan="'+n+'">'+esc(msg)+'</td></tr>';
const chip=(v,kind='')=>'<span class="chip '+kind+'">'+esc(v)+'</span>';
const btn=(label,action,id,cls='ghost')=>'<button type="button" class="'+cls+'" data-action="'+action+'" data-id="'+esc(id)+'">'+esc(label)+'</button>';
function accountName(id){return state.accounts.find(a=>a.id===id)?.name||'已移除账号'}
function renderLogs(){
 const filter=$('log-filter').value;const logs=state.logs.filter(l=>filter==='all'||l.status===filter);
 $('logs-table').innerHTML=logs.length?logs.map(l=>'<tr><td>'+esc(fmtTime(l.at))+'</td><td><strong>'+esc(l.model||'—')+'</strong><small>'+esc(accountName(l.accountId))+'</small></td><td>'+chip(l.status==='ok'?'成功':'失败',l.status==='ok'?'good':'bad')+'</td><td>'+esc(duration(l.ms))+'</td><td>'+esc(l.usage?number(l.usage.total_tokens):'未返回')+'</td><td>'+esc(l.code||'—')+'</td></tr>').join(''):empty(6,'暂无匹配的请求记录');
}
function render(){
 const s=state,t=s.totals,enabled=s.accounts.filter(a=>a.enabled),total=t.input+t.output,rate=t.requests?t.success/t.requests*100:0;
 text('stat-accounts',enabled.length+' / '+s.accounts.length);text('stat-requests',number(t.requests));text('stat-tokens',number(total));text('stat-rss',s.rssMiB+' MiB');text('success-rate',t.requests?rate.toFixed(1)+'%':'—');$('ring').style.setProperty('--percent',rate+'%');text('success-count',number(t.success));text('error-count',number(t.errors));text('latency-note',s.latency.p50==null?'暂无耗时样本':'近 500 条内成功请求 P50 '+duration(s.latency.p50)+' · P95 '+duration(s.latency.p95));
 text('token-total',number(total));text('token-in',number(t.input));text('token-out',number(t.output));$('bar-in').style.width=(total?t.input/total*100:0)+'%';$('bar-out').style.width=(total?t.output/total*100:0)+'%';
 const ready=enabled.filter(a=>a.hasSession&&a.expiresAt>Date.now()&&a.runtime.ready).length;
 text('runtime-status',s.active?'进行中 '+s.active+' 个请求':ready?'已验证会话 '+ready+' 个':enabled.length?'会话待检查':'等待授权');text('channel-count',s.accounts.length);
 $('base-url').value=location.origin+'/v1';text('listen-address',location.host);text('uptime',Math.floor(s.uptimeSec/3600)+'h '+Math.floor(s.uptimeSec%3600/60)+'m');
 $('accounts-table').innerHTML=s.accounts.length?s.accounts.map(a=>{
  const status=!a.enabled?chip('已禁用'):!a.hasSession?chip('未登录','bad'):a.expiresAt<=Date.now()?chip('待刷新','bad'):a.runtime.ready?chip('已验证','good'):chip('会话已保存');
  return '<tr><td><strong>'+esc(a.name)+'</strong><small>'+esc(a.username)+'</small></td><td>'+esc(a.env)+'<small>'+esc(a.region)+'</small></td><td>'+status+'<small>过期：'+esc(fmtTime(a.expiresAt))+'</small>'+(a.runtime.lastError?'<small>'+esc(a.runtime.lastError)+'</small>':'')+'</td><td><div class="actions">'+btn('刷新','account-refresh',a.id)+btn(a.enabled?'禁用':'启用','account-toggle',a.id)+btn('移除','account-remove',a.id,'danger')+'</div></td></tr>'
 }).join(''):empty(4,'还没有账号。点击「添加账号」开始配置。');
 $('keys-table').innerHTML=s.keys.length?s.keys.map(k=>'<tr><td><strong>'+esc(k.name)+'</strong><small>'+esc(k.prefix)+'…</small></td><td>'+esc(accountName(k.accountId))+'</td><td>'+number(k.requests)+' / '+number(k.tokens)+'</td><td>'+chip(k.enabled?'启用':'禁用',k.enabled?'good':'')+'</td><td><div class="actions">'+btn(k.enabled?'禁用':'启用','key-toggle',k.id)+btn('删除','key-remove',k.id,'danger')+'</div></td></tr>').join(''):empty(5,'尚未创建 API Key。');
 $('model-list').innerHTML=s.models.map(m=>'<div class="model-item"><div><strong>'+esc(m.id)+'</strong><small>CloudBase · Text</small></div>'+btn(m.enabled?'已启用':'已禁用','model-toggle',m.id,m.enabled?'secondary':'ghost')+'</div>').join('');
 if(document.activeElement!==$('concurrency'))$('concurrency').value=s.settings.maxConcurrent;
 renderLogs();text('sync-state','已同步 '+new Date().toLocaleTimeString('zh-CN',{hour12:false}));
}
async function load(silent=false){
 if(polling||!admin)return;polling=true;
 try{state=await api('overview');$('login-screen').hidden=true;$('shell').hidden=false;render()}
 catch(e){if(!silent)notify(e.message,true);throw e}
 finally{polling=false}
}
async function mutate(path,data,message){try{await api(path,data);await load();notify(message)}catch(e){notify(e.message,true)}}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();admin=$('admin-key').value.trim();$('admin-key').value='';try{await load();sessionStorage.setItem('cbg-admin',admin);text('login-error','')}catch(err){signOut();text('login-error',err.message)}});
$('logout').onclick=signOut;$('reload').onclick=()=>load().catch(()=>{});
$('nav').onclick=e=>{const b=e.target.closest('[data-view]');if(b)navigate(b.dataset.view)};
$('log-filter').onchange=()=>state&&renderLogs();
$('add-account').onclick=()=>{$('account-form').reset();text('account-error','');$('account-dialog').showModal()};
$('account-form').onsubmit=async e=>{
 e.preventDefault();const form=e.target,submit=form.querySelector('button[type=submit]'),data=Object.fromEntries(new FormData(form));submit.disabled=true;submit.textContent='正在验证…';text('account-error','');
 try{await api('accounts/add',data);form.reset();$('account-dialog').close();await load();notify('账号已添加，官方会话验证成功。')}
 catch(err){text('account-error',err.message)}
 finally{form.elements.password.value='';data.password='';submit.disabled=false;submit.textContent='验证登录并添加'}
};
$('add-key').onclick=()=>{
 if(!state.accounts.length){notify('请先添加授权账号。',true);return}
 $('key-form').reset();$('key-form').hidden=false;$('created-key').hidden=true;$('created-key-value').value='';text('key-error','');
 $('key-account').innerHTML=state.accounts.map(a=>'<option value="'+esc(a.id)+'">'+esc(a.name)+'</option>').join('');$('key-dialog').showModal()
};
$('key-form').onsubmit=async e=>{e.preventDefault();const submit=e.target.querySelector('button[type=submit]');submit.disabled=true;try{const k=await api('keys/create',Object.fromEntries(new FormData(e.target)));$('key-form').hidden=true;$('created-key').hidden=false;$('created-key-value').value=k.key;await load();notify('API Key 已创建。')}catch(err){text('key-error',err.message)}finally{submit.disabled=false}};
$('key-dialog').addEventListener('close',()=>{$('created-key-value').value='';$('key-form').hidden=false;$('created-key').hidden=true});
$('account-dialog').addEventListener('close',()=>{$('account-form').reset();text('account-error','')});
$('settings-form').onsubmit=e=>{e.preventDefault();mutate('settings',{maxConcurrent:Number($('concurrency').value)},'设置已保存。')};
async function copy(id){const el=$(id);try{await navigator.clipboard.writeText(el.value);notify('已复制。')}catch{el.select();notify('请按 Cmd/Ctrl+C 复制。')}}
$('copy-base').onclick=()=>copy('base-url');$('copy-key').onclick=()=>copy('created-key-value');
document.addEventListener('click',async e=>{
 const jump=e.target.closest('[data-jump]');if(jump){navigate(jump.dataset.jump);return}
 const close=e.target.closest('[data-close]');if(close){$(close.dataset.close).close();return}
 const b=e.target.closest('[data-action]');if(!b||!state)return;const id=b.dataset.id,a=b.dataset.action;b.disabled=true;
 try{
  if(a==='account-refresh')await mutate('accounts/refresh',{id},'会话刷新成功。');
  if(a==='account-toggle')await mutate('accounts/toggle',{id,enabled:!state.accounts.find(x=>x.id===id).enabled},'账号状态已更新。');
  if(a==='account-remove'&&confirm('移除本地账号及绑定的 API Keys？此操作不会注销远程会话。'))await mutate('accounts/remove',{id},'账号已移除。');
  if(a==='key-toggle')await mutate('keys/toggle',{id,enabled:!state.keys.find(x=>x.id===id).enabled},'密钥状态已更新。');
  if(a==='key-remove'&&confirm('永久删除此 API Key？'))await mutate('keys/remove',{id},'密钥已删除。');
  if(a==='model-toggle')await mutate('models/toggle',{id,enabled:!state.models.find(x=>x.id===id).enabled},'模型状态已更新。');
 }finally{b.disabled=false}
});
if(admin)load().catch(()=>signOut());
setInterval(()=>{if(admin&&!document.querySelector('dialog[open]')&&view!=='settings')load(true).catch(()=>{})},5000);
