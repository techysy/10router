# 测试报告：electron-builder 反复失败「app.asar being used by another process」（2026-09-12）

> 发生面：Windows 桌面版本地测试轮（`desktop/test-local.ps1`）。核心结论：
> **构建输出落在工作区里，就会被任何"盯工作区文件"的进程锁住句柄**——修法不是
> 关杀软/杀进程，而是把输出目录挪出工作区。

## 1. 时间线与现象

- 一天内 electron-builder 连续多轮失败，`--dir` 清理/写 `dist2\win-unpacked\resources\app.asar`
  时报 **"app.asar is being used by another process"**，退出码非 0。
- 重试/等几秒再试无效——不是竞态，是**持续持有的句柄**。

## 2. 定位（Restart Manager API）

Windows 自带 Restart Manager（`rstrtmgr.dll`）能列出"谁锁着这个文件"：

```powershell
# PowerShell 5.1 无原生封装;用 .NET 调 RmStartSession/RmRegisterResources/RmGetList
# (或装 Get-FileLockTool 类模块)。连续两次定位到不同的锁主:
#   第一轮: Typora (PID 27836) —— 编辑器打开过 dist 下被替换下来的旧 asar
#   第二轮: ZCode 宿主自身 (PID 25520) —— 工作区文件监视抓着新写的 app.asar
```

要点：**锁主是随机的、会变的**（任何开着产物文件的应用、任何监视工作区的工具）。
逐个杀进程既不可持续也不是修复。

## 3. 根因与闸门

- 根因：electron-builder 默认输出 `desktop/dist2`——**在工作区内**。工作区必然被
  编辑器/杀软/Agent 宿主监视，新写入的大文件（app.asar）被抓住句柄的概率极高；
  下一次构建清理 dist 时必然撞锁。
- 闸门（已固化进 `desktop/test-local.ps1`）：

```powershell
$EbOutDir = Join-Path $env:TEMP "10router-eb-out"
npx electron-builder --win --dir "-c.directories.output=$EbOutDir"
```

  输出/取产物/替换全部改走 `%TEMP%\10router-eb-out`，工作区内不再出现构建产物。

## 4. 教训（浓缩版）

- 「构建产物放工作区」在单机人工流程里无害，**在任何有文件监视（编辑器/杀软/
  AI Agent 宿主）的环境里是定时炸弹**；产物目录一律出工作区。
- 撞文件锁先问"锁主是谁"（Restart Manager），再问"它为什么有理由盯这个路径"——
  多数情况下**改路径**比消灭锁主正确得多。
- 同族：仓库根的 `.next-cli-build` 也曾被锁过一次（同源），目前因 build-cli 需要原位
  引用而保留，但 electron-builder 的高频写路径必须出工作区。
