# 视频生成 API

本服务把第三方视频平台的网页端私有接口包成一套 HTTP API：上传图片 → 提交生成任务 → 轮询结果。
调度层管理多个账号，**每个账号最多保留两个未完成视频：一个生成中、一个在对方队列中**；超出的任务留在本服务本地队列。

当前接了三个渠道，按 `adapterId` 选：

| `adapterId` | 渠道 | 账号来源 | 模型 |
|---|---|---|---|
| `hailuo-v1` | 海螺 hailuoai.com | `tokens.txt`（一行一个 `_token`） | MiniMax H3 全能参考，固定一种 |
| `dreammaker-v1` | DreamMaker dreammaker.vobile.com.cn | `dreammaker-accounts.txt`（一行一个 access token，或 `用户名:密码`） | 平台在架的十余个模型，按 `options.modelId` 选 |
| `higgsfield-v1` | Higgsfield higgsfield.ai | `higgsfield-accounts.txt`（一行一个 Clerk `__client` cookie） | 平台聚合的各家模型，按 `options.modelId` 选生成器 |

三个渠道共用这一套 `/v1/assets`、`/v1/jobs` 接口和同一个账号池，区别只在 `adapterId` 与 `options`。

- Base URL：`http://127.0.0.1:3000`（`HOST` / `PORT` 可配）
- 鉴权：所有 `/v1/*` 请求带 `x-api-key: <API_KEY>`；缺失或错误返回 `401`
- 请求/响应均为 JSON，上传除外（`multipart/form-data`）

---

## 接入流程

```
POST /v1/assets          上传参考图，拿 assetId
   ↓
POST /v1/jobs            提交任务，立刻拿 jobId（202，不阻塞）
   ↓
GET  /v1/jobs/{jobId}    轮询到 succeeded / failed，取 videoUrl
```

建议轮询间隔 5–10 秒。

---

## POST /v1/assets

上传参考图。`multipart/form-data`，字段名 `file`，只能传一个。

- 支持 `image/png`、`image/jpeg`、`image/webp`、`image/gif`
- 上限 10 MB（`MAX_UPLOAD_BYTES`）
- 会校验文件头与 MIME 是否一致，不一致返回 `415`

```bash
curl -X POST http://127.0.0.1:3000/v1/assets \
  -H "x-api-key: $API_KEY" \
  -F file=@ref.png
```

**201**

```json
{
  "id": "asset_1285c232-d32c-4432-bdd2-c3206f2cb6f0",
  "originalName": "ref.png",
  "mimeType": "image/png",
  "size": 248717,
  "createdAt": "2026-08-20T06:22:11.000Z"
}
```

---

## POST /v1/jobs

提交生成任务。**立即返回 202**，不等生成完成。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `adapterId` | string | 是 | `"hailuo-v1"`、`"dreammaker-v1"` 或 `"higgsfield-v1"` |
| `assetId` | string | 是 | `POST /v1/assets` 返回的 id |
| `assetIds` | string[] | 否 | 参考素材 id，包含主故事板，去重。海螺最多 9 张（超出由其 adapter 截断）；DreamMaker 不限，张数由平台按模型裁定 |
| `text` | string | 是 | 提示词，1–7000 字 |
| `sessionId` | string | 否 | **指定账号**。不传则由池子自动挑一个空闲且积分够的号 |
| `options` | object | 否 | 按 `adapterId` 各有一套，见下 |

### options（hailuo-v1）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `modelId` | `"hailuo3.0-i2v"` | `hailuo3.0-i2v` | MiniMax H3 图生视频 |
| `resolution` | `"768"` \| `"1440"` | `768` | 1440 即 2K，按 12 积分/秒计费 |
| `durationSeconds` | int 4–15 | `5` | MiniMax H3 时长 |
| `aspectRatio` | enum | `16:9` | `Auto` `21:9` `16:9` `4:3` `1:1` `3:4` `9:16` |
| `referenceMode` | `"all-reference"` | `all-reference` | 全能参考 |
| `frameType` | `4` | `4` | 全能参考素材 |
| `quantity` | `1` | `1` | 当前固定生成一条 |
| `useOriginPrompt` | bool | `true` | H3 固定使用原始提示词 |

海螺渠道只支持 MiniMax H3 全能参考：`referenceMode=all-reference`、`frameType=4`。

