# Browser Automation API MVP

一个可运行的浏览器自动化服务骨架，当前包含：

- 多个独立 Chromium 进程组成的浏览器池
- 图片上传 API
- Cookie 会话保存和注入
- 异步任务提交与状态查询
- 版本化站点 Adapter
- 内置 `demo-v1` 页面，用于验证“输入文字 → 上传图片 → 提交 → 查询结果”完整链路
- `hailuo-v1` Adapter，用于执行“上传参考图 → 输入提示词 → 点击创作”
- 两个纯 API 渠道（不走浏览器）：`dreammaker-v1`（见 `docs/dreammaker.md`）与 `higgsfield-v1`（见 `docs/higgsfield.md`）

## 启动

```bash
pnpm install
pnpm browser:install
cp .env.example .env
cp tokens.txt.example tokens.txt
pnpm dev
```

浏览器会下载到项目自己的 `.playwright-browsers` 目录，不依赖机器上安装的 Chrome 或 Edge。安装脚本在国内网络默认使用 npmmirror 镜像；可以通过 `PLAYWRIGHT_DOWNLOAD_HOST` 覆盖下载源。`playwright` 包版本和下载的 Chromium 版本应一起锁定、一起升级。

Windows PowerShell 可以使用：

```powershell
Copy-Item .env.example .env
Copy-Item tokens.txt.example tokens.txt
pnpm dev
```

未设置 `API_KEY` 时，本地 API 不校验密钥；生产环境必须设置。设置后所有 `/v1/*` 请求需要携带 `x-api-key`。

海螺相关有两个互相独立的开关，都在 `.env`：`HAILUO_PROXY` 决定流量从哪个出口走（`iproyal` 住宅代理 / `local` 本机 Clash、mihomo / `direct`），签名 API 和浏览器共用同一出口；`HAILUO_TRANSPORT` 决定怎么调海螺（`api` 自己签名从 Node 发 / `browser` 在页面里调网页自己的 axios，方案见 `docs/browser-injected-api.md`，尚未接入）。

## 调用流程

1. 上传图片：`POST /v1/assets`，multipart 字段名为 `file`。
2. 创建任务：

```json
{
  "adapterId": "demo-v1",
  "text": "测试文字",
  "assetId": "asset_..."
}
```

3. 使用返回的地址查询：`GET /v1/jobs/:jobId`。

需要 Cookie 时，先调用：

```http
PUT /v1/sessions/account-001/cookies
```

```json
{
  "adapterId": "demo-v1",
  "cookies": [
    {
      "name": "session_id",
      "value": "cookie-value",
      "domain": ".example.com",
      "path": "/",
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ]
}
```

创建任务时添加 `"sessionId": "account-001"`。

## 海螺创作 Adapter

先把已登录海螺账号的 Cookie 保存到会话，`adapterId` 使用 `hailuo-v1`；创建任务时传入同一个 `sessionId`。默认创作页为 `https://hailuoai.com/create/image-to-video`，如果实际入口变化，可通过 `HAILUO_CREATE_URL` 覆盖。

Adapter 优先复用浏览器会话中的 `_token`，生成海螺所需的 `yy` 签名并直接请求 `GET /v1/api/user/equity`；如果直接请求失败，则自动打开页面并捕获前端发出的同一接口响应。任务提交成功后，结果中的 `currentCredits` 是点击“创作”前的当前积分数量。

保存登录态后，可以直接查询积分：

```http
GET /v1/sessions/hailuo-account-001/credits
```

```json
{
  "adapterId": "hailuo-v1",
  "text": "让参考图中的人物自然转身看向镜头",
  "assetId": "asset_...",
  "sessionId": "hailuo-account-001"
}
```

## 接入真实网站

在 `src/adapters` 下新增 Adapter，只在服务端代码中配置目标 URL、定位器和结果解析规则。不要允许 API 用户提交任意 URL、JavaScript 或本机文件路径。

当前版本是单机 MVP：任务、上传元数据保存在内存，Cookie 会话和图片保存在本地目录。生产化下一步应替换为 PostgreSQL、BullMQ/Redis、S3/MinIO，并对会话数据进行 KMS 加密。
