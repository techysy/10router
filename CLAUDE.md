# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

10Router (`10router-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:
- The **dashboard + gateway** (root `package.json`, `10router-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, published to npm as `@techysy/10router`) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), and `tests/`.

## Commands

Dashboard/gateway (run from repo root):
```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev   # dev (webpack, port 20127 by default via next dev)
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start           # production
```
- Bun variants: `npm run dev:bun` / `build:bun` / `start:bun`.
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Lint: `npx eslint .` (config `eslint.config.mjs`, extends `eslint-config-next`).

CLI package (`cli/`):
```bash
npm run cli:pack       # build + npm pack from root
cd cli && npm run dev  # nodemon watch
```

Local test build (stamp a throwaway version, build, replace in place, verify):
```bash
npm run test-version 1.1.0-test.1   # 三处 package.json + fnos manifest 同号, uncommitted
npm run test-version -- --check     # 看当前状态; --revert 回退 (refuses if those files carry other changes)
```
Never rebuild with a **released** version number — that is how 1.0.8 ended up with three different payloads
under one version. Full flow (Windows desktop / fnOS fpk), verification method and traps:
`docs/zh-CN/local-build-and-verify.md`. Note `ELECTRON_RUN_AS_NODE=1` in your shell makes `10Router.exe`
run as plain Node (no tray, no logs, silent exit) — looks exactly like a broken build.

Tests (vitest, in `tests/`, an **independent** ESM package — not wired into root `npm test`):
```bash
npm install                             # ROOT deps first — tests import from src/ which needs `open`, `undici`, etc.
cd tests && npm install                 # then tests' own deps (vitest) → tests/node_modules (allowed by tests/.gitignore)
npx vitest run                          # all tests; auto-discovers tests/vitest.config.js
npx vitest run unit/capabilities.test.js   # single file (path relative to tests/)
```
> The committed `tests/package.json` `test` script hardcodes Unix paths (`NODE_PATH=/tmp/node_modules …`) — a shared-install workaround from upstream. On Windows (or anywhere), ignore it and use the `npx vitest` form above; `vitest.config.js` resolves the `open-sse`/`@/` aliases from the repo root regardless of where vitest lives.
>
> **The suite is NOT expected to be all-green on a plain checkout.** ~1872 pass, ~41 fail. Judge regressions with `tests/__baseline__/verify-no-regression.mjs <results.json>`, not a raw run — it passes as long as nothing that passed in the baseline now fails. Produce the report with `npx vitest run --reporter=json --outputFile=…`. Expected red:
> - All 41 catalogued in `tests/__baseline__/known-fails.txt` (golden snapshot drift, windsurf URL, network-dependent fetches, `db-concurrent`, …). Re-baseline deliberately with `node tests/__baseline__/snapshot-known-fails.mjs <results.json>` — it marks *every* failure in that report as expected, so read the gate output first.
> - `unit/embeddings.cloud.test.js` imports `cloud/src/handlers/embeddings.js` — the `cloud/` worker dir is **not in this repo**, so it always fails here.
> - `unit/db-benchmark.test.js` imports `lowdb`, the DB layer that SQLite replaced — it is no longer a dependency.
> - `real/*.real.test.js` make live provider calls — need credentials, skip otherwise.
>
> Suite-level failures (`numFailedTestSuites`) are counted separately from assertion failures: a file whose cases all pass can still fail on import or teardown. Check both.
>
> Four files (`auth/saml`, `unit/kimchi*`, `unit/cli-build-artifacts`) are written against **`node:test`**, not vitest. They carry a shim that prefers `vitest` when importable and falls back to `node:test`; without it vitest reports "No test suite found" and their results silently reach no count. Copy that shim in any new `node:test` file.
- `*.real.test.js` under `tests/translator/real/` make live provider calls — skip unless credentials are set.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.
- Capability audit: `node scripts/audit-capabilities.mjs` (offline, no deps) replays the `getCapabilitiesForModel()` chain over every registry model and reports models that fall through to `DEFAULT_CAPABILITIES` (invisible to users but silently strips images / clamps `max_tokens`), multimodal-looking ids resolving to `vision:false`, and provider rows for delisted models. `--check` exits 1 on a violation. Its allowlist + resolver replay are the single source of truth for `tests/unit/capability-floor-allowlist.test.js` — add an allowlist entry (with a reason) rather than asserting in the test. CI prints the report on every run; the gate is the vitest case.
- CI runs the suite on every push to `main` and every PR (`.github/workflows/test.yml`, ubuntu + Node 24, matching `.nvmrc`). It runs the three registry baselines, the capability audit, then the regression gate, and uploads the JSON report as an artifact — download that to re-baseline. The other three workflows only build (fpk / standalone / Docker).

