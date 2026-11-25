# AIGate Qwen3-ASR 批量听写

ASR 与 ComfyUI 各自管理节点和作业。单个节点承接一批，任务顺序按创建时间。使用与视频相同的网关
鉴权、任务回执和客户端直传模式。Hailuo 接受清单和听写结果。

- `SYSTEM_ASR_WORKERS` 配置逗号分隔的节点 HTTPS 地址。
  `SYSTEM_ASR_WORKER_KEY` 配置 Hailuo 与节点的内部凭据。
  节点在 `GET /health` 返回 `ready: true` 后可被分配。
- `SYSTEM_ASR_AIGATE_INSTANCE_IDS` 配置逗号分隔的专用 AIGate 实例 ID，
  使用既有 `AIGATE_ACCESS_TOKEN` 管理开关机。只有领取到任务的实例才开机。
  从官方实例信息读取当前 18080 HTTPS 入口。实例进入运行态后检查模型服务；
  非 systemd 镜像通过 SSH 和文件锁启动同一份已安装的服务。
  队列为空且实例没有在途作业时，调度器在下一轮直接发起关机。提交回执未知和
  重启恢复都保持原实例 ID。静态 HTTPS 节点继续由外部管理电源。
- `SYSTEM_ASR_AIGATE_TEMPLATES` 接收包含 `id`、`areaName`、`imageId` 和
  `skuNames` 的个人镜像清单。按视频池的机型顺序配置，既有单机型配置可用
  `skuName`。可通过 `instanceId` 登记已准备的实例。确认关机后直接释放临时
  实例；释放与确认期间的新作业等原实例退役，再按同区镜像重建。平台明确
  报告容量不足时可尝试清单下一机型或另一可用区。尚未发给
  节点的任务保留原任务号与截止时间。
- `POST /v1/asr/jobs` 以调用方的 `requestKey` 幂等创建。请求包含
  可选 `language`（`Chinese` 或 `Auto`）和 `clips`。每个分镜提供
  `id`、`filename`、`contentType`、`sha256`、`size` 和 `durationMs`。
- 调用方可按作业 ID 或 `GET /v1/asr/jobs/by-request-key/:key` 查回执。
  本地 SQLite 冻结清单、计费秒数、作业 ID、节点地址和上传令牌。
  入队、等待节点和节点实际执行分阶段显示。
- 在 `awaiting_upload` 阶段，调用方用返回的作业级 Bearer 令牌向节点
  `PUT` 各个音频。节点校验字节、SHA-256 和解码时长。
  `POST /v1/asr/jobs/:id/inputs` 保存提交意图，Hailuo 向冻结节点发出
  幂等启动请求。节点返回缺件时恢复上传阶段，使用原节点和令牌。
- 网关只转发元数据。客户端收取 `result.transcripts` 后继续使用既有
  剧本映射和字幕校时。节点服务失败、时长不符按普通任务失败返回。
  网络抖动保留原节点和 ID，提交确认未返回时只重放对原节点的请求。
- GPU 上传预约沿既有视频池的 10 分钟预算，到期且尚无启动意图才释放
  槽位。收到带结果的节点终态后把文字事务写入 SQLite，释放槽位。

首轮按同一部剧的整集音轨验收两个区域的节点，从 New API 创建、直传、
确认、收取逐镜文本并检查重复请求回到原 ID。记录逐阶段用时和结果。
