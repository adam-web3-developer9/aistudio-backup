# 整包草稿共享

这是独立的手动 ZIP 版本共享模块，不启用旧项目增量共享，不执行字段合并，不触发生成任务。客户端保留本地草稿；同一个 share ID 的所有者及编辑成员均可发布不可变版本或手动下载版本。

## 启用与授权

`PACKAGE_SHARES_ENABLED` 默认未启用。两个服务器入口都只有在其值为 `true` 时才创建私有存储适配器；缺少存储配置时 capability 明确显示未配置，操作返回 `PACKAGE_STORAGE_UNAVAILABLE`。

私有存储由服务端配置 `PACKAGE_STORAGE_ACCESS_KEY_ID`、`PACKAGE_STORAGE_ACCESS_KEY_SECRET`、`PACKAGE_STORAGE_BUCKET`、`PACKAGE_STORAGE_REGION`、`PACKAGE_STORAGE_ENDPOINT`。长期凭据只留服务端；客户端获得限定对象／分片的短时授权。`PACKAGE_STORAGE_TTL_SECONDS` 默认 300，最多 900 秒。旧共享开关和用户自带参考素材公网桶不参与本模块。

每次请求检查真实会话、有效激活权益 `cloudEligible` 和当前成员关系，不依赖旧 `sharingEligible` 白名单。所有者可按已注册且验证的邮箱添加编辑成员、撤销成员、软删除或恢复共享。编辑成员不能管理其他成员。异步存储请求结束后再次检查会话与 ACL，撤权立即阻止新的授权和版本发布；此前签出的对象地址可能继续有效到短时授权到期。

## 接口与数据

接口根为 `/api/system/package-shares`：

- `GET /capability`：启用状态、存储配置状态、账号资格、真实分片协议约束和精确桶域名列表。
- `GET /` 返回 `{data}`；`POST /` 接收 `{requestId,draftId,title}` 创建共享身份。
- `GET /:shareId` 返回共享元数据、成员和版本。所有者使用 `POST /:shareId/members {email}`、`DELETE /:shareId/members/:userId` 管理成员。
- `POST /:shareId/uploads` 接收 `{requestId,draftId,title,size,sha256,scope,baseVersionId?}`；返回上传 ID、分片大小／数量和可恢复状态。`GET /:shareId/uploads/:uploadId` 查询并恢复初始化。
- `POST /:shareId/uploads/:uploadId/parts {parts:[{partNumber,md5Base64}]}` 返回限定字节长度及 MD5 的分片授权；长度由服务器规划，不能由客户端改写。
- `POST /:shareId/uploads/:uploadId/complete {parts:[{partNumber,etag}]}` 返回 `{version}`；`POST /:shareId/uploads/:uploadId/cancel` 取消并终止已知临时分片上传。
- `POST /:shareId/versions/:versionId/download` 返回版本元数据和短时下载地址。`DELETE /:shareId` 软删除，`POST /:shareId/restore` 恢复。

`draftId`／`sourceDraftId` 是包内稳定草稿身份；成员客户端可另存稳定身份到本机身份的映射。`scope` 完整保存 `kind: all | selected-episodes`、稳定 `episodeIds`、`sourceEpisodeCount` 和可选 `assetOrigins`。范围计数、重复身份及字段形状在服务端验证；实际 ZIP 内容与声明一致性由接收端验证。`baseVersionId` 是来源版本，不将并行发布强制改成覆盖或自动合并。

## 完整性、恢复和删除边界

服务器生成不可变对象键，只保存元数据，不接收 ZIP 大字节。保留小控制 JSON 请求预算；不添加 100 MiB 等业务大小上限或素材数量上限，仅保留安全整数和供应商真实分片约束。

同一上传请求号绑定内容、身份和范围，重复请求恢复同一上传。初始化有 SQLite 持久租约和回执 CAS；存储已创建而回执未落库时，重启后按精确对象键找回未完成分片任务。初始化租约覆盖 SDK 的两次 30 秒请求，过期可恢复，不构成永久阻断。上传保留租约可由当前有效成员续期，不限制正常上传总时长。

完成前读取服务端分片列表，核对顺序、数量、长度与 ETag，再完成对象并用 HEAD 核对总大小及 SHA256 元数据声明。HEAD 元数据不是独立计算的整包哈希证明：接收端必须验证下载的真实 SHA256、ZIP 安全结构和范围事实，才能进入本地导入确认流程。存储完成后数据库发布失败可重试：已有对象经 HEAD 校验后仅补写版本，不重复上传。版本序号和上传回执在同一 SQLite 事务内提交。

活动上传及下载授权有持久租约记录。软删除保留所有对象、版本和成员数据；本次没有实现或执行永久清理、桶策略变更或生产部署。临时上传取消只终止该上传，不删除已发布版本。

验证使用临时 SQLite 与假存储，涵盖并发发布、撤权、分片／HEAD 不一致、发布重试、软删除恢复及初始化崩溃恢复；不代表真实桶或生产环境已验收。

选集覆盖只更新对应剧集、分镜、分集场次与包内依赖资产；其他集、草稿级原文/设置/封面、画布及全剧分析保留本机，预览明确提示。新增副本保留包内投影内容；更新完整草稿级业务使用全集包。来源身份以 share 的稳定 draftId 为准，不允许成员将另一个草稿冒充同共享版本。

生产配置由部署方管理；本轮未配置任何真实桶或凭据。`PACKAGE_STORAGE_ACCESS_KEY_ID`、`PACKAGE_STORAGE_ACCESS_KEY_SECRET`、`PACKAGE_STORAGE_BUCKET`、`PACKAGE_STORAGE_REGION`、`PACKAGE_STORAGE_ENDPOINT` 为必需独立服务端配置，缺失则不可用。`PACKAGE_STORAGE_TTL_SECONDS` 默认 300，最多 900。endpoint 只允许受控 HTTPS TOS 域名。不要复用客户端公有引用存储或 Miora STS。SDK CRC64 关闭，省去非必需原生依赖；SDK 2.9.1 的普通预签名不绑定自定义 header，适配器用明确 TOS4 扩展绑定 Content-Length/Content-MD5，并通过真实 SDK 嵌套路径对照测试。真实私有桶仍待验收。

分片协议真实上限：最多 10000 片，非末片至少 5 MiB，单片最多 5 GiB，来源为 [官方 TOS SDK 常量](https://github.com/volcengine/ve-tos-python-sdk/blob/main/tos/consts.py)。这是传输协议约束，不是额外包大小或文件数量业务门槛。
