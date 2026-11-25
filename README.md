# CloudBase Gateway

零第三方依赖的本地 OpenAI 兼容文本网关（仅需 Node.js >= 20），支持两种官方调用通道：

1. **CloudBase 云函数 / 云托管（推荐，`@cloudbase/node-sdk`）**：将仓库内置的 [scf-bridge/](scf-bridge/) 部署到你的 CloudBase 环境（HTTP 云函数或云托管），使用云端运行时内置凭证调用 `cloudbase` 模型分组，完全独立运行、无需开启微信开发者工具或维护 Web 登录态。
2. **微信小程序原生桥接（`wx.cloud.extend.AI`）**：通过本地 WebSocket（`/bridge/wx`）连接微信开发者工具中的小程序，直接由小程序端执行 `wx.cloud.extend.AI`。

---

## 环境要求

- 本地机器安装 **Node.js >= 20**（无需执行 `npm install`，网关主程序零外部依赖）。
- 一个已开通 AI+ 模型能力的腾讯云开发（CloudBase）环境。

---

## 快速上手（推荐：云函数 / 云托管通道）

以下 5 步即可从零完成配置，并成功发出 OpenAI 格式的 `/v1/chat/completions` 请求。

### 第一步：生成 Bridge Token

在本地终端生成一个随机高强度密钥（云端环境变量与本地控制台填同一个值）：

```sh
openssl rand -hex 24
```

### 第二步：部署 `scf-bridge` 到 CloudBase

选择下面任意一种方式部署即可：

#### 方式 A：HTTP 云函数（Web 函数）

1. 登录腾讯云开发（CloudBase）控制台 → 进入目标环境 → **云函数** → **新建云函数**。
2. 配置基本信息：
   - **函数类型**：`HTTP 云函数（Web 函数）`
   - **函数名称**：自定义，例如 `ai-bridge`
   - **运行环境**：`Nodejs 20`
   - **超时时间**：建议设为 `60` 秒
3. 将本仓库 `scf-bridge/` 目录内的 `package.json`、`server.js`、`scf_bootstrap` 上传部署（确保这 3 个文件位于根目录，不要多套一层文件夹），勾选 **云端安装依赖**。
4. 在该函数 **配置 → 环境变量** 中添加：
   | 环境变量 | 说明 |
   | --- | --- |
   | `CLOUDBASE_ENV_ID` | 目标云开发环境 ID（须与当前云函数所属环境一致） |
   | `CLOUDBASE_BRIDGE_TOKEN` | 第一步生成的随机密钥 |
   | `CLOUDBASE_ALLOWED_MODELS` | （可选）逗号分隔的允许模型，默认支持 `hy3,hy4,hy4-flash,hy4-preview,deepseek-v4.1-flash,deepseek-v4.1-flash-1017` |
   | `CLOUDBASE_BRIDGE_PATH` | （可选）仅当下方路由开启「路径透传」时填写触发路径；关闭路径透传时无需填写 |
5. 开启 HTTP 访问：
   - 控制台左侧进入 **HTTP 访问服务** → **配置路由信息** → 新建路由。
   - **访问路径**：例如 `/ai-bridge`
   - **关联资源**：选择刚才部署的云函数 `ai-bridge`（`$DEFAULT` 版本）
   - **路径透传**：保持 **关闭**（访问 `/ai-bridge/healthz` 时后端直接收到 `/healthz`）
   - **身份认证**：保持 **关闭**（鉴权由云函数内的 `CLOUDBASE_BRIDGE_TOKEN` 负责）
   - 保存后复制该路由对应的完整默认域名，拼接路径即得到访问地址：
     ```text
     https://<默认域名>/ai-bridge
     ```

#### 方式 B：云托管容器

1. 在目标云开发环境创建 **云托管** 服务，以 `scf-bridge/` 为构建目录使用内置 `Dockerfile`，监听端口 `8080`。
2. 配置环境变量 `CLOUDBASE_ENV_ID` 与 `CLOUDBASE_BRIDGE_TOKEN`（及可选的 `CLOUDBASE_ALLOWED_MODELS`）。
3. 开启公网访问后，直接使用分配的 `https://<云托管公网域名>` 作为访问地址。

#### 验通云端服务

在终端执行（返回 `{"status":"ok",...}` 即部署成功）：

```sh
curl -sS https://<你的域名及路径>/healthz
```

### 第三步：启动本地网关并登录控制台

1. 在仓库根目录启动网关（默认仅监听本机 `127.0.0.1:8788`）：
   ```sh
   npm start
   ```
   > 如需指定端口：`node web.cjs start --port 8789`
2. 另开一个终端获取管理员密钥（仅用于登录 WebUI，不是模型推理 API Key）：
   ```sh
   npm run admin-key
   ```
3. 浏览器打开 `http://127.0.0.1:8788/admin`，粘贴管理密钥登录。

### 第四步：在控制台添加通道并签发 API Key

