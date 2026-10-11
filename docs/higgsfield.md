# 渠道：Higgsfield（higgsfield.ai）

日期：2026-09-21。离线前端：`Downloads/higgsfield.ai`（`/ai/video` 页面的构建产物，TanStack Start）。
本文记的是从该产物里逆出来的结论；**尚未用真实账号跑通**，见文末「未验证」。

## 一句话结论

传输层比海螺简单：**纯 REST + Bearer JWT，没有请求签名、没有设备身份**。难点有两个：
**凭据**——认证走 Clerk，网关要的那个 bearer token 只活约一分钟，所以存的是 Clerk 的长效
`__client` cookie，每次调用现换短 token；以及 **`/jobs/*` 被 Cloudflare 挡着**——
上传和轮询 Node 直连没问题，唯独提交这一步过不去，见下面「Cloudflare」。

## Cloudflare：提交那一步 Node 发不出去

2026-09-21 用真号实测：`POST /jobs/v2/seedance_2_5` 和 `POST /jobs/status-batch` 都返回
**403 + `cf-mitigated: challenge`**（Cloudflare 托管挑战的 "Just a moment..." 页面）。
同一个 token、同一时刻：

| 调用 | 结果 |
|---|---|
| `GET /workspaces/wallet`、`GET /job-sets/costs` | 200 |
| `POST /media/batch` | 200 |
| `POST /jobs/...`（提交、status-batch） | 403 challenge |

换出口（直连 / 本机 mihomo）和补全浏览器头（UA、Origin、Referer、sec-fetch-*）都不改变结果，
所以**不是 IP 也不是请求头，是挂在 `/jobs` 前缀上的 WAF 规则**：它要的是浏览器跑过挑战后
拿到的 `cf_clearance` cookie。也就是说本渠道现在**提交不了任务**，上传和轮询都是好的。

两条出路：在浏览器页面里发这条 POST（页面本身已经过挑战），或者把浏览器拿到的
`cf_clearance` 取出来、Node 带着它发（clearance 绑 IP + UA，过期要续）。两条都没做。

## 端点

网关：`https://fnf-api-gw.higgsfield.ai/fnf`（前端 `Eb()` 的 `baseURL`）。
请求头：`Authorization: Bearer <__session JWT>`、`Content-Type: application/json`，
可选 `hf-workspace-id`（团队 scope）与 `hf-surface`（前端用来标记来源页面）。

| 步骤 | 接口 | 说明 |
|---|---|---|
| 1 上传 | `POST /media/batch` | `{mimetypes:["image/png"], source:"user_upload"}` → `[{id, url, upload_url, content_type}]` |
| 2 上传 | `PUT <upload_url>` | 预签名直传，带 `Content-Type`；无 token，走直连 |
| 3 上传 | `POST /media/{id}/upload` | `{filename, force_nsfw_check, force_ip_check}`，确认并触发平台自己的检查 |
| 4 提交 | `POST /jobs/<生成器>` | body `{params:{…}, use_unlim, use_free_gens}` → `{job_sets:[…]}`；参考素材见下 |
| 5 轮询 | `GET /job-sets/{id}` | → `{id, type, jobs:[{id, status, results:{raw:{url},min:{url}}}]}` |
| — | `POST /jobs/status-batch` | `{ids}` → `{items:[…]}`，只有状态没有结果，本服务不用 |
| 余额 | `GET /workspaces/wallet` | `{subscription_balance, credits_balance, on_demand_credits, …}` |
| 价目 | `GET /job-sets/costs` | 每个生成器一个数 |

`job.status`：`queued` / `in_progress` / `completed` / `failed` / `nsfw` / `canceled`。
没有百分比进度，只有状态，所以 `progress.percent` 在这个渠道上始终为空。

## 认证：Clerk

前端用 clerk-js 6.25.10，Clerk 的 FAPI 在 `https://clerk.higgsfield.ai`。两个 cookie：

