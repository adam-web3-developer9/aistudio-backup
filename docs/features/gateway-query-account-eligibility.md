# 网关续查与账号提交资格（2026-10-15）

## 原因与证据

AIStudio 任务 `bb40dc99-7468-4abf-ab51-1bc3129b1b26` 已持有网关任务号 `job_gateway_upload_6176623a-c7dd-4479-93e6-32ba694f474b`，查询却收到 `Gateway channel account is unavailable` HTTP 403。`JobRunner.resumeGatewayQuery` 复用了提交闸门，`ManagedVideoGatewayRecords.assertExecution` 因账号禁用或归档拒绝续查，客户端将这项内部账号资格错误识别为渠道鉴权失败。

## 修复边界

- 网关请求密钥认证与任务持久归属继续强制检查。查询使用独立 `beforeQueryGuard` / `assertQuery`；账号启用与归档状态仅限制新提交。
- 已有上游 ID 始终使用原账号、原 ID，只续查，不切账号、不提交新生成。旧 `GATEWAY_ACCOUNT_UNAVAILABLE` 失败可按原 ID 恢复。
- 原会话确实不可读取、查询超时或其他非上游终态错误，记录为 `PROVIDER_QUERY_BLOCKED`、`retryable: true`、`providerTerminal: false`，公开投影增加 `scope: task`。查询返回任务正文，保留上游 ID，不把账号故障升级为网关 HTTP 401/403。
- 真实上游终态 `providerTerminal: true` 保持原错误；本次不修改 Miora 通用 HTTP 403 分类、账号清理规则或新提交保护。

## 定向验收

仅验证网关原 ID 续查及其归属/安全投影：账号提交闸门拒绝时查询仍可运行；不可查询时保留身份并公开查询受阻事实；禁用与归档不阻止查询，轮换密钥仍不能读其他归属任务。源码验收与线上部署分开，本次不部署、不运行真实生成。

新增续查回归先运行失败（预期恢复、实际返回 false），实现后以下定向命令通过 4 项，跳过 10 项；`rtk git diff --check` 通过。未执行全量测试、构建或生产重试。

```text
rtk vitest run src/jobs/job-runner.test.ts src/system-channels/video-gateway.test.ts -t "resumes unresolved gateway queries|keeps gateway queries independent|persistent resource ownership|gateway exposes task verdict"
```
