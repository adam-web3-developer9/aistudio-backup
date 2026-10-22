# AIGate ComfyUI 算力池：桌面直传与部署

> 新版服务端独立调度、弹性扩容和安全回收见 comfyui-elastic-scheduler.md；下文固定三台、GPU低利用率关机及不自动创建/释放的描述属于旧版边界。直传协议仍保持兼容。

本功能把算力调度与媒体传输分开。Hailuo 仅接收提示词、参数、SHA256、上传回执及结果文件描述符，不接收本渠道的图片、音频或视频字节。AIStudio 直接上传到选中实例的原生 ComfyUI，生成结果也由 AIStudio 直接下载。旧的 `comfyui-v1` 服务端素材模式保留兼容，但桌面新渠道不使用它，也不使用 `/v1/assets` 或 TOS 中转。

## 服务器 Token 放置位置

本项目既有部署脚本的环境文件为 **`/etc/aistudio-studio/system.env`**，由 `aistudio-studio.service` 的 `EnvironmentFile` 加载。在服务器安全编辑此文件，增加：

```dotenv
SYSTEM_COMFYUI_CONFIG=/etc/aistudio-studio/comfyui/pool.json
AIGATE_ACCESS_TOKEN=实际AIGate平台令牌
```

保留既有 `SYSTEM_CHANNELS_ENABLED=true`、`SYSTEM_VIDEO_GATEWAY_ENABLED=true`、`API_KEY`、`CHANNEL_CREDENTIAL_KEY` 与网关启动所需代理设置。平台 Token 只放服务器，不能放 AIStudio、工作流 JSON、Git 或聊天消息。AIStudio 的新渠道填写 **Hailuo HTTPS Base URL 与既有网关 API Key**，不是平台 Token。

把 `docs/examples/comfyui-pool.h3.example.json` 复制为服务器 `pool.json`，把相邻的 `minimax-h3-9plus3.api.json` 一并复制到同目录。配置替换为三个已有实例的真实十进制字符串 ID、已核实的原生 HTTPS 服务地址、真实地域和 GPU。占位配置不能直接运行。部署目录与旧功能文档中的 `/etc/hailuo` 只是自定义路径，本部署以此节为准。

三个实例必须分布在华东一区和华东二区；样例为一区5090、二区5090、一区4090。第三台也可以改为二区。配置仅接受5090/4090，调度优先5090；原生探活核对实际GPU型号，地域核对平台 `areaName`，不自动换成其他显卡、不自动新租或释放实例。直传实例必须 `headersEnv: {}`，否则不会分配；不向客户端暴露服务器原生端点密钥。

配置或环境变量加载需服务重新启动才生效。本次源码发布不代表线上已配置令牌、已登记三台实例或已完成部署验收。

## 缺卡与闲时关机

