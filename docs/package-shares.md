# 草稿快照与独立媒体公开 URL 共享

这是独立的手动 ZIP 版本共享模块，不启用旧项目增量共享，不执行字段合并，不触发生成任务。客户端保留本地草稿；同一个 share ID 的所有者及编辑成员均可发布不可变版本或手动下载版本。

## 发布与授权

新版本由完整草稿 snapshot JSON 和按内容身份登记的独立媒体组成。客户端先查询当前 share 的媒体索引，只上传缺少的媒体及完整 snapshot，再登记版本。旧 ZIP 版本仍可按原接口发布和下载。后端不配置存储桶，不持有桶 AK/SK，不接收 ZIP 大字节，不做 HEAD、下载探测、分片签名或供应商域名白名单。参考素材／草稿包在客户端按各自用途使用存储；全局模板和画风库继续独立迁移。

`PACKAGE_SHARES_ENABLED` 默认启用，显式设置为 `false` 可关闭本模块。旧字段共享仍关闭。本模块不要求任何 `PACKAGE_STORAGE_*` 配置；以前的服务端私有存储配置不再读取。

每次操作校验真实会话、有效激活权益 `cloudEligible` 和实时成员关系，不依赖旧 `sharingEligible` 白名单。所有者可按已注册且验证的邮箱添加编辑成员、撤销成员、软删除或恢复共享。编辑成员不能管理其他成员。

URL 只允许格式完整的 HTTP(S)，拒绝用户名／密码、文件协议、控制字符和 CRLF；不限制存储厂商，不验证地址实际可用性。版本列表、latest、共享详情、版本登记回执与审计摘要不包含 URL。只有成员鉴权后的下载及媒体查询／认领回执接口返回地址。撤权阻止后续从系统获取地址；已取得的公开地址仍受用户自己的存储可见性与生命周期控制。

## 接口与事实

接口根为 `/api/system/package-shares`：

- `GET /capability` 返回 `{enabled,eligible}`，不要求存储配置状态。
- `GET /` 返回 `{data}`；`POST /` 接收 `{requestId,draftId,title}` 创建共享身份。
- `GET /:shareId` 返回共享元数据、成员及不含 URL 的版本。所有者用 `POST /:shareId/members {email}`、`DELETE /:shareId/members/:userId` 管理成员。
- `GET /:shareId/latest` 返回 `{version|null}`，只包含元数据。
- `POST /:shareId/versions/receipt {requestId}` 只查询当前成员本人在该 share 的发布回执，返回 `{version|null}`，不包含 URL；恢复流程先查询回执，再决定是否补传或登记。
- `POST /:shareId/versions/:versionId/snapshot/repair {url,sha256,size}` 要求严格等于已发布 snapshot 的哈希和大小，仅更新独立的当前地址索引；不修改原发布 URL／hash／size、序号或媒体事实。
- `POST /:shareId/media/lookup {items:[{sha256,size}]}` 只向当前成员返回该 share 的 `ready/missing` 状态和可用公开 URL，不跨 share 探测哈希是否存在。
- `POST /:shareId/media/claims {requestId,sha256,size,repair?}` 返回 `ready`（复用 URL）、`claimed`（上传租约）或 `busy`（已有同内容上传）。`POST /:shareId/media/claims/:claimId/renew` 续期，`/cancel` 释放，`/complete {url,mime,kind}` 在上传成功后登记地址。
- `POST /:shareId/versions` 新格式接收 `{kind:'manifest',requestId,draftId,title,scope,baseVersionId?,snapshot:{url,sha256,size},media:[{sha256,size,mime,kind}]}`，返回 `{version}`。snapshot 是完整草稿事实，媒体列表覆盖选定范围的全部依赖；即使多数媒体复用，也发布完整 descriptor。
- 旧 ZIP 格式 `{kind?:'zip',requestId,draftId,title,size,sha256,scope,baseVersionId?,url}` 保持兼容，不将旧记录伪造成 manifest。
- `POST /:shareId/versions/:versionId/download` 在实时鉴权后返回版本元数据与 URL；`DELETE /:shareId` 软删除，`POST /:shareId/restore` 恢复。

