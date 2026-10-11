# Miora 渠道（miora.design）

`miora-v1`。第四个渠道，和 DreamMaker / Higgsfield 一样纯 REST、不用浏览器、不用签名。
只接了 **minimax-h3（全能参考，多模态）** 一个模型，其它模型有意不接。

## 账号

一个账号是一对令牌，来自网页的 `localStorage`：

- `authToken`：JWT，约 15 天有效，`sub` 是 userId。
- `refreshToken`：`def50200…` 不透明串，本服务用它在到期前换新 authToken。

账号文件（`MIORA_ACCOUNT_FILE`，默认 `./miora-accounts.txt`）一行一个 JSON：

```json
{"authToken":"eyJ…","refreshToken":"def50200…","email":"…"}
```

也接受手贴的 `authToken` 或 `authToken----refreshToken`。文件运行时热重载。

### 从浏览器导出转成账号行

网页 F12 导出 miora.design 的 site-state JSON（含 cookies + localStorage），把文件丢进
导入目录（`MIORA_IMPORT_DIR`，默认 `./miora-imports`，网关启动时自动创建）。

- **网关运行中**：监视这个目录（`fs.watch` + 10 秒轮询兜底），有 `*.json` 新增/改动就自动导入，
  账号文件热重载后账号立即可用，不用重启。
- **手动**：`npm run miora:import`，导入同一个目录的全部文件（不接受自定义路径）。

导入规则（`src/jobs/miora-import.ts`，自动和手动共用）：

- **按账号去重**：同一个 userId 只占一行；目录里同一账号的多份导出取最新的那份。
- **只用更新的令牌覆盖**：文件里已有的账号，只有导出里的 authToken 比文件里的新（iat，再 exp）
  才替换；否则跳过。所以导出文件留在目录里也无妨——网关续期写回的新令牌不会被旧导出冲掉。
  同一个 authToken 时只补齐文件里缺的 refreshToken / cookie / email。
- 账号文件原子替换；如果写入时正好碰上续期改了文件，会基于新内容重新合并。
- 不是 miora 导出（没 authToken）或 JSON 坏了的文件会被跳过并记日志。

每份导出里：

- **取最新的 authToken**（按签发时间 iat、再按到期 exp 排）。导出里 authToken 有两份：
  `localStorage` 那份是网站当前在用的新令牌，`cookie` 那份可能是几天前的旧令牌——旧令牌
  即使 `exp` 还没到，也已被服务端在刷新时作废，调接口会 401。**不看 scopes**：工具本身
  用的就是 `scopes: []` 的 localStorage 令牌，空 scopes 照样能生成。
- 抠出 `refreshToken`、`email` 和整套 miora.design cookie（T-Sec 风控要用）。

## 生成链路（都在 `/api/ai` 下，base `https://miora.design/api/ai`）

| 步骤 | 接口 | 说明 |
|---|---|---|
| 认证 | header `Authorization: Bearer <authToken>` + `X-Product: miora` / `x-Source: web` / Origin/Referer | 401 时本服务用 refreshToken 换新令牌重试一次 |
| 续期 | `POST https://miora.design/api/auth/refresh-token` `{refresh_token}` | 返回新 `access_token`（可能带新 refresh_token，会轮换） |
| 查积分 | `GET /quota/credit` | `left = nextExpiring.credit ?? total-used` |
| 平台项目 | `GET /workflow/list`，必要时 `POST /workflow/create` | 复用或创建「Miora 本地工作台」并在提交时携带 `workflowId`，与 v1.2.0 工作台归档方式一致 |
| 传参考素材 | `GET /cos/sts-tokens` → 自签名 `PUT <bucket>.cos.<region>.myqcloud.com/...` | 腾讯云 COS，HMAC-SHA1 自签，直连不走代理 |
| 提交 | `POST /media-generate/video` | `{type:"text_to_video", model, prompt, duration, extraParameters:{aspectRatio,resolution}, nodeId, sandboxTraceId, referenceImageFileKeys?, referenceVideoFileKeys?, referenceAudioFileKeys?}` → `data.data.taskId` |
| 轮询 | `POST /media-generate/progress` `{videoTaskIds:[id]}` | `completed`/`success` 完成 → `resultSignUrl`/`resultFileKey` |
| 取成品 | `resultSignUrl`，或 `POST /cos/cdn-sign-url {filePaths:[key]}` 换签名 URL | 签名 URL 短效（约 1 天），网关每次现签 |

`minimax-h3` 约束（来自 `catalog-snapshot`）：分辨率 `768P`/`2K`，时长 4-15s，参考图最多 9、
参考视频/音频各 3。快照里的 `promptLengthLimit: 2000` 在 v1.2.0 桌面工作台中用于任务入队校验（超长拒绝，不截取；`skipCheck` 可跳过）；**本网关不按它拦截或截断**——
最初按 2000 拦过，分镜长提示词全被网关 400 掉，而同样的提示词在别的工具里能正常出片。**`supportsAudioControl: false`——不发 `generateAudio`**
（发了会报 `VIDEO_UNSUPPORTED_AUDIO_CONTROL`）。

"全能参考"＝把上传的参考素材按类型分别挂到 `referenceImageFileKeys` / `referenceVideoFileKeys` /
`referenceAudioFileKeys`。注意网关 `/v1/assets` 收图片和视频，不收音频。

## 出口

积分读取（`GET /quota/credit`）、生成提交（`POST /media-generate/video`、`POST /media-generate/image`）和任务进度查询（`POST /media-generate/progress`）共用代理配置与路由快照。
模型列表、项目查询/创建、令牌续期、COS 上传凭证、成品签名 URL 和 COS 参考素材直传均直连，不切换到代理。
`MIORA_PROXY_URL` 未配置时，积分、提交和任务进度查询默认走本地代理，失败再直连。

