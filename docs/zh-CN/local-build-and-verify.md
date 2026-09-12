# 本地测试构建：构建 → 就地替换 → 验证

> 适用范围：把**未发布的改动**装进一台真机上手动测试。两条通道共用同一套方法：
> **Windows 桌面版**（Electron 托盘壳）与 **fnOS/NAS 的 fpk**。
> 正式发布（打 tag → CI 构建 → Release 资产 → npm publish）见 `docs/zh-CN/release-review-v1.0.7.md` 与 `CLAUDE.md`。

## 0. 为什么不是「重新构建一下现在版本号」

用**已发布**的版本号本地构建，会产出「版本号相同、内容不同」的第二份产物。1.0.8 就是这么踩的：
fpk 与测试报告出自一个 commit、四份 Windows 安装包出自另一个 commit、ghcr 镜像来自打 tag 那一次、
npm 上还停在 1.0.7 —— 事后谁也无法凭版本号判断手上那份是哪份、差多少。

所以本地测试构建**必须带独立的测试版本号**（见 §1），并且**验证过什么、用什么验证**要留痕（见 §4）。

## 1. 测试版本号：`X.Y.Z-test.N`

```bash
npm run test-version -- --check          # 看四处版本号 + 是否已盖章 + 最新 tag
npm run test-version 1.1.1-test.1        # 盖测试版本号（不提交）
npm run test-version -- --revert         # 测完回退（只在「改动全是版本行」时才会执行）
```

一次写入四处，保证 Windows 与 fpk 测试产物同号：

| 文件 | 谁在用 |
|---|---|
| `package.json` | 服务端 / dashboard 显示、npm |
| `cli/package.json` | `@techysy/10router` 启动器 |
| `desktop/package.json` | Electron 壳 + 安装包文件名 |
| `fnos-packaging/manifest` | fpk 版本号（由 `prebuild:fpk` 从根 `package.json` 同步） |

脚本内置三条约束，都是为了不再重演历史事故：

- **必须是 `X.Y.Z-test.N` 形态**，防止测试号被当成正式发布物（`--force` 可越过）。
- **必须大于最新 git tag**（`--check` 会打印当前 tag）：取最新 tag 的**补丁位 +1** 再挂 `-test.N`
  —— 例如当前 tag 是 `v1.1.0`，就盖 `1.1.1-test.N`。语义化版本里 `1.1.1-test.1 > 1.1.0 > 1.0.8`，
  而 `1.0.8-test.1 < 1.0.8`：小于等于当前发布版时，真机上在用的旧版本会把它当成降级而不提示更新。
- **`--revert` 拒绝吃掉无关改动**：`git checkout -- <file>` 会丢弃该文件**全部**未提交改动，
  不只是版本行 —— 这个脚本的 `assertVersionOnlyChanges()` 在回退前逐文件检查
  「git diff 的每一行是否都与 version 有关」，否则直接拒绝并列出文件，让你先 commit 或 stash。
  （这个坑真实发生过：一次回退把一整个未提交的修复一起还原了。）

> 测试号**永远不提交**。回退后 `git status --porcelain -- package.json cli/package.json desktop/package.json fnos-packaging/manifest`
> 必须是空的；发布了就 `git tag` 一次定型，不要移动 tag。

## 2. Windows 桌面版

> **想省事就用一键脚本**：`cd desktop; .\test-local.ps1` —— 它把下面 2.1~2.5 整套串成一条命令：
> 退托盘 → 盖测试号 → 构建 `cli/app` → 打包 → 替换/安装 → 启动 → 验证 → **自动回退版本号**（中途失败也会回退）。
> 常用开关：`-Mode install`（真跑安装器）、`-SkipAppBuild`（复用已有 `cli/app`）、
> `-Marker "<字面量>"`（顺带断言产物里含该标记）、`-Version X.Y.Z-test.N`（指定测试号）。
> 下面各节是它每一步在做什么，以及为什么必须那么做。

### 2.1 先选路：就地替换，还是真装一遍？

| 目的 | 走哪条 | 大致耗时 |
|---|---|---|
| **只验证代码改对了**（日常迭代，首选） | `--dir` 产物**就地替换**（§2.2） | 构建 ~2 分钟 + 替换 ~10 秒 |
| **验证安装器/升级覆盖/快捷方式本身** | 出 `Setup.exe` **静默覆盖安装**（§2.5） | 构建 ~3 分钟 + 安装 ~40 秒 |

