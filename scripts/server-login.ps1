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
  throw 'Server host is required. Use -ServerHost or AISTUDIO_SERVER_HOST.'
}

if ([string]::IsNullOrWhiteSpace($User)) {
  throw 'SSH user is required. Use -User or AISTUDIO_SERVER_USER.'
}

if ($Port -lt 1 -or $Port -gt 65535) {
  throw "Invalid SSH port: $Port"
}

$ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
if (-not $ssh) {
  throw 'ssh.exe was not found. Install the Windows OpenSSH Client optional feature.'
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
    throw '-CloseCachedConnection cannot be used with -DisableConnectionCache.'
  }
  Write-Host "Closing cached SSH connection for $target..." -ForegroundColor Cyan
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

Write-Host "Connecting to $target`:$Port ..." -ForegroundColor Cyan
if ([string]::IsNullOrWhiteSpace($KeyPath)) {
  Write-Host 'No private key was specified; SSH will use the agent or request a password.' -ForegroundColor DarkGray
}

if (-not [string]::IsNullOrWhiteSpace($CommandFile)) {
  (Get-Content -LiteralPath $resolvedCommandFile -Raw).Replace("`r`n", "`n") | & $ssh.Source @sshArgs
} else {
  & $ssh.Source @sshArgs
}
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
  throw "SSH exited with code $exitCode"
}
