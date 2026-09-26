# 10Router 桌面版一键打包 (Windows)
# 用法:
#   cd desktop
#   .\build.ps1                  # 全自动:构建 cli/app -> npm install -> electron-builder
#   .\build.ps1 -SkipAppBuild    # 复用已有 cli/app 产物(源码没变时省一次 Next build)
#   .\build.ps1 -Proxy http://127.0.0.1:7890
#   .\build.ps1 -Flavor 20 -SkipAppBuild
#                                # 风味包:与正式版并存的独立测试壳。注入 package.json
#                                # flavor 键(main.js 据此切换 userData/数据目录/默认端口),
#                                # 独立 appId/productName/快捷方式,产物在 dist-flavor\
# 产物在 dist\:10Router-Setup-<版本>.exe(NSIS 安装包)+ 10Router-Portable-<版本>.exe

param(
    [switch]$SkipAppBuild,
    [string]$Proxy = "",
    [string]$Flavor = ""
)

$ErrorActionPreference = "Stop"
$DesktopDir = $PSScriptRoot
$RepoDir = Split-Path $DesktopDir -Parent
$CliAppDir = Join-Path $RepoDir "cli\app"

# 风味定义（新增测试风味时在此加一条）
$Flavors = @{
    "20" = @{
        id           = "20"
        label        = "2.0 Test"
        productName  = "10Router 2.0 Test"
        appId        = "com.techysy.10router20"
        dataDirName  = "10router-20"
        port         = 20130
        version      = "2.0.0-test.1"
        shortcutName = "10Router 2.0 Test"
    }
}

$F = $null
if ($Flavor -ne "") {
    if (-not $Flavors.ContainsKey($Flavor)) { throw "未知风味 '$Flavor'（已定义: $($Flavors.Keys -join ', ')）" }
    $F = $Flavors[$Flavor]
    Write-Host "== 10Router Desktop Build [风味 $($F.label)] ==" -ForegroundColor Cyan
} else {
    Write-Host "== 10Router Desktop Build ==" -ForegroundColor Cyan
}

# 0) 产物汇集:确保 cli/app(Next standalone)存在
if ($SkipAppBuild -and (Test-Path (Join-Path $CliAppDir "custom-server.js"))) {
    Write-Host "[1/3] 复用已有 cli/app($CliAppDir)"
} else {
    Write-Host "[1/3] 构建 CLI 产物(node scripts/build-cli.js,含 Next build)…"
    Push-Location $RepoDir
    try { node "cli\scripts\build-cli.js"; if ($LASTEXITCODE -ne 0) { throw "build-cli.js 失败" } }
    finally { Pop-Location }
}

# 风味包:临时改写 package.json（appId/productName/版本/风味键/产物名/输出目录），
# 打完不论成败都还原，工作树不留痕迹。
$PkgPath = Join-Path $DesktopDir "package.json"
$pkgBackup = $null
if ($F) {
    $pkgBackup = [IO.File]::ReadAllText($PkgPath)
    $pkg = $pkgBackup | ConvertFrom-Json
    $pkg | Add-Member -NotePropertyName flavor -NotePropertyValue ([pscustomobject]@{
        id          = $F.id
        label       = $F.label
        port        = $F.port
        dataDirName = $F.dataDirName
    }) -Force
    $pkg.productName = $F.productName
    $pkg.version = $F.version
    $pkg.build.productName = $F.productName
    $pkg.build.appId = $F.appId
    $pkg.build.directories.output = "dist-flavor"
    $pkg.build.nsis.shortcutName = $F.shortcutName
    $pkg.build.nsis | Add-Member -NotePropertyName artifactName -NotePropertyValue "10Router$($F.id)-Setup-`${version}.`${ext}" -Force
    $pkg.build.portable.artifactName = "10Router$($F.id)-Portable-`${version}.`${ext}"
    # 风味包不打 nsis-web（它的 appPackageUrl 指向正式 Release，串味）
    $pkg.build.win.target = @(
        [pscustomobject]@{ target = "nsis"; arch = @("x64") },
        [pscustomobject]@{ target = "portable"; arch = @("x64") }
    )
    [IO.File]::WriteAllText($PkgPath, ($pkg | ConvertTo-Json -Depth 32))
    Write-Host "[*] package.json 已注入风味 $($F.id)（appId=$($F.appId), 端口=$($F.port), 数据目录 %APPDATA%\$($F.dataDirName)）"
}

try {
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
}
finally {
    if ($pkgBackup) {
        [IO.File]::WriteAllText($PkgPath, $pkgBackup)
        Write-Host "[*] package.json 已还原"
    }
}

$OutDir = Join-Path $DesktopDir ($(if ($F) { "dist-flavor" } else { "dist" }))
Write-Host ""
Write-Host "✅ 完成,产物在 $OutDir" -ForegroundColor Green
Get-ChildItem $OutDir -File | ForEach-Object { Write-Host ("  " + $_.Name) }