`draftId`／`sourceDraftId` 必须与共享身份绑定的稳定草稿身份一致；成员客户端可另存稳定身份到本机身份的映射。`scope` 保存 `kind: all | selected-episodes`、稳定 `episodeIds`、`sourceEpisodeCount` 和可选 `assetOrigins`。范围计数、重复身份及字段形状在服务端验证，无额外大小／数量业务上限；安全整数与小控制 JSON 请求预算保留。实际 ZIP 及声明一致性由接收端验证。

`baseVersionId` 记录来源版本，必须属于同一共享；并行发布产生独立新版本，不强制覆盖或自动合并。按 share／发布者／requestId 幂等登记；版本请求号与来源、snapshot 地址／哈希／大小、全部媒体事实、标题、范围及来源版本绑定；旧 ZIP 请求号仍绑定整包信息。事务已经提交但响应丢失时，使用原请求号重试恢复原版本，不能因此重新上传或生成。序号在 SQLite 事务内分配。

## 媒体去重、恢复和版本原子性

媒体上传认领是短时元数据互斥，不是服务器上传调度器。SQLite 活动认领唯一索引防止同 share、同 hash／size 两个成员同时取得上传权；两分钟租约可续期，取消释放，过期可抢。重新认领生成新 claim ID，旧上传回执不能越过新认领。撤销成员会释放其活动认领；没有永久阻断或新增媒体数量／大小业务上限。

上传失败或元数据回执丢失时，客户端保留已上传成功的对象收据，用原请求号重试登记；重新取得认领后可补登已有 URL，不应重新上传成功对象。服务端不 HEAD 或抓取字节，`ready` 表示已收到当前成员的成功登记声明；实际文件可用性和内容完整性由客户端验证。

有本地字节的成员可用 `repair:true` 认领并重新上传同 hash／size 媒体，更新当前索引 URL。旧版本 snapshot 的哈希、媒体事实和范围不变，下载会解析新的当前地址，不把过期媒体 URL 固化进版本事实。完整 snapshot JSON 的地址也可按相同哈希和大小修复到独立 `package_share_snapshot_urls` 索引，原发布请求重放仍绑定原始发布事实；响应已丢但版本已提交时先找回本人回执，不能为修复地址另造版本。

发布完整 manifest 必须在同一 SQLite 事务中确认全部媒体身份已有成功地址登记，任一缺失返回 `PACKAGE_MEDIA_NOT_READY` 且不创建版本。完整 snapshot 仅保存描述符地址／哈希／大小，后端不抓取其 JSON。此后原子分配序号、登记全部媒体事实和版本；不执行生成、GC、字段合并或大字节转发。

## 历史兼容与本地应用

旧公开 ZIP 保存到 `package_share_public_versions`；新完整 descriptor 保存到独立 `package_share_manifest_versions`，不伪造 ZIP 或上传记录。媒体当前地址按 `(shareId,sha256,size)` 保存，版本只冻结媒体身份、MIME 和 kind。原 `package_shares`、成员、私有版本、上传与租约表都保留，不执行 DROP、数据清理或桶操作。版本列表合并历史私有 ZIP、公开 ZIP 和完整 manifest；新序号延续全部格式的最大序号。

没有公开 URL 的旧私有版本显示 `downloadAvailable:false`，下载返回 `PACKAGE_VERSION_REPUBLISH_REQUIRED`，要求从本地重新发布。后端不能凭旧对象键伪造公开地址。软删除只更新共享状态，不删除版本或客户端存储对象。

manifest 下载返回 snapshot 地址及按当前索引解析的媒体地址。接收端验证 snapshot SHA256／大小、结构与全部媒体哈希／大小、稳定来源和范围事实，再进入本地预览／确认／保存握手／CAS 与备份流程；旧 ZIP 下载仍验证整包 SHA256 和 ZIP 安全结构。选集更新只修改对应剧集和依赖，其他集与草稿级数据保留；草稿包不携带全局库。

