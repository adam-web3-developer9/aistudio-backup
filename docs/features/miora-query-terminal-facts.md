# Miora 查询错误与真实终态（2026-10-15）

AIStudio/Hailuo联合调查已定位：任务已提交后，`/media-generate/progress` 返回10005积分拒绝，被按提交失败转为网关failed；客户端据此清原ID。另有COS UserNetworkTooSlow未进入既有有限重试。用户已授权修复。

## 职责与契约

Miora适配器解释渠道事实。仅进度接口10005是查询受阻：原账号、原taskId按既有退避继续查询，直到现有预算结束；提交积分不足和任务真实failed不改变分类。所有任务状态、次数与最长等待仍复用现有机制。

错误公开事实`providerTerminal`区分网关执行失败与上游任务真正失败：查询错误/超时为false，真实任务终态为true。没有明确上游终态的失败保留progress.providerJobId。客户端保存并按此决定续查或新执行。

客户端请求原网关任务时，只有已归属该key、有原上游ID且错误明确非终态的失败任务能认领原ID查询。使用JobRunner共享executing单飞，非阻塞返回当前状态；不调用生成提交、不换账号。原有system显式resumeRecorded语义继续保留。旧记录只有精确已知progress10005能识别为查询受阻，不推断任意历史余额错误。

生成失败原文不直接公开。已确认`system error, MiniMax-H3 context ir (status_code=2000)`只映射白名单固定说明；原文仍保留后台。凭据、提示词、账号和媒体路径不进入公开错误。

COS仍源流直接PUT；只将精确XML UserNetworkTooSlow加入既有RequestTimeout有限重试集合。其余400维持明确失败，不增加临时文件中转或大小配额。

## 验证与交付边界

定向验证progress10005后成功只提交一次、查询预算/真实终态区别、原ID恢复单飞及权限边界、白名单说明不泄露原文；COS只验证慢速恢复/耗尽和普通400不重试。全量测试不作为本轮要求。

源码通过与线上激活分别核对，部署通过现有main发布机制。历史真实终态和生产任务不由代码发布自动批量重跑。

## 实施与定向验证

- `MioraClient`仅对progress10005持续退避到本轮deadline；其余请求错误继续原分类。`ProviderFailure/ProviderJobError`保存显式终态事实，通用JobError不猜测默认值。
- 网关公开false只限合法上游ID已存在；无ID提交拒绝不带该字段，允许客户端明确失败后手动开启新执行。
- `resumeGatewayQuery`经过执行权限和账号闸门，两次核对记录并共用executing单飞；旧10005按准确原文识别。GET返回后后台仅原账号续查，不新提交。
- 精确context ir原文映射固定安全说明，任意含2000或私密原文不公开。
- COS新增精确UserNetworkTooSlow重试，仍有限且直接流式。

验证：Miora查询、恢复单飞、原积分拒绝与安全投影6项定向用例通过；公开契约无ID边界修正后仅复跑直接受影响2项并通过；COS定向4项通过。`npm run build`（TypeScript编译）与差异检查通过。未使用真实生成验证。