### options（dreammaker-v1）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `modelId` | string | `minimax-h3` | 平台 `/api/tool_spec/list` 里的任一 `toolKey`，见下表 |
| `mode` | string | 单图 `image2video`，多图 `allReference` | 已知取值 `text2video` `image2video` `firstLastFrame` `imageReference` `allReference` |
| `resolution` | string | `768p` | `480p` `720p` `768p` `1080p` `2k` `4k`，档位随模型 |
| `durationSeconds` | int ≥1 | `5` | 区间随模型 |
| `aspectRatio` | string | `adaptive` | `adaptive` 或 `16:9` 这类比例 |

**这些值网关不校验**：模型清单、清晰度档位、时长区间、参考图张数都按模型变、且随平台更新，
网关拒掉的可能正是平台会接的活，而调用方只会看到一句 `Invalid request`，看不到平台自己的说法。
所以这里只检查形状（非空字符串、正整数），值一律原样转发，由平台裁定并给出它的理由。

**计费按秒**：`积分 = 单价 × 时长`，而**单价同时取决于模型和清晰度**。
唯一准的来源是 `POST /api/billing/quote/aigc`（只读、不扣费，回的是每秒单价）；
`GET /api/billing/canvas-pricing` 每个模型只给一个数，那只是它某一档的价。
本服务按 `模型|清晰度` 缓存 quote 一小时，派单前据此判断这个号付不付得起；quote 打不通才退回 canvas-pricing。

| `modelId` | 名称 | 积分/秒 | 清晰度 | 时长 | 支持模式 |
|---|---|---|---|---|---|
| `minimax-h3` | MiniMax H3 | 768p **500** / 2k **800** | 768p / 2k | 4–15 | 全部四种 |
| `minimax-h3-max` | MiniMax H3 Max（极速版） | 500\* | 480p / 720p | 5–15 | t2v / i2v / 首尾帧 |
| `kling-v3` | 可灵 3.0 | 720p **600** / 1080p **800** / 4k **3000** | 720p / 1080p / 4k | 3、5、10、15 | i2v / 首尾帧 |
| `doubao-seedance-2-0-260128` | Seedance 2.0 | **1000**（480p 与 720p 同价） | 480p / 720p | 4–15 | 全部四种 |
| `doubao-seedance-2-5-260628` | Seedance 2.5 | 480p **672** / 720p **1512** / 1080p **3750** | 480p / 720p / 1080p | 4–30 | 全部四种 |
| `wan3.0-video` / `wan3.0-video-prime` | 通义万相 3.0 标准 / 高速 | **1000**（480p 与 720p 同价） | 480p / 720p | 2–30 | 全部四种 |
| `wan2.7-t2v` / `wan2.7-i2v-bl` | 通义万相 2.7 文生 / 图生 | 1000\* | 480p / 720p | 2–15 | 各自一种 |
| `happyhorse-1.1-t2v` / `happyhorse-1.1-i2v` | Happy Horse 1.1 | 1200\* | 480p / 720p | 3–15 | 各自一种 |

加粗的是逐档 quote 实测值；带 \* 的只有 canvas-pricing 的单一数字，没有逐档验证过——真实扣费以 quote 为准。
差别可以很大：Seedance 2.5 跑 27 秒，480p 是 18144 积分，1080p 是 101250。

模型清单会变，以平台 `/api/tool_spec/list` 为准；本服务不写死模型，传什么就发什么，不认识的模型只是估不出价。

`text2video` 目前发不出去：`assetId` 是必填字段，任务至少要带一张图。要放开得同时改 `createJobSchema` 与 `JobRunner`。

```bash
curl -X POST http://127.0.0.1:3000/v1/jobs \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{
    "adapterId": "dreammaker-v1",
    "assetId": "asset_1285c232-d32c-4432-bdd2-c3206f2cb6f0",
    "text": "镜头缓慢向前推进",
    "options": { "modelId": "minimax-h3", "resolution": "768p", "durationSeconds": 5 }
  }'
```

```bash
curl -X POST http://127.0.0.1:3000/v1/jobs \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{
    "adapterId": "hailuo-v1",
    "assetId": "asset_1285c232-d32c-4432-bdd2-c3206f2cb6f0",
    "text": "镜头缓缓推进，光影柔和流动",
    "options": { "resolution": "768", "durationSeconds": 15 }
  }'
```

### options（higgsfield-v1）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `modelId` | string | `seedance`（`HIGGSFIELD_JOB_TYPE`） | **生成器**，即 `/jobs/` 后面那一段；也可写 `生成器:模型` 同时指定 `params.model` |
| `mode` | `"medias"` \| `"input_image"` | `medias`（`HIGGSFIELD_IMAGE_BINDING`） | 参考素材挂在 `params` 的哪个键上，见下 |
| `resolution` | string | `720p` | `480p` `720p` `1080p` 之类，档位随生成器 |
| `durationSeconds` | int ≥1 | `5` | 区间随生成器 |
| `aspectRatio` | string | `16:9` | 原样发给平台 |
| `quantity` | int ≥1 | 不发 | 发成 `params.batch_size` |

