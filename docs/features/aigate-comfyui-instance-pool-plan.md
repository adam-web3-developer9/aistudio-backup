# AIGate / ComfyUI 后端实例池接入研究方案

日期：2026-10-20。状态：待用户审阅，非实施或生产验收。本轮仅查询公开文档、读取 Hailuo/AIStudio 源码及发布者配套文件；没有创建/启停实例、导入平台令牌、部署或提交新生成。

## 1. 结论与范围

建议 AIStudio 继续作为制作客户端，由 Hailuo 提供托管 ComfyUI 工作流渠道：后端统一排队、授权凭据保管、素材准备、机器选择、上游查询与结果收取。首期以 3 个独立实例、每实例 1 个生成槽为上限；先验证 1 台，再扩为 3 台固定池，最后再考虑自动启停。

用户于 2026-10-20 明确接入范围：直接使用发布者配套的官方 9+3 工作流与镜像，不依赖字字动画插件。插件许可、Windows/Python ABI、插件宿主和 Windows worker 均不属于本方案的前置条件。平台 API Token 与镜像/工作流实际存在的鉴权分别核实，不把插件授权错误推定为工作流也需要同样授权。

建设通用 ComfyUI 工作流执行适配器，以官方 9+3 工作流作为首份配置，直接连接配套镜像的 ComfyUI 服务。若实际镜像或节点有鉴权，按其真实合同接入，不移除或绕过；已有通用插件能力保持不动，本次执行链完全不经过插件。

## 2. 官方文档实际有三条路线

| 路线 | 核心输入 | 能解决什么 | 本次位置 |
| --- | --- | --- | --- |
| 算力 OpenAPI | SKU、区域、镜像、instanceId | 查询资源、创建实例、开关机、释放、保存镜像 | 自管实例池控制面 |
| 自有 ComfyUI 应用 API | appId + instanceId + allowInput | 指定应用和指定实例提交、查任务与输出 | 应用已建立并绑定实例时可选数据面 |
| 平台工作流 API | appId + inputParams | 调平台工作流，积分计费、异步查询与文件上传 | 托管替代方案，不等于自己租 3 台 |

不能因为两条路线都叫 appId 就混用认证入口、参数结构和上传接口。

已确认的接口：

- 算力：GET /api/openapi/instance/skuList；POST /api/openapi/instance/start；POST /api/openapi/instance/page；GET /api/openapi/instance/get、status、open、close、release；POST /api/openapi/image/save；POST /api/openapi/user/balance。
- 创建实例的 count 是租用 SKU 数量，文档返回一个 instanceId；不能把 count=3 视为已创建 3 个独立单槽实例。应登记三个不同的 instanceId，初期每次 count=1，并核实实际 GPU 配置。
- Comfy 应用：GET /api/openapi/comfyui/comfyuiApp/list；GET /api/openapi/comfyui/comfyuiInstance/list；POST /api/openapi/comfyui/comfyuiTask/create；GET /api/openapi/comfyui/comfyuiTask/status。
- 应用实例列表可返回 comfyuiHost；任务状态可返回 taskId、comfyuiPromptId、instanceId 和 files。上传说明为向实例 comfyuiHost + /api/upload/image 传 multipart image 和 type=input，节点使用返回文件名。
- 平台工作流：POST /api/comfyui/open/v1/comfyui_workflow/create，GET 同前缀 /getTask；另一上传接口 /uploadFile。该上传文档限制图片 5MB、音视频 20MB，此限制不能套到所有自管 ComfyUI 实例。

文档缺口须在接入前核实：

