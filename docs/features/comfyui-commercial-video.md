# H3 商业视频交付合同

New API 使用专用渠道连接本服务。用户账户、价格、预扣、退款及公开任务 ID 由 New API 管理；本服务不保存零售美元价格，不扣用户额度。H3 按冻结请求秒数计费，不使用排队、开机、上传、推理墙钟时间，也不按工作流帧数对齐后增加的时长加收。

## 创建与恢复

`POST /v1/jobs`，运营侧 `x-api-key` 鉴权：

```json
{
  "adapterId": "comfyui-v1",
  "workflowId": "minimax-h3-9plus3",
  "requestKey": "persisted-public-task-id",
  "transport": "direct",
  "resultDelivery": "archive",
  "values": { "prompt": "提示词", "duration": 10, "width": 1344, "height": 768 },
  "media": {},
  "directMedia": {}
}
```

商业交付要求已配置 GPU → TOS 归档，否则返回 503 `COMFY_ARCHIVE_UNAVAILABLE`。首期产品边界为整数 4–15 秒；宽高各为 32 的倍数、480–1920，像素总数不超过 1920×1088。它们是商业渠道的资源保护范围，不代表上游全部能力。非法参数返回 400 `COMFY_DURATION_INVALID` 或 `COMFY_DIMENSIONS_INVALID`，不创建任务。

创建返回 `jobId`、`status`、`statusUrl`、`billing: {"unit":"second","requestedSeconds":10}`。同 requestKey 同输入返回同一作业；更改输入或交付方式返回 409 `COMFY_REQUEST_CONFLICT`。运营网关必须先持久化 requestKey 和请求正文，再请求本服务。

提交回执丢失后，使用 `GET /v1/jobs/by-request-key/:key` 查询已接受作业；返回与按 ID 查询相同的任务投影，未发现返回 404 `JOB_NOT_FOUND`。查询按运营 Key 对应的 owner 隔离，不是终端用户权限接口。New API 必须自行校验 user/token/task 所有权，不能把运营 Key 下发给用户。404 只表示本次查询未发现；恢复时仍用原 requestKey 重放，不能换 Key 创建另一作业。

## 参考素材

素材字节由客户端直传 GPU，不经过 Hailuo。`directMedia` 声明 `image1`–`image9`、`audio1`–`audio3` 的 filename/contentType/sha256；不允许媒体声明占用未注册绑定。没有参考素材的商业作业分配 GPU 后自动确认空输入。

有素材时，等待任务 `stage="awaiting_upload"`，读取 `upload: {baseUrl,subfolder,files,reservationId}`。按 files 清单上传到 GPU `/upload/image`，不携带运营 Key。然后提交：

```json
{
  "reservationId": "返回的原值",
  "inputs": {
    "image1": { "name": "冻结文件名.png", "subfolder": "原 jobId", "type": "input" }
  }
}
```

`reservationId` 绑定作业、实例和持久化上传预约代数。预约重建后的旧回执返回 409 `COMFY_UPLOAD_RESERVATION_STALE`，客户端重新查询预约并重传；当前回执重放幂等。文件名、目录、清单不匹配返回 400 `COMFY_UPLOAD_INVALID`。其他不可接受上传的阶段返回 409 `COMFY_UPLOAD_UNAVAILABLE`。

## 成功与失败

商业作业生成完成后立即启动 GPU → TOS 上传及 HEAD 校验。归档期间对外 `status="running", stage="archiving"`，不暴露临时 GPU 视频结果。只有归档对象验证完成才返回 `status="succeeded"` 和 `result: {videoUrl,storage:"tos",expiresAt}`；expiresAt 是 Unix 毫秒，结果保留 24 小时，下载签名按剩余期限生成。客户端应在期限内收取保存。旧客户端未传 resultDelivery 时保留原 10 分钟归档后备策略。

`error.providerTerminal` 是确定商业失败退款的证据，不可只看 failed/cancelled 字符串。商业作业只有已证实未提交、原生失败、原实例确定释放且执行关闭，或归档最终放弃且无可交付结果时返回 true。网络中断、原生提交未确认、尚未证实远端停止的取消均为 false；临时归档错误继续 running/archiving。已交付结果后过期或存储暂不可用也为 false，不能因此退款重生成。

商业结果尚未完成归档时不接受 `/collected` 回执。New API 应以归档成功投影完成用户任务，不得用临时 GPU URL 提前完成结算。整个合同不需要 Hailuo 代理图片、音频或视频字节。