和 DreamMaker 一样，除 `mode` 外这些值网关只检查形状、不校验值域，由平台裁定并给出它自己的理由。

**`modelId` 为什么有两层**：Higgsfield 是聚合站，请求先打到一个生成器
（`POST /jobs/seedance`、`/jobs/minimax-hailuo`、`/jobs/kling2-6`、`/jobs/veo3-1`、`/jobs/sora2-video`、
`/jobs/image2video`、`/jobs/v2/<job_set_type>` …），body 里再点名它跑哪个版本（`params.model`）。
`"seedance"` 只选生成器，`"seedance:seedance-2-5"` 两层都点名。

**`mode` 为什么存在**：这个渠道的参考位收**图、视频、音频**三种，而平台上并存两套写法——
较新的生成器（含 seedance）收 `params.medias: [{role:"start_image", data:{id:"<media id>", type:"image"}}]`，
`role` 取 `start_image`/`end_image`/`image`/`video`/`audio`，三种素材都带得下；
较早的（`image2video`、`minimax-hailuo`、`kling`）收 `params.input_image` / `input_image_end`，
值是裸 id，**只能放两张图**，视频和音频没有去处。API 不告诉你某个生成器要哪一套，所以它是配置项，
按任务可用 `mode` 覆盖。写错不会报错，只会得到一条看不见参考素材的视频，因此这一项是枚举、不是自由文本。

**目前只有图能真的送到**：网关的 `POST /v1/assets` 只收 `image/*`，参考视频和音频没有入口。
这是网关层的限制、不是 Higgsfield 的，海螺那条路也一样。

**计费**：账号余额和价目表在网关里都换算成站上显示的整数积分（平台内部按 1/100 积分计）。
`GET /job-sets/costs` 只按生成器给一个数，不分清晰度和时长，所以估价只用来挡住余额见底的号，
不能当账单预测；不在表里的生成器直接不估价。

```bash
curl -X POST http://127.0.0.1:3000/v1/jobs \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{
    "adapterId": "higgsfield-v1",
    "assetId": "asset_1285c232-d32c-4432-bdd2-c3206f2cb6f0",
    "text": "镜头缓慢向前推进",
    "options": { "modelId": "seedance:seedance-2-5", "resolution": "720p", "durationSeconds": 5 }
  }'
```

**202**

```json
{
  "jobId": "job_f272a230-c6e1-4b1c-a58e-b408a1daae28",
  "status": "queued",
  "statusUrl": "/v1/jobs/job_f272a230-c6e1-4b1c-a58e-b408a1daae28"
}
```

**409 —— 所有账号积分都为 0**（提交时就拦下，不会产生一个注定失败的任务）

```json
{
  "error": {
    "code": "INSUFFICIENT_CREDITS",
    "message": "Every account is out of credits",
    "accounts": [
      { "sessionId": "hailuo-1", "credits": 0, "exhausted": true, "busy": false }
    ]
  }
}
```

---

## GET /v1/jobs/{jobId}

轮询任务。

**生成中**

```json
{
  "id": "job_f272a230-c6e1-4b1c-a58e-b408a1daae28",
  "status": "running",
  "adapterId": "hailuo-v1",
  "sessionId": "hailuo-1",
  "assetId": "asset_1285c232-...",
  "text": "镜头缓缓推进，光影柔和流动",
  "options": { "resolution": "768", "durationSeconds": 6 },
  "creditsBefore": 264,
  "createdAt": "2026-08-20T06:22:11.680Z",
  "startedAt": "2026-08-20T06:23:25.246Z"
}
```

**关于 `progress.percent`**：海螺会给真实百分比；DreamMaker 不给——整条渲染都是 0，只在结束时跳 100。
所以 DreamMaker 任务看 `progress.message` 的阶段（平台排队中 → 生成中 → 转存成片中），那才是会动的。

`status` 有四个值：

| 值 | 含义 |
|---|---|
| `queued` | 已受理，正在等一个空闲账号。此时 `sessionId` 可能还没定 |
| `running` | 已占到账号，正在上传/生成。`startedAt` 是拿到账号的时刻，不是提交时刻 |
| `succeeded` | 完成，`result` 里有视频地址 |
| `failed` | 失败，`error` 里有原因 |