## 验证边界

临时 SQLite 和真实 Fastify 注入用例覆盖任意独立 HTTP(S) 存储地址、无网络调用、丢回执恢复、幂等、并行发布、实时账号及 ACL、URL 隔离、软删除恢复与旧私有历史兼容。没有调用真实存储、生成或生产部署；另有定向用例验证媒体缺失不发布、两成员同哈希认领、取消／续期／过期接管、旧回执隔离、地址修复保留旧哈希与旧 ZIP 兼容；公开地址是否长期可访问和实际字节完整性由客户端传输与接收验证负责。

2026-10-13 本轮从 `015ddfd0f8d333ce97721ed6cc1f53d20137eb08` 在 `feat/share-panel-global-tasks-20261013` 开发，媒体/租约/manifest/回执恢复/地址修复及旧ZIP定向检查、TypeScript与构建已通过。用户在本地验收完成后明确批准两仓“提交 合并 推送”；发布前fetch确认origin/main仍为起点，无用户新增提交需合并。提交使用 `Codex <noreply@openai.com>`，正常快进main，不强推、不执行部署或Actions。客户端详细验收记录位于 `aistudio/docs/package-sharing-global-manifest-state-20261013.md`。

## 2026-10-13 分窗协议 v2

新客户端显式传 `format=manifest-v2` 查询参数。capability 的 `manifestProtocol:'manifest-v2'` 表示可用；旧服务缺此标记时不能发送新stage字段。旧客户端无参数保持原JSON合同；后端逐行流式输出旧数组，旧客户端自身响应体预算仍需升级，不宣称它支持任意规模。

v2列表用 `afterShareId`，详情版本用 `beforeSequence`（sequence倒序）；响应分别带 `complete/nextAfterShareId` 与 `versionsComplete/nextBeforeSequence`。`limit` 只是可持续续取的窗口，过大请求自动收窄，不成为总条目拒绝。v2版本摘要不内联media，附 `mediaCount/mediaDigest/mediaPageAvailable`。`GET /:shareId/versions/:versionId/media?after=0&limit=200` 返回稳定0起position、当前成员可得URL、nextAfter/complete及相同完整count/digest。摘要为按顺序 `SHA256(JSON.stringify({sha256,size,mime,kind})+'\n')`，URL不参与冻结事实；客户端必须核对位置、总数、摘要及快照依赖闭包。

v2 stage声明必须带同算法 `mediaDigest`，mediaCount不再限制百万总量。每窗最多500条，连续登记任意总量；SQL按位置、唯一身份和媒体就绪校验，版本/规范媒体行/index/提交回执同事务可见，旧请求号不能变内容。重复commit可按持久stage回执恢复原版本。旧mediaJson仅首次读由SQLite json_each事务迁入，保留原记录，index标记使重启不扫描。

大型scope可用 `scopeTransfer:{bytes,sha256,chunks}` 替代scope。`POST /:shareId/versions/stages/:stageId/scope {offset,items:[JSON文本片段]}` 连续登记，返回scopeReceived；JSON按UTF8字节与原文本SHA256冻结，片段不可拆破代理对。提交用SQLite检查完整JSON、字段类型、范围计数和重复身份。新摘要scope为null，并带 `scopeSummary:{kind,episodeCount,sourceEpisodeCount}`、scopePageAvailable/scopeBytes/scopeDigest/scopeChunks；`GET /:shareId/versions/:versionId/scope?after=0&limit=200` 返回items[{position,text}]、bytes/sha256/chunks、nextAfter/complete。旧默认JSON按原文本片段流式输出原scope。

验证与剩余边界见 `package-sharing-pagination-design.md`。SQLite仍需完成最终事务与scope JSON组装，物理磁盘、运行时容量和真实大规模耗时未假装无限；本轮不部署、不访问真实桶，保留用户f605e2a COS诊断代码。
