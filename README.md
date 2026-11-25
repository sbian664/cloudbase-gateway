# CloudBase Gateway

零外部依赖的本地 OpenAI 兼容网关（Node.js >= 20），支持两种官方调用通道：

1. **CloudBase 云函数 / 云托管（推荐，`@cloudbase/node-sdk`）**：连接部署在你的 CloudBase 环境中的 [scf-bridge/](scf-bridge/README.md)（HTTP 云函数或云托管容器），完全独立于微信开发者工具，支持多模型、真 SSE 流式与高并发。
2. **微信小程序原生桥接（`wx.cloud.extend.AI`）**：通过本地 WebSocket（`/bridge/wx`）连接运行在微信开发者工具中的小程序桥接客户端，直接调用小程序原生 `wx.cloud.extend.AI`。

## 快速启动

```sh
cd cloudbase-gateway-webui
npm start
```

另开一个本地终端获取管理密钥：

```sh
node web.cjs admin-key
```

浏览器打开 `http://127.0.0.1:8788/admin`，登录后：
1. 在 **账号管理** 添加 **CloudBase 云函数 / 云托管**（填入 `cloudbase-scf-bridge` 的 HTTPS 地址与 `CLOUDBASE_BRIDGE_TOKEN`）或 **微信小程序原生** 账号。
2. 在 **API Keys** 创建绑定该账号的访问密钥。
3. 在客户端将 Base URL 设为 `http://127.0.0.1:8788/v1`，API Key 填入刚生成的密钥。

## HTTP API

- `GET /livez`：进程存活探针。
- `GET /healthz` / `GET /readyz`：通道就绪状态（`scfReady`、`wxBridgeConnected`）、当前并发与最近调用结果。
- `GET /v1/models`：当前启用的模型列表（需 Bearer API Key）。
- `POST /v1/chat/completions`：支持非流式与 SSE 流式（含 `reasoning_content` 与 `stream_options.include_usage`），需 Bearer API Key。
- `WS /bridge/wx`：小程序原生通道本地 WebSocket 桥接端点（需 `bridgeToken`）。

## 配置与安全

- 默认仅绑定 `127.0.0.1:8788`（可用 `node web.cjs start --port 8789` 修改端口）。
- 本地状态持久化在 `~/.config/cloudbase-gateway/webui/state.json`（权限 `0600`，可用 `CBG_WEB_DIR` 覆盖）。
- 管理密钥与推理 API Key 相互独立，服务端仅存 API Key / Bridge Token 哈希，不记录提示词或模型输出。

## 测试

```sh
npm test
```