`createdAt` → `startedAt` 之间就是排队时间。

**生成中的 `progress`**（提交到海螺之后出现）

```json
{
  "status": "running",
  "progress": {
    "providerJobId": "556804997263765507",
    "batchId": "556804997263765506",
    "percent": 0,
    "renderAttempts": 1,
    "message": "海螺生成失败（内容生成失败。请重试。），30s 后第 2/4 次尝试",
    "retry": {
      "step": "render",
      "attempt": 1,
      "maxAttempts": 4,
      "delayMs": 30000,
      "nextAttemptAt": "2026-09-17T10:00:30.000Z",
      "code": "PROVIDER_RENDER_FAILED",
      "reason": "内容生成失败。请重试。"
    },
    "updatedAt": "2026-09-17T10:00:00.000Z"
  }
}
```

| 字段 | 含义 |
|---|---|
| `providerJobId` | 海螺侧当前这条视频的 id；渲染失败重投后会换成新 id |
| `percent` | 海螺报的渲染进度 0–100 |
| `renderAttempts` | 这个 job 已向海螺提交了几次生成（1 = 还没重投过） |
| `retry` | **服务端正在等待重试**。出现它说明上一步失败了但服务还没放弃；`step` 是失败的步骤（`credits` 读余额 / `upload` 上传参考图 / `submit` 提交 / `poll` 查状态 / `render` 海螺渲染失败重投），`attempt` 是刚失败的第几次，`maxAttempts` = 首次 + 重试次数，`nextAttemptAt` 是下一次开始的时间。重试一开始它就被清掉 |
| `message` | 面向人的一句话，重试中与 `retry` 同步 |

**服务端重试口径**：调用方是来生视频的，所以**除了账号积分不足，任何失败都由本服务自己按 `HAILUO_RETRY_DELAYS_MS`（默认 10s / 30s / 60s，共 3 次）重试**——网络抖动、海螺“当前资源较忙”、渲染“内容生成失败。请重试。”、文案违规（2400002）、token 异常、未知错误一律如此。期间 job 一直是 `running`，调用方照常轮询即可，**不要**因为看到 `retry` 就重新提交。渲染失败的重投复用已上传的参考图，不重新上传，海螺对失败渲染不扣积分；单次渲染超时的重试是继续轮询同一条视频，不重投，避免扣两次。文案违规同样的文案原样再提 3 次，3 次都被拒才 `failed`（`CONTENT_REJECTED`），此时要改文案。积分不足不重试，由调度器换账号。

**完成**

```json
{
  "status": "succeeded",
  "sessionId": "hailuo-1",
  "creditsBefore": 276,
  "finishedAt": "2026-08-20T06:23:24.000Z",
  "result": {
    "status": "succeeded",
    "text": "镜头缓缓推进，光影柔和流动",
    "videoId": "546702744619728905",
    "batchId": "546702744061886470",
    "videoUrl": "https://cdn.hailuoai.com/prod/.../1787200287527112530-0_1787200287.mp4",
    "downloadUrls": {
      "watermarkURL": "...",
      "aiWatermarkURL": "...",
      "hailuoWatermarkURL": "...",
      "fileName": "海螺_视频_镜头缓缓推进_546702744619728905",
      "fileID": "546702959100477447"
    },
    "coverUrl": "https://cdn.hailuoai.com/prod/....jpeg?x-oss-process=image/resize,w_540/format,webp",
    "durationSeconds": 6,
    "referenceImage": { "fileId": "546702743085264900", "url": "https://cdn.hailuoai.com/..." },
    "creditsBefore": 276,
    "creditsAfter": 264,
    "creditsSpent": 12
  }
}
```

`videoUrl` 就是可直接下载的 mp4。三个 `downloadUrls` 是不同水印版本，`watermarkURL` 与 `videoUrl` 通常相同。

**dreammaker-v1 的 result** 形状不同：没有 `downloadUrls`（平台只出一份无水印 mp4），
多了 `taskId`（平台任务号，也是 `progress.providerJobId`）、`model`、`ossUri`、`width` / `height` / `sizeBytes`
和原样透出的 `artifacts`。`creditsSpent` / `creditsAfter` 来自平台自己回报的 `creditCost` / `balanceAfter`，
不是两次余额相减，所以和账单一定对得上。

