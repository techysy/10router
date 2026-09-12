# 10Router 桌面版本地测试轮（Windows）:退托盘 -> 盖测试号 -> 构建 -> 替换/安装 -> 启动 -> 验证 -> 回退版本号
#
# 用法:
#   cd desktop
#   .\test-local.ps1                            # 就地替换(默认,最快,~2 分钟)
#   .\test-local.ps1 -Mode install              # 真跑一遍安装器(静默 /S,~4 分钟)
#   .\test-local.ps1 -Version 1.1.2-test.1      # 指定测试号(默认 = 最新 tag 补丁位 +1 再挂 -test.1)
#   .\test-local.ps1 -SkipAppBuild              # 复用已有 cli/app(源码没变时省一次 Next build)
#   .\test-local.ps1 -Marker "payload_too_short"  # 额外断言装好的产物里含该字面量
#
# 三条**踩过的坑**,别简化掉(细节见 docs/zh-CN/local-build-and-verify.md):
# 1. 启动必须 Start-Process。`cmd /c start "" "路径"` 会被 Git Bash 吃掉空标题,
#    于是 exe 路径被当成**窗口标题** —— 只弹一个 cmd 窗口、应用没起来、退出码还是 0。
# 2. 安装必须**直接执行** Setup.exe。经 `cmd /c start /wait "…exe" /S` 转一手,静默安装会
#    **什么都不做**且返回 0(用 Start-Process 直接起进程就没这个问题)。
# 3. 必须清掉 ELECTRON_RUN_AS_NODE,否则 10Router.exe 以纯 Node 跑:无托盘、秒退、无日志。

param(
    [string]$Version = "",
    [ValidateSet("replace", "install")][string]$Mode = "replace",
    [switch]$SkipAppBuild,
    [switch]$NoRevert,
    [string]$Marker = ""
)

$ErrorActionPreference = "Stop"
$DesktopDir = $PSScriptRoot
$RepoDir = Split-Path $DesktopDir -Parent
$AppDir = Join-Path $RepoDir "cli\app"
$Inst = Join-Path $env:LOCALAPPDATA "Programs\10Router"
# electron-builder 产物目录放工作区外:ZCode/杀软的文件监视会抓住工作区内新写的
# app.asar 句柄,导致下一次构建清理 dist 时 "being used by another process" 而失败。
$EbOutDir = Join-Path $env:TEMP "10router-eb-out"

function Step($n, $msg) { Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)  { Write-Host "  ✓ $msg" -ForegroundColor Green }

# 停进程并**等到真的没了**再返回(只 sleep 固定秒数不够:进程退得慢时
# 下一步就会撞上被占用的目录,而「先删再拷」一旦中途失败会把安装删成半成品)。
function Stop-Router([int]$TimeoutSec = 20) {
    Get-Process 10Router -ErrorAction SilentlyContinue | ForEach-Object { $_.Kill() }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 800
        if (-not (Get-Process 10Router -ErrorAction SilentlyContinue)) { return }
    }
    Die "10Router 进程仍在(手动退出托盘后重试)"
}

# ---------- 0) 推导测试号(必须严格大于最新 git tag,否则 test-version 会拒绝) ----------
if ($Version -eq "") {
    Push-Location $RepoDir
    try { $tag = (git describe --tags --abbrev=0 --match 'v*').Trim() } finally { Pop-Location }
    if ($tag -notmatch '^v(\d+)\.(\d+)\.(\d+)$') {
        Die "最新 tag '$tag' 不是 vX.Y.Z 形态,请用 -Version 显式指定测试号"
    }
    $Version = "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)-test.1"
}
Step 0 "测试号 $Version  模式 $Mode  $(if ($SkipAppBuild) { '(复用 cli/app)' })"

# ---------- 1) 停掉旧实例(不先停:文件被占用 / 端口被旧 sidecar 占着) ----------
Step 1 "停掉旧实例"
Stop-Router
Ok "已清空"

