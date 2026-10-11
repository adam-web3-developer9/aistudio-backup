# AI Studio 管理后台

Refine Core 5 + Ant Design 6 + React 19 + Vite 8 的独立管理应用。`src/providers.ts` 是直接调用 Better Auth 服务的薄 AuthProvider，以及管理 REST API 的 DataProvider；没有声称使用官方 Better Auth 适配器。

## 本地运行

```bash
cd apps/admin
npm ci
ADMIN_API_TARGET=http://127.0.0.1:3001 npm run dev
```

入口：`http://127.0.0.1:5174/admin/`。`ADMIN_API_TARGET` 应指向已启用 system API 的服务器，实际端口取决于服务配置。Vite 将 `/api/*` 代理到此地址。服务器必须把前端实际 origin 加入其可信 origin 配置，且前后端本地 hostname 保持一致，否则 Cookie/Origin 校验会失败。

```bash
npm run build
npm run preview
```

`dist/` 应部署在 `/admin/` 下，生产反向代理将 `/api/auth/*`、`/api/admin/*`、`/api/system/*` 转发给系统服务。生产 Cookie 安全、域名、可信 Origin、SMTP 与初始超级管理员配置属于服务器部署步骤；页面不会把未完成的配置显示为成功。

## 可用功能与权限

- 登录邮箱/密码；服务端 `/api/admin/me` 确认管理身份。客户端不保存会话 token/角色，不提供管理员注册或客户端提升角色入口。
- 账户列表、禁用/启用、撤销会话、共享资格白名单。
- 激活码查询、批量创建、撤销。默认激活 365 天；`redeemBefore` 独立设置。完整代码只保存在创建成功弹窗的内存状态，关闭销毁。
- 管理员权限授予/更新/移除，仅超级管理员可见；已有账户 ID 作为目标。
- 共享项目脱敏元数据及成员 ACL；只有 API 返回 `canManageMembers` 才允许撤销成员或将 editor 降为 viewer；不提供新增/提权入口，新增或提权必须由项目所有者在正常共享白名单中完成，所有操作再次由服务端授权，不能修改 owner。
- 系统任务脱敏状态，不请求任意项目正文、任务输入/输出或私有媒体。
- Miora 渠道账户脱敏列表；仅超级管理员导入/更新凭据、停用/启用、归档/恢复。支持选择本地 .json/.txt 文件（最大512 KiB）填入临时文本框，须手动确认才提交；输入仅存在表单内存，提交/失败/关闭清空，不写 localStorage/sessionStorage。可查看该账户关联任务的脱敏状态、结果是否存在和错误类型；格式与解密检查不代表渠道有效；明确显示远端会话未验证，导入不自动验证上游或生成真实任务。
- 审计列表、查询、分页、明确加载/错误/空态和操作结果。只读角色禁用所有写入操作；服务端仍是最终授权边界。

## API 依赖

所有请求 `credentials: include`，不依赖公共渠道 API key。列表 `GET /api/admin/{resource}?page=1&pageSize=20&q=...` 返回 `{data,total}`；错误 `{code,message}`。资源 `users`、`sharing-whitelist`、`activation-codes`、`admins`、`projects`、`system-jobs`、`channels/accounts`、`audit`。

认证：`POST /api/auth/sign-in/email` `{email,password}`，`POST /api/auth/sign-out`，`GET /api/admin/me` `{id,email,name,role}`；`GET /api/admin/channels/accounts/:id/jobs` `{data,total}` 返回关联任务脱敏元数据。

写入：`PATCH users/:id` `{disabled|sharingEligible}`；`POST users/:id/revoke-sessions`；`POST activation-codes` `{count,validityDays,redeemBefore,note}`；`POST activation-codes/:id/revoke`；`PUT admins/:id` `{role}` / `DELETE admins/:id`；`PUT projects/:projectId/members/:userId` `{role:viewer}（只允许 editor 降权）` / `DELETE`；`POST channels/accounts/miora/import` `{credentials,label?}`；`PATCH channels/accounts/:id` `{credentials?,label?,enabled?}`；`DELETE channels/accounts/:id`；`POST channels/accounts/:id/restore`。

渠道只使用脱敏字段：`id/provider/label/emailMasked/enabled/archivedAt/updatedAt/credentialExpiresAt/validationStatus/localCredentialStatus/remoteValidationPerformed/lastErrorCode`。项目列表只使用 `projectId/ownerId/shared/revision/members/canManageMembers`。

## 验证

```bash
npx playwright install chromium
npm test
# 已有本机 Chromium 时：
ADMIN_TEST_BROWSER=/usr/bin/chromium npm test
```

UI 测试拦截所有 `/api/**` 请求，使用内存假 API；不会发送真实邮件、调用真实渠道或启动生产服务。覆盖登录/撤销会话、角色限制、默认激活期限/一次性明文、假凭据清空/不持久化、成员 ACL 以及 API 失败提示。截图写到 `evidence/operator-codes.png`。

真实组合服务的集成 E2E（需要仓库根依赖已经安装）：

```bash
ADMIN_TEST_BROWSER=/usr/bin/chromium npm run test:integration
```

此测试构建生产静态页面，通过 `buildSystemWebApp` 在 `127.0.0.1:5277` 临时启动真实身份/管理/项目/任务/渠道组合服务，使用每次独立的 `/tmp` SQLite、私有媒体目录、假凭据加密密钥和 `MemorySystemMailer`。真实注册与内存邮箱验证后，仅 fixture 角色和激活资格通过隔离数据库赋予；测试使用浏览器真实 Cookie，没有 API 拦截。

覆盖真实登录/HttpOnly Cookie、365 天激活码创建/一次性显示/兑换、项目成员降权及管理员正文 ACL 拒绝、假渠道格式拒绝/加密持久化/未知远端验证/恢复归档、readonly 服务端拒写、operator 未加入项目时正文拒读，以及审计不泄漏假凭据。`channelsEnabled:false` 禁止真实上游执行，不发送外部邮件。测试服务结束时关闭并删除临时数据。真实服务截图位于 `evidence/real-project-acl.png`、`evidence/real-channel-unknown.png`。