```json
{
  "result": {
    "status": "succeeded",
    "taskId": "cgt_231a066ed8ad4e4b888d80a294722f7b",
    "model": "minimax-h3",
    "videoUrl": "https://vmatch-meta.oss-cn-hangzhou.aliyuncs.com/....mp4?OSSAccessKeyId=...&Expires=1790516496&Signature=...",
    "ossUri": "oss://vmatch-meta/dream_maker/user_21574/canvas/default/artifacts/....mp4",
    "coverUrl": "https://vmatch-meta.oss-cn-hangzhou.aliyuncs.com/....mp4?x-oss-process=video/snapshot,...",
    "width": 768,
    "height": 1344,
    "sizeBytes": 966227,
    "creditsBefore": 43184,
    "creditsAfter": 40684,
    "creditsSpent": 2500,
    "renderAttempts": 1
  }
}
```

DreamMaker 的成片链接签名有效期约 7 天（海螺约 1 天），但仍要尽快转存：`JOB_RETENTION_DAYS` 默认 1 天就会清任务记录。

**higgsfield-v1 的 result**：`taskId` 是平台的 job set id（也是 `progress.providerJobId`），
`jobId` 是出片的那个 job，`model` 是平台回的 `job_set_type`，`jobs[]` 原样列出这一组里每个 job 的
状态与链接（一次提交可能出多条）。`creditsSpent` 是**提交前后两次读余额相减**——平台不在任务上回报
扣费，所以这个数在账号同时跑别的任务时会偏，只能当参考；读不到余额时这两个字段直接缺省。

```json
{
  "result": {
    "status": "succeeded",
    "taskId": "01998f2c-...-job-set",
    "jobId": "01998f2c-...-job",
    "model": "seedance",
    "videoUrl": "https://cdn.higgsfield.ai/....mp4",
    "coverUrl": "https://cdn.higgsfield.ai/....jpg",
    "jobs": [{ "id": "01998f2c-...-job", "status": "completed", "url": "https://cdn.higgsfield.ai/....mp4" }],
    "creditsBefore": 2625,
    "creditsAfter": 2595,
    "creditsSpent": 30,
    "renderAttempts": 1
  }
}
```

**失败**（服务端重试用尽之后才会出现）

```json
{
  "status": "failed",
  "error": {
    "code": "PROVIDER_RENDER_FAILED",
    "message": "Hailuo generation 556807323462524935 failed: 内容生成失败。请重试。 (render: gave up after 4 attempts)",
    "retryable": true,
    "attempts": 4,
    "providerMessage": "内容生成失败。请重试。"
  }
}
```

| 字段 | 含义 |
|---|---|
| `code` | 见下方“任务级失败码” |
| `retryable` | `true`：服务端**已经按 3 次重试过并放弃**，换个时间重新提交可能成功（`CONTENT_REJECTED` 例外：3 次原样重提都被拒，应先改文案）；`false`：积分不足（由调度器换号，全都不够才失败），服务端不重试 |
| `attempts` | 服务端在出错的那一步一共试了几次（含首次） |
| `providerCode` / `providerMessage` | 海螺自己的状态码和原话，便于排查 |

调用方看到 `failed` 就是最终结论，**不需要再自行按网络抖动重试**。渲染失败**不扣积分**。

---

## GET /v1/accounts

调度池的实时状态 —— 排任务、查积分、发现死号都看这个。

每个 `tokens.txt` 非空行会对应一个 `sessionId`（例如第 1 个 token → `hailuo-1`），
因此 `accounts[]` 就是逐 token 的实时积分余额；服务不会返回原始 token。

服务还会自动维护本地 `data/TOKEN_BALANCES.md`：按积分余额从高到低排列，token 仅显示
前 8 位和后 8 位。服务启动、余额刷新、任务调度以及每次任务完成后都会更新；任务完成时
会重新查询刚使用账号的真实余额。

默认每次都去海螺拉一次真实余额；`?refresh=false` 用缓存（TTL `CREDITS_CACHE_TTL_MS`，默认 60s）。
可选 `?adapterId=hailuo-v1` 过滤。

