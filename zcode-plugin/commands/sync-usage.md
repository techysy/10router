---
description: Export ZCode's local usage ledger into 10Router (idempotent, uses /api/settings/database/import-usage)
---

Export ZCode model-usage records into 10Router by running the plugin's export script.

Steps:

1. Determine the 10Router endpoint: default `http://127.0.0.1:20127`; if the user gave an address in $ARGUMENTS (e.g. a NAS IP), use it via `--endpoint`.
2. Determine credentials: use `--key sk-…` (virtual key from 10Router dashboard → API Keys, recommended) or `--password`. If neither is known, ask the user for one.
3. Run a dry-run first and summarize what would be exported:

```bash
node "$ZCODE_PLUGIN_ROOT/scripts/export-usage.mjs" --endpoint <URL> --key <sk-…> --dry-run
```

4. If the dry-run looks right (non-zero rows, sensible provider split), run the real import and report the `imported X, skipped Y` result. The operation is idempotent — safe to re-run.
5. If the user writes in Chinese, respond in Chinese.

Arguments (all optional): $ARGUMENTS