- **`__session`** —— 网关要的那个 JWT，载荷 `{sub: user_…, sid: sess_…, exp}`，**约 60 秒过期**
- **`__client`** —— Clerk 的长效客户端凭据，载荷 `{id: client_…, rotating_token}`，浏览器登录态就靠它

所以账号文件里存 `__client`，本服务自己换短 token：

```
GET  {clerk}/v1/client?_clerk_js_version=6.25.10          Cookie: __client=…
     → {response:{sessions:[{id: sess_…, status, user:{id}}], last_active_session_id}}
POST {clerk}/v1/client/sessions/{sess_…}/tokens?_clerk_js_version=6.25.10
     → {response:{jwt: "…"}}
```

`HiggsfieldSessionTokens` 缓存这个 JWT 直到剩余不足 15 秒，并发调用共用一次 mint；
遇到 401 就丢弃重来一次（token 可能在飞行途中过期）。`sess_…` 记住不重查，mint 失败时
才回头重新查一次 —— 别处重新登录会换掉 session id。

**账号 id 不依赖网络**：`higgsfield-<client_…>`（或 session token 的 `higgsfield-<user_…>`）
直接从 JWT 载荷取。换一张同一浏览器的新 cookie，account id 不变，池子里的账号不会重新洗牌。

一行 `__session` JWT 也收，但一分钟就废，只够跑一次验证，启动日志会就此告警。

### 怎么拿这个 cookie

登录是微软邮箱 + 密码（Clerk 的 OAuth，跳 `login.microsoftonline.com`），Node 里跑不完，
所以有 `npm run higgsfield:login`：开本机 Chrome 的一个**临时资料目录**（无痕，和日常
那份 Chrome 隔开，关掉即清空），人工登进去，脚本等 `__session` 出现后取走 `__client`，
用它换一次短 token 读一遍钱包确认可用，再写进账号文件（同账号就地替换，不重复追加）。
默认走本机 mihomo `127.0.0.1:7897`，浏览器和 Node 这边同一个出口。
`--browser=msedge` / `--exe=` / `--direct` / `--proxy=` / `--timeout=` / `--print` 见脚本头部。

## 两层模型：生成器 + 版本

Higgsfield 是聚合站，这是它和前两个渠道最大的结构差别：请求先打到一个**生成器**，body 里再点名
它跑哪个**版本**。已在包里看到的视频生成器：

```
image2video  image2video-mix  image2video-extend-v2  minimax-hailuo  seedance
kling  kling2-6  kling-omni-flf  kling-omni-image-reference  kling-video-edit
wan2-2-video  wan2-5-video  wan2-6  veo3  veo3-1  veo3-speak  veo3-1-speak
sora2-video  grok（在 v2/ 下）  以及一批 v2/<job_set_type>
```

`options.modelId` 同时承载两层：`"seedance"` 只选生成器，`"seedance:seedance-2-5"` 两层都点名
（后者发成 `params.model`）。生成器清单会变，网关不写死，传什么就打到哪个路径。

**较新的模型走 `/jobs/v2/<job_set_type>` 这条**，前端里绝大多数提交函数都是它。Seedance 2.5
就在这条上：路径 `POST /jobs/v2/seedance_2_5`，body `{params, use_unlim, use_free_gens,
use_generation_seconds}`，参考素材用 `medias: [{role:"image", data:{…}}]`，`params.model`
留给 `video_edit` / `video_extension` / `seedance_2_5_extend` 这些变体，普通图生视频不带。
从本服务指过去不用改代码：`options.modelId = "v2/seedance_2_5"`（裸值即生成器，直接拼路径）。
`GET /job-sets/costs` 里能看到的 30 个 `job_set_type` 就是当前在售的清单。

## 参考素材挂在哪个键上——这是这个渠道唯一需要人工配置的点

**这个渠道的参考位收图、视频和音频三种**（网页端 Create Video 的 References 面板明写
"Image, Video or Audio"），不是只收图。能不能带得下后两种，取决于挂在哪个键上：