```json
{
  "totalCredits": 276,
  "idle": 1,
  "busy": 0,
  "exhaustedSessionIds": [],
  "accounts": [
    {
      "sessionId": "hailuo-1",
      "adapterId": "hailuo-v1",
      "account": { "userId": "546675790002360326", "name": "探索者326", "expiresAt": "2026-09-29T02:43:29.000Z" },
      "busy": false,
      "activeJobs": 0,
      "capacity": 2,
      "credits": 276,
      "creditsCheckedAt": "2026-08-20T06:22:11.670Z",
      "depleted": false,
      "exhausted": false
    }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `busy` | 该账号至少有一个视频正在生成或处于海螺队列中 |
| `activeJobs` | 已经提交或正在向海螺提交的视频数量 |
| `capacity` | 海螺侧未完成视频容量，当前固定为 2（1 个生成中 + 1 个海螺队列中） |
| `credits` | 最近一次读到的余额；`undefined` 表示还没读到过 |
| `depleted` | 余额不够下一单，本轮跳过 |
| `exhausted` | 余额恰好为 0 —— 号用完了，不是暂时不够 |
| `retired` | token 已从 `tokens.txt` 消失，但还有任务在它上面跑：不再派新任务，跑完最后一个才真正删除 session |
| `lastError` | 余额读取失败的原因（例如 token 过期） |
| `exhaustedSessionIds` | 顶层汇总，直接看这个就知道哪些号废了 |

自动调度采用“最小剩余积分”策略：先计算本次任务成本，再从所有空闲且够分的账号中，
选择执行后余额最少的账号。例如 768p、7 秒任务需要 `7 × 7 = 49` 分，若有账号
余额为 50 分，会优先使用该账号（任务后仅剩 1 分），以最大限度消耗零散积分。

---

## GET /v1/credits

所有账号余额的简版视图。单个账号出错只在该条目上带 `error`，不影响其他号。

```json
{
  "totalCredits": 276,
  "accounts": [
    {
      "sessionId": "hailuo-1",
      "adapterId": "hailuo-v1",
      "account": { "userId": "546675790002360326", "name": "探索者326" },
      "balance": { "totalCredits": 276, "breakdown": [] }
    }
  ]
}
```

调度请用 `/v1/accounts`；这个接口只是给人看余额的。

---

## 账号与并发

### 池子怎么挑号

1. 过滤出 `adapterId` 匹配的账号（传了 `sessionId` 就只看那一个）
2. 跳过已经占满 2 个槽位的账号；优先选择当前任务数更少的账号
3. 剩下的按**最久未使用**排序，逐个检查余额
4. 用该账号自己的价目表算这单要多少积分，余额不够就跳过并标 `depleted`
5. 第一个够的拿到租约并预留本单积分；每账号最多向海螺提交 2 个未完成视频
6. 所有账号都占满 → 超出的任务只保留在本服务的 `queued`，等槽位释放后才向海螺提交；全都不够 → 任务 `failed`，`error.code = INSUFFICIENT_CREDITS`，`error.accounts` 列出每个号的余额
7. 余额读取本身失败（`fetch failed`、5xx、“资源较忙”）不算“不够”：按 `HAILUO_RETRY_DELAYS_MS` 的节奏（默认 10s / 30s / 60s）重读，仍读不到才 `failed`，`error.code = ACCOUNT_BALANCE_UNAVAILABLE`、`retryable = true`，`error.accounts[].lastError` 带每个号的读取错误。读失败的结果不会被缓存，下一条任务会重新向海螺询价

MiniMax H3 使用固定按秒计费：768 为 7 积分/秒，1440（2K）为 12 积分/秒。例如 2K 5 秒任务需要 60 积分，调度前会据此过滤余额不足的账号。其他模型的价目表按账号从 `/v1/api/user/equity` 的 `modelControl` 读取。

### 加账号

在项目根目录的 `tokens.txt` 中一行写一个 token，顺序就是 `sessionId`：

```
eyJhbGci...                     → hailuo-1
eyJhbGci...                     → hailuo-2
```

token 就是浏览器里 hailuoai.com 的 `_token` cookie。每次启动用文件内的 token 覆盖对应 session，`tokens.txt` 是唯一真源。空行和以 `#` 开头的注释行会被忽略；可用 `HAILUO_TOKEN_FILE` 指定其他路径。

也可以运行时加：`PUT /v1/sessions/{id}/cookies`，body `{ "adapterId": "hailuo-v1", "cookies": [{ "name": "_token", "value": "...", "domain": ".hailuoai.com", "path": "/" }] }`。cookie 域名必须落在 `hailuoai.com` / `hailuoai.video` 下。

新加的号下一次调度就会被 `sync()` 发现，不用重启。

**DreamMaker 的账号**放在 `dreammaker-accounts.txt`（`DREAMMAKER_ACCOUNT_FILE` 可改），同样是一行一个、热加载、`#` 注释：

```
eyJhbGci...                     → dreammaker-21574（access token，取自浏览器 localStorage.access_token）
13316786433----密码              → 登录换 token，到期前自动续
17012345678:密码                 → 同上，两种分隔符都认
```

用户名密码可以用 `----` 或 `:` 分隔，按**第一个**出现的分隔符切，`----` 优先，所以密码里带冒号也不会被切坏。

