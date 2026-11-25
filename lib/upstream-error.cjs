'use strict';
// Preserve structured upstream diagnostics without logging credentials, bodies or headers.
function safeCode(v){
 if(typeof v==='number'&&Number.isSafeInteger(v))return String(v);
 return typeof v==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(v)?v:null;
}
function summarizeError(e){
 const nested=[e,e?.error,e?.cause,e?.response?.data?.error,e?.response?.data].filter(x=>x&&typeof x==='object');
 const code=nested.flatMap(x=>[x.code,x.errCode,x.error_code,x.errorCode]).map(safeCode).find(Boolean)||'upstream_error';
 const upstreamStatus=[e?.status,e?.statusCode,e?.response?.status,...nested.map(x=>x.status)].find(x=>Number.isInteger(x)&&x>=400&&x<=599)||null;
 const messages=[typeof e==='string'?e:null,...nested.flatMap(x=>[x.message,x.errMsg,x.error_description,x.error_message])].filter(x=>typeof x==='string');
 const raw=messages.join(' ');
 // Only predefined descriptions cross the Worker boundary. Never send raw exception text.
 let category='unknown';
 if(/quota|resource.?point|balance|insufficient|billing|额度|资源点|余额|计费|欠费/i.test(raw+' '+code))category='billing_or_quota';
 else if(/model.{0,60}(not found|not enabled|unavailable|unsupported|not exist|disabled)|模型.{0,30}(不存在|未开通|未启用|不可用)/i.test(raw+' '+code))category='model_unavailable';
 else if(/permission|forbidden|denied|unauthorized|invalid.{0,15}token|token.{0,20}expired|无权限|未授权/i.test(raw+' '+code))category='authorization';
 else if(/rate.limit|too many requests|限流/i.test(raw+' '+code)||upstreamStatus===429)category='rate_limit';
 else if(/timeout|timed out|超时/i.test(raw+' '+code))category='timeout';
 else if(/fetch failed|ECONN|ENOTFOUND|network|socket|网络/i.test(raw+' '+code))category='network';
 else if(/no text|undefined|null|not a function|cannot read/i.test(raw))category='sdk_response';
 return {code,upstreamStatus,category};
}
module.exports={summarizeError};
