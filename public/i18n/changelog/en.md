# Changelog

User-facing highlights per release. See [CHANGELOG.md](https://github.com/techysy/10router/blob/main/CHANGELOG.md) for the full developer log.

## v1.0.6 (2026-09-05)

### ✨ New

- **CodeBuddy CN auto daily check-in** (experimental, off by default): with "CodeBuddy CN auto daily check-in" enabled under Settings → Experimental, the Import / Export buttons on the CodeBuddy CN page are replaced by an automatic daily check-in (each account checks in at a random 00:00–06:00 local time to renew free quota; failures never interrupt the service and a 401 triggers one token refresh + retry) plus a manual "Check in now" button
- **Antigravity quota aligned with the official site (5h + weekly dual window)**: Antigravity quotas on the usage page now use the official retrieveUserQuotaSummary RPC as the primary source, showing exactly **4 cards** per account (Gemini Models / Claude and GPT models × {5-hour, weekly}), normalized to a 0–100 scale; falls back to the old per-model parse when the RPC is unavailable
- **OpenCode Free catalog aligned with the official free list**: adds Big Pickle / MiMo-V2.5 / Ling 3.0 Flash Fin / Nemotron 3 Ultra / Nemotron 3.5 Lightning; deliberately excludes the DeepSeek / Laguna free tiers the official docs have dropped (avoids accidental paid calls)

### 🐛 Fixes
- **Antigravity `ag/gemini-3.8-flash-*` 404**: model addressing now uses per-tier tiered entities and the IDE fingerprint is bumped to 2.11.0 (bare ids 404 with "Requested entity was not found"); adds the un-tiered `ag/gemini-3.8-flash` (routed to the medium tier)
- **"Only with balance" misses newly-checked-in quota packs**: fixed a case where CodeBuddy CN's daily full packs were hidden after older packs were renumbered and the persistent hide never cleared — the hidden set is now recomputed live so any pack with remaining balance (including fresh full packs) always shows
- **Friendly message for free-model 429 rate limits**: when a free-tier model (`oc/*-free`, `contributor-free`, APInex `free/`-prefixed, etc.) hits an upstream rate limit and returns 429, the raw English `rate_limit_exceeded` is no longer passed through — instead a friendly Chinese message is returned showing an estimated wait ("try again in ~N sec/min/hr") when the upstream supplied a reset time, otherwise advising to retry later or switch to a paid tier. Paid models and multi-account fallback are untouched

## v1.0.5 (2026-09-03)

### ✨ New

- **Desktop tray app (Windows / macOS)**: an install-and-go desktop app — system tray menu (open console / start / restart / stop / launch at login) plus an embedded window; closing the window minimizes to the tray. Shares data, keys and port with the npm CLI (the two forms run exclusively). Windows ships an NSIS installer (silent `/S` supported) and a portable exe; macOS ships separate Intel + Apple Silicon dmgs
- **CLI / desktop UI localization**: the npm CLI and the desktop tray now follow the system language (Simplified Chinese / Traditional Chinese / English); override with the `TENROUTER_LANG` env var (`zh-CN` / `zh-TW` / `en`)
- **Self-serve custom providers + new Skills-page skill**: register a custom OpenAI/Anthropic-compatible endpoint (baseUrl + upstream key + models) at runtime with a dashboard LLM key — no source change, no repackage. The Dashboard **Skills** page gains a **10router-add-provider** card and now links to the `main` branch (previously `master`, which 404'd)
- **CodeBuddy CN account JSON bulk import / export** (experimental, off by default): after enabling "CodeBuddy CN OAuth import / export" under Settings → Providers, the CodeBuddy CN detail page shows Import / Export buttons to bulk-import or export account credentials in the third-party (wb) JSON format (import dedupes by identity and skips non-CodeBuddy issuers). Import / export now require a dashboard-password confirmation (prevents anonymous token export in no-login mode)
- **Community welfare providers show by default**: GoRouter / TaBiAI now appear by default (no need to toggle them on), consistent across the provider list / Profile toggle / usage topology
- **Community welfare providers sort into one group**: in the Free Tier list, community providers (GoRouter / TaBiAI) now cluster into one adjacent block per rank group instead of interleaving with regular freeTier providers by priority/name
- **New Agnes AI dual-site providers**: international **Agnes AI** (com) + **Agnes AI (CN)** — each with Agnes 2.5 Flash / 2.5 Pro text models (512K / 1M context, vision + reasoning), plus Agnes Image 2.x Flash image models (standard images/generations endpoint; image-to-image / editing)
- **New "Experimental" settings group**: Profile gains a dedicated Experimental card gathering the developer-oriented default-off toggles (Fetch models from GitHub JSON + CodeBuddy CN import/export) for easy future expansion
- **New provider APInex (apinex.bond)**: prepaid USD-credit third-party gateway (OpenAI-compatible) with 18 models (13 paid + 5 `free/`-prefixed free models); provider pages show a copyable invite-code chip (APInex: `SLEWP68C`)
- **Upstream v0.5.65 catalog sync + new search providers**: adds GLM-5.3-Flash(Vision), GLM-4.6V, DeepSeek-V4-Flash-Vision-Exp, Grok-4.6, Claude-Fable-5.1 and more; new search providers Ollama-Search (reuses your local Ollama key) and Xquik (X/Twitter search)

### 🐛 Fixes
- **Usage table corruption after Cost/Token switch**: toggling the display mode and sorting no longer reverts some rows to currency values; Traditional Chinese usage-table headers are now fully translated
- **Usage table sorting semantics**: token / cost columns now sort model groups by their totals, matching the header arrow direction

## v1.0.4 (2026-09-01)

### ✨ New
- **3 new providers**: **TokenBom** (decentralized token marketplace — idle API keys earn credits, credits call many models; 79-model online catalog), **GoRouter** (free gateway, no recharge entry), **TaBiAI** (free gateway, no recharge entry)
- **Usage history import**: import usage data from 9Router backups (SQLite files) — merged into stats without touching config
- **Notification overhaul**: global toasts moved to top-center; browser-native alert() dialogs replaced with friendly notifications
- **Community welfare providers**: GoRouter / TaBiAI are hidden by default with a "community" badge; toggle them on in **Settings → Providers → Show community welfare providers**

### 🐛 Fixes
- **Provider ordering fixed**: connected providers first, disabled sink to bottom — no longer scrambled by priority
- **JSON catalog models invisible after enabling**: stale disable records are now cleared ("enabled but not listed" resolved)
- **B.AI / CodeBuddy CN model catalogs completed**: missing models that caused "not found" when switching are added
- **Friendly maintenance hints on connection tests**: endpoint down / Cloudflare-blocked shows a maintenance note instead of a misleading "Invalid API key"
- **Account filter reminder**: quota-pack account filter persists; an amber reminder bar shows when a non-default filter is active
- **CodeBuddy CN DeepSeek 11150**: DeepSeek-series calls no longer fail with 400 on the reasoning-effort param (auto/off); coding agents (dsh, etc.) work normally
- **CodeBuddy empty tool name (11133 / unknown tool)**: empty `function.name` in streaming tool calls is normalized, so standard clients no longer mis-detect the tool name
- **Topology still shows hidden community providers**: the usage topology now honors the "Show community providers" toggle — community welfare sites (GoRouter/TaBiAI) are hidden when it's off
- **Skills page i18n + Chinese links**: Skills page text is now localized; in Chinese (zh-CN) the links point to the Chinese skill files

## v1.0.3 (2026-08-30)

### ✨ New
- **4 new providers**: **LongCat** (Meituan), **SenseNova** (SenseTime, free beta), **Dots** (Xiaohongshu Dots Studio, free beta), **B.AI** (aggregator — one key for GPT / Claude / Gemini / DeepSeek / GLM / Kimi / Qwen and more)
- **Model JSON catalogs for custom providers**: custom nodes can pull an online model list, toggle models on/off individually, and manage them in bulk
- **fpk update check goes straight to Releases**: fnOS installs jump directly to the matching release download

### 🔒 Security
- **Progressive login rate-limit**: 5 failed password attempts → 30s / 2m / 10m / 30m lockout
- **Reject placeholder JWT keys**: copying the public `.env.example` key is ignored; a random key is generated instead
- **Fix npm package leaking build-machine secrets**: no more keys / machine IDs / data snapshots in the build artifact

### ⚠️ Notes
- npm package renamed to **`@techysy/10router`** (the old `10router` is an unrelated fork). If you installed `10router-cli`, switch to the new package; data directory unchanged.

## v1.0.2 (2026-08-29)

### 🐛 Fixes
- **Update check no longer points at a third-party package** (affected 1.0.1): version check, update command, and sidebar install command all target the correct package
- **postinstall no longer aborts install**: npm install no longer fails from the warm-up script on WSL paths

### ⚙️ Engineering
- **Test CI added**: tests + regression gate run automatically on push / PR

> ⚠️ **1.0.1 users should upgrade**: its built-in "check for updates" points to an unrelated third-party package.

## v1.0.1 (unreleased; delivered with v1.0.2)

> 1.0.1 was never published as a release (only the npm `10router-cli@1.0.1` briefly existed). The following reached Docker / fpk / standalone users with **v1.0.2**.

### 🔒 Security
- **4 MITM security fixes**: upstream TLS cert validation restored, root CA private key locked to 0600, no longer blindly killing the process on port 443, auto-cleanup of leftover hosts entries (MITM is off by default)

### ✨ New
- **Disabled providers sink to the bottom** via a settings toggle
- **Collapsible desktop sidebar**
- **OpenCode Go quota usage**
- **Gitee mirror fallback for model catalogs** (faster in CN)

### 🐛 Fixes
- **/v1/models no longer returns orphan custom models**
- **Custom node prefix uniqueness check**
- **Fix CodeBuddy executor dropping the Agent system prompt**

### ⚙️ Engineering
- **New npm distribution channel**: `npm i -g 10router-cli`
- **Generic "fetch models from GitHub JSON" capability** (Fetch Models)

## v1.0.0 (2026-08-26)

### ⚠️ Notes
1. **Data directory renamed**: `~/.9router/` → `~/.10router/` (Windows: `%APPDATA%\10router`), auto-migrated on first start
2. **SAML entityID changed**: default issuer is now `urn:10router:sp`; re-register in your IdP
3. **MITM CA renamed**: re-trust the new CA

### ✨ New
- **Rebrand**: 9Router → 10Router
- **i18n multi-region currency**: en / pt-BR / pt-PT / es / de
- **Multi-platform distribution**: Docker (amd64 / arm64), fnOS fpk (x86 / arm × url / iframe), Standalone