`sessionId` 取自 token 里的 `sub`（`dreammaker-<用户 id>`），所以重新登录换了 token 也还是同一个号。

两种 token 的寿命不一样，这决定了该用哪种写法：

| 来源 | 寿命 | 维护方式 |
|---|---|---|
| 浏览器 `localStorage.access_token` | 约 7 天 | 到期要手动换（`GET /v1/accounts` 的 `account.expiresAt` 提前告诉你） |
| `POST /api/auth/login`（密码行） | **约 16 小时** | 服务每小时检查，剩余不足「寿命的四分之一」就自动重登并换掉 session 里的 token |

续期阈值取 `DREAMMAKER_TOKEN_CHECK_MS` 对应窗口与 token 寿命四分之一里较小的那个——
16 小时的 token 按固定「不足一天就续」会每次检查都重登。密码只留在内存里，不写进 session。

### 积分为 0 会怎样

余额读到 0 时：

- 该号立刻标 `exhausted` + `depleted`，不再被派任务
- 服务端打一条 `warn` 日志（只打一次，不会每次轮询刷屏）：
  `Hailuo account is out of credits — it will be skipped until it is topped up`
- 出现在 `GET /v1/accounts` 的 `exhaustedSessionIds` 里
- 如果**所有**号都是 0，`POST /v1/jobs` 直接返回 **409**，不再受理

服务启动时会主动拉一次所有账号的余额，所以有号是 0 在**第一次查询时**就会报出来，不用等到提交任务。

余额严格小于 28（H3 768P、4 秒任务的最低费用）时，服务会自动从 `tokens.txt` 删除对应 token。
如果这个账号上还有 `queued` / `running` 的任务，session **不会**跟着删：账号进入 `retired` 状态，继续把手上的任务跑完（服务重启后也能凭它 resume），跑完最后一个才删除 session。没有在跑任务的账号则立即移除。

---

## 成本

单次生成消耗的积分。

海螺（MiniMax H3）：

| 分辨率 | 积分 |
|---|---|
| 768p | 7 / 秒 |
| 2K（1440） | 12 / 秒 |

DreamMaker 也按秒计价，但单价随**模型和清晰度**变（500–3750 积分/秒，见上面的模型表），
所以同样 5 秒的一条片子，MiniMax H3 768p 是 2500 积分，Seedance 2.5 480p 是 3360，1080p 是 18750。
两边的积分是各自平台的，不通用。

以 `GET /v1/accounts` 返回的实时余额为准；渲染失败不扣费。

---

## 错误码

| HTTP | code | 含义 |
|---|---|---|
| 401 | `UNAUTHORIZED` | `x-api-key` 缺失或不对 |
| 400 | `VALIDATION_ERROR` | 参数不合法，`issues` 里有字段级详情 |
| 400 | `ADAPTER_NOT_FOUND` | `adapterId` 不认识 |
| 400 | `ASSET_NOT_FOUND` | `assetId` 不存在 |
| 400 | `NO_ACCOUNTS_AVAILABLE` | 没配账号，或指定的 `sessionId` 不可用 |
| 400 | `FILE_REQUIRED` / `UNSUPPORTED_FILE_TYPE` / `FILE_SIGNATURE_MISMATCH` | 上传相关 |
| 404 | `JOB_NOT_FOUND` / `SESSION_NOT_FOUND` | 找不到 |
| 409 | `INSUFFICIENT_CREDITS` | 所有账号积分不足 |
| 502 | `CREDIT_QUERY_FAILED` | 查余额失败（通常是 token 过期） |

### 任务级失败码

在 `GET /v1/jobs/{id}` 的 `error.code` 里；`retryable` 列是服务端给的建议。