两条路的构建前缀相同：

```bash
npm install                                        # 全新 clone 才需要（root）
cd cli && npm install && cd ..                     # cli 的 esbuild 依赖
npm run test-version 1.1.1-test.1                  # 必须在构建**前**盖章：版本号会进文件名与包内容
node cli/scripts/build-cli.js                      # → cli/app（Next standalone，平台无关）
cd desktop
npx electron-builder --win --dir                   # 路 1：dist/win-unpacked（不出安装包，最快）
npx electron-builder --win nsis --x64              # 路 2：只出 nsis 安装包（省掉 portable/nsis-web）
```

- `cli/app` 必须**先**构建：桌面包用 `extraResources` 直接引用它，不复制内容。
- 测试号必须**严格大于**当前 `git tag`（§1）；`npm run test-version` 会自己校验，不用手算。
- 不带 target 的 `npx electron-builder --win` 会出全量（nsis + portable + nsis-web）。本地只装一遍时
  用 `--win nsis --x64`，省一半时间。
- 本地构建**不签名**（SignPath 只在 CI 配）：日志里 `no signing info identified, signing is skipped`
  是正常的，安装时 SmartScreen 可能拦一下。
- `desktop/README.md` 另有 `build.ps1` 一键脚本与 macOS 流程。

### 2.2 就地替换（不重新安装）

替换 `resources/app`（sidecar 代码）与 `resources/app.asar`（壳），保留安装器自己的东西：

```bash
INST="$LOCALAPPDATA/Programs/10Router"
taskkill //IM 10Router.exe //F          # 必须先停：sidecar 正跑在 resources/app 里
sleep 4
rm -rf "$INST/resources/app"
cp -r desktop/dist/win-unpacked/resources/app "$INST/resources/app"
cp -f desktop/dist/win-unpacked/resources/app.asar "$INST/resources/app.asar"
```

- **保留 `elevate.exe`**：它由 NSIS 安装器写入，`--dir` 产物里没有。
  替换后 `resources/` 应恰好是 `app`、`app.asar`、`elevate.exe` 三项。
- **数据目录天然留存**：应用数据路径与版本号无关（`%APPDATA%\10router`），
  就地替换不会动 `db/data.sqlite`、`auth`、`*-secret`、`machine-id`。
  桌面版与 npm CLI **有意共用**这一个目录（`desktop/main.js` 顶部注释），别去挪它。
- 覆盖安装（跑 Setup）也可以，但先做替换能快速迭代。

### 2.3 启动 —— 以及那个最贵的坑

```bash
unset ELECTRON_RUN_AS_NODE
powershell -NoProfile -Command "Start-Process -FilePath '$(cygpath -w "$INST/10Router.exe")'"
```

> **别用 `cmd //c start "" "路径"`。** Git Bash 会把那个空标题 `""` 吃掉，于是 `start` 把
> **exe 路径当成窗口标题**：它只弹一个 cmd 窗口、什么都不启动，而且**退出码是 0**、没有任何报错。
> 现象与「打包坏了」极像，很容易查错方向。非要用 `start` 就给个非空标题（`start "10Router" "路径"`）。

**必须清掉 `ELECTRON_RUN_AS_NODE`。** 这个变量一旦存在于环境里，`10Router.exe` 会以
**纯 Node** 模式执行：没有托盘、没有窗口、`whenReady` 之前的代码就跑完了、进程秒退、
不留任何日志 —— 看起来完全像「打包坏了 / 单实例锁被占 / 安装损坏」，能查上一小时。

识别特征：报 `bad option: --enable-logging`、退出码 9（这是 Node 的参数解析错误，
Chromium 不会这么说）。桌面包的 sidecar 自己 spawn 子进程时也会设这个变量，
所以「在同一个终端里手搓启动」很容易被残留环境骗到。

### 2.4 验证闭环

```bash
echo "$(tasklist | grep -ci 10Router) 个进程"
curl -s http://localhost:20128/api/health                       # {"ok":true}
tail -2 "$APPDATA/10router-desktop/logs/tray.log"               # start server / notify 已启动
```

日志位置（**先看这里再怀疑代码**）：

| 文件 | 内容 |
|---|---|
| `%APPDATA%\10router-desktop\logs\tray.log` | 壳：启动、健康预检、external 模式、spawn 命令 |
| `%APPDATA%\10router-desktop\logs\server.log` | sidecar 的 stdout/stderr（服务端 `console.log/warn/error` 都在这） |

