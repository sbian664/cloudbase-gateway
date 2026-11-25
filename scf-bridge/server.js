'use strict';
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MODELS = [
  'hy3',
  'hy4',
  'hy4-flash',
  'hy4-preview',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-1017',
];
const COMPLETION_FIELDS = [
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'stop',
  'tools',
  'tool_choice',
  'response_format',
  'thinking',
];

function sendJson(response, status, data, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(data));
}

function sendError(response, status, message, code = 'invalid_request') {
  sendJson(response, status, {
    error: {
      message,
      type: status === 401 ? 'authentication_error' : status >= 500 ? 'server_error' : 'invalid_request_error',
      code,
    },
  });
}

function toNodeStream(body) {
  if (body instanceof Readable) return body;
  if (typeof body?.getReader === 'function') return Readable.fromWeb(body);
  return null;
}

function parseModels(raw) {
  if (!raw || !raw.trim()) return [...DEFAULT_MODELS];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [...DEFAULT_MODELS];
}

function normalizeRoute(url, pathPrefix) {
  const pathname = new URL(url || '/', 'http://localhost').pathname;
  if (!pathPrefix) return pathname;
  const cleanPrefix = pathPrefix.endsWith('/') ? pathPrefix.slice(0, -1) : pathPrefix;
  if (pathname === cleanPrefix) return '/';
  if (pathname.startsWith(cleanPrefix + '/')) return pathname.slice(cleanPrefix.length);
  return pathname;
}

async function readPayload(request, response, allowedModels, disableThinkingModels) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      sendError(response, 413, 'Request exceeds 1 MiB', 'body_too_large');
      return null;
    }
    chunks.push(chunk);
  }

  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    sendError(response, 400, 'Invalid JSON', 'invalid_json');
    return null;
  }

  const allowAll = allowedModels.includes('*');
  const model = typeof input?.model === 'string' ? input.model.trim() : '';
  if (!model || (!allowAll && !allowedModels.includes(model))) {
    sendError(response, 400, 'Model is not enabled on this CloudBase bridge', 'model_not_found');
    return null;
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    sendError(response, 400, 'Expected a nonempty messages array', 'invalid_request');
    return null;
  }

  const stream = input.stream === true;
  const payload = { model, messages: input.messages, stream };
  for (const field of COMPLETION_FIELDS) {
    if (Object.hasOwn(input, field) && input[field] !== undefined) {
      payload[field] = input[field];
    }
  }
  if (!Object.hasOwn(payload, 'thinking') && disableThinkingModels.includes(model)) {
    payload.thinking = { type: 'disabled' };
  }
  if (stream) {
    payload.stream_options = input.stream_options && typeof input.stream_options === 'object'
      ? { include_usage: true, ...input.stream_options }
      : { include_usage: true };
  }
  return payload;
}

function createServer({
  token,
  env = '',
  models = DEFAULT_MODELS,
  disableThinkingModels = [],
  complete,
  pathPrefix = '',
}) {
  if (!token) throw new Error('CLOUDBASE_BRIDGE_TOKEN is required');
  const allowedModels = Array.isArray(models) && models.length ? models : DEFAULT_MODELS;
  const expectedAuth = Buffer.from(`Bearer ${token}`);

  const checkAuth = (request) => {
    const auth = Buffer.from(request.headers.authorization || '');
    return auth.length === expectedAuth.length && timingSafeEqual(auth, expectedAuth);
  };

  return http.createServer(async (request, response) => {
    const route = normalizeRoute(request.url, pathPrefix);
    if (request.method === 'GET' && (route === '/healthz' || route === '/readyz')) {
      sendJson(response, 200, {
        status: 'ok',
        runtime: 'cloudbase-node-sdk',
        env: env || undefined,
        models: allowedModels,
      });
      return;
    }

    if (request.method === 'GET' && route === '/v1/models') {
      if (!checkAuth(request)) {
        sendError(response, 401, 'Unauthorized', 'invalid_api_key');
        return;
      }
      const list = allowedModels.filter((id) => id !== '*');
      sendJson(response, 200, {
        object: 'list',
        data: list.map((id) => ({ id, object: 'model', created: 0, owned_by: 'cloudbase' })),
      });
      return;
    }

    if (request.method !== 'POST' || route !== '/v1/chat/completions') {
      sendError(response, 404, 'Not found', 'not_found');
      return;
    }

    if (!checkAuth(request)) {
      sendError(response, 401, 'Unauthorized', 'invalid_api_key');
      return;
    }

    try {
      const payload = await readPayload(request, response, allowedModels, disableThinkingModels);
      if (!payload || response.destroyed) return;

      const controller = new AbortController();
      response.once('close', () => {
        if (!response.writableFinished) controller.abort();
      });

      const result = await complete(payload, controller.signal);
      if (payload.stream) {
        const stream = toNodeStream(result);
        if (!stream) throw new Error('Expected a model stream');
        if (response.destroyed) {
          stream.destroy();
          return;
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        });
        await pipeline(stream, response);
      } else if (!response.destroyed) {
        if (!result?.choices?.[0]?.message) throw new Error('Expected a model completion');
        sendJson(response, 200, result);
      }
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
      } else {
        const code = typeof error?.code === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(error.code)
          ? error.code
          : 'upstream_error';
        sendError(response, 502, 'CloudBase model request failed', code);
      }
    }
  });
}

