# CloudBase 云函数 / 云托管模型桥接服务

基于官方 `@cloudbase/node-sdk@4.2.1`，部署在你的 CloudBase 环境中，以内置运行环境凭证调用 `cloudbase` 模型分组，向本地 `cloudbase-gateway-webui` 提供标准 OpenAI `/v1/chat/completions`（JSON / SSE）与 `/healthz` 接口。

## 方式 A：HTTP 云函数（Web 函数）

1. 在 CloudBase 控制台创建一个 **HTTP 云函数（Web 函数）**，将本目录上传部署（云端安装依赖，入口由 `scf_bootstrap` 启动并监听 `9000`）。
2. 配置环境变量：
   - `CLOUDBASE_ENV_ID`：目标云开发环境 ID（须与运行时 `SCF_NAMESPACE` / `TCB_ENV` 一致）
   - `CLOUDBASE_BRIDGE_TOKEN`：自行生成的随机高强度密钥
   - `CLOUDBASE_ALLOWED_MODELS`（可选）：逗号分隔的允许模型，默认支持 `hy3,hy4,hy4-flash,hy4-preview,deepseek-v4.1-flash,deepseek-v4.1-flash-1017`
   - `CLOUDBASE_BRIDGE_PATH`（可选）：如果 HTTP 访问服务配置了子路径前缀（如 `/ai-bridge`），填在这里
3. 在「HTTP 访问服务」绑定该云函数获取 HTTPS 访问地址，记下 `https://<域名><路径>` 与 `CLOUDBASE_BRIDGE_TOKEN`。

## 方式 B：云托管容器

1. 在目标云开发环境创建云托管服务，以本目录为构建目录使用 `Dockerfile`，端口 `8080`。
2. 配置环境变量 `CLOUDBASE_ENV_ID`、`CLOUDBASE_BRIDGE_TOKEN`（及可选的 `CLOUDBASE_ALLOWED_MODELS`）。
3. 获取云托管 HTTPS 域名并填入 `cloudbase-gateway-webui` 控制台。

## 接入 `cloudbase-gateway-webui`

在本地控制台 `http://127.0.0.1:8788/admin` → **账号管理** → **添加账号**，选择 **CloudBase 云函数 / 云托管 (`@cloudbase/node-sdk`)**，填入：
- 账号别名
- 环境 ID
- 云函数 / 云托管访问地址（例如 `https://xxx.service.tcloudbase.com/ai-bridge`）
- Bridge Token（即 `CLOUDBASE_BRIDGE_TOKEN`）

## 本地测试

```sh
npm test
```