注意 Electron 的 `userData` 是 `%APPDATA%\10router-desktop`（取自 `package.json` 的
`name`，**不是** productName），与服务端数据目录 `%APPDATA%\10router` 是两个地方。

若托盘没起来而端口却被占：说明已有一个实例在跑，新实例会走 external 模式。
先 `taskkill` 干净，再启动。

### 2.5 真装一遍（静默覆盖安装）

只在需要验证**安装器本身**（升级覆盖、快捷方式、卸载项）时走这条；验证代码用 §2.2 的就地替换。

```bash
taskkill //IM 10Router.exe //F                     # 必须先停：安装器要覆盖 resources/app
sleep 4
cd desktop/dist
./"10Router Setup 1.1.1-test.1.exe" /S             # 直接执行；装完不会自动启动
```

**坑在这里：`/S` 只在「直接执行 exe」时有效。** 经 `cmd /c start /wait "…exe" /S` 转一手会
**静默什么都不做** —— 返回 0、没有任何报错、文件一个都不动，极易误判成「装好了但没生效」。

装完用版本号确认到底装没装（比看进程可靠）：

```bash
INST="$LOCALAPPDATA/Programs/10Router"
node -e "console.log(require(process.argv[1]).version)" "$INST/resources/app/package.json"
stat -c '%y %n' "$INST/resources/app/package.json"     # mtime 应就是刚刚
```

`resources/app` 正是 `extraResources` 里的 `cli/app`，所以它的 `package.json` 版本号 == 你盖的测试号。
另外两点：**静默安装不会自动拉起应用**（跳过 `runAfterFinish`），要按 §2.3 手动启动；
覆盖安装不动数据目录（`%APPDATA%\10router`），`db/data.sqlite` 原样保留。

## 3. fnOS / NAS 的 fpk

> **日常更新代码不需要重装 fpk**：热替换 server 产物 → 重启即可，见 `fnos-hot-replace-deploy.md`。
> 本文这一节只在验证**安装器本身**时走（等价于 Windows 的 §2.5）。

与 Windows 同源的目录（`fnos-packaging/`）与同一套版本号：

```bash
npm run test-version 1.1.1-test.1
npm run prebuild:fpk     # manifest version ← package.json（测试号随之进 fpk 文件名）
npm run build            # → .next/standalone
```

组装与打包在 NAS 上做（完整命令见 `fnos-packaging/README.md`）：传骨架 + server 产物 →
`fnpack build` → 分别产出 **url** 与 **iframe** 两个变体。验证要点：

- 端口 **20127**（与 9router 的 20128 并存），数据目录 `@appdata/10router`。
- 安装后在应用里打开一次入口，确认能进 dashboard；`cmd/main` 已把 `HOME` 指到 `DATA_DIR`
  （fnOS 应用用户没有 `/home`，否则 `EACCES`）。
- 两个变体都要试：`url` 模式由 fnOS 反向代理，`iframe` 模式嵌在窗口里，登录态/cookie 行为不同。

## 4. 验证方法论（两通道通用）

**① 先验证产物，再安装。** 装之前就能证伪大半问题 —— 直接在构建输出里找标记：

```bash
# 正向标记：新代码的特征字符串必须在（挑不会被压缩改名的字面量，如错误码 / i18n key / 路由名）
grep -rl "payload_too_short" "$INST/resources/app" | wc -l        # ≥1

# 反向标记：被删掉的旧代码特征必须为 0（比正向标记更有力）
grep -rl "xiaomiMimoSessions.clear()" "$INST/resources/app" | wc -l   # 0
```

反向标记是关键：只查「新代码在不在」无法发现「旧代码还在、两份逻辑并存」。
挑标记时避开打包器会改的东西（函数名会被压缩/改名），用字面量。

**② 端到端打真接口，而不是只看进程活着。** 起临时数据目录跑 sidecar，登录后按真实分支逐一打：

```bash
ELECTRON_RUN_AS_NODE=1 NODE_ENV=production PORT=20129 HOSTNAME=127.0.0.1 \
INSTALL_CHANNEL=desktop DATA_DIR="/tmp/verify-data" "$INST/10Router.exe" custom-server.js
```

- 临时 `DATA_DIR` + 非默认端口，才能在不碰用户数据的前提下拿到默认口令登录。
- 未鉴权时受保护路由返回 **401 而不是 404**：401 只证明路由存在，不证明逻辑对 —— 要带 session
  再打一次，逐个断言错误分支的文案/状态码。
