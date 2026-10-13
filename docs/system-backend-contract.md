# 系统后端增量契约（2026-10-11）

## 范围与基线

本地功能分支以 `bafd8f0b49787baacda066032391f322f69d4190` 为基线。现有 `/v1` 视频 API 和渠道适配器保留；新增系统域独立初始化，账号服务、管理后台及同步测试不得因启动触发渠道余额、浏览器登录或生成请求。管理界面放在同仓 `apps/admin`，不建立第三仓。

系统后端先保持单部署、模块化 Fastify。系统领域持久层使用事务数据库；现有 JSON 作业保存暂留渠道兼容域，不能用其异步写入冒充系统请求耐久确认。渠道 cookies、令牌、客户端自有渠道密钥不得进入用户或管理公开响应。

## 已确认的产品边界

- 邮箱账户首次使用须完成登录、验证和激活。无设备绑定、设备席位、指纹或解绑；既有客户端机器标识只用于本地数据安全。
- 激活码兑换到账户。授权时长可配置，默认 365 天，从兑换时间起算；可兑换截止 `redeemBefore` 独立于兑换后的 `validUntil`。
- `everActivated` 与当前有效期限分开。曾登录且已激活的账户断网继续本地功能，不增加短期离线锁。到期是否限制本地使用仍待决，返回 `localExpiryPolicy: pending`，不得把云端有效期检查直接用于永久禁止本地功能。
- 新共享资格默认关闭，资格的开通政策尚待确认。资格与草稿成员 ACL 分开保存并由服务器验证。
- 所有草稿默认 local-only。只有用户显式开启单个草稿共享并指定账号白名单后，才上传正文或媒体、创建同步流。登录和账户激活不隐式开启同步，同账号多设备也不例外。
- 旧积分、旧登录链路与账本不恢复，不引订阅计费或激活服务平台。

## 身份与管理员

Better Auth 负责邮箱身份、验证、会话及密码流程；业务激活与项目权限使用独立事务模块。主进程持有客户端会话，页面只拿脱敏身份与状态。管理员不是公开注册角色，初始管理员仅经受控运维入口指定已验证账户，不创建生产凭据。

角色为 `superadmin/operator/readonly`，每个 API 在服务端验证权限；只有 superadmin 可改变管理员权限。operator 不得通过管理员列表或 API 提升角色，不得读取任意私有草稿正文。账户禁用和撤销会话有审计；激活码正文仅创建时返回一次，后续只显示掩码与摘要相关标识。

邮件经可替换 transport，测试使用内存发件箱。生产必须配置 SMTP 与邮件域名；缺配置时显式失败，不发送真实邮件、不假称验证已完成。

## 初始接口

- Better Auth: `/api/auth/*`。
- `GET /api/system/me`: 身份、邮箱验证、管理员角色、everActivated、validUntil、cloudEligible、sharingEnabled、localExpiryPolicy。
- 账户激活兑换入口：鉴权、邮箱验证、兑换截止及唯一兑换约束均服务端核验；兑换、entitlement、持久回执和审计同事务。
- `/api/admin/users`、`/api/admin/activation-codes`、`/api/admin/audit`、`/api/admin/admins`；列表 `{data,total}`，分页参数 `page/pageSize/q`。角色变更仅 superadmin。

代码实现的精确路由与错误码以模块说明为准，前后端共同变更契约，不能靠界面隐藏按钮代替服务器校验。

## 共享与执行协议

首期采用类型化命令增量。服务器已确认事实是共享域权威；客户端 SQLite 保存确认副本和未确认操作。localRevision 和 serverRevision 分开，编辑与 outbox 同事务，服务器事实、命令回执、序号和墓碑同事务。ACK 表示事务已提交，WebSocket 只作通知，游标断档按该草稿快照恢复。

不相交字段自动合并，同字段保留基线/本地/远端并显式冲突。结构插删与重排必须有集合基准，wire 协议明确 set/unset。外部用户不能声明 task/workflow origin 或使用 latest 绕过并发校验。媒体同步 assetId/hash/大小/类型，不上传绝对路径或 SQLite；读取、上传、下载均检验项目权限。

关闭共享与移除成员立即停止后续上传及访问，保留未确认本地编辑，不静默永久删除云端或已下载副本。共享删除使用墓碑，不允许迟到操作复活实体。云端保留策略仍待后续明确。

任务不随草稿同步自动复活。服务器统一认领目标并冻结输入；云渠道归服务器，本地 FFmpeg/Whisper/导出归指定本机执行者，其他端只观察。请求重传返回原 job，新一轮明确重试使用新 attempt。租约过期不等于上游未收到请求；有上游 ID 续查，不假称端到端恰好一次。

## 验收边界

