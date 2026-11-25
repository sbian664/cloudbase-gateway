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

## WebUI preview (v0.2.0-dev)
The original v0.1 CLI and its configuration remain supported. The new WebUI mode uses a separate local state file and a separate port, so it does not silently import or reuse an active CLI session.

```sh
npm ci
npm run web
```

Open http://127.0.0.1:8788/admin. In another local terminal, run `node web.cjs admin-key` to obtain the administrator key. This is not an inference API key. Sign in, add an authorized CloudBase Web user account, and create a client key bound to that account. The API base URL is http://127.0.0.1:8788/v1. An inference key is shown only at creation; save it locally.

- Admin and inference authentication are separate. The gateway binds to loopback and validates the Host and Origin of requests. This development build is not designed for direct public exposure.
- Accounts use independent Node.js worker threads, started on use or successful login, with the same official SDK as v0.1. A key is bound to one explicit account. No automatic account rotation or replay of model calls is performed.
- Account removal removes the local session and its associated keys; it does not revoke the remote session.
- The WebUI supports official CloudBase Web SDK authentication with username/password, email or SMS OTP, WeChat Open Platform, Google, GitHub, Apple OAuth, and a custom ticket issued by an authorized external authentication service. Other upstream types, tool calling, Responses API, and Anthropic Messages are not implemented here.
- Session state and statistics are stored atomically in `~/.config/cloudbase-gateway/webui/state.json` (mode 0600; parent directory 0700), with `CBG_WEB_DIR` as an override. Passwords are not persisted. API key hashes, rather than raw inference keys, are retained. The administrator key and session tokens are sensitive.
- Request logs retain 500 metadata-only entries; lifetime counters survive restart. Latency percentiles use recent successful requests; unknown token usage is not estimated. There are no additional database or frontend server processes.
- Health checks describe current local session readiness and do not actively probe model entitlement or spend tokens.
- `node web.cjs start --port 8789` can use a different local port when required.

This branch has automated offline coverage for the HTTP and management interfaces and the actual SDK initialization in isolated workers. Live WebUI login and live multi-account requests still need verification against authorized accounts, including each newly added identity provider. All calls are official Web-channel calls, subject to the provider's access and billing rules.


### Authentication methods
Enable the selected identity provider in CloudBase first; the gateway does not change environment-level identity settings. The channel page reports implemented login paths, not the remotely configured provider status.

- Password: existing CloudBase username/password.
- SMS/email: sign in to an existing account, using the SDK's OTP verification callback. SMS requires the Shanghai region. An OTP attempt lives for up to five minutes, with at most five verification attempts and a local 60-second resend cooldown. User creation is not requested by the gateway.
- WeChat Open Platform (wx_open): use the configured website application and its authorized redirect. If the identity is not linked to a CloudBase user, complete linking through your official application first.
- Google, GitHub, Apple: configure the provider in CloudBase and authorize the appropriate callback URL. The default local callback is http://127.0.0.1:8788/admin (or http://localhost:8788/admin if accessed through localhost). Each provider has its own domain/HTTPS restrictions; if loopback is not accepted, this local preview cannot complete that provider's login until an approved callback deployment is configured. OAuth uses the official SDK provider redirect and code exchange, with a random, one-use state and a five-minute in-memory transaction. No upstream credentials or authorization codes are printed.
- Custom Ticket: use a ticket already issued for the user by your trusted identity service; no signing key or ticket minting is supported.
- WeChat Cloud Service Assistant mini-program: shown for reference, not available through this Web runtime. Native mini-program authentication and Web-channel authorization are separate.

All newly added methods have offline flow tests. Provider configuration, real OTP delivery, real OAuth consent and real ticket issuance have not been verified in a live environment. See https://docs.cloudbase.net/api-reference/webv3/authentication and https://docs.cloudbase.net/authentication-v2/method/wechat-login.