- 依赖浏览器手点的流程（OAuth、粘贴授权码）就用**真实调用点**验证：
  例如用真 crypto 造一份平台侧密文，喂给处理函数，断言能解开。

**③ 自加密自解密的测试等于没测。** 自定义加解密/线格式（wire format）类逻辑，测试助手必须
**对齐对端实现，而不是对齐我们自己的解码器** —— 两边都按同一个错误假设写，测试必然全绿，
而线上每一份真实数据都解不开（小米 MiMo 的授权码就因此白跑了 5 轮：载荷长度完全正常，
只是我们把「临时公钥 + nonce」的顺序写反了）。做法：

- 把**对端实现**（这里是 `app.asar` 里的官方客户端）挖出来，逐字节抄成测试助手；
- 固定一条**布局断言**（哪个字段占哪几个字节），有人把顺序改回去就立刻变红；
- 做完改一次**变异验证**：故意把错的那版注入回去，确认用例真的会红 —— 绿的用例不代表它有
  保护力，只有「改坏了会红」才代表。

判断一个字段的编解码方式时也要注意：`base64url` 与标准 `base64` 的字母表不同（`-_` vs `+/`），
用错会让严格解码器**静默跳过**这些字符、把数据毁掉。看官方用什么，就用什么。

**④ 留一条「下次失败时能定位」的路。** 路径类失败（解不开、找不到、超时）要打日志说明
**长度 / 数量 / 尝试次数**，但**绝不记录载荷、密钥、token 本体** —— 那是凭据容器。

**⑤ 收尾。** 杀掉临时进程 → `npm run test-version -- --revert` → 确认工作树只剩你真正要提交的改动。
若临时进程占着端口，先停再回退，否则容易误判「改动没生效」。

## 5. 常见误判对照

| 现象 | 实际原因 |
|---|---|
| exe 双击/命令启动秒退、无托盘、无日志 | 环境里有 `ELECTRON_RUN_AS_NODE=1`（§2.3） |
| 换了代码但行为没变 | 旧实例仍占 20128，新实例进 external 模式只开窗口，跑的是旧 sidecar |
| 包内 grep 不到新代码 | 产物目录不是 `.next` 而是 `.next-cli-build`；或搜的函数名被压缩改名了 |
| 提示找不到 `elevate.exe` 相关能力 | `--dir` 产物本来就没有，替换时别删安装器留下的那份 |
| 测试后版本号回不干净 | 用 `npm run test-version -- --revert`，不要手敲 `git checkout --`（§1） |
| `cmd //c start "" "…exe"` 像什么都没发生 | 空标题被 Git Bash 吃掉，exe 路径被当成窗口标题（§2.3） |
| `Setup.exe /S` 返回 0 但版本没变 | 经 `cmd /c start /wait` 转手会让它静默空转；必须直接执行 exe（§2.5） |
| 装完应用不会自己起来 | 静默安装跳过 `runAfterFinish`，按 §2.3 手动启动（§2.5） |

## 6. 相关文件

| 路径 | 用途 |
|---|---|
| `scripts/test-build-version.mjs` | 测试版本号盖章 / 检查 / 安全回退 |
| `scripts/sync-manifest-version.mjs` | `fnos-packaging/manifest` ← 根 `package.json` |
| `cli/scripts/build-cli.js` | 构建 `cli/app`（sidecar 代码，平台无关） |
| `desktop/main.js` | 托盘壳：单实例锁、健康预检、spawn sidecar |
| `desktop/build.ps1` / `build.sh` | 一键打包（构建 cli/app → npm install → electron-builder），**不含**安装与验证 |
| `desktop/test-local.ps1` | 一键**本地测试轮**：退托盘 → 盖号 → 构建 → 替换/安装 → 启动 → 验证 → 回退（§2） |
| `docs/zh-CN/fnos-hot-replace-deploy.md` | fnOS **热替换部署**（不重装 fpk）：预解包 → 原子交换 → appcenter-cli 重启 |
| `.github/workflows/build-desktop-win.yml` | 正式 Windows 产物（tag `v*` 触发） |
| `.github/workflows/build-fpk.yml` | 正式 fpk 产物（x86/arm × url/iframe） |
| `desktop/README.md` / `fnos-packaging/README.md` | 两个形态各自的打包细节 |