| 写法 | 形状 | 能带 | 已确认使用的生成器 |
|---|---|---|---|
| `medias` | `params.medias: [{role, data:{id, type}}, …]` | 图 + 视频 + 音频 | 较新的那批（前端通用视频表单走这条，seedance 在内） |
| `input_image` | `params.input_image` / `input_image_end`，值是裸 media id | 只有图，且最多两张 | `image2video`、`minimax-hailuo`、`kling`、`kling-omni-flf` |

`medias` 的打包函数在 `vDwbIZuK1tnel3z4.js`：

```js
{ role: i, data: N(e) }        // N(e) = { ...extras, id: e.id, type: e.type, url? }
```

`role` 取 `start_image` / `end_image` / `image` / `video` / `audio`，`type` 取 `image` / `video` / `audio`。
**`data` 是对象不是裸 id**，这点和 `input_image` 那套正相反，写成字符串平台不认。

前端里把参数还原成素材列表的那个函数（`fPVlvKqYeqsYJclr.js`）只对 `KLING / KLING_OMNI_FLF /
MINIMAX_HAILUO / IMAGE2VIDEO` 读 `input_image`，其余读 `medias`；seedance 的提交类没有任何
`input_image` 痕迹，而通用视频表单（`0_dFV44mpzfox6C2.js`，带 `bitrate_mode` / `generate_audio`，
对得上网页端 Seedance 2.5 那张表单）走的正是 `medias`，所以 seedance 默认按 `medias` 发。

默认由 `HIGGSFIELD_IMAGE_BINDING` 定（默认 `medias`），单个任务用 `options.mode` 覆盖。
**写错不会报错**——平台会收下一条看不见参考素材的任务，照样扣费。所以这一项在 schema 里是枚举，
不是自由字符串，而且第一次跑真号时要先确认出片里确实有参考图。

注意两套写法里给的都是 media **id**，不是 URL——和 DreamMaker 正相反。

**但目前只有图能真的送到**：本网关自己的 `POST /v1/assets` 只收
`image/png|jpeg|webp|gif`，参考视频和音频没有入口。这是网关层的限制、不是平台的，
海螺那条路也一样。适配器这边已经按 media 的 kind 打好 `role` 与 `type`，
`/v1/assets` 放开的那天不用再改这里。

## 计价

积分在 API 里以 **1/100 积分**为单位（前端所有显示处都 `/100`），网关在 `parseWallet` 和
`parseCostTable` 里一次性换算成整数积分，对外只有整数。

`GET /job-sets/costs` 的真实形状（2026-09-21 真号实测，**和这里原先写的不一样**）是
`{data: [{job_set_type, cost: [...]}]}`，逐档给价、单位是**积分/秒**，而且数值已经是整积分
带小数（3、4.5、7），不是 1/100。各行的 `cost` 形状还不统一：

```jsonc
{"job_set_type":"seedance_2_5","cost":[{"resolution":"720p","video":{"with_video":{"cost_per_second":7},"without_video":{"cost_per_second":7}}}, …]}
{"job_set_type":"seedance_2_0","cost":[{"model":"seedance_2_0","resolutions":[{"resolution":"720p","cost_per_second":4.5,"original_cost_per_second":6}, …]}]}
{"job_set_type":"kling3_0","cost":[{"mode":"pro","audio":{"on":2.5,"off":1.75}}, …]}
```

`job_set_type` 用下划线（`seedance_2_5`、`kling3_0`），和 `/jobs/` 路径段（`seedance`、
`kling2-6`）不是一套写法。**`parseCostTable` 认不出这个形状，整表为空**，于是
`estimateJobCost` 一律返回 `undefined`、池子退回「有余额就行」—— 按设计这是安全的降级
（不会算出错价），但估价功能等于没有。要修得连 `job_set_type` 映射一起补。