# ---------- 2) 盖测试号 ----------
Step 2 "盖测试版本号"
Push-Location $RepoDir
try {
    npm run test-version $Version
    if ($LASTEXITCODE -ne 0) { Die "test-version 失败(测试号必须严格大于最新 git tag)" }
} finally { Pop-Location }

try {
    # ---------- 3) 构建 cli/app(桌面包用 extraResources 直接引用它) ----------
    if ($SkipAppBuild -and (Test-Path (Join-Path $AppDir "custom-server.js"))) {
        Step 3 "复用已有 cli/app"
        Ok $AppDir
    } else {
        Step 3 "构建 cli/app(node cli/scripts/build-cli.js,含 Next build)"
        Push-Location $RepoDir
        try {
            node "cli\scripts\build-cli.js"
            if ($LASTEXITCODE -ne 0) { Die "build-cli.js 失败" }
        } finally { Pop-Location }
        Ok $AppDir
    }

    # ---------- 4) 打包 ----------
    $sw = [Diagnostics.Stopwatch]::StartNew()
    if ($Mode -eq "replace") {
        Step 4 "electron-builder --win --dir"
        Push-Location $DesktopDir
        try {
            npx electron-builder --win --dir "-c.directories.output=$EbOutDir"
            if ($LASTEXITCODE -ne 0) { Die "electron-builder 失败" }
        } finally { Pop-Location }
        $unpacked = Join-Path $EbOutDir "win-unpacked"

        # ---------- 5a) 就地替换(重命名式交换:失败不留半成品) ----------
        Step 5 "就地替换 resources\(app + app.asar)"
        if (-not (Test-Path $Inst)) { Die "未找到已安装的 10Router:$Inst(先跑一次 Setup 装一遍)" }

        # 先校验新产物完整,再碰线上安装 —— 否则会把好的换成坏的
        $srcApp = Join-Path $unpacked "resources\app"
        $srcAsar = Join-Path $unpacked "resources\app.asar"
        foreach ($f in @("package.json", "custom-server.js", ".next-cli-build")) {
            if (-not (Test-Path (Join-Path $srcApp $f))) { Die "产物不完整:缺 $f(先跑一次 build-cli.js)" }
        }

        Stop-Router    # 构建那几十秒里,开机自启/手动点击都可能把应用又拉起来
        $live = Join-Path $Inst "resources"
        $oldApp = Join-Path $live "app.old"
        $oldAsar = Join-Path $live "app.asar.old"
        Remove-Item $oldApp, $oldAsar -Recurse -Force -ErrorAction SilentlyContinue

        # 用**重命名**做交换:目录里有进程占用时 Rename 会直接失败,什么都不会被删掉。
        # (早先的 `Remove-Item -Recurse -Force` 就是这么把安装删成空目录的:应用正在跑,
        #  它能删的先删掉、删不掉的报错返回 —— 结果线上安装只剩一个半成品。)
        try {
            Rename-Item (Join-Path $live "app") $oldApp -ErrorAction Stop
            Rename-Item (Join-Path $live "app.asar") $oldAsar -ErrorAction Stop
            Copy-Item $srcApp (Join-Path $live "app") -Recurse -Force -ErrorAction Stop
            Copy-Item $srcAsar (Join-Path $live "app.asar") -Force -ErrorAction Stop
        } catch {
            if (Test-Path $oldApp) {
                Remove-Item (Join-Path $live "app") -Recurse -Force -ErrorAction SilentlyContinue
                Rename-Item $oldApp (Join-Path $live "app") -ErrorAction SilentlyContinue
            }
            if (Test-Path $oldAsar) { Rename-Item $oldAsar (Join-Path $live "app.asar") -Force -ErrorAction SilentlyContinue }
            Die "替换失败(应用还在运行?),已回滚:$($_.Exception.Message)"
        }
        Remove-Item $oldApp, $oldAsar -Recurse -Force -ErrorAction SilentlyContinue
        Ok "app + app.asar 已换(保留安装器的 elevate.exe)"
    } else {
        Step 4 "electron-builder --win nsis --x64(只打安装包一档)"
        Push-Location $DesktopDir
        try {
            npx electron-builder --win nsis --x64 "-c.directories.output=$EbOutDir"
            if ($LASTEXITCODE -ne 0) { Die "electron-builder 失败" }
        } finally { Pop-Location }
        $setup = Get-ChildItem $EbOutDir -Filter "10Router Setup *.exe" |
                 Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $setup) { Die "没找到 $EbOutDir\10Router Setup *.exe" }

        # ---------- 5b) 静默安装:**直接**起进程,/S 才有效 ----------
        Step 5 "静默安装 $($setup.Name)(直接执行,/S)"
        $p = Start-Process -FilePath $setup.FullName -ArgumentList "/S" -Wait -PassThru
        if ($p.ExitCode -ne 0) { Die "安装器退出码 $($p.ExitCode)" }
        Ok "安装完成(静默模式不会自动拉起应用)"
    }
    $sw.Stop()
    Ok "打包+部署耗时 $([int]$sw.Elapsed.TotalSeconds) 秒"

    # ---------- 6) 启动 ----------
    Step 6 "启动"
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 坑 3
    Start-Process -FilePath (Join-Path $Inst "10Router.exe")               # 坑 1
    $procs = 0
    foreach ($i in 1..20) {
        Start-Sleep -Seconds 2
        $procs = @(Get-Process 10Router -ErrorAction SilentlyContinue).Count
        if ($procs -gt 0) { break }
    }
    if ($procs -eq 0) { Die "启动后没有 10Router 进程 —— 先看 %APPDATA%\10router-desktop\logs\tray.log" }
    Ok "$procs 个进程"

    # ---------- 7) 验证(装没装对 / 服务活没活) ----------
    Step 7 "验证"
    $pkg = Join-Path $Inst "resources\app\package.json"
    $installed = (Get-Content $pkg -Raw | ConvertFrom-Json).version
    if ($installed -ne $Version) { Die "产物版本是 $installed,期望 $Version(安装/替换没生效?)" }
    Ok "产物版本 $installed"

    $health = $null
    foreach ($i in 1..15) {
        try { $health = Invoke-RestMethod "http://127.0.0.1:20128/api/health" -TimeoutSec 5; break } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $health.ok) { Die "20128 /api/health 没通(旧实例还占着端口?看 server.log)" }
    Ok "20128 /api/health -> ok"

    if ($Marker -ne "") {
        $roots = @((Join-Path $Inst "resources\app\.next-cli-build"), (Join-Path $Inst "resources\app\src"))
        $hit = Get-ChildItem $roots -Recurse -File -ErrorAction SilentlyContinue |
               Select-String -Pattern $Marker -SimpleMatch -List | Select-Object -First 1
        if (-not $hit) { Die "产物里找不到标记 '$Marker'(代码没进去?注意产物目录是 .next-cli-build)" }
        Ok "标记命中: $($hit.Path)"
    }
}
finally {
    # ---------- 8) 回退测试号(永远执行,除非 -NoRevert) ----------
    if (-not $NoRevert) {
        Step 8 "回退测试版本号"
        Push-Location $RepoDir
        try {
            npm run test-version -- --revert
            # 干净树时 porcelain 输出为空,PS5.1 里是 $null —— 直接 .Trim() 会炸掉 finally
            $dirty = (git status --porcelain | Out-String).Trim()
            if ($dirty -ne "") { Write-Host "  ! 工作区非空,提交前先看: $dirty" -ForegroundColor Yellow }
        } finally { Pop-Location }
    } else {
        Step 8 "保留测试号(-NoRevert)"
    }
}

Write-Host ""
Write-Host "✅ 本地测试轮完成:$Version 已装好并跑起来" -ForegroundColor Green