1. 进入左侧 **账号管理** → 点击 **＋ 添加账号**：
   - **接入通道**：选择 `CloudBase 云函数 / 云托管 (@cloudbase/node-sdk)`
   - **账号别名**：自定义，例如 `Hy4 云函数`
   - **环境 ID**：你的云开发环境 ID
   - **地域**：例如 `ap-shanghai`
   - **云函数 / 云托管访问地址**：填入第二步验通的地址（如 `https://<默认域名>/ai-bridge`，是否带 `/v1` 均可自动规范化）
   - **Bridge Token**：填入第一步设置的 `CLOUDBASE_BRIDGE_TOKEN`
   - 点击 **校验连通并添加**（网关会自动探测 `/healthz`）。
2. 进入左侧 **API Keys** → 点击 **＋ 创建密钥**：
   - 填写密钥名称，**绑定账号** 选择刚添加的云函数账号。
   - **立即复制并保存**生成的 `sk-cbg-...` 密钥（关闭弹窗后无法再次查看明文）。

### 第五步：发起 OpenAI 格式请求

在终端测试非流式与流式 SSE 请求：

```sh
read -s "CBG_KEY?API Key: "; echo

# 1. 查看可用模型
curl -sS http://127.0.0.1:8788/v1/models \
  -H "Authorization: Bearer $CBG_KEY"

echo ""

# 2. 非流式对话
curl -sS http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer $CBG_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hy4",
    "messages": [{"role": "user", "content": "用一句话解释二分查找。"}],
    "stream": false
  }'

echo ""

# 3. 流式对话（SSE + usage）
curl -N -sS http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer $CBG_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hy4",
    "messages": [{"role": "user", "content": "用三点说明快速排序的核心思路。"}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'

unset CBG_KEY
```

#### 在第三方客户端中接入（OpenAI 兼容）

在支持自定义 OpenAI 接口的客户端（如 Cherry Studio、ChatBox、OpenAI SDK 等）填入：

- **Base URL**：`http://127.0.0.1:8788/v1`
- **API Key**：第四步创建的 `sk-cbg-...`
- **Model**：`hy4`（或 `hy4-flash`、`hy4-preview`、`hy3`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`，可在控制台「模型管理」开关）

---

## 备选通道：微信小程序原生桥接（`wx.cloud.extend.AI`）

如果你希望通过小程序原生基础库调用：

1. 在控制台 **账号管理** → **＋ 添加账号** → 接入通道选 `微信小程序原生 (wx.cloud.extend.AI)`，填写别名与环境 ID，生成一次性的 `bridgeToken` 与 JSON 配置。
2. 在微信开发者工具中开启「不校验合法域名」，使用支持 `wx.connectSocket` 的小程序端连向 `ws://127.0.0.1:8788/bridge/wx?token=<bridgeToken>` 并在收到 `generate` / `stream` 指令后调用 `wx.cloud.extend.AI.createModel('cloudbase')`。
3. 控制台账号状态变为 **桥接在线** 后，同样创建绑定该账号的 API Key 即可使用相同 OpenAI 接口。

---

## 接口与参数说明

| 端点 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /livez` | 无 | 进程存活检查 |
| `GET /healthz` / `GET /readyz` | 无 | 返回通道就绪状态（`scfReady`、`wxBridgeConnected`）与最近请求状态，不消耗 Token |
| `GET /v1/models` | Bearer API Key | 返回当前启用的候选模型列表 |
| `POST /v1/chat/completions` | Bearer API Key | 文本对话（`system`/`user`/`assistant`），支持 `stream`、`stream_options.include_usage`、`temperature`、`top_p`，透传 `reasoning_content` 与 `usage` |
| `WS /bridge/wx` | Bridge Token | 小程序原生通道本地 WebSocket 桥接 |

> 当前本地网关校验层专注于文本对话；请求体上限 1 MiB，默认最大并发 4（可在控制台「系统设置」调整为 1–16）。

---

## 本地存储与安全

- 网关默认仅绑定回环地址 `127.0.0.1`，管理接口校验 `Host` 与 `Origin`，请勿直接暴露至公网。
- 配置与统计持久化于 `~/.config/cloudbase-gateway/webui/state.json`（目录权限 `0700`，文件权限 `0600`，可用环境变量 `CBG_WEB_DIR` 覆盖）。
- 管理密钥、推理 API Key 哈希与上游 Bridge Token 均仅存本机，请求日志仅记录元数据（不记录提示词、回复正文或密钥）。
- 实际模型计费与活动包抵扣类别请以腾讯云开发控制台 **AI+ / 模型用量** 为准。

---

## 常见问题排查

- **添加云函数时提示连通失败**：先用 `curl https://<你的域名及路径>/healthz` 检查。若返回 404，确认路由「路径透传」已关闭（或云函数环境变量 `CLOUDBASE_BRIDGE_PATH` 与访问路径一致）；若返回 401/403，确认 HTTP 访问服务路由的「身份认证」已关闭。
- **推理返回 `502 (scf_unauthorized)`**：本地填写的 Bridge Token 与云函数环境变量 `CLOUDBASE_BRIDGE_TOKEN` 不一致，可在账号管理点 **修改配置** 更新（不影响已签发的 API Key）。
- **推理超时**：确认云函数超时时间已调至 `60` 秒，并确认目标模型已在当前云开发环境开通。

---

## 运行测试

```sh
npm test
```

---

## 开源协议

本项目采用 [MIT License](LICENSE) 开源。