function createCloudBaseCompletion(app) {
  const ai = app.ai();
  return async (payload, signal) => {
    const headers = { 'Content-Type': 'application/json' };
    if (payload.stream) headers.Accept = 'text/event-stream';
    const { data, header, statusCode } = await app.request.fetch({
      url: `${ai.aiBaseUrl}/cloudbase/chat/completions`,
      method: 'post',
      headers,
      body: JSON.stringify(payload),
      stream: payload.stream,
      signal,
    });
    const result = await data;
    const contentType = typeof header?.get === 'function'
      ? header.get('content-type')
      : (header?.['content-type'] || header?.['Content-Type'] || '');
    const mediaType = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
    if (statusCode >= 400 || (payload.stream && mediaType !== 'text/event-stream')) {
      toNodeStream(result)?.destroy();
      const err = new Error('Unexpected CloudBase model response');
      err.statusCode = statusCode;
      throw err;
    }
    return result;
  };
}

function resolveRuntimeConfig(environment) {
  const scfEnv = environment.TENCENTCLOUD_RUNENV === 'SCF'
    ? (environment.SCF_NAMESPACE?.trim() || environment.TCB_ENV?.trim())
    : '';
  const env = environment.CBR_ENV_ID?.trim() || scfEnv;
  if (!env) {
    throw new Error('CloudBase runtime must supply CBR_ENV_ID, SCF_NAMESPACE, or TCB_ENV');
  }
  const configuredEnv = environment.CLOUDBASE_ENV_ID?.trim();
  if (configuredEnv && configuredEnv !== env) {
    throw new Error('CLOUDBASE_ENV_ID must match the CloudBase runtime environment');
  }
  const token = (environment.CLOUDBASE_BRIDGE_TOKEN || environment.CAMPUSQA_BRIDGE_TOKEN || '').trim();
  if (!token) throw new Error('CLOUDBASE_BRIDGE_TOKEN is required');
  const models = parseModels(environment.CLOUDBASE_ALLOWED_MODELS || environment.CLOUDBASE_MODEL);
  const disableThinkingModels = (environment.CLOUDBASE_DISABLE_THINKING_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const pathPrefix = (environment.CLOUDBASE_BRIDGE_PATH || environment.CAMPUSQA_BRIDGE_PATH || '').trim();
  return { env, token, models, disableThinkingModels, pathPrefix };
}

if (require.main === module) {
  const { env, token, models, disableThinkingModels, pathPrefix } = resolveRuntimeConfig(process.env);
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env, timeout: 120_000 });
  const server = createServer({
    token,
    env,
    models,
    disableThinkingModels,
    pathPrefix,
    complete: createCloudBaseCompletion(app),
  });
  const port = Number(process.env.PORT || (process.env.TENCENTCLOUD_RUNENV === 'SCF' ? 9000 : 8080));
  server.listen(port, '0.0.0.0', () => {
    console.log(`CloudBase SCF bridge listening on 0.0.0.0:${port} (env=${env})`);
  });
}

module.exports = {
  DEFAULT_MODELS,
  createServer,
  createCloudBaseCompletion,
  resolveRuntimeConfig,
  parseModels,
};
