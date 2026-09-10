#!/usr/bin/env node
/**
 * 10router usage exporter — supports ZCode, OpenCode *and* mirasim.
 *
 * Reads a local model-usage ledger (ZCode: ~/.zcode/cli/db/db.sqlite,
 * OpenCode: ~/.local/share/opencode/opencode.db,
 * mirasim: ~/.mirasim/insights/usage-*.ndjson) and either POSTs to
 * 10Router's /api/settings/database/import-usage (online) or writes a JSON
 * file for offline import.
 *
 * Modes:
 *   (default)  export + POST to --endpoint            (needs network + auth)
 *   --export F collect rows, write JSON file F        (no network, no auth)
 *   --import F read JSON file F, POST to --endpoint   (needs network + auth)
 *
 * Source selection:
 *   --source zcode      (default) read ZCode ledger
 *   --source opencode   read OpenCode desktop ledger
 *   --source mirasim    read mirasim desktop insights ledger
 *
 * Auth (online modes): one of
 *   --key sk-…            virtual proxy key from 10router dashboard (preferred)
 *   --password <pass>     dashboard password (same as usage-import UI)
 * Config: --endpoint http://host:port (default http://127.0.0.1:20127)
 *
 * Manual smoke test:
 *   node export-usage.mjs --endpoint http://127.0.0.1:20127 --key sk-… --dry-run
 *   node export-usage.mjs --export zcode-usage.json
 *   node export-usage.mjs --source opencode --export opencode-usage.json
 *   node export-usage.mjs --source mirasim --export mirasim-usage.json
 *   node export-usage.mjs --import opencode-usage.json --endpoint http://nas:20128 --key sk-…
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
    source: "zcode", // "zcode" | "opencode" | "mirasim"
    limit: 0,
    dryRun: false,
    quiet: false,
    exportFile: null,
    importFile: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--endpoint") args.endpoint = argv[++i];
    else if (a === "--key") args.key = argv[++i];
    else if (a === "--password") args.password = argv[++i];
    else if (a === "--source") args.source = argv[++i];
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10) || 0;
    else if (a === "--export") args.exportFile = argv[++i];
    else if (a === "--import") args.importFile = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node export-usage.mjs [mode] [options]

Modes (pick at most one; default = read db + POST online):
  --export <file>      read local db, write usageHistory JSON (no network/auth)
  --import <file>      POST a previously exported JSON to --endpoint

Source:
  --source zcode       (default) read ZCode ledger (~/.zcode/cli/db/db.sqlite)
  --source opencode    read OpenCode desktop ledger (~/.local/share/opencode/opencode.db)
  --source mirasim     read mirasim insights ledger (~/.mirasim/insights/usage-*.ndjson)

Options:
  --endpoint URL       10Router base URL (default http://127.0.0.1:20127)
  --key sk-...         virtual proxy key (recommended)   [online modes]
  --password PASS      dashboard password                 [online modes]
  --limit N            keep only the newest N rows
  --dry-run            show what would be sent, send nothing
  --quiet              suppress progress output`);
      process.exit(0);
    }
  }
  if (args.exportFile && args.importFile) {
    console.error("error: --export and --import are mutually exclusive");
    process.exit(2);
  }
  if (!["zcode", "opencode", "mirasim"].includes(args.source)) {
    console.error(`error: --source must be "zcode", "opencode" or "mirasim", got "${args.source}"`);
    process.exit(2);
  }
  // Offline export needs neither endpoint nor credentials.
  if (!args.exportFile && !args.key && !args.password) {
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
// OpenCode db discovery
// ---------------------------------------------------------------------------

function opencodeDbCandidates() {
  const home = os.homedir();
  const candidates = [];
  // Primary: ~/.local/share/opencode/opencode.db (works on all platforms)
  candidates.push(path.join(home, ".local", "share", "opencode", "opencode.db"));
  // Windows fallback: %LOCALAPPDATA%\opencode\opencode.db
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    candidates.push(path.join(localAppData, "opencode", "opencode.db"));
  }
  return candidates.filter((p) => fs.existsSync(p));
}

function convertOpenCodeSession(s) {
  // model field is JSON: {"id":"mimo-v2.5-free","providerID":"opencode","variant":"default"}
  let modelId = "unknown";
  let providerID = "opencode";
  if (s.model) {
    try {
      const m = typeof s.model === "string" ? JSON.parse(s.model) : s.model;
      modelId = m.id || "unknown";
      providerID = m.providerID || "opencode";
    } catch {
      modelId = String(s.model);
    }
  }
  const tokens = {
    prompt_tokens: s.tokens_input || 0,
    completion_tokens: s.tokens_output || 0,
  };
  if (s.tokens_cache_read) tokens.cache_read_input_tokens = s.tokens_cache_read;
  return {
    timestamp: new Date(s.time_created).toISOString(),
    provider: "opencode-" + providerID,
    model: modelId,
    connectionId: null,
    apiKey: null,
    endpoint: "opencode://desktop",
    cost: s.cost || 0,
    status: "ok",
    tokens,
    meta: {
      source: "opencode",
      opencodeSessionId: s.id || null,
      title: s.title || null,
      agent: s.agent || null,
      reasoning_tokens: s.tokens_reasoning || 0,
      cache_write_tokens: s.tokens_cache_write || 0,
    },
  };
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

// Read every ZCode db snapshot and return converted usageHistory entries.
function collectZcodeEntries() {
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
  return entries;
}

// Read OpenCode desktop db and return converted usageHistory entries.
function collectOpencodeEntries() {
  const dbs = opencodeDbCandidates();
  if (dbs.length === 0) {
    console.error("error: no OpenCode db found (~/.local/share/opencode/opencode.db)");
    process.exit(1);
  }

  const entries = [];
  for (const dbPath of dbs) {
    // OpenCode uses WAL too; snapshot before reading.
    const { tmpDir, dst } = snapshotDb(dbPath);
    try {
      const db = new DatabaseSync(dst, { readOnly: true });
      try {
        const rows = db.prepare(`SELECT id, title, model, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated FROM session ORDER BY time_created ASC`).all();
        for (const row of rows) {
          entries.push(convertOpenCodeSession(row));
        }
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// mirasim insights ledger (~/.mirasim/insights/usage-YYYY-MM.ndjson)
// ---------------------------------------------------------------------------

function mirasimLedgerFiles() {
  const dir = path.join(os.homedir(), ".mirasim", "insights");
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => /^usage-\d{4}-\d{2}\.ndjson$/.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  } catch { /* no insights dir */ }
  return files;
}

