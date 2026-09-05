---
name: zcode-usage-sync
description: Export ZCode's local model-usage ledger into 10Router via /api/settings/database/import-usage. Use when the user asks to 导出/同步/导入 ZCode 使用量到 10Router, sync zcode usage, export usage to 10router, or asks how much they used ZCode and wants it recorded in 10Router stats.
---

# ZCode Usage Sync → 10Router

Export this machine's ZCode model-usage ledger into 10Router's usage statistics.

## Preconditions (check before running)

1. **10Router endpoint** — default `http://127.0.0.1:20127`. If the user runs 10Router elsewhere (NAS, LAN), ask or infer from context. For a NAS/remote instance use its address, e.g. `http://192.168.31.101:20127`.
2. **Credential (one of)** —
   - Virtual key (recommended): created in 10Router dashboard → API Keys, format `sk-…`. Pass via `--key`.
   - Dashboard password: pass via `--password`.
   - The script also reads env vars `TENROUTER_ENDPOINT` / `TENROUTER_KEY` / `TENROUTER_PASSWORD`.
3. Never ask the user to paste credentials into chat if they already configured them; prefer env/config over interactive prompts.

## Run

Dry-run first (shows row counts per provider, imports nothing):

```bash
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --endpoint <URL> --key <sk-…> --dry-run
```

Then import:

```bash
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --endpoint <URL> --key <sk-…>
```

Notes:
- The script is **idempotent**: 10Router dedups by row signature, so re-running never duplicates rows.
- It **excludes providers whose baseURL points at 10Router itself** (those calls are already counted), so only official-channel usage (builtin:bigmodel-*, builtin:zai-*, …) is exported.
- Each row becomes provider `zcode-<name>` in 10Router, cost 0 (subscription plans), with agent/session metadata under `meta`.
- `--limit N` exports only the newest N rows; `--quiet` suppresses progress output.

## After running

Report the result line (`imported X, skipped Y`) and remind the user the numbers appear on the 10Router dashboard (Usage section) under the `zcode-*` providers.

## Troubleshooting

- `HTTP 401 Invalid password` → key revoked or wrong password; create a new virtual key in the dashboard.
- `HTTP 401 Unauthorized` (error text "Unauthorized") → request was blocked by the global guard before reaching the route; means neither key nor password header reached it — check the script's auth flags.
- `connection refused` → wrong endpoint or 10Router not running.
- `no ZCode db.sqlite found` → ZCode has never recorded usage on this machine.
