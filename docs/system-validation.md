# 系统后端验证与上线边界（2026-10-11）

基线 `main@bafd8f0b49787baacda066032391f322f69d4190`；功能分支 `feat/system-backend-account-sharing-20261011`。保持一个 Node/Fastify 服务和同仓 `apps/admin`，原视频适配器为可选渠道，不建立微服务或第三仓。

## 已通过

- 后端 TypeScript 检查与生产编译；管理界面 TypeScript + Vite 生产构建。
- 定向 Vitest 合计 152 项：身份 23、项目/媒体/任务 31、渠道 4、安全围栏 3、原 worker 集成 1、原任务 runner 5、任务持久化 4、Miora adapter 5、Miora client 12、系统收费提交 2、实际出口门禁 2、Miora transport 58、请求预算 1、资产存储 1。同一版本通过后不重复全量运行；最后出口/收费策略、核对和原 worker 接线定向通过，恢复政策变更后的项目/渠道 35 项通过。
- 身份验证包括邮箱/激活兑换、并发重放、角色拒绝、会话撤销、账户禁用、CSRF/Origin、限流和 HTTP 响应脱敏；初始管理员仅离线授权已有验证账户。
- 共享验证包括事务 ACK、字段及结构并发、stable board ID、墓碑、ACL/资格/会话即时复核、私有媒体 hash/格式/配额、执行租约围栏、有可查询 ID 的 uncertain 保持活跃目标、无查询途径失败结算与原执行者核验、既有结果核对。
- 原 `buildApp` + `JobRunner` + `AccountPool` + `MioraAdapter` 实际接线测试，只替换 provider 函数：启用托管账号由 worker 消费、旧文件 watcher 不撤托管账号、续期不落明文 JSON、系统模式原 `/v1` 不允许旧 API key 绕过账号 ACL；外部 fetch 与收费调用均为 0。
- 围栏覆盖等待账号期间取消、媒体准备期间取消、重启后 queued 不自动付费；provider 已收任务 ID 仅恢复查询，`beforeSubmit` 拒绝二次收费提交，随后同一服务器 job 收取成功候选。系统任务的 adapter 不隐式重试收费提交或失败后重新生成；有ID重试原查询，无ID且无法查询则结算failed并明确收费未知。原客户端有限重试预算或用户明确新建服务端任务决定新attempt，避免两套预算叠加和永久冻结。每个实际网络出口以及401续期后均重新核验取消/权限。
- 管理 Chromium 假 API 3 项、真实系统 API 3 项均通过；文件导入新增定向用例通过，限制 512 KiB、提交前零写、关闭/失败/成功清空临时凭据。真实服务测试覆盖 operator 不能提权、不能新增/升级项目成员、Miora 本地检查显示远端 unknown。脱敏截图存于 `apps/admin/evidence/`。
- 客户端实际 HTTP 12 项及账户 HTTP 10 项与本分支真实系统应用联调，MemoryMailer + 临时 SQLite + 假 provider；详见客户端验证说明。

## 运维与迁移

系统默认不启用渠道 worker；完整入口为 `system:dev` / `system:start`。同 origin `/admin` + `/api`，明确 HTTPS 与可信代理列表。生产 SMTP、数据库/媒体目录、首个管理员、凭据加密密钥需部署操作人配置，本轮没有设置生产 secret、导入真实 Cookie 或部署。

旧渠道 JSON 和明文文件未自动迁移或删除。先备份，在新系统逐账号导入并保持停用，人工确认身份/真实远端会话后启用；随后安排旧配置退役，避免同身份重复池。AES-GCM 密钥轮换需旧密钥解密并事务重加密，直接换 key 会失败关闭。

流式单文件默认 256 MiB，可配置但硬上限 1 GiB；旧 JSON/base64 接口保留 20 MiB 上限。项目默认 1 GiB、owner 默认 2 GiB；关闭共享及旧代数仍计入。上传、下载、Miora 结果搬运都按块处理，SHA-256、声明大小和媒体签名校验失败不确认链接。并发、预留空间和磁盘失败受限，失败仅清理本次临时文件，拒绝 ZIP 媒体且不解压。保留期及对象回收另行确认，禁止删除仍被命令或任务引用的内容。上传后数据库提交失败留下的未链接对象应按链接审计回收。

暂停、撤权、退出、重启均不将未知已提交任务当作未提交；保留系统/渠道映射和原 provider ID，优先查询已有任务。无ID且没有查询途径时结算failed释放旧目标，后续统一预算/明确手动重试才创建新attempt，错误保留SUBMISSION_OUTCOME_UNKNOWN，不能称为未收费。原上游不支持通用幂等时不能承诺收费端到端恰好一次。

曾激活后的授权到期本地政策仍为 `pending`，本轮保留本地使用；云权限由服务器当前状态校验。共享资格开通策略、媒体保留/配额与正式发布仍由用户后续决定。

本地手工验收使用 [local-acceptance.md](./local-acceptance.md)，显式 `SYSTEM_LOCAL_TEST=1`、全新临时库、仅 loopback、保留域名测试邮箱及私密访问标记。复用正式服务和媒体路由；默认关闭渠道，生产入口不提供测试邮箱，缺失 SMTP 拒绝启动。

## 媒体与本地验收补验

- 新私有流式媒体 16 项、既有项目/媒体/任务 31 项、精确媒体 Origin 边界 1 项、服务端结果流式搬运 2 项：相关四文件共 50 项通过。真实 HTTP 32 MiB 上传/下载超过原 JSON bodyLimit，明确禁止调用 Buffer put/get；验证 ENOSPC、声明预留、停滞超时后槽释放、源文件 FD 关闭与用户原文件保留、路径/hash/ZIP/符号链接拒绝及撤权/代数/墓碑最终检查。
- 本地验收 4 项通过；脚本实际 listen 在 loopback，health/admin 为 200，无邮箱标记为 401，真实邮箱注册为 400；生产模式与缺 SMTP 拒绝。临时服务已关闭，仅清理本轮临时目录。
- 客户端真实账户 HTTP + 双 Electron SQLite `--media-stream` 6 项通过（24 MiB）：typed 集正文/原素材、场次、asset/shot/board/project 提示词、私密凭据剔除、人工候选选择与媒体 hydrate；同 hash 双实体首实体删除后仍可重新下载。付费调用 0。持久脚本位于配套客户端 `scripts/test-sharing-system-integration.cjs`，临时证据 `/tmp/shared-media-system-result.json`。
- 当前后端 TypeScript 无错误检查、客户端 TypeScript/Vite 构建通过。媒体只有格式签名检查，不冒充完整解码或物理双 Mac 验收。原 Miora 参考输入的 image AssetStore Buffer 准备仍最多 20 MiB，此限制与大视频共享及结果搬运分开。
