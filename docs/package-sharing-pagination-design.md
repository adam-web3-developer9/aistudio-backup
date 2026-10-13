# 共享清单分窗与兼容设计（2026-10-13）

当前基线 `main@f605e2a`，仅在 `fix/remove-artificial-transfer-caps-20261013` 实施。用户授权去除人工业务大小与数量拒绝；保留账户/成员ACL、哈希、稳定身份、请求内容绑定和原子可见性。总架构沿 V1 数据归属、V2 幂等事务、V4 凭据边界、V5 显式失败及第8章数据/媒体/任务概念；本模块仍只管理元数据，不抓用户URL、不持有桶密钥、不执行生成。

新客户端显式用 `?format=manifest-v2`：共享列表按shareId游标、版本按sequence倒序游标；详情/latest/receipt/发布回执仅摘要，附mediaCount/mediaDigest，完整媒体另页获取。媒体位置从0起，after是下一位置，nextAfter=after+items.length，complete仅在nextAfter等于总数时成立。digest为SHA256依次更新 `JSON.stringify({sha256,size,mime,kind})+'\n'`，不含URL或position。每页可控制内存窗口但不限制总量，客户端持续取完并校验顺序/数量/摘要与快照闭包。

manifest媒体规范存 `package_share_version_media`，版本index保存count/digest。分窗结束以SQL检查完整位置、重复内容身份及媒体就绪，SQLite同一IMMEDIATE事务写版本/媒体/index/提交回执及删除stage。digest逐行处理，不构造完整媒体数组、Set或mediaJson。旧mediaJson保留并首次读取时由SQLite json_each惰性迁入，事务index标记使启动不扫描、失败可重放。

大scope可用scopeTransfer:{bytes,sha256,chunks}替代scope；JSON文本按UTF8片段连续登记，字节/摘要/JSON结构与范围约束完整后提交。新摘要返回scope:null及scope分页索引，客户端逐页恢复并核验原scope。普通小scope及旧stage仍兼容。片段预算属于传输窗口，不是草稿总量限制。

默认无format的旧客户端仍收到原media数组和scope；后端以Readable逐行输出JSON，不把完整媒体清单转为JS数组/Buffer。旧客户端自身20MiB响应拒绝仍需升级，不能宣称旧版本也支持任意规模。旧ZIP及私有历史不伪造成manifest；旧数据库表不DROP。server使用旧代码直接读取新行表版本不受支持，部署回退必须保留本协议服务或按备份恢复，不能把mediaJson占位视作完整清单。

验证仅最少定向：真实Fastify+临时SQLite，分窗原子可见/内容绑定与重复commit、v2分页顺序/count/digest/ACL、旧JSON媒体迁移与默认流式兼容、大scope跨窗及损坏拒绝。保留既有测试；不生产桶/真实用户数据/付费生成/部署/Actions，不全suite。实际网络/物理客户端大规模性能不以隔离用例冒充验收。
