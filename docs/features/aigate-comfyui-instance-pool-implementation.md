# AIGate / ComfyUI 固定实例池：首期实现与调用示例

> 本文记录首期服务端素材模式；后续已增加 AIStudio 直传渠道、跨区候卡、5090/4090限制及平台GPU闲时关机。新部署、Token位置和桌面协议以 `aigate-comfyui-direct-channel.md` 为准，本文的“尚无桌面渠道/需手动关机”等首期边界不再代表新版本。

日期：2026-10-20。工作流按用户已测试通过处理，不重复做工作流可行性论证。

## 实现范围

本期新增 `comfyui-v1` 后端渠道，复用现有系统服务、API key 鉴权和 `/v1/assets`、`/v1/jobs`。不会伪装成 Miora，不经过字字动画插件。

支持登记 1–3 个已有实例、管理员开机/关机/排空、可选排队按需开机、单实例单生成槽、SQL 持久化排队与断点、原任务恢复查询、私有结果下载。

没有自动租用新实例、释放实例、自动闲置关机、用户按任务扣费、管理后台页面或 AIStudio 新渠道 UI。本期管理员通过 API 操作，桌面渠道注册与端到端真实生成另行验收。

## 配置

在既有完整系统服务上设置 `SYSTEM_CHANNELS_ENABLED=true`、`SYSTEM_VIDEO_GATEWAY_ENABLED=true`，保留既有 `API_KEY`、`CHANNEL_CREDENTIAL_KEY` 和 Miora 网关代理配置。本期未改变既有网关的启动校验；ComfyUI 请求本身不经过 Miora 适配器或其专用代理。

额外的服务端环境变量：

```dotenv
SYSTEM_COMFYUI_CONFIG=/etc/hailuo/comfyui/pool.json
AIGATE_ACCESS_TOKEN=在服务器上配置实际平台令牌
```

未设置 `SYSTEM_COMFYUI_CONFIG` 时功能关闭，不访问平台、不自动开机。不提交凭据到 Git，也不通过客户端发送平台 Token。

配置样例：`docs/examples/comfyui-pool.example.json`。占位值必须替换后才能加载，不是可直接执行的 H3 节点映射。`file` 相对池配置文件所在目录解析，内容必须是已经验证的 ComfyUI API 格式图（`class_type` / `inputs`），不是编辑器画布 JSON。

- `instances[].id` 必须使用十进制字符串，避免 64 位实例号精度丢失。
- `baseUrl` 填已验证的原生服务入口，可含 `/api` 或实际代理前缀；不能填平台应用的 `5006` 服务。当前显式登记地址，不猜测 `host/port/httpType` 组合；开机后地址变化时须先核对配置。
- 远程服务使用 HTTPS；HTTP 仅允许本机回环地址，供受控隧道或测试使用。
- 原生端点如需鉴权，通过 `headersEnv` 引用服务器环境变量。例如 `{"Authorization":"COMFY_INSTANCE_AUTH"}`，该变量的值应包含端点实际要求的完整请求头内容。平台 Token 不会自动转发给原生服务。
- `workflowIds` 声明实例可运行的工作流；节点、模型和镜像版本仍由运维固定，不把 HTTP 探活称为模型合同验收。
- `autoOpen=false` 默认只使用已开机实例；设为 `true` 后，已接受的排队任务可以触发登记实例开机并产生算力费用。只补足排队所需启动容量，最大不超过配置中的 3 台。
- 此版本不会自动闲置关机，生成结束不等于算力计费结束。需要管理员排空后关机；存储与镜像费用仍按平台规则另计。

## 工作流参数与媒体

`bindings` 是唯一允许用户修改的节点字段清单。未登记字段拒绝，客户端不能提交节点图、节点 ID、实例地址或本地文件路径。

- `kind=value`：显式允许的文本、数字或布尔参数，例如 prompt、seed、尺寸、帧数。单位和范围按已经验证的工作流填写，本期不猜测 duration 与 frames 的换算。
- `kind=media`：只能传本后端上传成功的 `asset_...` ID，执行时上传到选中实例，并替换成该实例返回的 input 文件名。每个媒体绑定都必须显式提供，避免遗留示例素材。
- `kind=output-prefix`：后端自动注入本次作业 ID，客户端不能覆盖。应绑定视频输出节点真实的文件名前缀字段，保证后续任务不覆盖待收取结果。

样例只演示 1 个图像槽。正式 9 图/3 音频需逐个绑定为 `image1...image9`、`audio1...audio3`，名称可自定义但提交时必须一致；首帧是否算入 9 图、首尾帧角色按真实图绑定，不会自动按数组位置猜测。

图中未使用的媒体节点应由管理员从已验证的 API 图中断开或移除；本期不做未知图结构的自动裁剪，也不自动清空未登记的节点字段。工作流文件不要包含明文密钥。

有 `output-prefix` 时，上游生成终态后可归还生成槽，结果收取单独保护实例。没有该绑定时采用保守策略：保留该生成槽直到收取成功，避免固定文件名被下一任务覆盖。结果转存全局最多 3 项并行。

## 管理员操作

以下接口使用正常管理员登录 Cookie 与已有同源/Origin 校验，不接受视频网关 API key 代替管理员身份。查看允许管理员只读权限；开机/关机/排空要求 superadmin，并在同一事务登记审计和操作意图。