// mirasim rows are ndjson with per-call token counts; `id` is unique per call.
// HTTP >=400 rows are failed calls — mirasim logs 0 tokens on them, so keep
// only rows that actually consumed tokens to avoid zero-rows noise.
const MIRASIM_PROVIDER_PREFIX = "mirasim-";

function convertMirasimRow(e) {
  const tokens = {
    prompt_tokens: e.input || 0,
    completion_tokens: e.output || 0,
  };
  if (e.cacheRead) tokens.cache_read_input_tokens = e.cacheRead;
  if (e.cacheWrite) tokens.cache_creation_input_tokens = e.cacheWrite;
  if (e.reasoning) tokens.reasoning_tokens = e.reasoning;
  const statusOk = (e.status || 0) >= 200 && (e.status || 0) < 400;
  return {
    timestamp: e.ts,
    provider: MIRASIM_PROVIDER_PREFIX + String(e.provider || "unknown"),
    model: e.model || "unknown",
    connectionId: null,
    apiKey: null,
    endpoint: "mirasim://" + (e.agent || e.leg || "relay"),
    cost: 0, // mirasim relay is plan-based, not metered API spend
    status: statusOk ? "ok" : "error",
    tokens,
    meta: {
      source: "mirasim",
      mirasimCallId: e.id || null,
      relayCallId: e.relayCallId || null,
      agent: e.agent || null,
      leg: e.leg || null,
      viaRelay: e.viaRelay ?? null,
      upstreamHost: e.upstreamHost || null,
      effort: e.effort || null,
      httpStatus: e.status ?? null,
      durationMs: e.durationMs ?? null,
      repo: e.repo || null,
      workspace: e.workspace || null,
      planUsage: true,
    },
  };
}