- 已明确确认缺卡的开机拒绝进入持久化 `waiting_capacity`，默认每30秒重查状态并尝试可用区域，最多等6小时。候卡不使用10分钟开机超时；真正开始开机后才使用开机超时。分配实例后任务执行期限单独重置为2小时。
- 缺卡识别只针对 `open`：严格的缺卡语义或显式配置的 `capacityErrorCodes`。官方未公布完整缺卡错误码，不编造数值。余额不足、鉴权失败、未知业务错误不当成缺卡；网络超时等不确定开机结果只查状态，不盲目重复开机。
- 候卡提示仅描述已登记实例的开机响应，不推断平台全局库存。未分配作业列出实际候卡区域/GPU并去重，不投影单个候选为已绑定实例；已绑定作业只描述原实例恢复。任一区域进入启动后显示该启动实例，不继续显示其他区域的候卡提示。
- 不再使用永久隔离状态。开机超时、外部占用、区域不匹配等进入持久化退避，默认30秒后重新查询；历史quarantined记录自动迁移，保留原任务、prompt ID与上传回执。外部队列忙只等待，不抢占；区域不匹配不派发；未知生成结果保留原槽位并继续查询原任务，绝不重新提交。关闭请求遇到忙卡保留关闭意图并退避，不打断外部工作。
- 2026-10-22用户批准由服务端业务任务/队列统一决定正常关机，停止设置GPU低利用率30分钟关机。运行实例调用官方 `POST /api/openapi/instance/setTimerStop` 的 `stopType="0"` 取消旧策略；只对运行实例操作，不为取消设置开机。每服务启动/电源周期幂等取消一次，失败记录并退避，不阻断原ID查询、派发或收取。
- 保留 `comfyui-elastic-scheduler.md` 的5分钟业务空闲关机：无槽位、无未完成任务/待收结果且native队列空才关闭。外部人工关机不受本池保护；关机后仍有存储费用，正常授权释放另行核对。
- 平台低GPU策略曾不受结果保护控制，现不再作为本池正常关机机制。Hailuo重启从数据库恢复原作业、原生尝试和预算；GPU的ComfyUI内存历史可能丢失，不能据缺项撤销已有接收事实。
- 平台闲时关机后，新排队任务可以触发重新开机。已生成但未收取的结果，只有客户端主动查询原任务才请求唤醒；不会因为结果一直未收取而每30分钟无人值守反复开机计费。

## 元数据协议

1. `POST /v1/jobs`，`x-api-key` 鉴权。请求 `adapterId="comfyui-v1"`、`transport="direct"`、`workflowId="minimax-h3-9plus3"`、持久 requestKey、`media={}`，以及 `directMedia` 中的 binding/filename/contentType/sha256。正文只含元数据。
2. 先返回并保存原 job ID；候卡不阻塞提交函数。相同 requestKey/相同输入复用原单，变更输入返回409。
3. `GET /v1/jobs/:id` 返回 `stage="awaiting_upload"` 时，`upload` 中给出固定实例的 `baseUrl`、`subfolder=job.id` 及完整 files 清单。此后不改派实例。
4. 桌面向该实例 `POST /upload/image`，multipart 字段为 `image`、`type=input`、`subfolder`；使用同一文件名及 overwrite，重启后只对原实例恢复上传。网关 `x-api-key` 和平台 Token 不得携带到这些请求。
5. `POST /v1/jobs/:id/inputs` 仅确认 `{inputs:{image1:{name,subfolder,type:"input"},...}}`。要求清单完整、路径精确匹配；重复确认幂等，不触发重复生成。
6. 后端每次原生提交前持久化普通阶段断点。已确认接收按实际prompt ID续查；始终未确认且完整查询无匹配时，在原作业/实例以冻结输入最多3次总提交，预算与身份跨重启保留。查询失败不当缺项；原生同ID无去重保证，回执窗口可能重复执行。首次成功结果通过正常输出合同选中，迟到尝试不覆盖已有结果/取消。成功返回受信任实例的绝对 `/view` URL。
7. AIStudio 经既有收取链路完成本地落盘后，`POST /v1/jobs/:id/collected` 发送幂等 JSON 回执。在此之前，管理员关闭接口会拒绝关机；不在客户端落盘前谎报结果已转存。
8. `COMFY_REMOTE_UNCONFIRMED` 返回 `providerTerminal:false`，保留原ID。显式普通重试使用 `POST /v1/jobs/:id/retry` 和 `{requestKey}`；同key重放不重复开启窗口。GET与reconcile不触发新提交。桌面只有手动retry命令生成的retryRequestId开启该窗口；初次自动执行不借此延长deadline。

素材 SHA256 由客户端计算；服务器仅校验冻结声明和回执，因为不读取媒体字节，不能声称服务器验证了 native 文件内容哈希。原生服务地址本身是敏感访问入口，只向作业所有者返回；本期依赖平台原生入口的访问控制，不生成虚构的短期原生上传凭证。

## H3 工作流适配

