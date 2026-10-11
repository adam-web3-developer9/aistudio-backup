# 本地账户、管理后台与共享验收

以下命令在后端仓库 `aistudio-backup` 根目录运行。只使用本机新建的临时测试目录、`.invalid` / `.test` 邮箱和测试密码，不需要 SMTP。此入口拒绝 `NODE_ENV=production`，必须显式设置 `SYSTEM_LOCAL_TEST=1`，只能绑定 `127.0.0.1`。渠道工作器始终关闭，不读取已有渠道账户、不启动浏览器、不调用上游生成。

## 1. 安装并构建后台页面

使用 Node.js 24 和仓库指定 pnpm 版本：

```bash
pnpm install --frozen-lockfile
npm --prefix apps/admin ci
npm --prefix apps/admin run build
```

管理页面将由系统服务在同一 origin 的 `/admin/` 提供，手工验收不需要额外启动 Vite，也不需要设置跨域可信列表。端口默认 `3001`；若该端口已被占用，设置 `SYSTEM_LOCAL_TEST_PORT`，客户端与后续 URL 一并使用该端口。

## 2. 新建测试目录并启动

```bash
export LOCAL_TEST_DIR="$(mktemp -d /tmp/aistudio-local-acceptance.XXXXXX)"
export SYSTEM_LOCAL_TEST=1
export SYSTEM_LOCAL_TEST_DIRECTORY="$LOCAL_TEST_DIR"
export SYSTEM_LOCAL_TEST_PORT=3001
node --import tsx scripts/system-local-dev.mjs
```

保持此终端运行。启动输出只有页面地址、测试目录和私密访问文件路径，不打印 Cookie、邮箱验证链接、重置链接或访问标记。服务地址为 `http://127.0.0.1:3001`，后台为 `http://127.0.0.1:3001/admin/`。

测试目录必须是全新、空的 `/tmp/aistudio-local-acceptance-*` 或 `/tmp/aistudio-local-acceptance.*` 目录。入口拒绝复用现有数据库，也不会读取项目 `data/` 或用户数据目录。SQLite、私有媒体与随机邮箱访问标记都在该临时目录；`local-test-access.json` 权限为 `0600`。停止后保留目录供检查；重新启动需另建新目录，当前测试会话与随机密钥不会沿用。

## 3. 普通注册并查看假邮箱

另开终端，进入同一后端仓库，把下方目录替换为启动终端打印的实际目录：

```bash
export LOCAL_TEST_DIR=/tmp/aistudio-local-acceptance.实际后缀
curl --fail --silent --show-error \
  -H 'Origin: http://127.0.0.1:3001' \
  -H 'Content-Type: application/json' \
  --data '{"email":"admin@example.invalid","name":"本地验收管理员","password":"Local-Acceptance-Password-Only"}' \
  http://127.0.0.1:3001/api/auth/sign-up/email
```

密码仅用于当前本地测试，可以自行更换为至少 12 字符的测试密码。普通注册不会产生管理员角色、激活资格或共享白名单。未验证邮箱时登录会被拒绝。

读取该测试邮箱的验证链接：

```bash
export LOCAL_TEST_MARKER="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).marker)' "$LOCAL_TEST_DIR/local-test-access.json")"
curl --fail --silent --show-error \
  -H "x-local-test-marker: $LOCAL_TEST_MARKER" \
  'http://127.0.0.1:3001/__local-test/mailbox?email=admin@example.invalid'
```

响应 `data[0].url` 是仅存于测试发件箱的验证链接。复制到本机浏览器打开；看到验证提示后即可登录。该只读邮箱接口要求本机连接和私密随机标记，拒绝外部 Origin、非 loopback Host、真实邮箱及无标记请求；每次最多返回最新 20 条，每类测试邮件最多保留 100 条。重置邮件用同样接口加 `&kind=reset`。不要把测试目录、访问标记或链接分享到网络。

## 4. 离线授予首个管理员

