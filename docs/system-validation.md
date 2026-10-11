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

单文件上限 20 MiB、项目默认 1 GiB、owner 默认 2 GiB；关闭共享及旧代数仍计入。保留期及对象回收另行确认，禁止删除仍被命令或任务引用的内容。上传后数据库提交失败留下的未链接对象应按链接审计回收。

暂停、撤权、退出、重启均不将未知已提交任务当作未提交；保留系统/渠道映射和原 provider ID，优先查询已有任务。无ID且没有查询途径时结算failed释放旧目标，后续统一预算/明确手动重试才创建新attempt，错误保留SUBMISSION_OUTCOME_UNKNOWN，不能称为未收费。原上游不支持通用幂等时不能承诺收费端到端恰好一次。

曾激活后的授权到期本地政策仍为 `pending`，本轮保留本地使用；云权限由服务器当前状态校验。共享资格开通策略、媒体保留/配额与正式发布仍由用户后续决定。
