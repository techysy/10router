# 10Router 桌面版(Electron 托盘壳)

把 10Router Web 服务封装成「装完即用、托盘管理」的桌面应用:Electron 托盘 + 内嵌窗口 + Node sidecar。

## 形态与架构

```
┌─ Electron main(main.js)──────────────┐      ┌─ Node sidecar ───────────────────┐
│ 托盘图标/菜单 · BrowserWindow         │ spawn│ resources/app/custom-server.js    │
│ 单实例锁 · 健康轮询 /api/health       │ ───→ │ PORT=20128 HOSTNAME=0.0.0.0       │
│ 开机自启(setLoginItemSettings)       │      │ ELECTRON_RUN_AS_NODE=1(纯 Node) │
└──────────────────────────────────────┘      └──────────────────────────────────┘
```

- **sidecar 复用 Electron 二进制**:`ELECTRON_RUN_AS_NODE=1` 以纯 Node 模式运行
  `cli/app/custom-server.js`(Next standalone 产物,平台无关),不需要内嵌独立 Node 运行时;
  服务自己拉起的子进程(应用更新器 / MITM)继承该环境变量,同样以纯 Node 运行。
- **SQLite**:Electron 37+ 内置 Node 22,驱动链 `better-sqlite3`(桌面包里没有,自动回退)
  → `node:sqlite`(原生可用)→ `sql.js`(已捆绑兜底)。
- **数据目录与 npm CLI 完全一致**:`%APPDATA%\10router`(Win)/ `~/.10router`(mac/linux)。
  桌面版与 CLI 共享配置/密钥/数据库,同一端口(20128)健康预检,**两形态互斥运行**:
  端口已被占用且健康时,桌面壳进入 external 模式只开窗口,绝不 spawn 第二个实例。
- 托盘是 Electron 原生 Tray(与 CLI 的 PowerShell NotifyIcon / systray2 方案无关)。
- **界面语言跟随系统**(en / zh-CN / zh-TW,与 npm CLI 同规则),`TENROUTER_LANG` 环境变量可强制覆盖。

## 目录

```
desktop/
├── main.js          # 全部壳逻辑(托盘/窗口/启停/健康轮询/单实例)
├── package.json     # electron + electron-builder(devDeps)+ build 配置
├── icon.ico/.png    # 托盘/安装包图标(品牌橙,与 CLI 托盘一致)
├── make_icon.py     # 用 Pillow 重新生成图标(改品牌色后跑一遍)
├── build.ps1        # Windows 一键打包
├── build.sh         # macOS 一键打包(必须在 mac 上执行)
└── dist/            # 产物(gitignore)
```

## 打包

### Windows

```powershell
cd desktop
.\build.ps1                 # 全自动:构建 cli/app → npm install → electron-builder
.\build.ps1 -SkipAppBuild   # 源码没变时复用已有 cli/app,省一次 Next build
```

产物:`dist\10Router-Setup-<版本>.exe`(NSIS 安装包;`/S` 静默安装**需直接执行安装器**才生效,见 docs/zh-CN/local-build-and-verify.md 2.5 节)+
`dist\10Router-Portable-<版本>.exe`(便携版,双击即用)。

### macOS(需 mac 机器)

```bash
cd desktop
./build.sh                  # 产出 x64 + arm64 两个 dmg
```

无开发者证书时 ad-hoc 签名可直接运行,首次打开需右键 → 打开。
`cli/app` 产物是纯 JS + WASM,平台无关 —— 在 mac 上用 `./build.sh` 现场构建最稳。

## 生命周期

| 动作 | 行为 |
|---|---|
| 启动应用 | 托盘 + spawn sidecar(先健康预检)→ 就绪后自动打开控制台 |
| 关闭窗口 | 缩到托盘,不退出 |
| 停止服务(菜单) | 只杀 sidecar 进程树,壳常驻 |
| 退出(菜单) | 停服务 → 壳退出 |
| 开机自启 | 登录拉起托盘壳,壳再拉起服务(仅打包版可开) |

## 踩坑与注意

- **首次启动弹 Windows 防火墙**:服务绑定 `0.0.0.0`(与 CLI 一致,局域网设备要访问)必然触发,
  点允许(专用网络)即可;安装版路径固定只弹一次。
- **`cli/app` 必须先构建**:`node cli/scripts/build-cli.js`(build.ps1 会自动做)。
  桌面包直接以 `extraResources` 引用该目录,不复制、不改内容。
- **不要给 sidecar 设 `NODE_PATH` 指向 `~/.10router/runtime`**:那里的 `better-sqlite3` 是
  系统 Node 的 ABI,Electron 内置 Node 加载不了(会自动回退到 node:sqlite/sql.js,无碍但徒增日志)。
- 打包版托盘图标来自 asar 内的 `icon.ico`/`icon.png`,`files` 字段已显式列出;换了图标记得
  重新跑 `python make_icon.py` 而不是只替换一张图。
- electron-builder 在 Windows 上偶发卡死在 winCodeSign 解压(symlink 问题),手动把
  winCodeSign-2.6.0.7z 解到 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\` 即可。

## 版本同步

三处版本号一起改：`cli/package.json`、`desktop/package.json`、`ChangeLog.md`。

## 本地测试构建

把未发布的改动装进本机测，不要用已发布版本号重建（会得到「同号不同内容」的产物）：

```powershell
npm run test-version 1.1.0-test.1        # 盖测试版本号（三处 package.json + fnos manifest）
node cli/scripts/build-cli.js
cd desktop; npx electron-builder --win --dir
# 停掉托盘 → 替换 resources/app 与 resources/app.asar（保留 elevate.exe）→ 启动
npm run test-version -- --revert          # 测完回退
```

完整流程、验证方法与踩坑（含 `ELECTRON_RUN_AS_NODE` 会让 exe 以纯 Node 秒退这个坑）：
见 `docs/zh-CN/local-build-and-verify.md`。
