# 服务器登录脚本

脚本不会保存服务器密码，默认连接服务器 `43.156.237.133:40543`。

脚本默认启用SSH连接复用。第一次连接完成后，后续命令会在15分钟内复用同一条SSH连接，避免重复握手和认证。

## 密码登录

```powershell
rtk pwsh -ExecutionPolicy Bypass -File .\scripts\server-login.ps1 -User root
```

SSH 会在终端中交互式询问密码。

## 私钥登录

```powershell
rtk pwsh -ExecutionPolicy Bypass -File .\scripts\server-login.ps1 `
  -User root `
  -KeyPath "$HOME\.ssh\id_ed25519"
```

## 自定义服务器和端口

```powershell
rtk pwsh -ExecutionPolicy Bypass -File .\scripts\server-login.ps1 `
  -ServerHost 43.156.237.133 `
  -User root `
  -Port 40543
```

## 执行单条只读诊断命令

```powershell
rtk pwsh -ExecutionPolicy Bypass -File .\scripts\server-login.ps1 `
  -User root `
  -Command "hostname; uptime; free -h; df -h"
```

也可以使用环境变量保存非敏感连接信息：

```powershell
$env:AISTUDIO_SERVER_HOST = '43.156.237.133'
$env:AISTUDIO_SERVER_USER = 'root'
$env:AISTUDIO_SERVER_PORT = '40543'
$env:AISTUDIO_SERVER_KEY = "$HOME\.ssh\id_ed25519"
```

不要把密码、私钥内容或包含密钥的 `.env` 文件提交到仓库。

## 关闭缓存连接

```powershell
rtk pwsh -ExecutionPolicy Bypass -File .\scripts\server-login.ps1 `
  -KeyPath "C:\Users\adam\Downloads\43.156.237.133_id_ed25519" `
  -CloseCachedConnection
```

如需禁用复用，可增加 `-DisableConnectionCache`。
