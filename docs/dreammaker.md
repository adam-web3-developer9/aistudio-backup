# 渠道：DreamMaker（dreammaker.vobile.com.cn）

日期：2026-09-20。离线前端：`Downloads/dreammaker.vobile.com.cn`（canvas 页面的构建产物）。
探测脚本与响应样本留在会话 scratchpad，不入库；本文记的是结论。

## 一句话结论

比海螺简单得多：**纯 REST + Bearer JWT，没有请求签名、没有设备身份、没有风控 cookie**，
Node 直连就能跑完整条链路（上传 → 提交 → 轮询），不需要浏览器。计费按秒，模型十余个，
一次 5 秒的 MiniMax H3 是 2500 积分。

## 认证

前端主路径是 SSO（`auth-console.vobile.cn`，OAuth2 + PKCE，client_id `dreamstudio`），
换到的 `access_token` 存在 `localStorage.access_token`，之后所有请求带 `Authorization: Bearer <token>`
（团队 scope 再加 `X-Account-Id`）。

但**密码直登端点还在线**：`POST /api/auth/login {username, password}`（已用真实账号验证），
所以本服务不碰 SSO 那一套。JWT 载荷只有 `{sub, iat, exp}`，`sub` 是账号 id。

**两种 token 寿命不同**：浏览器里那个是 7 天，`/api/auth/login` 换来的只有**约 16 小时**。
所以续期阈值不能写死成「剩余不足一天」——那比短 token 的整个寿命还长，会导致每次检查都重登；
`DreamMakerCredentials.needsRefresh` 取「配置窗口」与「寿命四分之一」里较小的那个。

同域还有 `/api/auth/captcha-config?platform=…`、`/api/auth/send-sms-code`、`/api/auth/login-sms`：
平台有验证码门和短信登录，目前密码登录没有撞上验证码，撞上了就只能退回人工取 token。

## 链路

| 步骤 | 接口 | 说明 |
|---|---|---|
| 1 上传 | `POST /api/uploads/initiate` | `{intent:'workspace_input', filename, mimeType, sizeBytes, clientRequestId}` → OSS 表单策略 |
| 2 上传 | `POST <uploadUrl>` | 阿里云 OSS 直传，表单字段照抄 `formData` 再附 `file`；无 token，走直连 |
| 3 上传 | `POST /api/uploads/complete` | `{uploadId, etag, sizeBytes, mimeType}` → `{ossUri, url}`，`url` 就是生成接口吃的地址 |
| 4 提交 | `POST /api/video/generate` | 见下 |
| 5 轮询 | `POST /api/canvas/tasks/batch {taskIds}` | 也有 `GET /api/canvas/tasks/{id}`；batch 对不存在的 id 回 200 空数组 |
| 6 退单 | `POST /api/canvas/tasks/{id}/cancel` | 取消并退积分 |

`POST /api/video/generate` 的 body（camelCase）：

```json
{
  "model": "minimax-h3",
  "mode": "image2video",
  "prompt": "…",
  "imageUrls": ["<uploads/complete 的 url>"],
  "videoUrls": [], "audioUrls": [],
  "projectId": null, "canvasId": null, "nodeId": null,
  "clientRequestId": "gen-…",
  "options": { "duration": 5, "durationSeconds": 5, "resolution": "768p", "ratio": "adaptive" }
}
```

**只有 `model` 是必填**（空 body 的 422 只点名 `model`）：不需要 canvas、不需要 project、不需要 node，
所以无头调用不用先在平台建项目。`mode` 取值 `text2video` / `image2video` / `firstLastFrame` /
`imageReference` / `allReference`。

返回与轮询是同一个形状：

```json
{ "taskId": "cgt_…", "status": "queued", "stage": "queued", "progress": 0,
  "artifacts": [], "creditCost": "0.000000", "balanceAfter": "45684.000000",
  "errorCode": null, "errorMessage": null, "errorShort": null, "errorAction": null }
```

`status`：`queued` / `running` / `succeeded` / `failed` / `canceled`；`stage` 更细（`generating`、`archiving`）。
`progress` 多数模型只有 0 和 100，不能当进度条用。成片在 `artifacts[]`：`url`（签名 mp4，约 7 天有效）、
`ossUri`、`thumbnailUrl`、`width` / `height` / `sizeBytes`。`creditCost` / `balanceAfter` 是平台自己回报的
扣费与余额，比两次读余额相减可靠。

## 失败与错误码

平台在失败任务上直接给出"怎么办"，`errorAction` 就是权威信号，本服务按它分类：