| code | retryable | 含义 |
|---|---|---|
| `PROVIDER_RENDER_FAILED` | true | 海螺接了单但渲染失败（“内容生成失败。请重试。”），服务端已重投 3 次仍失败 |
| `PROVIDER_NETWORK_ERROR` | true | 本服务到海螺 / OSS 的连接失败（`fetch failed`、5xx、429 等），重试 3 次仍失败 |
| `PROVIDER_BUSY` | true | 海螺“当前资源较忙”，重试 3 次仍失败 |
| `PROVIDER_JOB_NOT_FOUND` | true | 海螺的创作列表里连续 4 次都找不到这条视频 |
| `CONTENT_REJECTED` | true | 文案或参考图违反社区规范（海螺 2400002），原样重提 3 次仍被拒；改内容再提 |
| `INSUFFICIENT_CREDITS` | false | 所有候选账号积分都不够，`error.accounts` 列出余额 |
| `ACCOUNT_BALANCE_UNAVAILABLE` | true | 派单时所有候选账号的余额都读不到（本服务到海螺的网络问题），重读 3 次仍失败；任务没有提交，`error.accounts[].lastError` 是每个号的读取错误 |
| `AUTH_FAILED` | true | 账号 token 过期 / 失效，重试 3 次仍失败 |
| `RENDER_TIMEOUT` | true | 同一条视频连续 4 轮 `HAILUO_POLL_TIMEOUT_MS` 仍未完成 |
| `JOB_TIMEOUT` | false | 整个 job 超过运行预算（极少见，预算已覆盖全部重试） |
| `INTERRUPTED` | false | 服务重启时该 job 还没拿到海螺 id，结果未知，请重新提交 |
| `NO_ACCOUNTS_AVAILABLE` / `SESSION_NOT_FOUND` / `SESSION_ADAPTER_MISMATCH` / `ADAPTER_NOT_FOUND` / `ASSET_NOT_FOUND` | false | 配置或参数问题 |
| `AUTOMATION_FAILED` | true | 其他未分类错误，重试 3 次仍失败，看 `message` |

---

## 其他接口

- `GET /health` —— 无需鉴权。返回浏览器池状态和已注册的 adapter
- `GET /v1/sessions` —— 列出所有 session（含从 JWT 解出的账号昵称、过期时间）
- `GET /v1/sessions/{id}/credits` —— 单个账号余额

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `API_KEY` | — | 本服务网关密钥。与海螺无关 |
| `HAILUO_TOKEN_FILE` | `./tokens.txt` | 海螺账号 token 文件，一个账号一行 |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 监听地址 |
| `HAILUO_MODEL_ID` | `hailuo3.0-i2v` | 当前固定 MiniMax H3 |
| `HAILUO_RESOLUTION` | `768` | `768` 或 `1440` |
| `HAILUO_DURATION` | `5` | 4–15 秒 |
| `HAILUO_ASPECT_RATIO` | `16:9` | 默认画幅 |
| `HAILUO_REFERENCE_MODE` | `all-reference` | 当前固定全能参考 |
| `HAILUO_FRAME_TYPE` | `4` | 当前固定全能参考素材 |
| `HAILUO_POLL_TIMEOUT_MS` | `900000` | 单次渲染等待上限（重投后重新计时） |
| `HAILUO_POLL_INTERVAL_MS` | `10000` | 轮询海螺的间隔 |
| `HAILUO_RETRY_DELAYS_MS` | `10000,30000,60000` | 单个步骤失败后的重试间隔，个数即重试次数；`none` 关闭重试 |
| `DREAMMAKER_ACCOUNT_FILE` | `./dreammaker-accounts.txt` | DreamMaker 账号文件：access token 或 `用户名:密码`，一行一个 |
| `DREAMMAKER_ORIGIN` | `https://dreammaker.vobile.com.cn` | 平台地址 |
| `DREAMMAKER_MODEL` | `minimax-h3` | 默认模型（在架里最便宜的一个），每单可用 `options.modelId` 覆盖 |
| `DREAMMAKER_MODE` | `image2video` | 默认输入模式 |
| `DREAMMAKER_RESOLUTION` | `768p` | 默认清晰度 |
| `DREAMMAKER_DURATION` | `5` | 默认时长（秒） |
| `DREAMMAKER_ASPECT_RATIO` | `adaptive` | 默认画幅，`adaptive` 跟随首帧 |
| `DREAMMAKER_POLL_TIMEOUT_MS` / `DREAMMAKER_POLL_INTERVAL_MS` | `900000` / `10000` | 轮询上限与间隔 |
| `DREAMMAKER_RETRY_DELAYS_MS` | `10000,30000,60000` | 同 `HAILUO_RETRY_DELAYS_MS`，作用于 DreamMaker |
| `DREAMMAKER_TOKEN_CHECK_MS` | `3600000` | 多久检查一次密码账号的 token 是否临近过期 |
| `DREAMMAKER_PROXY_URL` | — | 一般不用：平台是国内站，默认直连 |
| `CREDITS_CACHE_TTL_MS` | `60000` | 余额缓存时间 |
| `MAX_UPLOAD_BYTES` | `10485760` | 上传大小上限 |
| `DATA_DIR` | `./data` | 素材与 session 落盘目录 |

生成任务走纯 HTTP 直连海螺，**不需要 Playwright 浏览器**。`BROWSER_POOL_SIZE` / `BROWSER_HEADLESS` 只影响旧的浏览器自动化路径。