所有验证使用临时库、测试账户、假邮件和假渠道；重点验证角色拒绝、兑换并发/重放、事务耐久、local-only 零同步请求、白名单撤销、冲突双方保留、ACK 丢失与双客户端认领。用户后续授权实现、测试、提交并推送两个新功能分支。稳定分支、合并、生产凭据、真实邮件、付费生成、部署及 Apple 签名/公证仍不在本轮执行范围内。

## 完整系统入口与运维验收

`pnpm system:dev` / `pnpm system:start` 现在使用同一 Fastify 应用接 identity、admin、projects、private media、system jobs 与渠道管理；先在 `apps/admin` 执行 `npm ci && npm run build`。监听默认 loopback 3001；正式部署同 origin `/admin` + `/api`，HTTPS 与明确可信代理地址。旧 `pnpm start` 保持渠道兼容，需 `SYSTEM_ENABLED=true` 才切完整系统入口。默认 `SYSTEM_CHANNELS_ENABLED=false`，账户/管理不会初始化浏览器、读取渠道余额或生成视频。

Miora 管理 AES-256-GCM 独立加密库，`CHANNEL_CREDENTIAL_KEY` 无默认、缺失拒绝导入/解密。账号默认停用，superadmin 可明确启用、更新、归档、恢复（恢复仍停用）；operator/readonly仅看脱敏渠道记录。旧文件渠道 reconciler 不认领 managed 账号；`ManagedSessionStore` 让原 JobRunner/AccountPool 直接读取启用后的加密账号，续期仍加密，不输出 JSON cookie 文件。格式及解密检查只给 `localCredentialStatus`，真实会话状态 `validationStatus=unknown`；没有执行线上校验。

服务端任务支持 `kind=miora.video`，参数 `{text,mediaHashes,options?}`，仅使用本项目/本代数已授权上传媒体。先 durable claim + bridge映射 + 普通渠道任务落盘，真实paid阶段及401续期后重新校验账号、ACL与lease；adapter禁用隐式付费提交重试与失败后重新生成；有ID重试已有查询，无ID且无法查询时明确失败并保留收费未知，交统一有限预算/明确手动重试新attempt；客户端直连任务同样需明确local租约。取消/撤权围栏阻止新的付费提交；已接受的上游任务保持query/checkpoint，不让adapter自行叠加重付。进程重启有原provider ID的服务端任务变 `uncertain`，保留映射供查询；无ID且无法查询则结算failed并释放旧目标，以明确错误允许后续统一重试；用户可调用 `/api/system/projects/:p/jobs/:id/reconcile` 收取已有成功回执，该路径仅查询已有任务/搬运结果，不重新生成；queued managed记录不会被旧recover自动提交。结果只以私有sha256媒体引用和稳定候选追加推送，不将provider原始响应或signed URL放共享命令。

私有媒体路由和视频结果迁移采用有界流式传输，不设固定文件/累计业务容量配额，旧 SYSTEM_MEDIA_MAX_FILE_BYTES/PROJECT_BYTES/OWNER_BYTES 字段弃用，不因已有环境变量复制值重新拒绝合法内容。旧 JSON/base64 格式仍兼容，由实际 process/heap 资源预算解析并按块解码写盘；只有 Buffer 接口的旧 image AssetStore 仍需实际可分配内存，不伪称已全链路流式。资源不足、停滞或验证失败保留原任务ID供核对，不新付费。共享可存储大视频不代表渠道接受大视频/任意媒体作为生成输入，此轮没有扩展 provider 输入类型。并发以排队/背压控制，持续读写进展刷新 idle watchdog，不用15/30分钟总时长或120秒 fetch总截止终止合法大文件。密钥轮换须先用旧密钥解密再用新密钥事务重加密；不能直接替换key，否则fail-closed。旧明文渠道文件未自动迁移/删除，托管账号与旧文件所有权分离，管理员可以逐个导入核对后另行撤旧账号，避免同身份重复池配置。

首次管理员通过正常邮箱注册验证后，部署操作人显式离线执行 `scripts/bootstrap-admin.mjs --database /absolute/existing.sqlite --email VERIFIED --confirm GRANT_FIRST_SUPERADMIN`；只在0 superadmin时授权，审计及会话撤销同事务，无公开bootstrap路由。本轮只使用/tmp测试库、MemoryMailer和假provider，不发送真实邮件，不导入生产Cookie，不部署服务，不配置Apple或云secret。

云资源预算：私有媒体采用实际磁盘/内存检查与并发排队，不设单项目1GiB或owner2GiB的业务上限。大规模对象存储回收/保留期仍需部署时定义，孤儿内容可按链接审计后回收，不能删除仍有待处理命令/任务引用的媒体。请求前的旧数量限流属于独立入口接线，本轮统一容量清理不得将其与真实认证、凭据到期、ACL或物理编码边界混为一谈。