| 信号 | 归类 | 本服务行为 |
|---|---|---|
| `errorAction: recharge`，或 code `INSUFFICIENT_CREDIT` / `PAYMENT_REQUIRED` / `MEMBER_QUOTA_EXCEEDED`，或 HTTP 402 | 付不起 | 不重试，换账号 |
| `errorAction: edit_prompt` / `replace_image` / `replace_asset` / `auto_compliance` | 内容被拒 | 原样重提 3 次，仍拒则 `CONTENT_REJECTED` |
| code `CONCURRENCY_LIMIT_EXCEEDED` / HTTP 429 | 排队 | 退避重试 |
| HTTP 401 / 403 | token 失效 | 重试；密码账号由续期逻辑修复 |
| 其余（如 `PROVIDER_SUBMIT_FAILED`，`errorAction: retry`） | 渲染失败 | 用已上传的图重新提交，最多 3 次 |

HTTP 错误体是 FastAPI 的 `{detail}`：字符串、字段校验数组，或 `{code, message}`。

## 计价

`POST /api/billing/quote/aigc` 回**每秒单价**（与传入的 duration 无关），所以估价要自己乘：`单价 × 秒数`。
**单价同时取决于模型和清晰度**，这是踩过的坑：

| 模型 | 480p | 720p | 768p | 1080p | 2k | 4k | canvas-pricing 说 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `doubao-seedance-2-5-260628` | 672 | 1512 | — | 3750 | — | — | 1512 |
| `minimax-h3` | — | — | 500 | — | 800 | — | 500 |
| `kling-v3` | — | 600 | — | 800 | — | 3000 | 600 |
| `doubao-seedance-2-0-260128` | 1000 | 1000 | — | — | — | — | 1000 |
| `wan3.0-video` | 1000 | 1000 | — | — | — | — | 1000 |

`GET /api/billing/canvas-pricing` 每个模型只给一个数，那只是它某一档的价（Seedance 2.5 给的是 720p 的 1512），
拿它当全档价会把 480p 的活按 720p 报价 —— 27 秒就是 40824 对 18144 的差别，足以把一条付得起的任务判成余额不足。
所以 `estimateJobCost` 走 quote，按 `模型|清晰度` 缓存一小时，quote 打不通才退回 canvas-pricing。
`charging_point_code`（如 `CP_AIGC_VIDEO_SEEDANCE25_480P`）会说明这个价来自哪一档，排查时很有用。

模型清单见 `docs/API.md` 的表；以 `GET /api/tool_spec/list` 为准，本服务不写死。
在架 11 个可用视频模型，最便宜 `minimax-h3` / `minimax-h3-max` 500 积分/秒，最贵 `doubao-seedance-2-5-260628` 1512。
个人 scope 的并发上限是 5（`GET /api/canvas/limits`）。

## 已验证

| 项 | 结果 |
|---|---|
| 只读探测（`/api/me`、余额、工具表、价目、限额） | 全部 200 |
| 上传链（1×1 PNG） | initiate → OSS 204 → complete，拿到可用 url |
| 真实生成（脚本直连，minimax-h3 768p 5 秒 image2video） | 成功，172 秒，扣 2500 积分，768×1344 |
| 端到端（本网关 `/v1/assets` → `/v1/jobs` → 轮询） | 成功，190 秒，扣 2500 积分，`creditsSpent` 与账单一致 |
| 账号池（`GET /v1/accounts?adapterId=dreammaker-v1`） | 识别 `dreammaker-21574`、余额、`expiresAt` |

## 边界由平台定，不由网关定

模型清单、清晰度档位、时长区间、参考图张数都按模型变，而且平台随时会改。
网关对这些值只检查形状（非空字符串、正整数），不做值域校验：拒错了，调用方只会看到
`Invalid request`，看不到平台自己的解释，而那条任务本来可能是能跑的。
`assetIds` 也不再按海螺的 9 张截断——海螺的 adapter 自己管它的 9 张，DreamMaker 这条路交给平台。

## 已知限制

- **文生视频发不出去**：`createJobSchema` 的 `assetId` 必填，`JobRunner` 也要求至少一个素材。
  平台侧 `mode: text2video` 是支持的（`wan2.7-t2v`、`happyhorse-1.1-t2v` 只有这一种模式），
  要放开得同时改 schema 与 runner。
- **只收图片参考**：`videoUrls` / `audioUrls` 字段在，但在架模型都没有参考视频/音频的模态，本服务不发。
- **不做浏览器回退**：这个渠道没有签名要用页面代劳，`run(page)` 直接抛错。
- 提示词里的素材引用写法（`<Picture N>` 之类）是按底座模型推断的，没有在这个平台上实测过。
