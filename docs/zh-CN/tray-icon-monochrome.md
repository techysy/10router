# 托盘图标单色化 — mac template 的 alpha 陷阱与 Windows 双主题注册表

> 状态：已实现并实机验证（2026-09-06，commit `3c5eb6cc` + `82fa807d`）。
> 涉及：`desktop/main.js`、`desktop/make_icon.py`、`desktop/package.json`、`cli/src/cli/tray/{tray.js,trayWin.js}`。

## 背景

产品有三处托盘面：CLI 服务托盘（mac 用 systray2 Go 二进制 / win 用 PowerShell NotifyIcon）和桌面壳托盘（Electron，全平台）。此前全部使用彩色品牌图标（橙色渐变圆角方块 + 白色粗体 "10"）。用户要求跟随平台惯例单色化：mac 菜单栏图标绝大多数是单色 template（随菜单栏深浅自适应），Windows 任务栏同理。

## 坑一：mac template 只用 alpha 通道

Template image 的渲染规则是 **忽略 RGB、只取 alpha**，再按菜单栏深浅填黑/白。而彩色版图标的 alpha 通道是**整块实心圆角方块**（文字是画在填充色上面的）——直接开 template 会渲染成一坨纯色方块。旧代码里 `isTemplateIcon: false` / `setTemplateImage(false)` 就是当年踩过这个坑后的回避。

**正确解法**：生成专用单色资产，让 **alpha 通道本身就是图形**（圆角方框描边 + 粗体 "10"，透明背景）：

- `desktop/make_icon.py` 新增 `build_mono()`：1024 master 上描边圆角方框（`MONO_STROKE = 7.5%`，32px 下 ≈2.4px）+ 40% 缩放粗体 "10"，纯黑（模板只看 alpha，纯黑仅为非模板回退时的正确观感）。
- 产物：桌面壳 `icon-template.png`(16) + `icon-template@2x.png`(32)（Electron 按同名自动取高分屏版）；CLI `icon-template.png`(32，systray2 只吃一张 base64)；两目录各一份 `icon-mono-white.ico` / `icon-mono-black.ico`（win 用）。
- 启用范围 **仅 darwin**：CLI systray2 菜单 `isTemplateIcon: process.platform === "darwin"`，Electron `img.setTemplateImage(true)`。Linux 保持彩色——面板没有 template 惯例，白色图形在浅色面板上会消失。
- 桌面壳 `build.files` 需显式列出新图标；CLI npm 包 `files` 整体打包 `src/`，自动随包。

## 坑二：Windows 有两套主题注册表

实机测试发现：切到深色任务栏后图标仍是黑色。根因——**Windows 的主题是两个独立开关**：

| 注册表值（`HKCU\...\Themes\Personalize`） | 含义 | 谁在用 |
|---|---|---|
| `SystemUsesLightTheme` | **Windows 模式** → 决定任务栏/开始菜单深浅 | 托盘图标的正确依据 |
| `AppsUseLightTheme` | **应用模式** → 决定应用内容深浅 | Electron `nativeTheme.shouldUseDarkColors` 只看它 |

用户用「自定义」模式（任务栏深色 + 应用浅色）时，`shouldUseDarkColors === false` → 黑色图标配深色任务栏，直接隐身。

**修复**：图标深浅不信任 `nativeTheme`，直接 `reg query SystemUsesLightTheme`（读取失败依次回退 `AppsUseLightTheme` → `shouldUseDarkColors`）。CLI 侧 `trayWin.js isWindowsLightTheme()` 同规则。

### 实时切换

- mac：template 天然免费，系统换肤自动重渲。
- win：监听 `nativeTheme.on('updated')`（WM_SETTINGCHANGE 时触发，两个注册表值变化都会到），回调里**重建图标**——必须重新读注册表，不能缓存首次判断。

## 回落链

所有路径缺单色资产时回落彩色品牌图标（`icon.ico` → `icon.png`），保证旧包/部分更新场景不白屏。

## 验证方法

```powershell
# 看当前两套主题值（Git Bash 里 /v 会被 MSYS 路径转换吃掉,用 node 或 cmd 跑）
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
```

切 Windows 深浅模式，托盘应即时黑白互换；mac 菜单栏切外观同理。图形可 `python desktop/make_icon.py` 后目检 `icon-template@2x.png`。

## 经验

1. **Template image 的前提是"alpha 即图形"**——任何"彩色图标直接开 template"的尝试都会得到实心色块；需要专门的线稿资产。
2. **Windows 主题判断永远先问：你要跟随的是任务栏还是应用？** 两者注册表分离，`nativeTheme.shouldUseDarkColors` 只代表应用模式。
3. 托盘图标这类"每平台惯例不同"的资产，生成脚本（`make_icon.py`）比手工维护 PNG/ICO 可靠——改一个参数全平台重出。