1. 公开的自有应用 API 提供应用/绑定关系查询，未找到创建应用或给新实例绑定应用的接口；使用该路线时不能宣称机器创建后自动可被 appId 调度。创作者 Setup 文档要求指定镜像，现有发布者镜像是否兼容须验证。
2. 自有应用任务创建响应的 data.key 示例未定义清晰任务号结构；平台工作流上传示例的 /api 前缀存在不一致，须核实实际入口；平台工作流状态表有 6=上传中，但后续轮询表仅列 0–5。应在测试账户做协议核验，不能猜测字段或把未识别状态当成功。
3. 创建实例/任务的公开参数未见客户端幂等键；响应丢失后不能声称自动重试绝不会重复。GET 的 open/close/release 具有副作用，不能按“GET 都安全”统一重试。
4. 自有应用文档未列任务取消接口；平台工作流明确排队任务暂不支持取消。原生 ComfyUI 的中断/删除队列能力须按现有镜像部署版本验证，尤其核实操作范围是单任务还是全实例，不能误杀别的任务，也不能把本地取消视为远端已经停止。
5. 平台实例操作指南说明关机停止算力计费，但仍有存储费用；释放后需重新租用。不能把关机宣称为所有费用归零，具体 SKU、镜像及存储价目仍需实际核对。

## 3. 推荐的部署与职责

AIStudio 普通任务
    → Hailuo 既有鉴权视频网关 / 作业查询
    → 后端持久任务队列与工作流配置
    → 统一实例池调度
        → 实例 A：单生成槽
        → 实例 B：单生成槽
        → 实例 C：单生成槽
    → 收取结果到后端受控媒体存储
    → 客户端下载并按原流程入库、追加候选

控制面由 AIGate 管机器。数据面直接使用官方 9+3 工作流与配套镜像的 ComfyUI HTTP API，核实该镜像实际的上传、提交、查询及输出合同。自有 Comfy 应用 API 仅作为备选，不作为首次接入的前置条件；两者共用上层任务与实例池概念，不叠加两个调度器。

第一版后端保持单部署，继续使用现有事务数据库，不为了 3 台外部 GPU 引入 Redis/Kubernetes/另一个队列服务。GPU 分布在三台云机器，不要求 Hailuo 本身先做多副本。若未来扩后端 worker，原子认领与 fencing 必须已经落库，不能依赖进程内 Set。

### 3.1 Hailuo 源码核对结果

本轮核对本地基线 88b845c，不代表已核对线上运行版本。

| 已有模块 | 可以沿用 | 不能误认为已有能力 |
| --- | --- | --- |
| src/app.ts:1077、1488、1608；src/system-channels/video-gateway.ts:133 | /v1/assets 上传、/v1/jobs 提交、/v1/jobs/:id 查询、result.videoUrl 结果合同 | managed gateway 当前只接受 miora-v1（app.ts:1495），GPU 渠道必须正式扩展路由，不能伪装 Miora |
| src/stores/job-store.ts:31、116；src/jobs/job-runner.ts:73、297、380 | 从文件恢复、持有 providerJobId/session 后 resume 查询的模式 | Map + 异步 JSON 文件写入不是事务队列；onProgress 不等待回执落盘，存在已接受但任务号未耐久的窗口 |
| src/jobs/account-pool.ts:140、146、285 | 资源等待/限流的概念 | 默认每账号 2 槽、余额预留和内存计数不是 GPU 单槽租约，不复用账号余额表表示机器 |
| src/system-jobs/store.ts:47；src/system/database.ts:10 | 同库事务 claim、heartbeat、fence、回执的设计 | 共享项目业务租约不是 GPU 槽；现有 ChannelJobBridge:42 启动会标记 server/running，整链不能直接多副本 |
| src/stores/asset-store.ts:24；src/system-media/routes.ts:47 | 鉴权素材入口、流式收取、hash/媒体校验基础 | /v1/upload-intents 及 miora-upload-intents.ts:64 为 Miora COS/账号合同；bridge.ts:67 的结果域白名单也需独立 GPU 适配 |
| apps/admin/src/App.tsx:822；src/system-jobs/routes.ts:23 | 登录权限、分页、错误与审计框架 | 现有渠道任务页读 system_jobs，新 /v1 GPU 作业不会自动出现在该页 |