余额来自 `GET /workspaces/wallet`。`on_demand_credits` 是按量计费的额度而不是余额，
**不计入可花费总额**——把它算进去会让一个空账号看起来付得起，于是所有任务都往它派。

## 失败分类

| 信号 | 归类 | 本服务行为 |
|---|---|---|
| code `not_enough_credits` 之类 / HTTP 402 / 文案里说 credits 不够 | 付不起 | 不重试，换账号 |
| `job.status: nsfw`，或 code/文案命中审核词 | 内容被拒 | 原样重提 3 次，仍拒则 `CONTENT_REJECTED` |
| HTTP 429 / 限流 code | 排队 | 退避重试 |
| HTTP 401 / 403、Clerk mint 失败 | token 失效 | 丢弃缓存的短 token 重试一次；仍失败则报 `AUTH_FAILED`，要换 `__client` |
| HTTP 408 / 5xx、连接层错误 | 网络 | 退避重试 |
| `job.status: failed`，或 completed 但没有成片 | 渲染失败 | 用已上传的 media 重新提交，最多 3 次 |
| 轮询超时 | 超时 | **继续轮询同一个 job set**，不重投（重投要再付一次） |

## 未验证

2026-09-21 用真号（`npm run higgsfield:login` 登进去的那个）跑通了认证到钱包这一段：
Clerk 的 `__client` → 短 token → `GET /workspaces/wallet` 正常返回，**第 1 条已确认**
（读出「订阅 100 + 已购 10」而不是 10000/1000，字段名和 1/100 换算都对）。
其余几条仍然只是从前端产物推断，**按这个顺序确认**：

1. ~~`GET /workspaces/wallet` 的字段名与 1/100 单位~~ —— 已确认
2. ~~`GET /job-sets/costs` 的行形状~~ —— 已确认，**和原先写的不一样**（逐档、积分/秒、
   下划线命名），`parseCostTable` 一条都认不出，见上面「计价」
3. seedance 到底收 `medias` 还是 `input_image`（默认 `medias`，看出片有没有参考图）；
   以及 `medias[].data` 的 `{id, type}` 是否还要带 `url`（前端的 `N()` 里 `url` 是可选的）
4. `params` 的键名：`duration` / `resolution` / `aspect_ratio` 是从通用视频表单抄的，
   个别生成器可能叫别的（前端还见过 `width` / `height` / `generate_audio` / `seed`）
5. `POST /media/{id}/upload` 的返回值（本服务只当确认用，不读它）
6. 提交响应确实是 `{job_sets:[…]}` 而不是单个 job set（两种都认）

另外 `PUT /jobs/seedance/confirm-rights/batch {job_ids}` 在包里存在：seedance 某些情况下要先
确认版权才放出成片。没有账号无法触发，**目前没接**；如果真号上出现 completed 却拿不到 url，
先看这里。

## 边界由平台定，不由网关定

和 DreamMaker 同一条原则：生成器清单、清晰度档位、时长区间、参考图张数都按模型变且随平台更新，
网关只检查形状（非空字符串、正整数），值一律原样转发。唯一的例外是 `options.mode`，
因为它不是发给平台的值，而是本服务决定怎么组装请求的开关，写错会静默出错。

## 已知限制

- **文生视频发不出去**：和另外两个渠道一样，`createJobSchema` 的 `assetId` 必填。
- **参考视频/音频进不来**：平台收，但网关的 `/v1/assets` 只收图片。要放开得改
  `app.ts` 的 `supportedImageTypes` 与文件头校验，那是三个渠道共用的素材通道。
- **提交被 Cloudflare 拦着**（见上）：`run(page)` 直接抛错，而现在恰恰需要一个页面来过挑战。
  这是目前这个渠道跑不通的唯一一步。
- **`creditsSpent` 只是两次余额相减**：平台不在任务上回报扣费，账号同时跑别的任务时这个数会偏。
- **`use_unlim` / `use_free_gens` 固定发 `false`**：两者都是按账号的额度，会悄悄改变一条任务的成本。
