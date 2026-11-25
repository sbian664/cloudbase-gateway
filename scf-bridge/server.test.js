'use strict';
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { createServer, createCloudBaseCompletion, resolveRuntimeConfig } = require('./server');

const token = 'test-scf-token-123456';
const messages = [{ role: 'user', content: '你好' }];

async function start(t, complete, opts = {}) {
  const server = createServer({ token, env: 'env-test', complete, ...opts });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    post: (body, auth = `Bearer ${token}`, path = '/v1/chat/completions', signal) => fetch(base + path, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal,
    }),
  };
}

test('resolveRuntimeConfig supports SCF and CloudRun and checks env match', () => {
  assert.throws(() => resolveRuntimeConfig({ CLOUDBASE_ENV_ID: 'env-a', CLOUDBASE_BRIDGE_TOKEN: token }), /CBR_ENV_ID/);
  assert.throws(() => resolveRuntimeConfig({ CBR_ENV_ID: 'env-b', CLOUDBASE_ENV_ID: 'env-a', CLOUDBASE_BRIDGE_TOKEN: token }), /match/);
  const scf = resolveRuntimeConfig({ TENCENTCLOUD_RUNENV: 'SCF', SCF_NAMESPACE: 'env-a', CLOUDBASE_ENV_ID: 'env-a', CLOUDBASE_BRIDGE_TOKEN: token });
  assert.equal(scf.env, 'env-a');
  assert.ok(scf.models.includes('hy4'));
  const cbr = resolveRuntimeConfig({ CBR_ENV_ID: 'env-c', CLOUDBASE_BRIDGE_TOKEN: token, CLOUDBASE_ALLOWED_MODELS: 'hy4,hy3' });
  assert.deepEqual(cbr.models, ['hy4', 'hy3']);
});

test('healthz, models list, auth check, and pathPrefix routing', async (t) => {
  const { base, post } = await start(t, () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { pathPrefix: '/ai-bridge' });
  const h = await fetch(base + '/ai-bridge/healthz');
  assert.equal(h.status, 200);
  assert.equal((await h.json()).runtime, 'cloudbase-node-sdk');
  assert.equal((await fetch(base + '/ai-bridge/v1/models')).status, 401);
  const m = await fetch(base + '/ai-bridge/v1/models', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(m.status, 200);
  assert.ok((await m.json()).data.some((x) => x.id === 'hy4'));
  assert.equal((await post({ model: 'hy4', messages }, 'Bearer wrong', '/ai-bridge/v1/chat/completions')).status, 401);
  assert.equal((await post({ model: 'hy4', messages }, `Bearer ${token}`, '/ai-bridge/v1/chat/completions')).status, 200);
});

test('forwards non-stream completion, tools, and SSE stream cleanly', async (t) => {
  const { post } = await start(t, (payload) => {
    if (payload.stream) {
      assert.equal(payload.stream_options.include_usage, true);
      return Readable.from([
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n',
      ]);
    }
    assert.equal(payload.temperature, 0.3);
    return {
      choices: [{ message: { role: 'assistant', content: '来自云函数 Hy4' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
    };
  });

  const r1 = await post({ model: 'hy4', messages, temperature: 0.3 });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).choices[0].message.content, '来自云函数 Hy4');

  const r2 = await post({ model: 'hy4', messages, stream: true });
  assert.equal(r2.status, 200);
  assert.match(r2.headers.get('content-type'), /^text\/event-stream/);
  const sse = await r2.text();
  assert.match(sse, /你好/);
  assert.match(sse, /\[DONE\]/);
});

test('createCloudBaseCompletion calls aiBaseUrl/cloudbase/chat/completions and guards error status', async () => {
  const complete = createCloudBaseCompletion({
    ai: () => ({ aiBaseUrl: 'https://internal.cloudbase.test/v1/ai' }),
    request: {
      async fetch(opts) {
        assert.equal(opts.url, 'https://internal.cloudbase.test/v1/ai/cloudbase/chat/completions');
        return {
          statusCode: 200,
          header: new Headers({ 'content-type': 'application/json' }),
          data: { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
        };
      },
    },
  });
  const res = await complete({ model: 'hy4', messages, stream: false });
  assert.equal(res.choices[0].message.content, 'ok');
});