// Read every mirasim insights ledger and return converted usageHistory entries.
function collectMirasimEntries() {
  const files = mirasimLedgerFiles();
  if (files.length === 0) {
    console.error("error: no mirasim usage ledger found (~/.mirasim/insights/usage-*.ndjson)");
    process.exit(1);
  }

  const entries = [];
  const seenIds = new Set();
  let skippedNoTokens = 0;
  for (const fp of files) {
    const raw = fs.readFileSync(fp, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; } // tolerate torn tail lines
      if (!e || typeof e !== "object") continue;
      // Dedup across months: mirasim ids are globally unique (uuid:uuid).
      if (e.id) {
        if (seenIds.has(e.id)) continue;
        seenIds.add(e.id);
      }
      const consumed = (e.input || 0) + (e.output || 0) + (e.cacheRead || 0) + (e.cacheWrite || 0);
      if (!consumed) { skippedNoTokens++; continue; } // failed calls log zero tokens
      entries.push(convertMirasimRow(e));
    }
  }
  if (skippedNoTokens > 0) log(`mirasim: skipped ${skippedNoTokens} rows without token counts (failed/empty calls)`);
  return entries;
}

function collectEntries() {
  if (args.source === "opencode") return collectOpencodeEntries();
  if (args.source === "mirasim") return collectMirasimEntries();
  return collectZcodeEntries();
}

// POST entries in bounded batches; 10router dedups so re-runs are safe.
async function postEntries(selected) {
  const BATCH = 5000;
  let imported = 0, skipped = 0;
  for (let i = 0; i < selected.length; i += BATCH) {
    const data = await importBatch(selected.slice(i, i + BATCH), args);
    imported += data.imported || 0;
    skipped += data.skipped || 0;
  }
  log(`done: imported ${imported}, skipped ${skipped} (of ${selected.length})`);
}

function applyLimit(entries) {
  return args.limit > 0 ? entries.slice(-args.limit) : entries;
}

async function main() {
  // Offline import: read a previously exported JSON, POST it. No ZCode db
  // access — this runs on whatever machine can reach the 10Router instance.
  if (args.importFile) {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(args.importFile, "utf8"));
    } catch (err) {
      console.error(`error: cannot read import file ${args.importFile}: ${err.message}`);
      process.exit(1);
    }
    const raw = payload.usageHistory || payload.usage;
    if (!Array.isArray(raw)) {
      console.error("error: file is not a usage export (expected { usageHistory: [...] })");
      process.exit(1);
    }
    const selected = applyLimit(raw);
    if (selected.length === 0) {
      log("nothing to import (0 rows in file)");
      return;
    }
    if (args.dryRun) {
      log(`[dry-run] would import ${selected.length} rows from ${args.importFile} to ${args.endpoint}`);
      return;
    }
    log(`importing ${selected.length} rows from ${args.importFile} → ${args.endpoint}`);
    await postEntries(selected);
    return;
  }

  // Both remaining modes read the local ZCode ledger.
  const entries = applyLimit(collectEntries());
  if (entries.length === 0) {
    log("nothing to export (0 rows after filtering)");
    return;
  }

  // Offline export: write a JSON file shaped exactly like the import API's
  // payload — feed it back with --import, or load it in the dashboard's
  // JSON usage-import UI. No network, no credentials.
  if (args.exportFile) {
    const doc = {
      source: "zcode-plugin",
      exportedAt: new Date().toISOString(),
      rowCount: entries.length,
      usageHistory: entries,
    };
    fs.writeFileSync(args.exportFile, JSON.stringify(doc));
    const sizeKb = Math.round(fs.statSync(args.exportFile).size / 1024);
    log(`exported ${entries.length} rows → ${args.exportFile} (${sizeKb} KB)`);
    log(`next: carry the file to a machine that can reach 10Router and run`);
    log(`  node export-usage.mjs --import ${args.exportFile} --endpoint http://<host>:<port> --key sk-…`);
    return;
  }

  if (args.dryRun) {
    log(`[dry-run] would import ${entries.length} rows to ${args.endpoint}`);
    const byProvider = {};
    for (const e of entries) byProvider[e.provider] = (byProvider[e.provider] || 0) + 1;
    for (const [p, c] of Object.entries(byProvider).sort()) log(`  ${p}: ${c}`);
    log(`  sample: ${JSON.stringify(entries[entries.length - 1]).slice(0, 240)}`);
    return;
  }

  // One batch; 10router inserts in a single transaction. Keep payloads bounded
  // in case a ledger grows huge — 5k rows ≈ 2 MB JSON.
  await postEntries(entries);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
