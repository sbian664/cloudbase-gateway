# CloudBase Gateway
A local, lightweight, OpenAI-compatible text gateway using the official CloudBase JavaScript SDK and a CloudBase Web user session. No Electron, mini-program runtime, or browser is required at runtime. Web-channel permissions and billing apply; this project does not emulate mini-program identity or change grant eligibility.

## Requirements
Node.js >= 20. Your CloudBase environment must have username/password authentication enabled, a registered CloudBase user, a Publishable Key, and permission to invoke the desired AI models. Some accounts/environments may require additional official authentication or verification.

## Quick start
```sh
cd cloudbase-gateway
npm ci
node cli.cjs login
node cli.cjs start
```
Enter the environment ID, region (default ap-shanghai), Publishable Key, CloudBase username and password in the terminal. Do not use a Tencent Cloud administrator password, CAM SecretKey or a server-side API key. The password is not stored. The gateway binds only to 127.0.0.1:8787 by default.

Open another terminal:
```sh
cd ~/Documents/cloudbase-gateway
node cli.cjs status
node cli.cjs key
```
Copy the locally generated gateway key into your client. Base URL: http://127.0.0.1:8787/v1. Model: hy3 (other listed models depend on your environment).
```sh
read -s "CBG_KEY?Gateway key: "; echo
curl -sS http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $CBG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"hy3","messages":[{"role":"user","content":"Explain binary search in one sentence."}],"stream":false}'
unset CBG_KEY
```
For streaming, use curl -N and set stream:true. Set stream_options.include_usage:true if your client needs the final usage event. The SDK's textStream supplies incremental text; upstream streaming availability must be confirmed against the live service.

## Commands
- login: interactive password login, create or retain gateway key
- start [--port 8787]: foreground server with periodic session checks
- status: query readiness or show cached local configuration status
- refresh: refresh the session explicitly (stop running gateway first)
- key: print local gateway API key in an interactive terminal
- logout: sign out remotely and remove local configuration (stop gateway first)
- logout --local: explicitly remove local configuration without contacting the provider

Session/config location: ~/.config/cloudbase-gateway/config.json (0600; directory 0700); CBG_CONFIG_DIR overrides this directory. The file contains sensitive session tokens and must not be shared. The process lock prevents a second gateway or auth command from concurrently refreshing the same session. Do not commit config files. On shared systems, use a dedicated user account. Only the official SDK handles upstream authentication.

## HTTP API
GET /livez: process liveness.
GET /healthz, /readyz: session readiness, active requests and last observed model success/failure; does not spend tokens or actively probe models.
GET /v1/models: candidate model list, not a live entitlement check.
POST /v1/chat/completions: single choice, text-only system/user/assistant messages, non-stream or SSE stream; temperature/top_p supported. Other parameters (including tool calls, structured outputs, max_tokens, vision) are not implemented and are rejected rather than pretending to support them. Anthropic Messages and OpenAI Responses API are not implemented in this release.
Bearer gateway key required for model endpoints. Max 4 concurrent requests; 1 MiB body limit; SDK timeouts; no automatic replay of model calls. Never publish this port without an appropriate security review.

## Development status
```sh
npm test
```
The automated suite includes offline SDK initialization and injected authentication/HTTP fixtures. In the initial local deployment, the operator confirmed successful Node.js login, gateway startup, and live non-streaming and streaming Hy3 requests. Session refresh under prolonged operation, additional models, and cross-platform compatibility remain to be independently verified.
