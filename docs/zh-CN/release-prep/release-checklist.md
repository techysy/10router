# 发版检查清单与 Release 说明模板

> 每次发版照此执行，避免格式漂移与漏步。本清单由 v1.3.0 发版实战（2026-10-01）沉淀：
> 当时漏了 **npm publish**（更新检查的数据源，CI 不覆盖）与 Release 说明格式，均事后补救。

## 一、发版前审查

- [ ] 单元测试全量：`cd tests && npm test`；已知红以基线为准：
      `npx vitest run --reporter=json --outputFile=results.json && node __baseline__/verify-no-regression.mjs results.json`
- [ ] 回归门禁 + 三份注册表基线（providers / alias / oauth-urls）
- [ ] `node scripts/audit-capabilities.mjs` 能力审计
- [ ] 安全审查（凭据落盘、日志泄漏、虚拟 key 写路径、sudo argv 等）
- [ ] **从上一版本原地升级验证**（不能只测全新安装——升级路径上要执行【旧版本发布时冻结的卸载器】，它的进程检查/清理逻辑在新装测试里测不到；v1.3.5 的「无法关闭」弹窗即在全新安装测试全绿的情况下漏到线上）
- [ ] 新增供应商的 `public/providers/*.png` 图标齐全
- [ ] desktop 新增文件已登记 `desktop/package.json` 的 `build.files`（漏登记 = 打包后功能静默消失）
- [ ] ESLint 仅作参考：仓库基线并非零 error（v1.2.1 即 153 error），CI 不设卡，关注**净新增**
- [ ] 本机 Windows 构建 webpack 编译期 OOM 为已知环境问题；构建验证以 CI 为准，不必本地复跑

## 二、发版动作（按序）

1. **版本号 bump**（四处同号）：`package.json` / `cli/package.json` / `desktop/package.json`，
   然后 `node scripts/sync-manifest-version.mjs` 同步 `fnos-packaging/manifest`
2. **CHANGELOG.md**：`## vX.Y.Z (未发布)` 填实际日期；检查无重复小节标题
3. **三份用户日志** `public/i18n/changelog/{en,zh-CN,zh-TW}.md`：首段版本日期对齐发布日
   - ⚠️ 预期现象：`tests/unit/changelog-release-cap.test.js` 会红，**直到打上 tag**——
     该测试要求用户日志首段 == 最新 git tag，防止未发布说明提前到达客户端。打 tag 后自动转绿，勿回退了事。
4. 提交发版校准 commit（形如 `Release: vX.Y.Z — 发版面校准`）
5. `git tag -a vX.Y.Z` 并推送 main + tag → CI 自动构建
   （build-server / build-desktop-win / build-desktop-mac / build-fpk / docker-publish）
6. **npm publish（手工，CI 不覆盖！）**：`npm run cli:publish`
   - npmjs 处理需 5–10 分钟；以 `npm view @techysy/10router version --registry https://registry.npmjs.org`
     翻到新版为准。未翻到 = 全网的更新检查与桌面自更新都看不到新版本
7. **写 Release 说明**（模板见下）：`gh release edit vX.Y.Z --notes-file notes.md`
8. 复核 Release 资产：
   - Windows 自更新两件套 `10Router-Win-Setup-X.Y.Z.exe` + `SHA256SUMS-desktop.txt` 齐全
     （自 1.4.0 起资产名平台化、与 sums 条目完全一致；更早的 release 是点分隔的
     `10Router.Setup.X.Y.Z.exe` 对空格分隔的 sums 条目，更新器按归一名匹配两种命名，都能识别）
   - Docker 镜像流水线成功

## 三、Release 说明模板

````markdown
## vX.Y.Z

> 本版主题：**一句话概括三条主线**。无破坏性变更，可直接升级。

### ⚠️ 升级须知

- （本版特有的迁移 / 渠道注意事项；macOS dmg 未公证首次右键打开等常态提醒）

### ✨ 新增亮点

- （面向用户的功能，每条一行一句话 + 关键细节）

### 🐛 重要修复

- （issue 号 + 一句话；安全修复优先列）

完整开发明细见 [CHANGELOG.md](https://github.com/techysy/10router/blob/main/CHANGELOG.md)。

## 📦 安装

| 渠道 | 说明 |
|------|------|
| **fnOS / NAS** | `10Router-FnOS-X.Y.Z-x86.fpk` / `-arm.fpk` / `10Router-FnOS-Window-X.Y.Z-x86.fpk` / `-arm.fpk`，在 fnOS 应用中心安装 |
| **Windows** | `10Router-Win-Setup-X.Y.Z.exe`（推荐，NSIS 安装器）/ `10Router-Win-Portable-X.Y.Z.exe`（免安装）/ `10Router-Win-Web-Setup-X.Y.Z.exe`（安装时在线下载主包）/ `10router-desktop-X.Y.Z-x64.nsis.7z`（Web-Setup 的在线数据载荷，名字由 package.json 的 `name` 派生、**刻意不平台化**——它被烤进已发布的 Web-Setup 安装器里，改名即断链） |
| **macOS** | `10Router-Mac-Setup-X.Y.Z-arm64.dmg`（Apple 芯片）/ `10Router-Mac-Setup-X.Y.Z-x64.dmg`（Intel），未公证，首次右键打开 |
| **Docker** | `docker pull ghcr.io/techysy/10router:X.Y.Z` |
| **npm CLI** | `npm i -g @techysy/10router@X.Y.Z` |
| **独立服务端** | `10router-server.tar.gz` |

校验和见 `SHA256SUMS-desktop.txt` / `SHA256SUMS-fpk.txt` / `SHA256SUMS-mac.txt` / `SHA256SUMS-server.txt`
（清单未签名 / attest，见 `docs/zh-CN/verify-downloads.md`）。

**Full Changelog**: https://github.com/techysy/10router/compare/vPREV...vX.Y.Z
````

### 模板说明

- 骨架固定为：主题行 → 升级须知 → 新增 → 修复 → 📦 安装表 → Full Changelog。
- 外部贡献有 PR 时在正文相应条目写「感谢 @user」（v1.1.2 惯例）；无外部贡献则不写
  Contributors 区块（页面底部头像栏由 GitHub 按区间提交自动渲染，与正文无关）。
- README 无需手改版本号：npm badge 走 shields 动态读取，publish 后自动更新。
- 可用 `gh api repos/techysy/10router/releases/generate-notes -f tag_name=vX.Y.Z -f previous_tag_name=vPREV`
  生成 What's Changed 草稿对照，确认无遗漏的 PR。
