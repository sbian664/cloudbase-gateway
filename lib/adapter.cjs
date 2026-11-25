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
 return {model:b.model,messages:b.messages.map(({role,content})=>({role,content})),...(b.temperature===undefined?{}:{temperature:b.temperature}),...(b.top_p===undefined?{}:{top_p:b.top_p})};
}
module.exports={MODEL_IDS,validate};
