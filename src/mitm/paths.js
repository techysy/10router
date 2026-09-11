const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_NAME = "10router";
const LEGACY_APP_NAME = "9router";

function legacyDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), LEGACY_APP_NAME);
  }
  return path.join(os.homedir(), `.${LEGACY_APP_NAME}`);
}

// The only state a pre-SQLite 10Router install kept in the data-dir root.
// Keep in sync with LEGACY_JSON_FILES in src/lib/dataDir.js (this file is CJS
// and mirrors that ESM module; dataDir-migration.test.js pins both).
const LEGACY_JSON_FILES = ["db.json", "usage.json", "disabledModels.json", "request-details.json"];

// Does this dir already hold 10Router state? Mere non-emptiness is NOT an
// equivalent test: on Windows the data dir (%APPDATA%/10router) is also
// Electron's userData profile, so Cache/, GPUCache/, Local State … would keep
// it non-empty forever and silently pin the migration off.
function hasAppData(dir) {
  if (fs.existsSync(path.join(dir, "db", "data.sqlite"))) return true;
  return LEGACY_JSON_FILES.some((name) => fs.existsSync(path.join(dir, name)));
}

// One-time migration from 9Router data dir (mirrors src/lib/dataDir.js).
// force:false so a file we already own (a generated mitm/rootCA.key, say) is
// never replaced by the legacy copy.
function migrateLegacyData() {
  try {
    const legacy = legacyDir();
    const next = defaultDir();
    if (!fs.existsSync(legacy)) return;
    if (hasAppData(next)) return;
    fs.cpSync(legacy, next, { recursive: true, force: false });
    console.log(`[migration] copied legacy data dir ${legacy} → ${next}`);
  } catch (e) {
    console.warn(`[migration] failed to migrate ${legacyDir()} → ${defaultDir()}: ${e?.message}`);
  }
}

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) {
    migrateLegacyData();
    return defaultDir();
  }
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

const DATA_DIR = getDataDir();
const MITM_DIR = path.join(DATA_DIR, "mitm");

module.exports = { DATA_DIR, MITM_DIR };
