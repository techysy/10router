# 10Router 桌面版本地测试轮（Windows）:退托盘 -> 盖测试号 -> 构建 -> 替换/安装 -> 启动 -> 验证 -> 回退版本号
#
# 用法:
#   cd desktop
#   .\test-local.ps1                            # 就地替换(默认,最稳,~2 分钟)
#   .\test-local.ps1 -Mode ui                   # 只改过 public/** 时用:不构建、不重启,拷完刷新页面即生效
#   .\test-local.ps1 -Mode hot                  # 只同步 .next-cli-build + public 后重启(应用侧改动,不重打电子包)
#   .\test-local.ps1 -Mode install              # 真跑一遍安装器(静默 /S,~4 分钟)
#   .\test-local.ps1 -Version 1.1.4             # 指定测试号(默认 = 最新 tag 补丁位 +1,再接递增轮次 -test.N)
#   .\test-local.ps1 -SkipAppBuild              # 复用已有 cli/app(源码没变时省一次 Next build)
#   .\test-local.ps1 -Marker "payload_too_short"  # 额外断言装好的产物里含该字面量
#
# 模式怎么选(别一上来就 replace):
#   只改 public/** 且不在乎版本号 → -Mode ui   (不构建、不重启:静态文件按请求读盘,拷完刷新即可)
#   改 src/** 或 open-sse/**     → -Mode hot  (构建 + 只同步 .next-cli-build/public + 重启)
#   改 desktop/** 主进程或依赖   → -Mode replace(hot/ui 不会更新 app.asar / node_modules)
#   想真跑一遍安装器            → -Mode install
#
# 为什么这步不由脚本自动判断「该刷新还是该重启」:界面版本号是**构建期**从 package.json
# 烘焙进 bundle 的(src/shared/constants/config.js 里是静态 json import),所以只要你想要
# 左上角那个号变,就必然产生新 chunk、必然要重启 —— 判断取决于「你想不想要新号」,
# 没有自动化空间。真正只刷新就生效的只有 public/** 这一类,-Mode ui 就是它。
#
# 三条**踩过的坑**,别简化掉(细节见 docs/zh-CN/local-build-and-verify.md):
# 1. 启动必须 Start-Process。`cmd /c start "" "路径"` 会被 Git Bash 吃掉空标题,
#    于是 exe 路径被当成**窗口标题** —— 只弹一个 cmd 窗口、应用没起来、退出码还是 0。
# 2. 安装必须**直接执行** Setup.exe。经 `cmd /c start /wait "…exe" /S` 转一手,静默安装会
#    **什么都不做**且返回 0(用 Start-Process 直接起进程就没这个问题)。
# 3. 必须清掉 ELECTRON_RUN_AS_NODE,否则 10Router.exe 以纯 Node 跑:无托盘、秒退、无日志。

