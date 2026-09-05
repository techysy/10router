#!/usr/bin/env node
/**
 * 10router ZCode usage exporter.
 *
 * Reads ZCode's local model_usage ledger (~/.zcode/cli/db/db.sqlite, table
 * model_usage), converts rows to 10router usageHistory entries, and POSTs them
 * to /api/settings/database/import-usage (Bearer virtual key). Dedup on the
 * 10router side makes re-runs idempotent, so syncing the whole table each time
 * is safe and simple.
 *
 * Auth: one of
 *   --key sk-…            virtual proxy key from 10router dashboard (preferred)
 *   --password <pass>     dashboard password (same as usage-import UI)
 * Config: --endpoint http://host:port (default http://127.0.0.1:20127)
 *
 * Safety: ZCode's db.sqlite is a live WAL database. Never open it in place —
 * copy db.sqlite (+ -wal/-shm when present) to a temp dir and open the copy.
 *
 * Manual smoke test:
 *   node export-usage.mjs --endpoint http://127.0.0.1:20127 --key sk-… --dry-run
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    endpoint: process.env.TENROUTER_ENDPOINT || "http://127.0.0.1:20127",
    key: process.env.TENROUTER_KEY || "",
    password: process.env.TENROUTER_PASSWORD || "",
    limit: 0,
    dryRun: false,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--endpoint") args.endpoint = argv[++i];
    else if (a === "--key") args.key = argv[++i];
    else if (a === "--password") args.password = argv[++i];
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10) || 0;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node export-usage.mjs [--endpoint URL] [--key sk-...] [--password PASS] [--limit N] [--dry-run] [--quiet]`);
      process.exit(0);
    }
  }
  if (!args.key && !args.password) {
    console.error("error: provide --key sk-… (virtual key, recommended) or --password <dashboard password>");
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv);
const log = (...m) => { if (!args.quiet) console.log(...m); };

// ---------------------------------------------------------------------------
// ZCode db discovery
// ---------------------------------------------------------------------------

function zcodeDbCandidates() {
  const home = os.homedir();
  const list = [];
  const primary = path.join(home, ".zcode", "cli", "db", "db.sqlite");
  if (fs.existsSync(primary)) list.push(primary);
  // Older / alternate layout: per-project dirs under ~/.zcode/projects.
  const projectsDir = path.join(home, ".zcode", "projects");
  try {
    for (const name of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, name, "db.sqlite");
      if (fs.existsSync(candidate)) list.push(candidate);
    }
  } catch { /* no projects dir */ }
  return list;
}

// Copy a live WAL sqlite set to a temp file before opening (never touch the
// original; node:sqlite cannot open a WAL db that another process is writing).
function snapshotDb(srcPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-usage-"));
  const dst = path.join(tmpDir, "db.sqlite");
  fs.copyFileSync(srcPath, dst);
  for (const suffix of ["-wal", "-shm"]) {
    const src = srcPath + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, dst + suffix);
  }
  return { tmpDir, dst };
}

// ---------------------------------------------------------------------------
// model_usage → usageHistory conversion
// ---------------------------------------------------------------------------

// Providers whose baseURL points at 10router itself: their calls are already
// accounted in 10router's usageHistory, importing them again would double-count.
function loadSelfProviderIds() {
  const ids = new Set();
  const cfgPath = path.join(os.homedir(), ".zcode", "v2", "config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    for (const [id, p] of Object.entries(cfg.provider || {})) {
      const baseURL = String(p?.options?.baseURL || "");
      if (/[:/]20127\b|\/v1\b/.test(baseURL) && /10router|127\.0\.0\.1|192\.168\.|localhost/i.test(baseURL + " " + (p?.name || ""))) {
        ids.add(id);
      }
    }
  } catch { /* no config — nothing to exclude */ }
  return ids;
}

function statusTo10r(status) {
  // model_usage: completed | error | cancelled → usageHistory: ok | error
  if (status === "completed") return "ok";
  if (status === "error") return "error";
  return "error"; // cancelled mid-flight still consumed tokens; count as error
}

const ZCODE_PROVIDER_PREFIX = "zcode-";

