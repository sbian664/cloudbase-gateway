# CloudBase 云函数 / 云托管模型桥接服务

基于官方 `@cloudbase/node-sdk@4.2.1`，部署在你的 CloudBase 环境中，以内置运行环境凭证调用 `cloudbase` 模型分组，向本地网关提供标准 OpenAI `/v1/chat/completions`（JSON / SSE）、`/v1/models` 与 `/healthz` 接口。

## 方式 A：HTTP 云函数（Web 函数）

1. 在 CloudBase 控制台新建 **HTTP 云函数（Web 函数）**，运行环境选 `Nodejs 20`，超时建议设为 `60` 秒。
2. 将本目录内的 `package.json`、`server.js`、`scf_bootstrap` 上传部署（确保位于根目录，勾选云端安装依赖；入口由 `scf_bootstrap` 启动并监听 `9000`）。
3. 配置环境变量：
   - `CLOUDBASE_ENV_ID`：目标云开发环境 ID（须与运行时 `SCF_NAMESPACE` / `TCB_ENV` 一致）
   - `CLOUDBASE_BRIDGE_TOKEN`：自行生成的随机高强度密钥（可用 `openssl rand -hex 24` 生成）
   - `CLOUDBASE_ALLOWED_MODELS`（可选）：逗号分隔的允许模型，默认支持 `hy3,hy4,hy4-flash,hy4-preview,deepseek-v4.1-flash,deepseek-v4.1-flash-1017`
   - `CLOUDBASE_BRIDGE_PATH`（可选）：仅当 HTTP 访问服务开启「路径透传」时填写触发路径（如 `/ai-bridge`）；保持关闭路径透传时无需填写
4. 在 **HTTP 访问服务** 新建路由绑定该云函数：
   - 访问路径填如 `/ai-bridge`
   - **路径透传**：建议保持 **关闭**
   - **身份认证**：保持 **关闭**（由 `CLOUDBASE_BRIDGE_TOKEN` 鉴权）
5. 用 `curl https://<默认域名>/ai-bridge/healthz` 确认返回 `{"status":"ok",...}` 后，将 `https://<默认域名>/ai-bridge` 填入本地 WebUI 控制台。

## 方式 B：云托管容器

1. 在目标云开发环境创建云托管服务，以本目录为构建目录使用 `Dockerfile`，端口 `8080`。
2. 配置环境变量 `CLOUDBASE_ENV_ID`、`CLOUDBASE_BRIDGE_TOKEN`（及可选的 `CLOUDBASE_ALLOWED_MODELS`）。
3. 开启公网访问，将云托管 HTTPS 域名填入本地 WebUI 控制台。

## 本地测试

```sh
npm test
```
