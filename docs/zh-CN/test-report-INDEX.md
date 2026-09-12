# 测试报告总索引（事故复盘 · 一篇一文件）

> 凡是**测试轮/CI/部署没拦住、被用户或线上先发现**的问题，都值得一篇独立报告；
> 轮次拦住的只是已知模式，漏网的都是验证强度的盲区。本文件是全部报告的总索引，
> 按发生面分类；方法论正文（`local-build-and-verify.md` / `fnos-hot-replace-deploy.md`）
> 只保留浓缩后的闸门与坑清单，不放历史叙事。

## 约定

- **命名**：`test-report-<版本或日期>-<一句话病因>.md`；
- **结构**：时间线与现象 → 根因 → 为什么没拦住 → 修复与闸门 → 教训（浓缩版）；
- **收尾三步**：教训浓缩一行进对应手册的坑/误判清单 → 新增的闸门写进手册正文 →
  在本索引加一行。

## 本地测试轮（Windows 桌面构建 / 验证）

| 日期 | 报告 | 一句话结论 | 闸门反哺 |
|---|---|---|---|
| 2026-09-12 | [test17-tdz-page500](test-report-test17-tdz-page500.md) | 轮次绿 ≠ 页面能用：health 不渲染页面，TDZ 只在登录态 SSR 炸 | test-local.ps1 新增登录态 SSR 冒烟（local-build-and-verify §2.4） |
| 2026-09-12 | [desktop-asar-locked](test-report-desktop-asar-locked.md) | 构建产物放工作区 = 被文件监视进程锁死 | electron-builder 输出目录出工作区 `-c.directories.output=%TEMP%`（test-local.ps1 固化） |

## NAS 热替换（arch 构建机 → fnOS 101）

| 日期 | 报告 | 一句话结论 | 闸门反哺 |
|---|---|---|---|
| 2026-09-12 | [nas-stale-checkout](test-report-nas-stale-checkout.md) | 构建机只 fetch 不 pull = 拿旧代码构建；增量 `.next` 伪造 marker 命中 | 构建前 `pull --ff-only` + 核对 HEAD==origin/main + 服务端变更干净重建 + marker 分 dashboard/open-sse 两处（fnos-hot-replace §5） |

浓缩在手册坑清单（一句话坑，不单独成篇）：fnOS 守护 **72s 自动拉起**（必须先换完
文件再重启）、**`.env` 不保留 = JWT_SECRET/INITIAL_PASSWORD 全丢**、standalone
**必须补拷** open-sse/src/mitm/外部 node_modules——见 `fnos-hot-replace-deploy.md` §5。

## 发版与 CI（tag 触发的四工作流 + 多渠道产物）

| 日期 | 报告 | 一句话结论 | 闸门反哺 |
|---|---|---|---|
| 2026-09-10 | [v108-version-drift](test-report-v108-version-drift.md) | 四版本位漂移产出同名不同载安装器；tag 与 main 同推被静默丢事件 | `test-build-version.mjs` 四文件盖章 + manifest 同步脚本；**tag 永远单独推** + 推后查 run 列表 |

## 既有专项复盘（问题 → 根因 → 修复 的独立文档，收编入索引）

| 文档 | 一句话 |
|---|---|
| [sqlite-driver-chain](sqlite-driver-chain.md) | better-sqlite3 在 Node≥24 SIGSEGV → node:sqlite 回退链与打包取舍 |
| [tray-icon-monochrome](tray-icon-monochrome.md) | mac template 图标的 alpha 陷阱（alpha=图案）与 Windows 双主题注册表 |
| [mirasim-dsh-toolcall-loss](mirasim-dsh-toolcall-loss.md) | 内嵌 dsh 工具调用 id/name 丢失导致 CodeBuddy 11133 |
| [CodeBuddy-agent-amnesia-fix](CodeBuddy-agent-amnesia-fix.md) | CodeBuddy CN agent system prompt 失忆问题 |
| [usage-usageKey-contract](usage-usageKey-contract.md) | 用量去重 usageKey 契约（请求聚合键）|
| [contributors-cache-residue](contributors-cache-residue.md) | GitHub 贡献者页幽灵数据（fork 网络残留缓存）|

另有一条跨场景方法论教训（暂无独立报告，散见各处）：**外部 AI 的审查/交叉结论
必须先对码核实再采纳**——已有编造函数、虚构测试数、错误归因的前科
（见 release-review 系列中的核误记录）。

## 常见误判速查

一句话级坑的速查表在手册内，不在此重复：
- 桌面/本地验证 → `local-build-and-verify.md` §6；
- NAS 热替换 → `fnos-hot-replace-deploy.md` §5。
