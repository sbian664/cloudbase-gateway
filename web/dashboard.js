'use strict';
const $=id=>document.getElementById(id);
const text=(id,v)=>{$(id).textContent=v??'—'};
const number=x=>Number(x||0).toLocaleString('zh-CN');
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTime=x=>x?new Date(x).toLocaleString('zh-CN',{hour12:false}):'—';
const duration=x=>x==null?'—':x<1000?x+' ms':(x/1000).toFixed(2)+' s';
const pageNames={overview:['运行概览','掌握本地 API 网关的运行与使用情况。'],channels:['渠道管理','管理 CloudBase 云函数 / 云托管与微信小程序原生通道。'],accounts:['账号管理','配置你的云函数/云托管端点与小程序原生桥接。'],keys:['API Keys','为客户端签发独立访问密钥。'],models:['模型管理','控制网关公开的候选模型。'],logs:['请求日志','检查真实请求结果、耗时及用量。'],settings:['系统设置','管理运行参数和本地安全策略。']};
let admin=sessionStorage.getItem('cbg-admin')||'',state=null,view='overview',polling=false,submitting=false;
const methodLabels={scf_node_sdk:'云函数 / 云托管 (Node SDK)',wx_miniprogram:'小程序原生 (wx.cloud.extend.AI)'};
const methodHints={
 scf_node_sdk:'连接已部署在 CloudBase 环境的 HTTP 云函数或云托管服务（cloudbase-scf-bridge），由官方 @cloudbase/node-sdk 调用模型，无需开开发者工具或维护 Web 会话。',
 wx_miniprogram:'通过本地 WebSocket 反向桥接微信开发者工具中的 wx.cloud.extend.AI，支持原生小程序调用、SSE 流式输出与多请求并发。'
};
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
 const scfAccounts=s.accounts.filter(a=>a.method==='scf_node_sdk'),wxAccounts=s.accounts.filter(a=>a.method==='wx_miniprogram');
 const scfEnabled=scfAccounts.filter(a=>a.enabled&&!a.runtime?.lastError).length;
 const wxOnline=wxAccounts.filter(a=>a.enabled&&a.runtime?.connected).length;
 const parts=[];
 if(scfEnabled)parts.push('云函数/云托管 '+scfEnabled);
 if(wxOnline)parts.push('小程序在线 '+wxOnline);
 text('runtime-status',s.active?'进行中 '+s.active+' 个请求':parts.length?parts.join(' · '):enabled.length?'等待连接或检测':'等待配置');
 text('scf-channel-count',scfAccounts.filter(a=>a.enabled).length+' / '+scfAccounts.length);
 text('wx-channel-count',wxOnline+' / '+wxAccounts.length);
 text('wx-bridge-url',s.bridgeUrl||('ws://'+location.host+'/bridge/wx'));
 $('base-url').value=location.origin+'/v1';text('listen-address',location.host);text('uptime',Math.floor(s.uptimeSec/3600)+'h '+Math.floor(s.uptimeSec%3600/60)+'m');
 $('accounts-table').innerHTML=s.accounts.length?s.accounts.map(a=>{
  const isScf=a.method==='scf_node_sdk',isWx=a.method==='wx_miniprogram';
  let status,detail,actions,envCol;
  if(isScf){
   const rt=a.runtime||{};
   status=!a.enabled?chip('已禁用'):rt.ready?chip('连通正常','good'):rt.lastError?chip('连通失败','bad'):chip('已配置');
   detail=rt.lastCheckedAt?'<small>最近检测：'+esc(fmtTime(rt.lastCheckedAt))+(rt.latencyMs!=null?' · '+esc(duration(rt.latencyMs)):'')+'</small>':'<small>Token 前缀：'+esc(a.tokenPrefix||'—')+'…</small>';
   envCol=esc(a.env)+'<small>'+esc(a.endpoint||a.region)+'</small>';
   actions=btn('测试连通','account-refresh',a.id)+btn('修改配置','account-edit-scf',a.id,'secondary')+btn(a.enabled?'禁用':'启用','account-toggle',a.id)+btn('移除','account-remove',a.id,'danger');
  }else if(isWx){
   const rt=a.runtime||{};
   status=!a.enabled?chip('已禁用'):rt.connected?chip('桥接在线','good'):chip('等待小程序连接','bad');
   const info=rt.clientInfo;
   detail=rt.connected?'<small>活跃请求：'+number(rt.activeRequests||0)+(info?.libVersion?' · 基础库 '+esc(info.libVersion):'')+'</small>':'<small>令牌前缀：'+esc(a.bridgeTokenPrefix||'—')+'…</small>';
   envCol=esc(a.env)+'<small>'+esc(a.region)+'</small>';
   actions=btn('检查连接','account-refresh',a.id)+btn('重置令牌','account-rotate-token',a.id,'secondary')+btn(a.enabled?'禁用':'启用','account-toggle',a.id)+btn('移除','account-remove',a.id,'danger');
  }else{
   status=chip('已弃用 (Web SDK)','bad');
   detail='<small>旧版渠道已移除，建议删除后改用新通道</small>';
   envCol=esc(a.env)+'<small>'+esc(a.region)+'</small>';
   actions=btn('移除','account-remove',a.id,'danger');
  }
  return '<tr><td><strong>'+esc(a.name)+'</strong><small>'+esc(a.username)+' · '+esc(methodLabels[a.method]||'旧版 Web SDK')+'</small></td><td>'+envCol+'</td><td>'+status+detail+(a.runtime?.lastError&&isScf||a.runtime?.lastError&&isWx?'<small>'+esc(a.runtime.lastError)+'</small>':'')+'</td><td><div class="actions">'+actions+'</div></td></tr>';
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
function syncMethod(){
 const f=$('account-form'),m=$('auth-method').value,isScf=m==='scf_node_sdk',isWx=m==='wx_miniprogram';
 $('endpoint-field').hidden=!isScf;f.elements.endpoint.disabled=!isScf;f.elements.endpoint.required=isScf;
 $('scftoken-field').hidden=!isScf;f.elements.scfToken.disabled=!isScf;f.elements.scfToken.required=isScf;
 $('appid-field').hidden=!isWx;f.elements.appId.disabled=!isWx;
 $('method-hint').textContent=methodHints[m]||'';
 $('account-submit').textContent=isScf?'校验连通并添加':'创建并生成桥接令牌';
}
function showBridgeConfig(info){
 const url=info.bridgeUrl||state?.bridgeUrl||('ws://'+location.host+'/bridge/wx');
 $('bridge-url-value').value=url;
 $('bridge-token-value').value=info.bridgeToken||'';
 $('bridge-bundle-value').value=JSON.stringify({bridgeUrl:url,bridgeToken:info.bridgeToken||'',envId:info.env||''});
 $('bridge-dialog').showModal();
}
function openAccount(method='scf_node_sdk'){
 if($('account-dialog').open)return;
 const f=$('account-form');f.reset();
 $('auth-method').value=method;syncMethod();text('account-error','');$('account-dialog').showModal();
}
$('add-account').onclick=()=>openAccount('scf_node_sdk');
$('auth-method').onchange=syncMethod;
$('account-form').onsubmit=async e=>{
 e.preventDefault();if(submitting)return;
 const form=e.target,submit=$('account-submit'),data=Object.fromEntries(new FormData(form));submitting=true;submit.disabled=true;submit.textContent='正在处理…';text('account-error','');
 try{
  const created=await api('accounts/add',data);
  form.reset();$('account-dialog').close();await load();
  if(created?.bridgeToken){showBridgeConfig(created);notify('小程序原生账号已创建，请将桥接配置粘贴到微信开发者工具中连接。')}
  else notify('云函数 / 云托管账号已验证连通并添加。');
 }catch(err){text('account-error',err.message)}
 finally{
  form.elements.scfToken.value='';data.scfToken='';submitting=false;submit.disabled=false;syncMethod();
 }
};
$('account-dialog').addEventListener('cancel',e=>{if(submitting)e.preventDefault()});
$('account-dialog').addEventListener('close',()=>{$('account-form').reset();syncMethod();text('account-error','')});

let editScfId=null;
$('scf-edit-form').onsubmit=async e=>{
 e.preventDefault();const f=e.target,b=f.querySelector('button[type=submit]');b.disabled=true;text('scf-edit-error','');
 try{
  const payload={id:editScfId,endpoint:$('scf-edit-endpoint').value.trim()};
  const tok=$('scf-edit-token').value.trim();
  if(tok)payload.scfToken=tok;
  await api('accounts/update-scf',payload);
  $('scf-edit-dialog').close();await load();notify('云函数 / 云托管配置已更新并通过连通测试。');
 }catch(err){text('scf-edit-error',err.message)}
 finally{$('scf-edit-token').value='';b.disabled=false}
};
$('scf-edit-dialog').addEventListener('close',()=>{$('scf-edit-token').value='';editScfId=null});

$('add-key').onclick=()=>{
 const usable=state.accounts.filter(a=>a.method==='scf_node_sdk'||a.method==='wx_miniprogram');
 if(!usable.length){notify('请先添加云函数/云托管或小程序原生账号。',true);return}
 $('key-form').reset();$('key-form').hidden=false;$('created-key').hidden=true;$('created-key-value').value='';text('key-error','');
 $('key-account').innerHTML=usable.map(a=>'<option value="'+esc(a.id)+'">'+esc(a.name)+' ('+esc(methodLabels[a.method]||a.method)+')</option>').join('');$('key-dialog').showModal()
};
$('key-form').onsubmit=async e=>{e.preventDefault();const submit=e.target.querySelector('button[type=submit]');submit.disabled=true;try{const k=await api('keys/create',Object.fromEntries(new FormData(e.target)));$('key-form').hidden=true;$('created-key').hidden=false;$('created-key-value').value=k.key;await load();notify('API Key 已创建。')}catch(err){text('key-error',err.message)}finally{submit.disabled=false}};
$('key-dialog').addEventListener('close',()=>{$('created-key-value').value='';$('key-form').hidden=false;$('created-key').hidden=true});

$('settings-form').onsubmit=e=>{e.preventDefault();mutate('settings',{maxConcurrent:Number($('concurrency').value)},'设置已保存。')};
async function copy(id){const el=$(id);try{await navigator.clipboard.writeText(el.value);notify('已复制。')}catch{el.select();notify('请按 Cmd/Ctrl+C 复制。')}}
$('copy-base').onclick=()=>copy('base-url');$('copy-key').onclick=()=>copy('created-key-value');
$('copy-bridge-url').onclick=()=>copy('bridge-url-value');$('copy-bridge-token').onclick=()=>copy('bridge-token-value');$('copy-bridge-bundle').onclick=()=>copy('bridge-bundle-value');
$('bridge-dialog').addEventListener('close',()=>{$('bridge-token-value').value='';$('bridge-bundle-value').value=''});

document.addEventListener('click',async e=>{
 const jump=e.target.closest('[data-jump]');if(jump){navigate(jump.dataset.jump);return}
 const close=e.target.closest('[data-close]');if(close){if(close.dataset.close==='account-dialog'&&submitting)return;$(close.dataset.close).close();return}
 const b=e.target.closest('[data-action]');if(!b||!state)return;const id=b.dataset.id,a=b.dataset.action;b.disabled=true;
 try{
  if(a==='method-add'){navigate('accounts');openAccount(id);return}
  if(a==='account-edit-scf'){
   const acct=state.accounts.find(x=>x.id===id);editScfId=id;
   text('scf-edit-account',acct.name+' · '+acct.env);
   $('scf-edit-endpoint').value=acct.endpoint||'';$('scf-edit-token').value='';text('scf-edit-error','');
   $('scf-edit-dialog').showModal();return;
  }
  if(a==='account-rotate-token'&&confirm('重置桥接令牌会立即断开当前小程序连接，需要重新粘贴新令牌。继续？')){
   try{const info=await api('accounts/rotate-bridge-token',{id});await load();showBridgeConfig(info);notify('桥接令牌已重置，请在小程序中更新配置。')}catch(err){notify(err.message,true)}return;
  }
  if(a==='account-refresh'){
   const acct=state.accounts.find(x=>x.id===id);
   await mutate('accounts/refresh',{id},acct?.method==='scf_node_sdk'?'云函数 / 云托管连通正常。':'小程序桥接在线正常。');
  }
  if(a==='account-toggle')await mutate('accounts/toggle',{id,enabled:!state.accounts.find(x=>x.id===id).enabled},'账号状态已更新。');
  if(a==='account-remove'&&confirm('移除此账号及绑定的 API Keys？'))await mutate('accounts/remove',{id},'账号已移除。');
  if(a==='key-toggle')await mutate('keys/toggle',{id,enabled:!state.keys.find(x=>x.id===id).enabled},'密钥状态已更新。');
  if(a==='key-remove'&&confirm('永久删除此 API Key？'))await mutate('keys/remove',{id},'密钥已删除。');
  if(a==='model-toggle')await mutate('models/toggle',{id,enabled:!state.models.find(x=>x.id===id).enabled},'模型状态已更新。');
 }finally{b.disabled=false}
});
if(admin)load().catch(()=>signOut());
setInterval(()=>{if(admin&&!document.querySelector('dialog[open]')&&view!=='settings')load(true).catch(()=>{})},5000);