GPU 路线继续面向现有 /v1 视频网关，不强迫桌面改为共享项目的 /api/system/projects/.../jobs。新增 GPU 执行域需以同一事务库中的执行/槽记录作为唯一事实；网关公开 DTO 仅作投影，不能同时让 jobs/*.json 与 SQL 各写一份 GPU 状态。队列接受确认必须等本地事务提交，上游任务号的保存必须是可等待的断点写入，不复用“只通知界面”的 onProgress 冒充耐久确认。不顺带改造所有旧渠道。

## 4. 持久化与调度规则

以下是概念归属，优先扩展已有记录，不预设必须新建一套平行任务表：

- 工作流档案：可信管理员登记的图、内容 hash/版本、镜像版本、参数绑定、媒体角色与能力限制。终端用户不能提交任意节点图、Python 代码或本机路径。
- 实例池：平台凭据引用、区域/SKU/镜像、期望/最大实例数、每实例槽数=1、启停策略与预算。
- 实例事实：instanceId、服务地址、观察到的平台状态、业务健康、机器启动代数、当前任务/租约、未收取结果计数；分开登记人工导入与本池创建的资源所有权。
- 任务 attempt：唯一客户端请求、冻结工作流版本/输入、所选 instanceId、槽租约/fence、上游 taskId/promptId、提交/查询/收取断点及错误。

调度行为：

1. 多客户端共用一份后端队列。3 台均健康时最多 3 个生成；例如提交 10 个任务，3 个占槽，其余 7 个仍在后端等候，不在某一实例塞进全部任务。
2. 只选版本、显存/尺寸/时长能力匹配且空闲的实例；在同一事务原子认领任务和空槽，落下实例与 attempt 绑定后才准备发送。可按等待时间公平选取，不必先实现复杂调度算法。
3. 实例“运行中”不等于可接单。需要服务探活、节点/模型合同检查、无外部占用及必要预热后再标 ready。
4. 同一请求重传返回原作业；用户明确另生成候选/重试使用新 attempt。不能只拿分镜 ID 作为所有候选永久唯一键。
5. 掉线、租约到期或本地取消都不能证明远端已停止。已持有 taskId/promptId 的任务沿原实例续查，不因为后端重启就改发另一台。回执不明时结合原实例 queue/history 及自己的请求标记核对；不能声称 client_id 自带提交幂等。
6. 仅上游终态或确认取消后归还远端生成槽。GPU 槽与结果收取分开，防止新任务等待视频慢速回传；但实例还有未耐久收取的输出时，禁止关机/释放。
7. 一台坏了只隔离这一台，其他两台继续；鉴权/缺模型等明确配置错误不跨三台反复提交碰运气。客户端/后端沿原任务有限重试和最长等待，不增加另一套永久未知保护。
8. 上游 WS 用于实时进度，HTTP queue/history/status 用于断线恢复。没有真实百分比时显示排队、准备、生成、收取阶段，不编造进度。
9. 对生成与素材传输分别限流。单机单生成不意味着全后端只能串行下载或上传；同时也不能用 Promise.all 无界搬运大视频。
10. 取消后阻止尚未发生的提交与过期结果写回；远端仍运行时保留机器占用及必要收取事实，不能自动复活已取消的业务任务，也不能让旧 attempt 覆盖新候选。初版明确公布各数据面的取消能力，不虚构原生单任务取消保证。

管理后台新增“算力实例池”投影：池配置/可信工作流版本、3 台各自健康与占槽、排队数、当前任务/原任务号、授权失败、未收取输出、手动排空与启停审计。该页读取上述同一事实源，不借账号积分页推算机器空闲，不新增第二套任务写入者。

## 5. 素材与横竖屏

客户端提交提示词、草稿画幅、目标时长、分辨率、首尾帧和有序参考素材。Hailuo 负责：

1. 复用鉴权媒体入口；素材归上传者/项目，后端解析允许的媒体引用，不接收客户端本机绝对路径。
2. 根据被选实例上传所需媒体，获得该实例可识别的文件名，再按工作流绑定写入节点。上传缓存按素材 hash + instanceId + 实例启动代数区分，不能把 A 上的文件名直接发给 B。
3. 使用工作流参数档案映射 prompt、width/height、duration/frames、seed、首帧/参考图及音频。图的节点 ID 留在档案里，不写死在业务代码或按插件名称分支。
4. H3 的 9 图/3 音频只是本工作流档案能力，不作为其他工作流的默认值。不足、必填/可选、索引顺序都显式声明；未用节点不能继续残留 example.png 或上次任务素材。
5. 画幅跟随草稿，用经过验证的模型尺寸预设。发布者标准图把 1344×768 等近似比例标为 16:9，它并非数学上严格 16:9；竖屏预设/严格成片比例的裁切或补边策略需单独确认，不可无提示拉伸或冒称精确比例。
6. 冻结 seed、图/音频顺序、参数和工作流版本，以便原 attempt 重放；显存与帧数约束在提交前检查。长时长/高分辨率应按目标规格压测，不凭空承诺某张卡够用。
7. 完成后有界下载、实际媒体类型/时长校验、写入受控结果存储，再通知客户端收取。生成完成与结果已安全入库是两件事，不只保存临时的实例下载地址。

## 6. 授权、安全与机器生命周期

- 平台 Token、镜像访问凭据及实际需要的工作流鉴权凭据只在后端加密管理，沿既有管理员权限及审计；不返回客户端，不写入工作流，不把实例详情中的账号/密码打印到日志。不导入或依赖字字动画插件授权。
- 原生 ComfyUI 端点需明确鉴权或网络限制，不将“网址难猜”当作安全；文件下载/上传需复用受控地址、重定向与媒体验证边界，避免任意 URL/SSRF。
- 后端应用数据与工作流不要依赖 GPU 临时文件系统；实例镜像/模型/节点版本固定，变更先排空后替换。
- 首期固定池最大 3，不自动建机。开放自动扩容前，必须有实例数量上限、单价/镜像费核对、预算与创建冷却，且先登记创建意图；创建超时先对账实例列表，无法唯一确认时显式要求处理，而不是继续加开机器。
- 缩容先 draining，不再领新任务；确认无执行、无待收取输出再关机。GPU 利用率低可能是上传/加载/收取，不能单靠平台 GPU 闲时关机策略判断业务空闲。
- release 与 close 是不同操作，释放默认管理员明确操作；不能动账号下未归本池管理的机器。
- 成本与吞吐按实测记录。3 台的理论生成容量近似 3×3600/T 条每小时（T 为单任务实际 GPU 占槽秒数，不是生成视频的播放时长），还要考虑预热、失败、IO 与任务规格。费用按实际 SKU、镜像和其他平台计费项核对，不在没有报价时估固定金额。

## 7. 分阶段落地与最小验收

阶段 0：确认官方 9+3 工作流文件、配套镜像版本、平台 Token、可用 SKU 和现有实例归属。只读检查该镜像的节点、ComfyUI API 及实际鉴权要求，核实上传、任务号与结果合同；不以插件授权或应用绑定作为前置条件。

阶段 1：1 台接入通用工作流渠道。验首帧/多参考图/音频索引、横竖屏档案、一个真实结果收取写回；生成须另获用户授权。验回执后断线/后端重启仍查原 ID，不新提交。

阶段 2：固定 3 台单槽池。用受控任务验证全局槽上限 3、同一机器绝不并行、第四项等待、完成后补位、多客户端同请求不重复、1 台故障其他 2 台继续。并验证取消不误杀另一任务、收取未完成不关机。

阶段 3：在已有数据支持下开放自动启停。验创建超时不盲目重复、最大机器数/预算约束、排空与输出保护；冷启动时间及可用 SKU 另记录。

此轮研究不运行业务测试、不生成付费任务、不迁移现有服务。方案获认可后按上述阶段再拆实施文件与验收范围。

## 8. 主要来源

- AIGate 接口入口：https://docs.aigate.cc/developer/apiInstruction
- 算力 OpenAPI：https://docs.aigate.cc/developer/openAPI
- 自有 Comfy 应用 API：https://docs.aigate.cc/developer/comfyAPI
- 平台工作流 API：https://docs.aigate.cc/developer/workflowAPI
- 创作者 Setup：https://docs.aigate.cc/bestPractice/aigateCUI
- 计费资源策略：https://docs.aigate.cc/FAQ/billingAndResourceStrategy
- ComfyUI 原生路由：https://docs.comfy.org/development/comfyui-server/comms_routes
- ComfyUI 当前上游实现（非部署版本保证）：https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/server.py
- 实例操作指南：https://docs.aigate.cc/bestPractice/instanceOperationGuide
- 本地契约：docs/system-backend-contract.md；发布者配套官方 9+3 工作流、镜像说明与 MINIMAX-H3 标准尺寸图片。
