# 10Router Documentation / 文档导航

[English](#english) · [中文](#中文)

---

## English

Architecture, engineering notes, and troubleshooting guides for the 10Router AI routing gateway + dashboard.

### Architecture

- [Architecture Overview](/docs/zh-CN/ARCHITECTURE.md) ([English](/docs/en/ARCHITECTURE.md)) — full system design: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, and SQLite data model.

### Engineering deep-dives

- [Streaming [DONE] Sentinel & Client Abort Fix](/docs/zh-CN/streaming-done-sentinel-abort-fix.md) (zh-only) — root-cause and architectural fix for completed streams erroneously logged as 0-token `[Streaming aborted]` errors when clients disconnect upon seeing `[DONE]` (Issue #48 / PR #50).
- [SQLite Driver Chain](/docs/zh-CN/sqlite-driver-chain.md) (zh-only) — how `bun:sqlite → better-sqlite3 → node:sqlite → sql.js` is selected, and why `better-sqlite3` is build-time-required but barely used at runtime.
- [Usage Dedup usageKey Contract](/docs/zh-CN/usage-usageKey-contract.md) (zh-only) — the per-attempt `usageKey` dedup contract that prevents same-millisecond count loss across 5 call sites.
- [Earliest Expiry First Architecture](/docs/zh-CN/earliest-expiry-first-architecture.md) (zh-only) — multi-account "Earliest Expiry First" quota scheduling: non-blocking critical path, SWR lightweight caching, and fallback matrix.
- [API Key Signing & Secret Rotation](/docs/zh-CN/api-key-signing-rotation.md) (zh-only) — key format `sk-{machineId}-{keyId}-{crc8}`, the secret resolution chain, local DB validation, and future strict-CRC plan.
- [Antigravity Integration Guide](/docs/zh-CN/antigravity-integration-guide.md) (zh-only) — connecting and debugging the `antigravity` channel: distinguishing egress-IP blocking from account risk control vs code bugs.
- [Antigravity Account Risk & Recovery](/docs/zh-CN/antigravity-account-risk-and-recovery.md) (zh-only) — user-facing: shared family plan pitfalls, Play payment region matching, the 18+ age verification gate, and appeal paths.
- [Usage Import Rows Contract](/docs/zh-CN/usage-import-rows.md) (zh-only) — `meta.imported` display contract: usageHistory vs requestDetails, tag-and-backfill, read-side synthesis, and double-display boundaries.
- [Mirasim Usage Ledger](/docs/zh-CN/mirasim-usage-ledger.md) (zh-only) — desktop local usage ledger as a sync data source: insights fields, anti-double-count rules, and boundaries.
- [ZCode × CodeBuddy CN Compatibility & Plugin Design](/docs/zh-CN/zcode-cbcn-compatibility-and-plugin-design.md) (zh-only) — governance of CodeBuddy CN 11128 channel-scope risk control, session size control, and `10router-sync` plugin collaboration.
- [ZCode Integration & Proxy Guide](/docs/zh-CN/zcode-integration-and-proxy-guide.md) (zh-only) — reverse-proxying ZCode client, consuming free trial packs via CreditDaddy gateway, and official Coding Plan subscriptions.
- [MITM Proxy Security Hardening](/docs/zh-CN/mitm-security-hardening.md) (zh-only) — the four security fixes: TLS verification, 0600 root CA key, no blind port-443 kill, and hosts cleanup.
- [Mirasim-bundled dsh tool_call id/name loss](/docs/en/mirasim-dsh-toolcall-loss.md) ([中文](/docs/zh-CN/mirasim-dsh-toolcall-loss.md)) — third-party bug causing 11133/`unknown tool ""`; 10Router does not work around it.
- [Monochrome Tray Icons](/docs/en/tray-icon-monochrome.md) ([中文](/docs/zh-CN/tray-icon-monochrome.md)) — alpha-channel trap of macOS template images and Windows dual-theme registries.
- [Xiaomi MiMo Desktop Adaptation](/docs/zh-CN/xiaomi-mimo-desktop.md) (zh-only) — credential paths per platform, authorization-code flow, byte-exact protocol parity with official client, and post-mortems of 7 pitfalls.
- [Xiaomi MiMo Model List Cross-Check](/docs/zh-CN/xiaomi-mimo-model-sources.md) (zh-only) — four-source verification: official catalog vs models.dev vs desktop client vs live endpoint.
- [Adding a Custom Provider with an Agent](/docs/zh-CN/agent-add-custom-provider.md) (zh-only) — walkthrough for driving 10Router through an agent to register a new provider.

### CodeBuddy CN compatibility layers

- [Error Codes Reference](/docs/en/codebuddy-cn-error-codes.md) ([中文](/docs/zh-CN/codebuddy-cn-error-codes.md)) — quick classification of 11101/11128/11133/11134/11140/11150/11151 + 429/401/402 with fixes (including the 11128 channel circuit breaker).
- [Agent System Prompt Amnesia Fix](/docs/zh-CN/CodeBuddy-agent-amnesia-fix.md) (zh-only) — whitelist to stop custom agent prompts from being wiped by upstream content filters.
- [reasoning_effort Compatibility Fix](/docs/zh-CN/CodeBuddy-reasoning-effort-fix.md) (zh-only) — DeepSeek models rejecting `auto`/`off`; mapped to `high`/dropped.
- [CN Account Bulk Import](/docs/zh-CN/codebuddy-cn-account-import.md) (zh-only) — importing multiple `codebuddy-cn` accounts at once.

### Maintenance & Operations

- [Dashboard Password Recovery](/docs/zh-CN/dashboard-password-recovery.md) (zh-only) — `reset-password` file format and location for resetting dashboard credentials without reinstalling.
- [Release Download Verification](/docs/zh-CN/verify-downloads.md) (zh-only) — verifying release assets with `SHA256SUMS-*.txt` across desktop, fnOS fpk, and server archives.
- [Specification: `10router doctor` Command](/docs/zh-CN/spec-10router-doctor.md) (zh-only) — design and implementation of the read-only environment and dependency diagnostic command.
- [Design: Tray Ready Handshake](/docs/zh-CN/design-tray-ready-handshake.md) (zh-only) — design RFC for background detached process startup synchronization.
- [Local Test Build & Verify](/docs/zh-CN/local-build-and-verify.md) (zh-only) — unified flow for Windows desktop and fnOS fpk verification with throwaway `X.Y.Z-test.N` versions.
- [fnOS / NAS Hot-Replace Deploy](/docs/zh-CN/fnos-hot-replace-deploy.md) (zh-only) — hot-updating 10Router on fnOS without reinstalling fpk: unpack → atomic rename swap → lifecycle restart.
- [Test Reports Index](/docs/zh-CN/test-report-INDEX.md) (zh-only) — index of incident post-mortems and test run reports across local test cycles, NAS hot deployment, and CI releases.

### Archive (historical reviews & outdated notes)

- [Archive Overview](/docs/zh-CN/archive/README.md) (zh-only) — index of past release audits, one-off research, and completed issue analyses.
- [Release Reviews](/docs/zh-CN/archive/reviews/) (zh-only):
  - [v1.0.7 Release Review](/docs/zh-CN/archive/reviews/release-review-v1.0.7.md)
  - [v1.1.0 Release Review](/docs/zh-CN/archive/reviews/release-review-v1.1.0.md)
  - [v1.1.1 Release Review](/docs/zh-CN/archive/reviews/release-review-v1.1.1.md)
  - [v1.1.2 Release Review](/docs/zh-CN/archive/reviews/release-review-v1.1.2.md)
  - [v1.2.0 Release Review](/docs/zh-CN/archive/reviews/release-review-v1.2.0.md)
- Historical triages & reports (zh-only):
  - [Upstream v0.5.69 → v0.5.75 triage](/docs/zh-CN/archive/upstream-triage-v0.5.75.md)
  - [Upstream v0.5.81 triage](/docs/zh-CN/archive/upstream-triage-v0.5.81.md)
  - [Open issues status snapshot (2026-09-11)](/docs/zh-CN/archive/open-issues-status.md)
  - [ZCode plan proxy feasibility](/docs/zh-CN/archive/zcode-plan-proxy-feasibility.md)
  - [CatPaw 10Router feasibility](/docs/zh-CN/archive/catpaw-10router-feasibility.md)
  - [Contributors cache residue](/docs/zh-CN/archive/contributors-cache-residue.md) ([English](/docs/zh-CN/archive/contributors-cache-residue.en.md))

---

## 中文

10Router 网关 + 仪表盘的架构、工程设计与排障运维文档。

### 架构

- [架构总览](/docs/zh-CN/ARCHITECTURE.md)（[英文版](/docs/en/ARCHITECTURE.md)）— 完整系统设计：请求生命周期、组合/账号 fallback、OAuth + token 刷新、云端同步、SQLite 数据模型。

### 工程专题

- [流式 [DONE] 哨兵与客户端断开引发的假夭折修复](/docs/zh-CN/streaming-done-sentinel-abort-fix.md) — 客户端读到 `[DONE]` 立即关闭连接导致 `TransformStream.flush()` 跳过，将已完整交付的回答误记为 0 Token `[Streaming aborted]` 的根因剖析与架构修复（Issue #48 / PR #50）。
- [SQLite 驱动链](/docs/zh-CN/sqlite-driver-chain.md) — `bun:sqlite → better-sqlite3 → node:sqlite → sql.js` 的选择逻辑，以及 better-sqlite3 为何"构建期必需、运行时几乎不用"。
- [用量去重 usageKey 契约](/docs/zh-CN/usage-usageKey-contract.md) — 每次上游尝试打 `usageKey` 的去重契约，防止同毫秒丢计数（5 处调用点）。
- [跨账号「配额包到期优先」调度架构](/docs/zh-CN/earliest-expiry-first-architecture.md) — 为什么主路径绝不发起同步账单查询、SWR（Stale-While-Revalidate）轻量缓存设计与异常回退容错矩阵。
- [API Key 签名与密钥签名轮换](/docs/zh-CN/api-key-signing-rotation.md) — 密钥格式 `sk-{machineId}-{keyId}-{crc8}`、签名密文解析链、为何本地校验是 DB 查找（CRC 暂不强制——过渡态设计）、Rotate all 幂等防护与未来强校验规划。
- [Antigravity（反重力）接入指南与踩坑实录](/docs/zh-CN/antigravity-integration-guide.md) — 接入/排查 `antigravity` 渠道：先分清是出口 IP 问题、账号风控还是代码问题，避免一看到 403 就重登 token。
- [Antigravity 账号风险与恢复](/docs/zh-CN/antigravity-account-risk-and-recovery.md) — 用户向：低价家庭拼车风险、Play 付款资料地区修改、**18+ 年龄验证硬门槛**、风控分级与申诉路径。
- [用量导入行展示契约（meta.imported）](/docs/zh-CN/usage-import-rows.md) — usageHistory 与 requestDetails 的分工、打标/去重回填/读侧合成三件套、归并分页正确性证明与撞签打标的双显示边界。
- [mirasim 桌面端本地用量账本](/docs/zh-CN/mirasim-usage-ledger.md) — 作为同步数据源：insights 账本字段全表、"走了 10Router" 的识别信号、防双计规则与已知边界。
- [ZCode × CodeBuddy CN 兼容治理与插件协同设计](/docs/zh-CN/zcode-cbcn-compatibility-and-plugin-design.md) — CodeBuddy 11128 渠道级风控、会话体积控制与 `10router-sync` 插件扩展的协同方案。
- [ZCode 接入与本地反代完整指南](/docs/zh-CN/zcode-integration-and-proxy-guide.md) — 反代 ZCode 客户端、借助 CreditDaddy 网关消费免费试用包、以及官方 Coding Plan 订阅方案。
- [MITM 代理安全加固](/docs/zh-CN/mitm-security-hardening.md) — 四项安全修复（TLS 校验、root CA 私钥 0600、不再盲杀 443、hosts 清理）。
- [Mirasim 内嵌 dsh 工具调用 id/name 丢失](/docs/zh-CN/mirasim-dsh-toolcall-loss.md)（[英文版](/docs/en/mirasim-dsh-toolcall-loss.md)）— 第三方 bug 导致 11133 / `unknown tool ""`，10Router 不做适配。
- [托盘图标单色化](/docs/zh-CN/tray-icon-monochrome.md)（[英文版](/docs/en/tray-icon-monochrome.md)）— mac template 的 alpha 陷阱与 Windows 双主题注册表（任务栏 ≠ 应用模式）。
- [小米 MiMo 桌面版适配](/docs/zh-CN/xiaomi-mimo-desktop.md) — 设计 A（折进既有 `xiaomi-mimo` 做双认证）：各平台凭据路径、授权码流程、与官方客户端逐字节的协议对齐，以及 7 个坑的真因复盘。
- [小米 MiMo 模型清单：四方交叉](/docs/zh-CN/xiaomi-mimo-model-sources.md) — 官方目录 / models.dev / 桌面客户端 / 端点实测四方对比，定 Preview 归属与 `mimo-v2.5-pro-ultraspeed`。
- [用 Agent 添加自定义供应商](/docs/zh-CN/agent-add-custom-provider.md) — 通过 agent 驱动 10Router 注册新供应商的完整走法。

### CodeBuddy CN 兼容层

- [上游错误码速查与修复](/docs/zh-CN/codebuddy-cn-error-codes.md)（[英文版](/docs/en/codebuddy-cn-error-codes.md)）— 快速区分 11101/11128/11133/11134/11140/11150/11151 及 429/401/402 并给出修复/出路（含 11128 渠道级熔断）。
- [Agent 系统提示失忆修复](/docs/zh-CN/CodeBuddy-agent-amnesia-fix.md) — 白名单放行自家 Agent 提示，避免"失忆"。
- [reasoning_effort 兼容修复](/docs/zh-CN/CodeBuddy-reasoning-effort-fix.md) — DeepSeek 模型不支持 `auto`/`off`，映射为 `high`/删除。
- [CN 账号批量导入](/docs/zh-CN/codebuddy-cn-account-import.md) — 一次性导入多个 `codebuddy-cn` 账号。

### 运维与运维手册

- [仪表盘密码重置与找回](/docs/zh-CN/dashboard-password-recovery.md) — 忘记或锁定密码时通过数据目录 `reset-password` 文件免重装重置凭据机制。
- [安装包与 Release 资产校验指引](/docs/zh-CN/verify-downloads.md) — 手动下载产物时的 `SHA256SUMS-*.txt` 校验标准与防御边界。
- [`10router doctor` 诊断命令规格与实现](/docs/zh-CN/spec-10router-doctor.md) — 只读诊断命令设计与实现（解决环境与驱动遮蔽导致的暗坑）。
- [设计方案：托盘就绪握手](/docs/zh-CN/design-tray-ready-handshake.md) — 后台脱离进程启动时防谎报运行的设计方案。
- [本地测试构建与验证](/docs/zh-CN/local-build-and-verify.md) — Windows 桌面版 / fnOS fpk 共用一条流程：构建 → 就地替换 → 验证，及不入库的 `X.Y.Z-test.N` 测试版本号。
- [fnOS / NAS 热替换部署](/docs/zh-CN/fnos-hot-replace-deploy.md) — 无需重装 fpk 直接更新 fnOS 上的 10Router 服务端：预解包 → 原子重命名交换 → appcenter-cli 生命周期重启。
- [测试报告总索引](/docs/zh-CN/test-report-INDEX.md) — 本地测试轮次复盘、NAS 漏 pull 事故、ASAR 句柄锁与发版验证总索引（含多篇单项故障复盘报告）。

### 历史归档（发版审查与过时记录）

- [历史归档总索引](/docs/zh-CN/archive/README.md) — 集中收归历史发版审计报告、阶段性上游分诊、已结项调研与问题排查记录。
- 历史发版审查（`archive/reviews/`）：
  - [v1.0.7 发版审查](/docs/zh-CN/archive/reviews/release-review-v1.0.7.md) — 23 笔提交逐笔审查记录
  - [v1.1.0 发版范围评审](/docs/zh-CN/archive/reviews/release-review-v1.1.0.md) — 1.1.0 发版范围与决策记录（原 1.0.9 决策原貌）
  - [v1.1.1 发版前审计报告](/docs/zh-CN/archive/reviews/release-review-v1.1.1.md) — 全部 81 笔提交逐笔审读、全量回归门禁与发版最终检查单
  - [v1.1.2 全量审查报告](/docs/zh-CN/archive/reviews/release-review-v1.1.2.md) — v1.1.1 → HEAD 共 87 笔提交（150 文件，+8013/−621）安全/熔断/退避/凭据刷新/数据账本/i18n/供应商治理逐项审查、三注册表基线复核与发版检查单
  - [v1.2.0 全量审查报告](/docs/zh-CN/archive/reviews/release-review-v1.2.0.md) — v1.1.3 → v1.2.0 共 91 笔提交（347 文件，+17873/−1865）：6 高危 / 8 中危 / 一批低危逐条核查与修复状态、修复阶段新增的 CDP 无头浏览器探针方法论、发布元数据现状与发版检查单
- 阶段性调研与历史排查：
  - [上游 v0.5.69 → v0.5.75 分诊](/docs/zh-CN/archive/upstream-triage-v0.5.75.md) — 上游 7 个版本 26 笔提交内容分诊记录（已在 v1.1.0 落地）
  - [上游 v0.5.81 分诊](/docs/zh-CN/archive/upstream-triage-v0.5.81.md) — 上游 0.5.81 特性与变更接入分诊
  - [未关闭 Issue 现状汇总（2026-09-11 快照）](/docs/zh-CN/archive/open-issues-status.md) — 历史 issue 核对快照（其中 #12、#13、#14 现已全部关闭）
  - [ZCode 订阅渠道接入可行性](/docs/zh-CN/archive/zcode-plan-proxy-feasibility.md) — ZCode 订阅渠道接入调研（结论不可行已结项）
  - [美团妙手（CatPaw）接入 10Router 可行性报告](/docs/zh-CN/archive/catpaw-10router-feasibility.md) — 客户端与协议分析（结论：缺乏增量余额与闭环证据，不实施反代）
  - [Contributors 残留上游贡献者](/docs/zh-CN/archive/contributors-cache-residue.md)（[英文版](/docs/zh-CN/archive/contributors-cache-residue.en.md)）— fork detach 贡献者幽灵数据排查（已自愈）
