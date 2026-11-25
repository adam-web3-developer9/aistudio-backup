# AIGate Qwen3-ASR 批量听写

ASR 与 ComfyUI 各自管理节点和作业。首版从环境变量载入已启动的 AIGate
ASR 节点，单节点承接一批，任务顺序按创建时间。使用与视频相同的网关
鉴权、任务回执和客户端直传模式。Hailuo 接受清单和听写结果。

- `SYSTEM_ASR_WORKERS` 配置逗号分隔的节点 HTTPS 地址。
  `SYSTEM_ASR_WORKER_KEY` 配置 Hailuo 与节点的内部凭据。
  节点在 `GET /health` 返回 `ready: true` 后可被分配。
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
