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
- [Model JSON Catalog Mechanism](/docs/en/json-model-catalog-mechanism.md) — `modelsJsonUrl` online model catalogs, Gitee fallback, and the "enabled but not listed" pitfall.
- [MITM Proxy Security Hardening](/docs/en/mitm-security-hardening.md) — the four security fixes (TLS verification, 0600 root CA key, no blind port-443 kill, hosts cleanup).
- [Mirasim-bundled dsh tool_call id/name loss](/docs/en/mirasim-dsh-toolcall-loss.md) — third-party bug causing 11133/`unknown tool ""`; 10Router does not work around it.
- [Stream-default spec fix (issue #4)](/docs/en/stream-default-spec-fix.md) — omitted `stream` was misjudged as streaming; experimental `strictStreamDefault` toggle restores the OpenAI-spec default.

### CodeBuddy CN compatibility layers

- [Agent System Prompt Amnesia Fix](/docs/en/CodeBuddy-agent-amnesia-fix.md) — whitelist to stop our own agents' prompts from being wiped (amnesia).
- [reasoning_effort Compatibility Fix](/docs/en/CodeBuddy-reasoning-effort-fix.md) — DeepSeek models reject `auto`/`off`; mapped to `high`/dropped.

---

## 中文

10Router 网关 + 仪表盘的架构与工程文档。所有文档在 `docs/en/`（英文）与 `docs/zh-CN/`（简体中文）双语提供。

### 架构

- [架构总览](/docs/zh-CN/ARCHITECTURE.md) — 完整系统：请求生命周期、组合/账号 fallback、OAuth + token 刷新、云端同步、数据模型。

### 工程专题

- [SQLite 驱动链](/docs/zh-CN/sqlite-driver-chain.md) — `bun:sqlite → better-sqlite3 → node:sqlite → sql.js` 的选择逻辑，以及 better-sqlite3 为何"构建期必需、运行时几乎不用"。
- [用量去重 usageKey 契约](/docs/zh-CN/usage-usageKey-contract.md) — 每次上游尝试打 `usageKey` 的去重契约，防止同毫秒丢计数（5 处调用点）。
- [模型 JSON 目录机制](/docs/zh-CN/json-model-catalog-mechanism.md) — `modelsJsonUrl` 在线模型目录、Gitee 回退，以及"激活了却不显示"的坑。
- [MITM 代理安全加固](/docs/zh-CN/mitm-security-hardening.md) — 四项安全修复（TLS 校验、root CA 私钥 0600、不再盲杀 443、hosts 清理）。
- [Mirasim 内嵌 dsh 工具调用 id/name 丢失](/docs/zh-CN/mirasim-dsh-toolcall-loss.md) — 第三方 bug 导致 11133 / `unknown tool ""`，10Router 不做适配。
- [stream 默认值规范修复（issue #4）](/docs/zh-CN/stream-default-spec-fix.md) — 省略 `stream` 被误判为流式；实验性开关 `strictStreamDefault` 恢复 OpenAI 规范默认。

### CodeBuddy CN 兼容层

- [Agent 系统提示失忆修复](/docs/zh-CN/CodeBuddy-agent-amnesia-fix.md) — 白名单放行自家 Agent 提示，避免"失忆"。
- [reasoning_effort 兼容修复](/docs/zh-CN/CodeBuddy-reasoning-effort-fix.md) — DeepSeek 模型不支持 `auto`/`off`，映射为 `high`/删除。

---

> Full developer changelog: [CHANGELOG.md](/CHANGELOG.md) · 完整开发日志：[CHANGELOG.md](/CHANGELOG.md)