param(
    [string]$Version = "",
    [ValidateSet("replace", "install", "hot", "ui")][string]$Mode = "replace",
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

# ---------- 入口预检:污染过的 shell 直接拒(坑 3 的前置版) ----------
# ELECTRON_RUN_AS_NODE 残留 = step 6 启动静默秒退、无托盘、无日志,现象与"包坏了"完全一样,
# 能查一小时(2026-10-06 又踩,见 docs 坑清单)。step 6 里也清,但那时构建的时间已白花——
# 在第一步就拒,并给出清除命令。agent/CI 的 shell 环境最容易被带进来。
if (Test-Path Env:\ELECTRON_RUN_AS_NODE) {
    Die "当前 shell 有 ELECTRON_RUN_AS_NODE —— 启动会静默秒退。先清除: Remove-Item Env:\ELECTRON_RUN_AS_NODE (或 bash: unset ELECTRON_RUN_AS_NODE)"
}

# ---------- 改动范围 vs 所选模式(提示级,不拦截) ----------
# 只看影响产物的路径;别用全仓库 status——scripts/、docs/、fnos-packaging/ 的无关改动
# (包括未跟踪文件)不该触发任何提醒。
Push-Location $RepoDir
try {
    $sc = @(git status --porcelain -- public src open-sse desktop cli 2>$null)
} finally { Pop-Location }
$hasDesktop = [bool]($sc | Where-Object { $_ -like "* desktop/*" -or $_ -like "*cli/*" })
$hasServer  = [bool]($sc | Where-Object { $_ -like "* src/*"   -or $_ -like "*open-sse/*" })
$hasPublic  = [bool]($sc | Where-Object { $_ -like "* public/*" })
if (($hasDesktop -or $hasServer) -and $Mode -eq "ui") {
    Write-Host "⚠ 检测到 src/open-sse/desktop/cli 改动,但选了 -Mode ui(ui 只拷 public/,这些改动不会生效)。应选:" -ForegroundColor Yellow
    if ($hasDesktop) { Write-Host "    desktop/cli → replace" }
    if ($hasServer)  { Write-Host "    src/open-sse → hot" }
}
if (-not $hasDesktop -and -not $hasPublic -and -not $hasServer -and $Mode -ne "install") {
    Write-Host "ℹ 影响产物的路径(public/src/open-sse/desktop/cli)没有未提交改动——本轮构建的是已提交代码。" -ForegroundColor DarkGray
}

# ---------- -Mode ui:纯 public/** 热替换(不构建、不重启、不换版本号) ----------
# public/** 是**按请求读盘**的静态文件,所以拷完在界面上刷新一下就生效,应用连退都不用退。
# 只限 public/** —— 其余任何东西(server chunk、构建清单、烘焙进 bundle 的版本号)都得重启。
# 从**仓库** public/ 拷(不是 cli/app/public):这一类改完通常不会再跑一次构建,
# 构建产物里的那份可能已经是旧的。
# 注意:已在编译代码里引用过的路径(如已有 provider 的图标 PNG、locale 词条)可以这样换;
# **新增** provider/alias 不行 —— 那张 alias→图标 的映射是编译进 chunk 的,必须构建+重启。
if ($Mode -eq "ui") {
    Step 0 "模式 ui(只同步 public/**,不构建、不重启)"
    $uiSrc = Join-Path $RepoDir "public"
    $uiDst = Join-Path $Inst "resources\app\public"
    if (-not (Test-Path $uiSrc)) { Die "仓库里没有 public/:$uiSrc" }
    if (-not (Test-Path $uiDst)) { Die "未找到已安装的 10Router:$Inst(先跑一次 -Mode install)" }
    robocopy $uiSrc $uiDst /MIR /NFL /NDL /NJH /NJS /R:2 /W:1 | Out-Null
    # robocopy 拿 0-7 当成功,>=8 才是真失败
    if ($LASTEXITCODE -ge 8) { Die "同步 public 失败(robocopy 退出码 $LASTEXITCODE)" }
    Ok "public\ 已同步(应用无需重启)"
    Write-Host ""
    Write-Host "✅ 已生效:在界面上刷新即可(Ctrl+Shift+R 强刷)" -ForegroundColor Green
    exit 0
}

# ---------- 0) 推导测试号(必须严格大于最新 git tag,否则 test-version 会拒绝) ----------
# 默认号 = 最新 tag 的补丁位 +1,再接一个**递增的测试轮次** `-test.N`:第一次 1、第二次 2……
# 左上角版本号因此一眼就能看出「这是第几轮」,而不只是一串没人看得懂的字符。
#
# 轮次存在 desktop/.test-round(未跟踪)。**别改成时间戳/随机数**:那样号虽然也唯一,
# 但看了一串 unix 秒根本不知道跑到第几轮了。
#
# 仍是 `-test.*` 预发布号:预发布排在同核心的正式号**之前**,所以装了测试号的实例
# 不会被 updater 当成「已升级到 1.1.4」。想让界面直接显示工作树版本(如 1.1.4)时,显式传 -Version。
$round = 0
if ($Version -eq "") {
    Push-Location $RepoDir
    try { $tag = (git describe --tags --abbrev=0 --match 'v*').Trim() } finally { Pop-Location }
    if ($tag -notmatch '^v(\d+)\.(\d+)\.(\d+)$') {
        Die "最新 tag '$tag' 不是 vX.Y.Z 形态,请用 -Version 显式指定测试号"
    }
    # **立刻**把 $Matches 取出来存好:$Matches 是自动变量,之后任何一次 -match 都会覆盖它。
    # (第一版把取组留到最后,而中间那个校验计数器内容的 -match 已经把 $Matches 清空,
    #  于是号变成了 "..1-test.2"。tag 匹配之后不许再出现 -match。)
    $vMajor = $Matches[1]
    $vMinor = $Matches[2]
    $vPatch = [int]$Matches[3] + 1
    # 计数器只在**本轮跑通之后**才落盘(见 step 7 之后):失败的一轮不该白吃一个号
    $roundFile = Join-Path $DesktopDir ".test-round"
    if (Test-Path $roundFile) {
        # 文件缺失/内容不是数字就当 0 —— 宁可回到第 1 轮,也不让脚本在这里挂掉
        $prev = Get-Content $roundFile -Raw -ErrorAction SilentlyContinue
        if ($prev -and $prev.Trim() -match '^\d+$') { $round = [int]$prev.Trim() }
    }
    $round++
    $Version = "$vMajor.$vMinor.$vPatch-test.$round"
}
Step 0 "测试号 $Version  模式 $Mode  $(if ($round -gt 0) { "(第 $round 轮)" })  $(if ($SkipAppBuild) { '(复用 cli/app)' })"

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
        Step 3 "复用已有 cli/app(同步测试号到 app/package.json)"
        # build-cli.js 只在构建时同步版本号;复用旧产物时手动对齐,否则 step 7 版本校验必挂
        node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version=process.argv[2];fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');" (Join-Path $AppDir "package.json") $Version
        if ($LASTEXITCODE -ne 0) { Die "同步 app/package.json 版本号失败" }
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
    } elseif ($Mode -eq "install") {
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
    } elseif ($Mode -eq "hot") {
        # ---------- 4) 不重打包 ----------
        # 桌壳(resources\app.asar)和 Electron 主进程没改时, 重打一遍电子包是纯浪费: 应用侧
        # 代码全在 resources\app 下, 且 .next-cli-build / public 是**真实目录**(不在 asar 里),
        # 所以只同步这两个子树 + 重启就够。改 desktop\ 主进程或依赖时必须回到 replace/install。
        Step 4 "跳过 electron-builder(热替换不重打桌面包)"
        Ok "沿用已安装的 resources\app.asar"

        # ---------- 5) 只同步构建子树(先校验产物, 再碰线上安装) ----------
        Step 5 "同步 .next-cli-build + public -> 已安装目录"
        $liveApp = Join-Path $Inst "resources\app"
        if (-not (Test-Path $liveApp)) { Die "未找到已安装的 10Router:$Inst(先跑一次 -Mode install)" }
        foreach ($f in @("package.json", "custom-server.js", ".next-cli-build", "public")) {
            if (-not (Test-Path (Join-Path $AppDir $f))) { Die "构建产物不完整:cli\app 下缺 $f" }
        }
        Stop-Router
        foreach ($sub in @(".next-cli-build", "public")) {
            # /MIR 让安装目录**等于**本轮构建 —— 用 /E 会把上一轮的旧 chunk 留在那里。
            # 两个目录都是纯构建产物, 应用不往里写运行时数据(那些走 DATA_DIR)。
            robocopy (Join-Path $AppDir $sub) (Join-Path $liveApp $sub) /MIR /NFL /NDL /NJH /NJS /R:2 /W:1 | Out-Null
            # robocopy 拿 0-7 当成功, >=8 才是真失败 —— 别拿 -ne 0 判
            if ($LASTEXITCODE -ge 8) { Die "同步 $sub 失败(robocopy 退出码 $LASTEXITCODE)" }
            Ok "$sub 已同步"
        }
        # 版本号: step 7 按安装目录的 package.json 校验, 且它正是被烘焙进 bundle 的那份
        Copy-Item (Join-Path $AppDir "package.json") (Join-Path $liveApp "package.json") -Force -ErrorAction Stop
        Copy-Item (Join-Path $AppDir "custom-server.js") (Join-Path $liveApp "custom-server.js") -Force -ErrorAction Stop
        Ok "package.json + custom-server.js 已同步"
    } else {
        Die "未知模式 $Mode"
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

    # 服务自报版本:currentVersion 是**构建期**烘焙进 bundle 的(config.js 静态
    # import),磁盘上 app/package.json 的手动对齐救不了它——SkipAppBuild 跨测试号
    # 复用旧产物时这里必露馅(实测 test.4 复用 test.3 bundle,仪表盘陈旧横幅
    # "Installed version ... differs from the running build" 报得完全正确)。
    # 完整构建必须自洽(不一致直接 Die);SkipAppBuild 只警告不拦,权衡留给调用者。
    $serving = Invoke-RestMethod "http://127.0.0.1:20128/api/version" -TimeoutSec 5
    if ($serving.currentVersion -ne $Version) {
        if ($SkipAppBuild) {
            Write-Host "  ! 服务自报版本 $($serving.currentVersion) ≠ $Version(SkipAppBuild 复用旧 bundle:陈旧检测横幅会按旧号报,要自洽就完整重建)" -ForegroundColor Yellow
        } else {
            Die "服务自报版本 $($serving.currentVersion) ≠ $Version(bundle 里烘焙的版本号没跟上——build-cli.js 真跑了吗?)"
        }
    } else {
        Ok "服务自报版本 $Version -> ok"
    }

    # 登录态 SSR 冒烟:用本地 jwt-secret 铸 cookie 打 /dashboard。
    # /api/health 不走页面渲染,挡不住 "health 绿但页面 500"(如 TDZ/循环引用回归)。
    # 铸 JWT 走落盘 helper(PS5.1 传参会吃掉内嵌双引号,内联 -e 必炸,见 mint-smoke-jwt.mjs 头注)。
    $jwtSecretPath = Join-Path $env:APPDATA "10router\jwt-secret"
    if (Test-Path $jwtSecretPath) {
        $tokenFile = Join-Path $env:TEMP "10router-smoke.jwt"
        node (Join-Path $DesktopDir "mint-smoke-jwt.mjs") $jwtSecretPath $tokenFile
        if ($LASTEXITCODE -ne 0) { Die "铸 SSR 冒烟 JWT 失败" }
        $token = (Get-Content $tokenFile -Raw).Trim()
        $dashCode = & curl.exe -s -o NUL -w "%{http_code}" -m 20 -H "Cookie: auth_token=$token" http://127.0.0.1:20128/dashboard
        if ($dashCode -ne "200") { Die "登录态 /dashboard SSR 返回 $dashCode (期望 200) —— 看 server.log" }
        Ok "登录态 /dashboard SSR -> 200"
    }

    if ($Marker -ne "") {
        $roots = @((Join-Path $Inst "resources\app\.next-cli-build"), (Join-Path $Inst "resources\app\src"))
        $hit = Get-ChildItem $roots -Recurse -File -ErrorAction SilentlyContinue |
               Select-String -Pattern $Marker -SimpleMatch -List | Select-Object -First 1
        if (-not $hit) { Die "产物里找不到标记 '$Marker'(代码没进去?注意产物目录是 .next-cli-build)" }
        Ok "标记命中: $($hit.Path)"
    }

    # 本轮所有校验都过了,才把轮次记下 —— 失败的一轮不消耗号
    if ($round -gt 0) {
        Set-Content -Path (Join-Path $DesktopDir ".test-round") -Value $round -Encoding ascii -NoNewline
        Ok "测试轮次记为第 $round 轮"
    }
}
finally {
    # ---------- 8) 回退测试号(永远执行,除非 -NoRevert) ----------
    if (-not $NoRevert) {
        Step 8 "回退测试版本号"
        Push-Location $RepoDir
        try {
            # 直接调 node,不走 npm run:绕开 npm 的参数解析(-- 偶发被当成 flag 报 EUNKNOWNCONFIG)
            node scripts\test-build-version.mjs --revert
            # 干净树时 porcelain 输出为空,PS5.1 里是 $null —— 直接 .Trim() 会炸掉 finally
            $dirty = (git status --porcelain | Out-String).Trim()
            if ($dirty -ne "") { Write-Host "  ! 工作区非空,提交前先看: $dirty" -ForegroundColor Yellow }        } finally { Pop-Location }
    } else {
        Step 8 "保留测试号(-NoRevert)"
    }
}

Write-Host ""
Write-Host "✅ 本地测试轮完成:$Version 已装好并跑起来" -ForegroundColor Green