积分读取和任务进度查询遇到网络错误或 HTTP 408/429/5xx 时，依次尝试
`MIORA_PROXY_URL` → 本地代理 → 本地直连，全部失败后才进入原来的重试流程。
`MIORA_LOCAL_PROXY_URL` 默认 `auto`：自动读取 Windows 当前用户启用的系统 HTTP 代理，缓存约 2 秒；切换代理软件或端口后，新请求自动跟随，无需改配置或重启。两个客户端都需启用“系统代理”。未启用系统代理时跳过本地代理，继续直连；TUN/VPN 模式下直连请求由系统网络接管。不自动执行 PAC，也不把 SOCKS 端口当成 HTTP 端口。
如需固定端口，仍可显式设置 `MIORA_LOCAL_PROXY_URL=http://127.0.0.1:端口`。未配置 `MIORA_PROXY_URL` 时，顺序为 本地代理 → 直连。同一轮请求使用固定路由快照和原上游任务 ID，端口切换不会中断在途请求。

若本机 DNS 将主代理域名解析到不可用地址，可设置 `MIORA_PROXY_ADDRESS` 为经核实的代理网关 IPv4/IPv6。它只覆盖主代理网关连接地址，保留原域名、认证和 TLS 校验，不改目标网站或系统 DNS。厂商网关地址可能变化，失效时需重新核实并更新或清空。
401 和业务拒绝保留原来的认证/业务处理，不切换出口。
生成提交仅在连接拒绝、DNS 或连接超时等确认尚未发送的错误下切换；
请求发出后的断流或服务端错误不通过换出口重复提交，避免重复扣费。

## 计费与并发

- 过期账号清理复用启动加载和定期续期检查：访问 Token 已过期且没有 refreshToken，
  或续期接口明确返回 JSON 消息“无效的刷新令牌或令牌已过期”时，清理对应的原凭证。
  尚未过期、网络失败、风控、一般 400/401、非 JSON 响应和 5xx 均保留，不以积分读取失败作为删除依据。
  删除前核对 authToken、refreshToken 和 Cookie 未被替换；在途任务先退役，保留会话到任务结束。
  确认清理后，对应凭证及比它更旧的导出从 `miora-imports` 移至 `data/miora-imports-archive`。
  新凭证、其他账号、未确认读取失败和不可解析的导出保留；归档与账号文件导入共用写锁，避免再次导入已清理账号。

- 自动清理复用账号池的成功积分读取链路：`minimax-h3` 最短 4 秒，按每秒 6.62 积分，
  **成功读取余额且低于 26.48 积分**时从账号文件清理；等于门槛保留。`minimax-h3-max`
  对应门槛为 27.40，未知模型不清理。积分接口失败、超时或返回无效数据均不清理，
  不会使用旧余额或调度预留余额清理。日志明确记录已读取余额、4 秒门槛及清理结果。
  清理在启动、账号加载、余额刷新和任务完成后的余额查询时触发，已有任务保留会话到完成。
  确认低余额清理时，也归档对应旧导出；归档失败明确记日志，不恢复已经清理的账号。

- 提交即扣费。定价按模型和档位，网关**不做绑定式预估**（已知模型按每秒价格向上取整
  预留调度积分，`costEstimateIsBinding=false`）：预估不足时调度器仍会尝试积分最多的号，
  让平台判定能不能付；已确认低于 4 秒门槛并被清理的号不再接自动任务。
- 并发满 / 429 归类为 `provider_busy`，会重试。

## 已验证 / 未验证

**已验证（离线）**：
- `bundle.cjs`（v1.2.0 本地工作台，javascript-obfuscator 混淆）反混淆后读全，请求/响应结构照此实现。
- cookie-state JSON 解析、authToken/refreshToken 提取、scopes 判定、cosAuth 签名结构、账号解析/续期：单测覆盖（`*.test.ts`）。

**未验证（需真号 live 调用，会扣费/受风控影响）**：
- `/quota/credit`、`/media-models`、COS 上传、提交、轮询、cdn-sign 的线上真实字段与本实现完全一致。
- 空 scopes 的 authToken 是否会被生成接口拒绝、refresh 后 scopes 是否改变（工作台只按到期时间判断能否运行，不能据此推断上游权限）。
- 真跑一条 minimax-h3 全能参考出片（导入的测试号只有 ~100 积分，先算成本）。

> 接入时被 auto-mode 分类器以 Credential Materialization 拦下了「拿真 token 打线上接口」这步，
> 所以以上 live 项留待人工放行后验证。参考 [[dreammaker-channel-cost]] 的教训：真跑前先确认单价。

## 客户端侧（aistudio）

已镜像 `miora-v1`（`videoAdapter: 'miora'`，与其它本地网关渠道共用 `/v1/assets` + `/v1/jobs`）：
`src/ai/videoAdapters.ts` ↔ `electron/video-provider-adapters.cjs`、`src/ai/providers.ts`、
`src/pages/SettingsPage.tsx`（预设 + 清晰度 768P/2K）、`src/ai/videoReferencePrompt.ts` ↔
`electron/video-reference-prompt.cjs`（沿用 H3 的 `<Picture N>/<Video N>/<Audio N>`）、
`src/pages/DraftEditorPage.tsx`、`electron/video-submit-worker.cjs`（报错文案）。
`isHailuoVideoProvider` 会先让 Miora 认领，同一个网关 baseUrl 不会被海螺抢走。