新建 `minimax-h3-9plus3` 作业时为 RandomNoise 的 noise_seed 生成安全整数随机种子，和工作流一起持久化冻结。同一 requestKey 重试、轮询、候卡及服务重启继续使用原种子；既有作业不改种子，不因恢复而重新生成。其他工作流及 ReservedVRAMSetter 的 seed 不受影响。

随附脱敏API图保留已实测模型及采样节点。图片绑定为image1–image9、音频为audio1–audio3。`omitWhenMissing` 是管理员对可信可选loader的显式授权，只移除已审核的 LoadImage/LoadAudio 以及对应动态可选引用，拒绝普通必需连接、输出节点或图依赖，绝不拿示例素材凑数。

5秒参数按原工作流帧数公式对齐为124帧，在24fps下实际约5.167秒。桌面仅对本渠道转换引用标签，其他渠道提示词不变。此前一次真实7图/无参考音频测试已生成并下载；开头抽帧存在故事板宫格，链路成功不等于成片效果完全达标。新增候卡、开关机和桌面直传仍需部署后分层实测。

## 日志与客户端状态

- 等待客户端直传时仍核对原实例状态；平台闲时关机后唤醒已绑定实例，保留原任务、上传目录及回执，不改派、不重新生成。开机请求先持久化，缺卡按到期时间重试；恢复前隐藏上传清单，展示booting、waiting_capacity或waiting_instance，提供等待原因与下次检查时间。平台HTTP服务的可选instancePort字符串"null"视为未分配外部端口，实际port与其他非法端口值仍严格校验。
- 已生成结果的只读可达性检查独立于生成调度：native健康检查成功即清除结果唤醒等待，返回原视频URL让客户端直下，即使队列仍有外部任务也不阻挡收取；不抢占、不重新生成、不经后端转存视频。检查失败保留原结果和待收取状态。
- 客户端查询时若结果健康缓存已过期或仍在等待唤醒，当次查询直接检查原实例健康；可达立即返回原结果，不再强制等待下一轮任务查询，避免客户端轮询间隔超过缓存期限而反复进入唤醒状态。不可达才请求后台唤醒，期间保留原结果。

- SQL `comfy_events` 持久保存接受任务、实例分配、缺卡轮询、开机请求、闲时关机策略设置、素材确认、提交回执、生成终态、结果收取确认与槽位释放等状态变化；重启后仍可按原作业追溯。相同状态的空轮询不反复刷事件。
- Fastify 同时输出结构化 `comfyEvent`，可在部署服务器通过 `journalctl -u aistudio-studio.service` 查看；SQL事件以sequence稳定分页。
- `GET /v1/jobs/:id` 带最近12条事件，以及中文 `progress.message`、细分phase、真实实例区域/GPU、候卡下次重试时间、等待起点、任务时限和经过时间。终态耗时固定，不随查询不断增长。
- 完整作业事件：`GET /v1/jobs/:id/events?after=0&limit=50`，返回events和nextAfter；仅原作业API key可读。实例事件：`GET /api/admin/comfyui/instances/:id/events`，只允许管理员读取已登记实例。
- 阶段明确区分queued、waiting_capacity、booting、awaiting_upload、preparing、submitting、running、preparing_result、succeeded、failed、cancelled。桌面上传时显示实际完成文件数；后端不读取上传媒体字节，不伪造逐字节进度。
- 日志只保存阶段、时间、实例/任务标识、安全错误码、HTTP状态、出错节点ID与错误类型；拒绝提示词、工作流正文、URL、密钥、原始响应正文、堆栈和本地素材路径。Native错误正文读取最多64KiB且仅提取上述白名单，不把供应商自由文本写入日志。
- 没有原生采样进度证据时，仅显示“ComfyUI正在执行原工作流”，不编造模型加载、采样百分比或预计完成时间。取消只表示本地停止等待，不宣称已停止GPU执行。
