# 旧私有媒体与结果收取的资源接纳

2026-10-13 用户授权清理全部人工业务大小门槛。`buildSystemWebApp` 仍注册项目私有媒体接口；服务端 system job 的 submit/reconcile 仍经过 `ChannelJobBridge`，因此不能将这两条路径当成废弃代码。新公开 manifest、Miora direct 上传和用户最新诊断改动不在本项文件范围内。

根因：旧媒体策略默认文件 256 MiB、硬 1 GiB、项目 1 GiB、owner 2 GiB，固定声明大小接纳预算和 429 拒绝；路由、blob store、结果收取还分别使用总耗时截止。它们阻断合法内容，与实际空间和进展无关。

按现有 V1/V2/V5、8.3/8.5/8.7/8.8 修复：不设文件/累计业务配额，只保留可表示的整数、协议格式、路径、ACL/generation、内容签名、真实长度/SHA 和实际磁盘/内存预算。用户本轮进一步明确取消所有人工业务配额，因此旧 `SYSTEM_MEDIA_MAX_FILE_BYTES/PROJECT_BYTES/OWNER_BYTES` 和 `MediaPolicy` 容量字段均弃用；不将已有 `.env` 拷贝值冒充新的管理员明确授权。公共策略字段形状仍保留，返回安全整数表示边界，不是容量承诺。并发数量仅调节资源窗口：忙时等待，取消或连接关闭撤出队列；不按声明整个文件大小永久拒绝大文件。

媒体写盘和结果下载采用无进展 watchdog，每次真实读写进展刷新；持续传输不因总用时超限中断。磁盘不足或真实内存无法支撑兼容对象时返回资源错误，保留上游结果及原业务数据。

旧 JSON/base64 公共格式保留。在媒体插件内安装按实际 heap/可用内存预算读取的 JSON parser，避免默认 bodyLimit 先拒绝；兼容 JSON 对象仍需要内存并明确承认此限制。base64 按块验证/解码后写流，不另外构造完整媒体 Buffer。仅 Buffer 接口的旧存储按实际可分配内存和 Node 的物理编码边界接纳，不设 20 MiB 业务门槛。生产 LocalPrivateBlobStore 的二进制路径始终流式。

最少定向验证：超过旧 JSON 20 MiB 的真实接口；大文件声明/累计策略及旧环境配额不拒绝；并发排队及取消/关闭清理；持续进展跨总时长成功、停滞超时；既有 hash/length/signature、磁盘失败和 ACL 回执边界；结果收取流式且忙时排队。使用临时 SQLite/文件及假 fetch，真实 provider、生产凭据、部署和 Actions 均不操作。

## 本轮结果

已完成上述可达路径修改。命名过滤验证包括 21 MiB 兼容 JSON 的实际接口/分块观察、旧容量配置弃用、流式结果、停滞与持续进展、内部排队及客户端断开/服务关闭撤队列、hash/length/signature、ENOSPC 和 ACL 最终回执保护；仅执行直接相关用例，未跑全套旧协议。两个原累计 quota 用例改为验证有效 ACK 和去容量门槛行为，并保留实际元数据断言。

`SystemRequestBudget` 的唯一项目入口调用与不再使用的类已移除，原测试替换为真实完整系统入口、内存邮件和 Cookie 账户集成：同一窗口 13 次媒体写与 121 次字段命令成功，未登录/撤 session 仍401，非成员/错误 Origin 仍403，错误 hash 仍400。日志 `/tmp/private-media-business-budget-result.log`。`media-policy` 显式返回 `streaming:true` 和 `deprecatedQuotaPolicy:true`，旧形状容量数字仅为安全整数表示边界。完整后端 TypeScript 检查已通过；真实桶、公网超大文件、物理断电和生产上游未验收。