必须先完成步骤 3 的普通注册和邮箱验证，再在后端仓库运行：

```bash
node --import tsx scripts/bootstrap-admin.mjs \
  --database "$LOCAL_TEST_DIR/system.sqlite" \
  --email admin@example.invalid \
  --confirm GRANT_FIRST_SUPERADMIN
```

这是显式离线操作：只授权既有、已验证且未禁用的账户；数据库已有 superadmin 后拒绝再次首次授权。不创建用户、不设置密码、不发送邮件，也不会激活账户。没有公开 bootstrap HTTP 接口。授权后已存在的该账户会话被撤销，需要重新登录。

## 5. 在管理 UI 创建激活码与共享白名单

1. 打开 `http://127.0.0.1:3001/admin/`，用 `admin@example.invalid` 和步骤 3 的密码登录。
2. 在“激活码”页创建一个码，默认有效期 `365` 天；兑换截止时间可留空。完整代码只在创建结果中显示一次，复制后关闭弹窗，列表不会再次显示完整代码。
3. 在“账户”页确认刚创建的管理员仍未激活，证明管理员授权没有绕过激活流程。
4. 在客户端正常注册 `user@example.invalid`，用步骤 3 的假邮箱查询方法验证该地址，再登录并兑换刚复制的激活码。
5. 在后台账户列表找到 `user@example.invalid`，显式开启“共享资格”。激活只授予账户有效期，默认不会自动开启共享资格。
6. 客户端刷新账户状态，应看到已激活及共享资格。共享草稿仍需客户端显式开启并按邮箱添加成员；成员先正常注册、验证、激活并加入共享资格白名单。

可以创建已验证的 `operator@example.invalid`、`readonly@example.invalid`，再由 superadmin 在“管理员”页授权对应角色，检查 readonly 写入拒绝、operator 无法升权及未加入项目时无法读取私有草稿正文。不要导入真实渠道凭据；此入口即使导入假渠道数据，也不会验证远端会话或执行真实生成。

## 6. 客户端账户服务地址

启动配套 `aistudio` 客户端，打开账户入口中的“账户服务地址”，保存：

```text
http://127.0.0.1:3001
```

入口处于未激活账户壳时也能修改地址。请使用 `127.0.0.1` 并保持端口一致。客户端主进程维护 HttpOnly Cookie，renderer 只接收安全身份与资格信息；服务端会话凭据不会出现在认证 JSON 响应中。若电脑上已有常用账户，不要覆盖其常用测试以外的配置或数据；使用独立客户端测试资料目录完成验收。

## 7. 停止与清理

在启动终端按 `Ctrl+C`，等待进程关闭。先关闭仍连接该测试服务的客户端，然后确认要删除的是本轮打印的临时目录：

```bash
case "$LOCAL_TEST_DIR" in
  /tmp/aistudio-local-acceptance-*|/tmp/aistudio-local-acceptance.*)
    rm -rf -- "$LOCAL_TEST_DIR"
    ;;
  *) echo '拒绝清理：路径不是专用本地验收目录' ;;
esac
unset LOCAL_TEST_MARKER SYSTEM_LOCAL_TEST SYSTEM_LOCAL_TEST_DIRECTORY SYSTEM_LOCAL_TEST_PORT LOCAL_TEST_DIR
```

此清理只删除指定临时测试库、私有媒体与假邮箱访问文件，不删除仓库 `data/`、客户端常用资料、生产账户或生产凭据。生产部署继续使用正常系统入口、HTTPS、SMTP、明确的代理信任配置与受控首管理员流程；本地测试邮箱接口不属于正常入口。

自动验证：`pnpm exec vitest run src/system/local-dev.test.ts`，覆盖 SMTP 配置缺失拒绝、生产测试模式拒绝、显式开关、全新目录、邮箱访问保护、真实邮箱拒绝，以及普通注册→验证→离线授予管理员→创建兑换激活码→显式共享资格闭环。
