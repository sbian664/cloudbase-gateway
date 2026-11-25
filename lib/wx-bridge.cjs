'use strict';
const crypto=require('node:crypto');
const {summarizeError}=require('./upstream-error.cjs');
const WS_GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD=2*1024*1024;
const DEFAULT_TIMEOUT=125000;
const safeShort=(v,max=80)=>typeof v==='string'&&v.trim()?v.trim().slice(0,max):null;
function encodeFrame(opcode,payload){
 const buf=Buffer.isBuffer(payload)?payload:Buffer.from(String(payload||''),'utf8');
 const len=buf.length;
 let header;
 if(len<126){
  header=Buffer.allocUnsafe(2);
  header[0]=0x80|opcode;header[1]=len;
 }else if(len<=65535){
  header=Buffer.allocUnsafe(4);
  header[0]=0x80|opcode;header[1]=126;header.writeUInt16BE(len,2);
 }else{
  header=Buffer.allocUnsafe(10);
  header[0]=0x80|opcode;header[1]=127;header.writeBigUInt64BE(BigInt(len),2);
 }
 return Buffer.concat([header,buf]);
}
class WsConnection{
 constructor(socket,{onMessage,onClose,onActivity}){
  this.socket=socket;this.onMessage=onMessage;this.onClose=onClose;this.onActivity=onActivity;
  this.buf=Buffer.alloc(0);this.fragments=[];this.fragLen=0;this.closed=false;
  this.socket.setNoDelay(true);
  this.socket.on('data',chunk=>this.onData(chunk));
  this.socket.on('close',()=>this.handleClose());
  this.socket.on('error',()=>this.handleClose());
 }
 sendText(text){
  if(this.closed||this.socket.destroyed||!this.socket.writable)return false;
  try{this.socket.write(encodeFrame(0x1,Buffer.from(text,'utf8')));return true}catch{return false}
 }
 sendJson(obj){return this.sendText(JSON.stringify(obj))}
 ping(){
  if(this.closed||this.socket.destroyed||!this.socket.writable)return;
  try{this.socket.write(encodeFrame(0x9,Buffer.alloc(0)))}catch{}
 }
 close(code=1000,reason=''){
  if(this.closed)return;
  this.closed=true;
  if(!this.socket.destroyed&&this.socket.writable){
   const r=Buffer.from(reason,'utf8').subarray(0,120);
   const p=Buffer.allocUnsafe(2+r.length);p.writeUInt16BE(code,0);r.copy(p,2);
   try{this.socket.end(encodeFrame(0x8,p))}catch{this.socket.destroy()}
  }else this.socket.destroy();
  this.onClose?.();
 }
 handleClose(){
  if(this.closed)return;
  this.closed=true;this.buf=Buffer.alloc(0);this.fragments=[];this.fragLen=0;
  this.onClose?.();
 }
 onData(chunk){
  if(this.closed||!chunk?.length)return;
  this.buf=this.buf.length?Buffer.concat([this.buf,chunk]):chunk;
  if(this.buf.length>MAX_PAYLOAD+64){this.close(1009,'Message too large');return}
  while(!this.closed&&this.buf.length>=2){
   const b0=this.buf[0],b1=this.buf[1];
   const fin=(b0&0x80)!==0,opcode=b0&0x0f;
   const masked=(b1&0x80)!==0;
   if(!masked){this.close(1002,'Client frames must be masked');return}
   let len=b1&0x7f,offset=2;
   if(len===126){
    if(this.buf.length<4)return;
    len=this.buf.readUInt16BE(2);offset=4;
   }else if(len===127){
    if(this.buf.length<10)return;
    const big=this.buf.readBigUInt64BE(2);
    if(big>BigInt(MAX_PAYLOAD)){this.close(1009,'Frame too large');return}
    len=Number(big);offset=10;
   }
   if(len>MAX_PAYLOAD){this.close(1009,'Frame too large');return}
   const total=offset+4+len;
   if(this.buf.length<total)return;
   const mask=this.buf.subarray(offset,offset+4);
   const payload=Buffer.allocUnsafe(len);
   for(let i=0;i<len;i++)payload[i]=this.buf[offset+4+i]^mask[i&3];
   this.buf=this.buf.subarray(total);
   this.onActivity?.();
   if(opcode===0x8){this.close(1000);return}
   if(opcode===0x9){if(!this.socket.destroyed&&this.socket.writable)try{this.socket.write(encodeFrame(0xA,payload))}catch{}continue}
   if(opcode===0xA)continue;
   if(opcode===0x2){this.close(1003,'Binary unsupported');return}
   if(opcode!==0x1&&opcode!==0x0){this.close(1002,'Unsupported opcode');return}
   if(opcode===0x1&&this.fragments.length){this.close(1002,'Unexpected text frame');return}
   if(opcode===0x0&&!this.fragments.length){this.close(1002,'Unexpected continuation');return}
   this.fragLen+=payload.length;
   if(this.fragLen>MAX_PAYLOAD){this.close(1009,'Message too large');return}
   this.fragments.push(payload);
   if(fin){
    const full=this.fragments.length===1?this.fragments[0]:Buffer.concat(this.fragments);
    this.fragments=[];this.fragLen=0;
    this.onMessage?.(full.toString('utf8'));
   }
  }
 }
}
class WxBridge{
 constructor({store,heartbeatMs=20000,staleMs=55000,requestTimeoutMs=DEFAULT_TIMEOUT,path='/bridge/wx'}={}){
  this.store=store;this.heartbeatMs=heartbeatMs;this.staleMs=staleMs;
  this.requestTimeoutMs=requestTimeoutMs;this.path=path;
  this.sessions=new Map();this.lastErrors=new Map();
  this.timer=setInterval(()=>this.sweep(),heartbeatMs);this.timer.unref();
 }
 attach(server){
  server.on('upgrade',(req,socket,head)=>this.handleUpgrade(req,socket,head));
  return this;
 }
 rejectUpgrade(socket,status,text){
  if(!socket.destroyed){try{socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)}catch{socket.destroy()}}
 }
 handleUpgrade(req,socket,head){
  let url;try{url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`)}catch{return this.rejectUpgrade(socket,400,'Bad Request')}
  if(url.pathname!==this.path)return this.rejectUpgrade(socket,404,'Not Found');
  if(String(req.headers.upgrade||'').toLowerCase()!=='websocket'||typeof req.headers['sec-websocket-key']!=='string')return this.rejectUpgrade(socket,400,'Bad Request');
  const authHeader=typeof req.headers.authorization==='string'&&req.headers.authorization.startsWith('Bearer ')?req.headers.authorization.slice(7).trim():'';
  const token=authHeader||url.searchParams.get('token')||'';
  const account=this.store?.resolveBridgeToken?.(token);
  if(!account)return this.rejectUpgrade(socket,401,'Unauthorized');
  const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key'].trim()+WS_GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  this.register(account,socket,head);
 }
 register(account,socket,head){
  const prev=this.sessions.get(account.id);
  if(prev)this.teardown(account.id,prev,4000,'replaced');
  const now=Date.now();
  const sess={accountId:account.id,connectedAt:new Date(now).toISOString(),lastSeenAt:now,clientInfo:null,pending:new Map(),ws:null};
  const ws=new WsConnection(socket,{
   onActivity:()=>{sess.lastSeenAt=Date.now()},
   onMessage:text=>this.handleMessage(sess,text),
   onClose:()=>{if(this.sessions.get(account.id)===sess)this.cleanupSession(account.id,sess)}
  });
  sess.ws=ws;
  this.sessions.set(account.id,sess);
  this.lastErrors.delete(account.id);
  ws.sendJson({type:'welcome',accountId:account.id,accountName:account.name,env:account.env,heartbeatMs:this.heartbeatMs});
  if(head&&head.length)ws.onData(head);
 }
 handleMessage(sess,raw){
  let m;try{m=JSON.parse(raw)}catch{return}
  if(!m||typeof m!=='object')return;
  if(m.type==='pong'||m.type==='ping'){if(m.type==='ping')sess.ws.sendJson({type:'pong',ts:Date.now()});return}
  if(m.type==='hello'){
   sess.clientInfo={
    appId:safeShort(m.appId,64),
    env:safeShort(m.env,120),
    libVersion:safeShort(m.libVersion,32),
    platform:safeShort(m.platform,32),
    version:safeShort(m.version,32)
   };
   const account=this.store?.account?.(sess.accountId);
   sess.ws.sendJson({type:'welcome',accountId:sess.accountId,accountName:account?.name||'',env:account?.env||''});
   return;
  }
  const p=typeof m.id==='string'?sess.pending.get(m.id):null;
  if(!p)return;
  if(m.type==='chunk'&&p.mode==='stream'){
   const ev={};
   if(typeof m.text==='string'&&m.text)ev.text=m.text;
   if(typeof m.reasoning==='string'&&m.reasoning)ev.reasoning=m.reasoning;
   if(ev.text||ev.reasoning){p.queue.push(ev);p.wake?.()}
   return;
  }
  if(m.type==='done'&&p.mode==='stream'){
   this.finishPending(sess,m.id,p);
   p.queue.push({finish:safeShort(m.finish,32)||'stop',usage:m.usage||null});
   p.done=true;p.wake?.();
   return;
  }
  if(m.type==='result'&&p.mode==='generate'){
   this.finishPending(sess,m.id,p);
   if(typeof m.text!=='string'){
    p.error=Object.assign(Error('Mini program returned no text'),{code:'sdk_response',category:'sdk_response'});
   }else{
    p.result={text:m.text,finish:safeShort(m.finish,32)||'stop',usage:m.usage||null,...(typeof m.reasoning==='string'&&m.reasoning?{reasoning:m.reasoning}:{})};
   }
   p.done=true;p.wake?.();
   return;
  }
  if(m.type==='error'){
   this.finishPending(sess,m.id,p);
   const diag=summarizeError({code:m.code,message:m.message});
   const code=safeShort(m.code,80)||diag.code;
   this.lastErrors.set(sess.accountId,code);
   p.error=Object.assign(Error('Mini program wx.cloud.extend.AI call failed'),{code,category:safeShort(m.category,40)||diag.category,upstreamStatus:diag.upstreamStatus});
   p.done=true;p.wake?.();
  }
 }
 finishPending(sess,id,p){
  sess.pending.delete(id);
  clearTimeout(p.timer);
  p.cleanup?.();
 }
 teardown(accountId,sess,code=1000,reason=''){
  if(this.sessions.get(accountId)===sess)this.sessions.delete(accountId);
  this.failPending(sess,'bridge_disconnected','Mini program bridge disconnected');
  sess.ws.close(code,reason);
 }
 cleanupSession(accountId,sess){
  if(this.sessions.get(accountId)===sess)this.sessions.delete(accountId);
  if(sess.pending.size)this.lastErrors.set(accountId,'bridge_disconnected');
  this.failPending(sess,'bridge_disconnected','Mini program bridge disconnected');
 }
 failPending(sess,code,message){
  for(const [id,p] of sess.pending){
   clearTimeout(p.timer);p.cleanup?.();
   p.error=Object.assign(Error(message),{code,category:'network'});
   p.done=true;p.wake?.();
  }
  sess.pending.clear();
 }
 sweep(){
  const now=Date.now();
  for(const [id,sess] of this.sessions){
   if(now-sess.lastSeenAt>this.staleMs){
    this.lastErrors.set(id,'bridge_timeout');
    this.teardown(id,sess,4001,'heartbeat timeout');
   }else{
    sess.ws.ping();
    sess.ws.sendJson({type:'ping',ts:now});
   }
  }
 }
 requireSession(accountId){
  const sess=this.sessions.get(accountId);
  if(!sess||sess.ws.closed)throw Object.assign(Error('Mini program bridge is offline'),{code:'bridge_offline',category:'network'});
  return sess;
 }
 startRequest(account,mode,input,signal){
  const sess=this.requireSession(account.id);
  const id=crypto.randomUUID();
  const p={id,mode,queue:[],done:false,wake:null,error:null,result:null,timer:null,cleanup:null};
  const abort=()=>{
   if(p.done)return;
   this.finishPending(sess,id,p);
   sess.ws.sendJson({type:'abort',id});
   p.error=Object.assign(Error('Request cancelled'),{code:'request_cancelled',category:'timeout'});
   p.done=true;p.wake?.();
  };
  p.cleanup=()=>signal?.removeEventListener('abort',abort);
  p.timer=setTimeout(()=>{
   if(p.done)return;
   this.finishPending(sess,id,p);
   sess.ws.sendJson({type:'abort',id});
   p.error=Object.assign(Error('Mini program bridge request timed out'),{code:'upstream_timeout',category:'timeout'});
   p.done=true;p.wake?.();
  },this.requestTimeoutMs);
  sess.pending.set(id,p);
  if(signal?.aborted){abort();return p}
  signal?.addEventListener('abort',abort,{once:true});
  const ok=sess.ws.sendJson({type:mode,id,env:account.env,input});
  if(!ok){
   this.finishPending(sess,id,p);
   p.error=Object.assign(Error('Mini program bridge write failed'),{code:'bridge_disconnected',category:'network'});
   p.done=true;
  }
  p.abort=abort;
  return p;
 }
 async ensure(account){
  this.requireSession(account.id);
  return this.state(account.id);
 }
 async generate(account,input,signal){
  const p=this.startRequest(account,'generate',input,signal);
  while(!p.done)await new Promise(r=>{p.wake=r});
  if(p.error)throw p.error;
  return p.result;
 }
 async *stream(account,input,signal){
  const p=this.startRequest(account,'stream',input,signal);
  try{
   while(!p.done||p.queue.length){
    if(p.queue.length)yield p.queue.shift();
    else await new Promise(r=>{p.wake=r});
   }
   if(p.error)throw p.error;
  }finally{if(!p.done)p.abort?.()}
 }
 route(account,keyId){
  return {
   auth:{ensure:()=>this.ensure(account)},
   adapter:{
    generate:(input,signal)=>this.generate(account,input,signal),
    stream:(input,signal)=>this.stream(account,input,signal)
   },
   accountId:account.id,
   keyId
  };
 }
 state(accountId){
  const sess=this.sessions.get(accountId);
  const connected=!!(sess&&!sess.ws.closed);
  return {
   ready:connected,
   connected,
   lastError:connected?null:(this.lastErrors.get(accountId)||null),
   connectedAt:connected?sess.connectedAt:null,
   lastSeenAt:connected?new Date(sess.lastSeenAt).toISOString():null,
   activeRequests:connected?sess.pending.size:0,
   clientInfo:connected?sess.clientInfo:null
  };
 }
 disconnect(accountId,reason='disconnected'){
  const sess=this.sessions.get(accountId);
  if(sess)this.teardown(accountId,sess,1000,reason);
 }
 closeAll(){
  clearInterval(this.timer);
  for(const [id,sess] of [...this.sessions])this.teardown(id,sess,1001,'server stopping');
 }
}
module.exports={WxBridge,WsConnection,encodeFrame};