```http
GET /api/admin/comfyui

POST /api/admin/comfyui/instances/实际实例ID/open

POST /api/admin/comfyui/instances/实际实例ID/drain

POST /api/admin/comfyui/instances/实际实例ID/close
```

操作返回 202 表示本地已耐久接受，不表示机器已完成开关机。通过 GET 投影观察 `starting/ready/busy/closing/quarantined`、排队数、原作业 ID、未收取结果数和错误码；这些是池业务状态，不是直接复刻平台全部状态。

开机链路：读取平台 `/api/openapi/instance/status` → 对允许开机的已关机/暂停状态登记发送断点 → 调用 `/open` 一次 → 轮询平台运行状态 → 验证原生 `/system_stats` 与空队列 → 标记 ready → 原子认领一个任务。平台状态为运行中但服务不可用时不派单。

开关机回执丢失不盲目重发；超出 `bootTimeoutMs` 隔离该实例。关机必须没有执行槽占用和未耐久收取结果，先停止领新任务再调用 `/close`，并查询确认。初期不调用 `/release`。

## 上传与提交

复用 `POST /v1/assets`，请求头 `x-api-key: 服务端视频网关密钥`，multipart 字段 `file`。图片/视频沿用原格式；启用本池时另接受 MP3/WAV 并校验签名。此入口沿用现有上传大小、内存和文件存储实现，不宣称已经全链路流式上传。

取上传响应中的 `id`，再提交：

```http
POST /v1/jobs
x-api-key: 实际视频网关密钥
Content-Type: application/json

{
  "adapterId": "comfyui-v1",
  "requestKey": "shot20-candidate1-attempt1",
  "workflowId": "official-9-plus-3",
  "values": { "prompt": "本次已确认的提示词" },
  "media": { "image1": "asset_实际上传ID" }
}
```

示例对应精简后的单图绑定配置；正式 9+3 配置必须同时提供其中所有媒体槽。不能发送本机绝对路径或远程素材 URL。

首次返回 202，包含 `jobId/status/statusUrl`。相同 key 与相同输入重传返回原作业（200）；相同 key 不同输入返回 409。新候选或明确重新生成使用新 requestKey。作用域是现有操作员视频网关 API key，不是共享项目用户 ACL，不能将客户端自报 projectId 当作服务端权限证明。

队列接受和所选实例、提交断点全部在同一 SQL 库中持久化，不为 GPU 任务创建旧 JSON 作业。原生提交前保存计划 prompt UUID，提交后保存实际回执 ID；兼容返回不同 ID 的部署版本。请求发送后回执不明时，只查原实例的 history/queue/请求标记，不跨机器重新生成。

## 查询、取消与收取

```http
GET /v1/jobs/实际jobId
GET /v1/jobs?status=running&limit=20
POST /v1/jobs/实际jobId/cancel
POST /v1/jobs/实际jobId/reconcile
GET /v1/jobs/实际jobId/result
```

以上均要求原视频网关 API key。状态返回原 `/v1` 的 queued/running/succeeded/failed，并额外提供 stage；只显示真实阶段，不估算百分比。`result.videoUrl` 是相对本后端的私有路径，下载必须携带同一个 `x-api-key`；客户端适配时要保留下载鉴权，不是实例临时 URL。

取消初版只停止尚未发送的生成与业务结果发布；远端已开始时继续查询并保留机器占用，响应明确 `remoteStopped=false`。本期不调用全实例 interrupt，也不宣称远端任务已取消。客户端本地取消入口尚需接此接口。

`jobTimeoutMs` 从入队开始计算，包括等待、准备和生成；等待预算落库，重启/GET 不重置。有已确认上游 ID 则沿原 ID 查询；回执不明会按计划 ID和请求标记核对。history 扫描有界，查不到不能证明未提交。到期业务结束，但未确认远端终态的实例仍隔离、保留槽占用，不能据此自动关闭或复用机器。

`reconcile` 只核对原任务或搬运原结果，不重新生成；成功作业重复 reconcile 不重新下载。生成成功后只收取已登记输出节点的单个 MP4，有界流式落盘、SHA-256、文件签名和声明长度校验后写入私有存储。失败时保留待收取事实，禁止关机；显式取消的结果不再发布。

签名校验不等于时长、帧率或实际画幅验收。本期复用的私有存储要求目录 fsync；本地 Windows 文件系统可能返回 EPERM，不能把 mock 通过称为 Windows 实盘耐久验收。生产应在支持该耐久语义的文件系统上验证结果转存。

## 交付与真实接入边界

本期验证使用 fake 平台、fake ComfyUI 与临时数据库，不创建/启停真实实例，不提交付费任务、不部署或重启现有服务。

本次源码验证：typecheck、build、diff 检查通过；新增 ComfyUI 测试 243 项通过，连同相关旧网关定向回归共 251 项通过。最后全量 870 项中 849 通过、21 失败：其中 20 项在原 HEAD 的隔离源码快照中同名复现，涉及已有媒体存储/Windows 权限等基线问题；另 1 项 TokenFileWatcher 监听次数抖动，单独重跑该文件 7 项全部通过。本轮没有修改这些范围外实现，也不把全量回归表述为全绿。

真实接入仍需把已验证 API 图及其参数/输出节点映射、实例 ID、原生服务地址登记到配置；平台令牌和端点鉴权在服务器环境配置。先一台验完整开机→排队→提交→收取，再登记第二、三台；不需要重新验证用户已确认的工作流可行性，但必须验证这条新后端调用链。
