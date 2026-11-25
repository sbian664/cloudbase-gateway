'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {summarizeError}=require('../lib/upstream-error.cjs');
test('structured SDK errors keep numeric and nested codes without raw secrets',()=>{
 const e={message:'quota exceeded token=secret-value',errCode:123,response:{status:403}};
 assert.deepEqual(summarizeError(e),{code:'123',upstreamStatus:403,category:'billing_or_quota'});
 assert.ok(!JSON.stringify(summarizeError(e)).includes('secret-value'));
 assert.equal(summarizeError({error:{code:'ModelNotFound',message:'model not found'}}).category,'model_unavailable');
 assert.equal(summarizeError('invalid token timestamp').category,'authorization');
});