function convertRow(row) {
  const tokens = {
    prompt_tokens: row.input_tokens || 0,
    completion_tokens: row.output_tokens || 0,
    ...(row.reasoning_tokens ? { reasoning_tokens: row.reasoning_tokens } : {}),
    ...(row.cache_creation_input_tokens ? { cache_creation_input_tokens: row.cache_creation_input_tokens } : {}),
    ...(row.cache_read_input_tokens ? { cache_read_input_tokens: row.cache_read_input_tokens } : {}),
  };
  const startedMs = row.started_at || row.completed_at || Date.now();
  return {
    timestamp: new Date(startedMs).toISOString(),
    provider: ZCODE_PROVIDER_PREFIX + String(row.provider_id || "unknown").replace(/^builtin:/, ""),
    model: row.model_id || "unknown",
    connectionId: null,
    apiKey: null,
    endpoint: "zcode://" + (row.agent || "session"),
    // cost stays 0: official channels are subscription plans, not metered API spend
    cost: 0,
    status: statusTo10r(row.status),
    tokens,
    meta: {
      source: "zcode",
      zcodeProviderId: row.provider_id || null,
      agent: row.agent || null,
      sessionId: row.session_id || null,
      durationMs: row.duration_ms ?? null,
      planUsage: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Import POST
// ---------------------------------------------------------------------------

async function importBatch(entries, { endpoint, key, password }) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  if (password) headers["x-9r-password"] = password;
  const res = await fetch(`${endpoint.replace(/\/$/, "")}/api/settings/database/import-usage`, {
    method: "POST",
    headers,
    body: JSON.stringify({ usageHistory: entries }),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    throw new Error(`import failed: HTTP ${res.status} ${data.error || text.slice(0, 200)}`);
  }
  return data; // { imported, skipped, total, source }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const selfIds = loadSelfProviderIds();
  const dbs = zcodeDbCandidates();
  if (dbs.length === 0) {
    console.error("error: no ZCode db.sqlite found (~/.zcode/cli/db/db.sqlite)");
    process.exit(1);
  }

  const entries = [];
  const seenIds = new Set();
  for (const dbPath of dbs) {
    const { tmpDir, dst } = snapshotDb(dbPath);
    try {
      const db = new DatabaseSync(dst, { readOnly: true });
      try {
        // Schema drift tolerance: only select columns guaranteed by the current
        // schema; older builds may lack some — tolerate via try/catch below.
        let rows;
        try {
          rows = db.prepare(`SELECT logical_request_id, provider_id, model_id, agent, status, started_at, completed_at, duration_ms, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM model_usage ORDER BY started_at ASC`).all();
        } catch {
          rows = db.prepare(`SELECT logical_request_id, provider_id, model_id, agent, status, started_at, completed_at, duration_ms, input_tokens, output_tokens FROM model_usage ORDER BY started_at ASC`).all();
        }
        for (const row of rows) {
          if (selfIds.has(row.provider_id)) continue; // already in 10router
          if (row.provider_id && row.logical_request_id) {
            const dedupId = `${row.provider_id}|${row.logical_request_id}`;
            if (seenIds.has(dedupId)) continue;
            seenIds.add(dedupId);
          }
          entries.push(convertRow(row));
        }
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  let selected = entries;
  if (args.limit > 0) selected = entries.slice(-args.limit);

  if (selected.length === 0) {
    log("nothing to import (0 rows after filtering)");
    return;
  }

  if (args.dryRun) {
    log(`[dry-run] would import ${selected.length} rows to ${args.endpoint}`);
    const byProvider = {};
    for (const e of selected) byProvider[e.provider] = (byProvider[e.provider] || 0) + 1;
    for (const [p, c] of Object.entries(byProvider).sort()) log(`  ${p}: ${c}`);
    log(`  sample: ${JSON.stringify(selected[selected.length - 1]).slice(0, 240)}`);
    return;
  }

  // One batch; 10router inserts in a single transaction. Keep payloads bounded
  // in case a ledger grows huge — 5k rows ≈ 2 MB JSON.
  const BATCH = 5000;
  let imported = 0, skipped = 0;
  for (let i = 0; i < selected.length; i += BATCH) {
    const data = await importBatch(selected.slice(i, i + BATCH), args);
    imported += data.imported || 0;
    skipped += data.skipped || 0;
  }
  log(`done: imported ${imported}, skipped ${skipped} (of ${selected.length})`);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
