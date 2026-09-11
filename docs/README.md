# 10Router Documentation / 文档导航

[English](#english) · [中文](#中文)

---

## English

Architecture and engineering notes for the 10Router gateway + dashboard. All docs are bilingual under `docs/en/` (English) and `docs/zh-CN/` (简体中文).

### Architecture

- [Architecture](/docs/en/ARCHITECTURE.md) — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.

### Engineering deep-dives

- [SQLite Driver Chain](/docs/en/sqlite-driver-chain.md) — how `bun:sqlite → better-sqlite3 → node:sqlite → sql.js` is selected, and why `better-sqlite3` is build-time-required but barely used at runtime.
- [Usage Dedup usageKey Contract](/docs/en/usage-usageKey-contract.md) — the per-attempt `usageKey` dedup contract that prevents same-millisecond count loss (5 call sites).
- [API Key Signing & Secret Rotation](/docs/zh-CN/api-key-signing-rotation.md) — key format `sk-{machineId}-{keyId}-{crc8}`, the secret resolution chain, why local validation is a DB lookup (CRC not enforced yet — transition design), and the future strict-CRC plan (zh-only).
- [MITM Proxy Security Hardening](/docs/en/mitm-security-hardening.md) — the four security fixes (TLS verification, 0600 root CA key, no blind port-443 kill, hosts cleanup).
- [Mirasim-bundled dsh tool_call id/name loss](/docs/en/mirasim-dsh-toolcall-loss.md) — third-party bug causing 11133/`unknown tool ""`; 10Router does not work around it.
- [Monochrome Tray Icons](/docs/en/tray-icon-monochrome.md) — the alpha-channel trap of macOS template images and Windows' dual theme registries (taskbar ≠ app mode).
- [Xiaomi MiMo Desktop adaptation](/docs/zh-CN/xiaomi-mimo-desktop.md) (zh-only) — design A (dual auth on the existing `xiaomi-mimo`): credential paths per platform, the authorization-code flow, byte-exact protocol parity with the official client, and post-mortems of the 7 pitfalls.
- [Xiaomi MiMo model list — four-source cross-check](/docs/zh-CN/xiaomi-mimo-model-sources.md) (zh-only) — official catalog vs models.dev vs desktop client vs live endpoint, settling the Preview ownership and `mimo-v2.5-pro-ultraspeed`.
- [Adding a custom provider with an Agent](/docs/zh-CN/agent-add-custom-provider.md) (zh-only) — the walkthrough for driving 10Router through an agent to register a new provider.
- [ZCode plan proxy feasibility](/docs/zh-CN/zcode-plan-proxy-feasibility.md) (zh-only) — feasibility analysis for wiring a ZCode subscription channel into 10Router.

### CodeBuddy CN compatibility layers

- [Error Codes Reference](/docs/en/codebuddy-cn-error-codes.md) — quick classification of 11101/11128/11133/11150/11151 + 429/401/402 with fixes.
- [Agent System Prompt Amnesia Fix](/docs/en/CodeBuddy-agent-amnesia-fix.md) — whitelist to stop our own agents' prompts from being wiped (amnesia).
- [reasoning_effort Compatibility Fix](/docs/en/CodeBuddy-reasoning-effort-fix.md) — DeepSeek models reject `auto`/`off`; mapped to `high`/dropped.
- [CN account bulk import](/docs/zh-CN/codebuddy-cn-account-import.md) (zh-only) — importing several `codebuddy-cn` accounts at once.

### Repo operations

- [Contributors cache residue](/docs/en/contributors-cache-residue.md) — why the sidebar showed 248 upstream contributors after the fork detach; triage the three data sources and let the cache rebuild (no history rewrite).
- [v1.0.7 Release Review](/docs/zh-CN/release-review-v1.0.7.md) — per-commit review of the 23 commits in v1.0.7 (zh-only): security fixes verified, upstream v0.5.69 re-implementation audit, test regression gate, tag/SignPath checklist.
- [Local test build & verify](/docs/zh-CN/local-build-and-verify.md) (zh-only) — one flow for Windows desktop and fnOS fpk: build → replace in place → verify, plus the uncommitted `X.Y.Z-test.N` scheme.
- [v1.1.0 release-scope review](/docs/zh-CN/release-review-v1.1.0.md) (zh-only) — the scope/decision record for 1.1.0 (written while 1.0.9 was still planned; 1.0.9 was voided and folded into 1.1.0).
- [Upstream v0.5.69 → v0.5.75 triage](/docs/zh-CN/upstream-triage-v0.5.75.md) (zh-only) — item-by-item triage of seven upstream releases: what gets re-implemented here and why.
- [Open issues status](/docs/zh-CN/open-issues-status.md) (zh-only) — every open issue checked against the current code: the 11-item security audit with `file:line` evidence (1 fixed / 4 partial / 6 open), the content-filter retry design, and the v1.0.8 packaging post-mortem.

---

## 中文

10Router 网关 + 仪表盘的架构与工程文档。所有文档在 `docs/en/`（英文）与 `docs/zh-CN/`（简体中文）双语提供。

### 架构

- [架构总览](/docs/zh-CN/ARCHITECTURE.md) — 完整系统：请求生命周期、组合/账号 fallback、OAuth + token 刷新、云端同步、数据模型。

### 工程专题

- [SQLite 驱动链](/docs/zh-CN/sqlite-driver-chain.md) — `bun:sqlite → better-sqlite3 → node:sqlite → sql.js` 的选择逻辑，以及 better-sqlite3 为何"构建期必需、运行时几乎不用"。
- [用量去重 usageKey 契约](/docs/zh-CN/usage-usageKey-contract.md) — 每次上游尝试打 `usageKey` 的去重契约，防止同毫秒丢计数（5 处调用点）。
- [API Key 签名与密钥签名轮换](/docs/zh-CN/api-key-signing-rotation.md) — 密钥格式 `sk-{machineId}-{keyId}-{crc8}`、签名密文解析链、为何本地校验是 DB 查找（CRC 暂不强制——过渡态设计）、Rotate all 幂等防护与未来强校验规划。
- [MITM 代理安全加固](/docs/zh-CN/mitm-security-hardening.md) — 四项安全修复（TLS 校验、root CA 私钥 0600、不再盲杀 443、hosts 清理）。
- [Mirasim 内嵌 dsh 工具调用 id/name 丢失](/docs/zh-CN/mirasim-dsh-toolcall-loss.md) — 第三方 bug 导致 11133 / `unknown tool ""`，10Router 不做适配。
- [托盘图标单色化](/docs/zh-CN/tray-icon-monochrome.md) — mac template 的 alpha 陷阱与 Windows 双主题注册表（任务栏 ≠ 应用模式）。
- [小米 MiMo 桌面版适配](/docs/zh-CN/xiaomi-mimo-desktop.md) — 设计 A（折进既有 `xiaomi-mimo` 做双认证）：各平台凭据路径、授权码流程、与官方客户端逐字节的协议对齐，以及 7 个坑的真因复盘。
- [小米 MiMo 模型清单：四方交叉](/docs/zh-CN/xiaomi-mimo-model-sources.md) — 官方目录 / models.dev / 桌面客户端 / 端点实测四方对比，定 Preview 归属与 `mimo-v2.5-pro-ultraspeed`。
- [用 Agent 添加自定义供应商](/docs/zh-CN/agent-add-custom-provider.md) — 通过 agent 驱动 10Router 注册新供应商的完整走法。
- [ZCode 订阅渠道接入可行性](/docs/zh-CN/zcode-plan-proxy-feasibility.md) — 把 ZCode 订阅渠道接进 10Router 的可行性分析。

### CodeBuddy CN 兼容层

- [上游错误码速查与修复](/docs/zh-CN/codebuddy-cn-error-codes.md) — 快速区分 11101/11128/11133/11150/11151 及 429/401/402 并给出修复/出路。
- [Agent 系统提示失忆修复](/docs/zh-CN/CodeBuddy-agent-amnesia-fix.md) — 白名单放行自家 Agent 提示，避免"失忆"。
- [reasoning_effort 兼容修复](/docs/zh-CN/CodeBuddy-reasoning-effort-fix.md) — DeepSeek 模型不支持 `auto`/`off`，映射为 `high`/删除。
- [CN 账号批量导入](/docs/zh-CN/codebuddy-cn-account-import.md) — 一次性导入多个 `codebuddy-cn` 账号。

### 仓库运维

- [Contributors 残留上游贡献者](/docs/zh-CN/contributors-cache-residue.md) — fork detach 后侧边栏为何显示 248 个上游贡献者；三数据源定位 + 等缓存重建（勿重写历史）。
- [v1.0.7 发版审查](/docs/zh-CN/release-review-v1.0.7.md) — v1.0.7 全部 23 笔提交逐笔审查（安全修复验证/上游 v0.5.69 重实现审计/回归门禁/打 tag 与 SignPath 检查单）。
- [本地测试构建与验证](/docs/zh-CN/local-build-and-verify.md) — Windows 桌面版 / fnOS fpk 共用一条流程：构建 → 就地替换 → 验证，及不入库的 `X.Y.Z-test.N` 测试版本号。
- [v1.1.0 发版范围评审](/docs/zh-CN/release-review-v1.1.0.md) — 1.1.0 的范围与逐项决策记录（写于 1.0.9 尚在计划时；1.0.9 已作废并入 1.1.0）。
- [上游 v0.5.69 → v0.5.75 分诊](/docs/zh-CN/upstream-triage-v0.5.75.md) — 上游七个版本逐项分诊：哪些在本仓重实现、哪些不并，以及依据。
- [未关闭 Issue 现状汇总](/docs/zh-CN/open-issues-status.md) — 全部 open issue 逐一对照当前代码核查：11 项安全审计的逐项状态（✅1 / 🟡4 / ❌6，附 `文件:行` 证据）、内容过滤重试的设计要点、v1.0.8 产物不一致的复盘。

---

> Full developer changelog: [CHANGELOG.md](/CHANGELOG.md) · 完整开发日志：[CHANGELOG.md](/CHANGELOG.md)
