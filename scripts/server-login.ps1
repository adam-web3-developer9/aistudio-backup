param(
  [string]$ServerHost = $(if ($env:AISTUDIO_SERVER_HOST) { $env:AISTUDIO_SERVER_HOST } else { '43.156.237.133' }),
  [string]$User = $(if ($env:AISTUDIO_SERVER_USER) { $env:AISTUDIO_SERVER_USER } else { 'root' }),
  [int]$Port = $(if ($env:AISTUDIO_SERVER_PORT) { [int]$env:AISTUDIO_SERVER_PORT } else { 40543 }),
  [string]$KeyPath = $env:AISTUDIO_SERVER_KEY,
  [string]$Command = '',
  [string]$CommandFile = '',
  [int]$ConnectionCacheMinutes = 15,
  [switch]$DisableConnectionCache,
  [switch]$CloseCachedConnection,
  [switch]$VerboseSsh
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($ServerHost)) {
  throw '服务器地址不能为空。请使用 -ServerHost 或 AISTUDIO_SERVER_HOST。'
}

if ([string]::IsNullOrWhiteSpace($User)) {
  throw 'SSH 用户名不能为空。请使用 -User 或 AISTUDIO_SERVER_USER。'
}

if ($Port -lt 1 -or $Port -gt 65535) {
  throw "SSH 端口无效：$Port"
}

$ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
if (-not $ssh) {
  throw '未找到 ssh.exe。请在 Windows“可选功能”中安装 OpenSSH 客户端。'
}

$sshArgs = @(
  '-p', [string]$Port,
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ConnectTimeout=15',
  '-o', 'StrictHostKeyChecking=accept-new'
)

$controlPath = ''
if (-not $DisableConnectionCache) {
  $controlDirectory = Join-Path $HOME '.ssh'
  if (-not (Test-Path -LiteralPath $controlDirectory)) {
    New-Item -ItemType Directory -Path $controlDirectory -Force | Out-Null
  }
  $safeHost = ($ServerHost -replace '[^a-zA-Z0-9.-]', '_')
  $safeUser = ($User -replace '[^a-zA-Z0-9.-]', '_')
  $controlPath = (Join-Path $controlDirectory "aistudio-$safeUser-$safeHost-$Port.sock").Replace('\', '/')
  $cacheSeconds = [Math]::Max(60, $ConnectionCacheMinutes * 60)
  $sshArgs += @(
    '-o', 'ControlMaster=auto',
    '-o', "ControlPersist=$cacheSeconds",
    '-o', "ControlPath=$controlPath"
  )
}

if ($VerboseSsh) {
  $sshArgs += '-v'
}

if (-not [string]::IsNullOrWhiteSpace($KeyPath)) {
  $resolvedKey = (Resolve-Path -LiteralPath $KeyPath).Path
  $sshArgs += @('-i', $resolvedKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes')
}

$target = "$User@$ServerHost"

if ($CloseCachedConnection) {
  if ($DisableConnectionCache) {
    throw '-CloseCachedConnection 不能与 -DisableConnectionCache 同时使用。'
  }
  Write-Host "正在关闭 $target 的SSH缓存连接..." -ForegroundColor Cyan
  & $ssh.Source @sshArgs '-O' 'exit' $target
  exit $LASTEXITCODE
}

$sshArgs += $target

if (-not [string]::IsNullOrWhiteSpace($CommandFile)) {
  $resolvedCommandFile = (Resolve-Path -LiteralPath $CommandFile).Path
  $sshArgs += @('bash', '-s', '--')
} elseif (-not [string]::IsNullOrWhiteSpace($Command)) {
  $sshArgs += $Command
}

Write-Host "正在连接 $target`:$Port ..." -ForegroundColor Cyan
if ([string]::IsNullOrWhiteSpace($KeyPath)) {
  Write-Host '未指定私钥，将由 SSH 交互式询问密码或使用系统 SSH Agent。' -ForegroundColor DarkGray
}

if (-not [string]::IsNullOrWhiteSpace($CommandFile)) {
  (Get-Content -LiteralPath $resolvedCommandFile -Raw).Replace("`r`n", "`n") | & $ssh.Source @sshArgs
} else {
  & $ssh.Source @sshArgs
}
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
  throw "SSH 连接结束，退出码：$exitCode"
}
