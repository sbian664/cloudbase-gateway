'use strict';
const MODEL_IDS=['hy3','hy4','hy4-flash','hy4-preview','deepseek-v4.1-flash','deepseek-v4.1-flash-1017'];
const MODEL_SET=new Set(MODEL_IDS);
function bad(message,code='invalid_request'){return Object.assign(new Error(message),{status:400,code})}
function validate(b){
 if(!b||!MODEL_SET.has(b.model))throw bad('Unknown model','model_not_found');
 if(!Array.isArray(b.messages)||!b.messages.length||b.messages.length>512||!b.messages.every(m=>m&&['system','user','assistant'].includes(m.role)&&typeof m.content==='string'))throw bad('Only text system/user/assistant messages are supported');
 if(!b.messages.some(m=>m.role==='user'&&m.content.trim()))throw bad('A nonempty user message is required');
 if(b.stream!==undefined&&typeof b.stream!=='boolean')throw bad('stream must be boolean');
 if(b.n!==undefined&&b.n!==1)throw bad('Only n=1 is supported');
 for(const k of ['tools','tool_choice','functions','function_call','response_format','max_tokens','max_completion_tokens','stop','frequency_penalty','presence_penalty','logprobs','top_logprobs','seed','reasoning_effort'])if(b[k]!==undefined)throw bad(k+' is not supported by this gateway version','unsupported_parameter');
 if(b.temperature!==undefined&&(!Number.isFinite(b.temperature)||b.temperature<0||b.temperature>2))throw bad('Invalid temperature');
 if(b.top_p!==undefined&&(!Number.isFinite(b.top_p)||b.top_p<0||b.top_p>1))throw bad('Invalid top_p');
 return {model:b.model,messages:b.messages.map(({role,content})=>({role,content})),...(b.temperature===undefined?{}:{temperature:b.temperature}),...(b.top_p===undefined?{}:{topP:b.top_p,top_p:b.top_p})};
}
function sdkResult(r){if(r?.error)throw Object.assign(new Error(r.error.message||'Model call failed'),{code:r.error.code||'upstream_error'});return r}
class CloudAdapter{
 constructor(auth){this.auth=auth;this.model=null}
 async ready(){await this.auth.ensure();this.model??=this.auth.app.ai().createModel('cloudbase');return this.model}
 async generate(input,signal){
   const model=await this.ready();
   try{
    const r=sdkResult(await model.generateText({...input,abortSignal:signal},{timeout:120000}));
    const raw=r.rawResponses?.at(-1);const finish=raw?.choices?.[0]?.finish_reason||'stop';
    if(typeof r.text!=='string')throw Error('Upstream returned no text');
    return {text:r.text,usage:r.usage,finish};
   }finally{await this.auth.sync()}
 }
 async *stream(input,signal){
   const model=await this.ready();
   try{
    const r=sdkResult(await model.streamText({...input,abortSignal:signal},{timeout:120000}));
    // Consume the documented text stream, not a synthetic split of a full response.
    // Handle promise rejections immediately; report usage only when available.
    const usage=Promise.resolve(r.usage).catch(()=>null);
    const messages=Promise.resolve(r.messages).catch(()=>null);
    for await(const text of r.textStream){if(signal.aborted)throw Error('Request cancelled');if(typeof text==='string'&&text)yield {text}}
    await messages;yield {finish:'stop',usage:await usage};
   }finally{await this.auth.sync()}
 }
}
module.exports={CloudAdapter,MODEL_IDS,validate};