## Architecture

Two authoritative docs already exist — read them before working in these areas rather than re-deriving:
- `docs/en/ARCHITECTURE.md`（中文版 `docs/zh-CN/ARCHITECTURE.md`） — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.
- `open-sse/AGENTS.md` — the routing/translation engine's own conventions and "how to add a provider/executor/translator". **Read this before editing anything under `open-sse/`.**

### Request flow (the thing to understand first)
`src/app/api/v1/*` route (Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (parse, combo expansion, account-selection loop)
→ `open-sse/handlers/chatCore.js` (detect source format, translate request, dispatch to executor, retry/refresh, stream setup)
→ `open-sse/executors/*` (per-provider upstream call; `default.js` handles any OpenAI-compatible provider)
→ `open-sse/translator/*` (client format ↔ provider format)
→ SSE back to client.

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

### Translator engine (`open-sse/translator/`)
- Pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop. Prefer a direct route for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side effect — a new translator file MUST be imported in `open-sse/translator/index.js` or it never runs.
- Never hardcode role/block/model strings — use `open-sse/translator/schema/` and `open-sse/config/` constants. Config-driven and DRY is enforced by convention here.

### Provider registry (`open-sse/providers/registry/*`)
- One file per provider. `providers/registry/index.js` is an **auto-generated** static import list — regenerate it with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, don't hand-edit.
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js`, add models to `config/providerModels.js`. Only add an executor for non-OpenAI-compatible upstreams.

### Persistence
State is **no longer `db.json`**. It's a SQLite layer under `src/lib/db/` with an adapter fallback chain (`driver.js`): `bun:sqlite` → `better-sqlite3` (optional native dep) → `node:sqlite` (Node ≥22.5) → `sql.js` (pure-JS fallback, always works). `better-sqlite3` is deliberately in `optionalDependencies` so install never fails without build tools.
- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code should import from `@/lib/db/index.js`; per-entity logic lives in `src/lib/db/repos/*`. Schema/migrations in `src/lib/db/migrations/`.
- DB file location resolves via `src/lib/dataDir.js` (`DATA_DIR`, else `~/.10router/`; one-time migration copies a legacy `~/.9router/` dir on first start).
- Usage/logs live in the same SQLite DB (`src/lib/db/`) and follow `DATA_DIR`.

### RTK token saver (`open-sse/rtk/`)
Pre-translate hooks that compress `tool_result` content in-place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of them. Skips `is_error`/`status:"error"` results to preserve traces.

## Conventions & gotchas

- Plain JavaScript (ESM), no TypeScript. `@/*` path alias → `src/*` (`jsconfig.json`).
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy. Preserve this when touching request/IP/rate-limit code.
- Security-sensitive env: `JWT_SECRET` (session cookie), `INITIAL_PASSWORD` (default `123456` — must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Full env contract in `.env.example` and ARCHITECTURE.md's env matrix.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- Versioning: root and `cli/` are versioned independently; changes are logged in `CHANGELOG.md`. Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).
- **Upstream features are re-implemented, never merged.** This fork's git history is deliberately rewritten (only techysy/ShiYanG Yu commits) and the contributor set is clean — that property is load-bearing. When upstream (decolua/9router) ships a feature, read the upstream implementation to learn the approach, then write it here in this repo's own style as your own commit(s). Never `git merge`/cherry-pick upstream branches, and never overlay an upstream tarball (`curl … | tar xz`) — both drag upstream commits and unreviewed code into the tree (this is how the qoder-cn registry-regen incident wiped deliberate provider hiding).
