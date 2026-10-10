# 10Router 桌面版一键打包 (Windows)
# 用法:
#   cd desktop
#   .\build.ps1                  # 全自动:构建 cli/app -> npm install -> electron-builder
#   .\build.ps1 -SkipAppBuild    # 复用已有 cli/app 产物(源码没变时省一次 Next build)
#   .\build.ps1 -Proxy http://127.0.0.1:7890
# 产物在 dist\:10Router-Win-Setup-<版本>.exe(NSIS 安装包)+ 10Router-Win-Portable-<版本>.exe

param(
    [switch]$SkipAppBuild,
    [string]$Proxy = ""
)

$ErrorActionPreference = "Stop"
$DesktopDir = $PSScriptRoot
$RepoDir = Split-Path $DesktopDir -Parent
$CliAppDir = Join-Path $RepoDir "cli\app"

Write-Host "== 10Router Desktop Build ==" -ForegroundColor Cyan

# 0) 产物汇集:确保 cli/app(Next standalone)存在
if ($SkipAppBuild -and (Test-Path (Join-Path $CliAppDir "custom-server.js"))) {
    Write-Host "[1/3] 复用已有 cli/app($CliAppDir)"
} else {
    Write-Host "[1/3] 构建 CLI 产物(node scripts/build-cli.js,含 Next build)…"
    Push-Location $RepoDir
    try { node "cli\scripts\build-cli.js"; if ($LASTEXITCODE -ne 0) { throw "build-cli.js 失败" } }
    finally { Pop-Location }
}

# 1) 依赖安装(Electron 二进制走 npmmirror;npm 本身走用户当前 registry)
Write-Host "[2/3] npm install (desktop)…"
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
if ($Proxy -ne "") {
    $env:HTTPS_PROXY = $Proxy
    $env:HTTP_PROXY = $Proxy
}
Push-Location $DesktopDir
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败(如提示 install-scripts 被拦,执行: npm install-scripts approve electron)" }

    # 2) electron-builder 打包
    Write-Host "[3/3] electron-builder --win…"
    npx electron-builder --win
    if ($LASTEXITCODE -ne 0) { throw "electron-builder 失败" }
}
finally { Pop-Location }

Write-Host ""
Write-Host "✅ 完成,产物在 $DesktopDir\dist\" -ForegroundColor Green
Get-ChildItem (Join-Path $DesktopDir "dist") -File | ForEach-Object { Write-Host ("  " + $_.Name) }
