# 整包草稿公开 URL 共享

这是独立的手动 ZIP 版本共享模块，不启用旧项目增量共享，不执行字段合并，不触发生成任务。客户端保留本地草稿；同一个 share ID 的所有者及编辑成员均可发布不可变版本或手动下载版本。

## 发布与授权

客户端先用自己的公开存储完成 ZIP 上传，再把地址和元数据登记给后端。后端不配置存储桶，不持有桶 AK/SK，不接收 ZIP 大字节，不做 HEAD、下载探测、分片签名或供应商域名白名单。参考素材／草稿包在客户端按各自用途使用存储；全局模板和画风库继续独立迁移。

`PACKAGE_SHARES_ENABLED` 默认启用，显式设置为 `false` 可关闭本模块。旧字段共享仍关闭。本模块不要求任何 `PACKAGE_STORAGE_*` 配置；以前的服务端私有存储配置不再读取。

每次操作校验真实会话、有效激活权益 `cloudEligible` 和实时成员关系，不依赖旧 `sharingEligible` 白名单。所有者可按已注册且验证的邮箱添加编辑成员、撤销成员、软删除或恢复共享。编辑成员不能管理其他成员。

URL 只允许格式完整的 HTTP(S)，拒绝用户名／密码、文件协议、控制字符和 CRLF；不限制存储厂商，不验证地址实际可用性。版本列表、共享详情、登记回执与审计摘要不包含 URL。只有成员鉴权后的下载接口返回地址。撤权阻止后续从系统获取地址；已取得的公开地址仍受用户自己的存储可见性与生命周期控制。

## 接口与事实

接口根为 `/api/system/package-shares`：

- `GET /capability` 返回 `{enabled,eligible}`，不要求存储配置状态。
- `GET /` 返回 `{data}`；`POST /` 接收 `{requestId,draftId,title}` 创建共享身份。
- `GET /:shareId` 返回共享元数据、成员及不含 URL 的版本。所有者用 `POST /:shareId/members {email}`、`DELETE /:shareId/members/:userId` 管理成员。
- `POST /:shareId/versions` 接收 `{requestId,draftId,title,size,sha256,scope,baseVersionId?,url}`，返回 `{version}`。客户端只有上传成功后才登记。
- `POST /:shareId/versions/:versionId/download` 在实时鉴权后返回版本元数据与 URL；`DELETE /:shareId` 软删除，`POST /:shareId/restore` 恢复。

`draftId`／`sourceDraftId` 必须与共享身份绑定的稳定草稿身份一致；成员客户端可另存稳定身份到本机身份的映射。`scope` 保存 `kind: all | selected-episodes`、稳定 `episodeIds`、`sourceEpisodeCount` 和可选 `assetOrigins`。范围计数、重复身份及字段形状在服务端验证，无额外大小／数量业务上限；安全整数与小控制 JSON 请求预算保留。实际 ZIP 及声明一致性由接收端验证。

`baseVersionId` 记录来源版本，必须属于同一共享；并行发布产生独立新版本，不强制覆盖或自动合并。按 share／发布者／requestId 幂等登记；请求号与来源、URL、哈希、大小、标题、范围及来源版本绑定。事务已经提交但响应丢失时，使用原请求号重试恢复原版本，不能因此重新上传或生成。序号在 SQLite 事务内分配。

## 历史兼容与本地应用

新的公开地址版本保存到独立 `package_share_public_versions`，不伪造上传记录。原 `package_shares`、成员、私有版本、上传与租约表都保留，不执行 DROP、数据清理或桶操作。版本列表合并旧私有版本及新公开版本；新序号延续两类版本的最大序号。

没有公开 URL 的旧私有版本显示 `downloadAvailable:false`，下载返回 `PACKAGE_VERSION_REPUBLISH_REQUIRED`，要求从本地重新发布。后端不能凭旧对象键伪造公开地址。软删除只更新共享状态，不删除版本或客户端存储对象。

接收端必须验证真实整包 SHA256、ZIP 安全结构、稳定来源和范围事实，再进入本地预览／确认／保存握手／CAS 与备份流程。选集更新只修改对应剧集和依赖，其他集与草稿级数据保留；草稿包不携带全局库。

## 验证边界

临时 SQLite 和真实 Fastify 注入用例覆盖任意独立 HTTP(S) 存储地址、无网络调用、丢回执恢复、幂等、并行发布、实时账号及 ACL、URL 隔离、软删除恢复与旧私有历史兼容。没有调用真实存储、生成或生产部署；公开地址是否长期可访问及最终 ZIP 完整性由客户端传输与接收验证负责。
