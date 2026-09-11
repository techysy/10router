import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "10router";
const LEGACY_APP_NAME = "9router";

// The only state a pre-SQLite 10Router install kept in the data-dir root
// (see db/paths.js, which builds its LEGACY_FILES from this). Single source so
// the migration below and the SQLite migration can never disagree on a name.
export const LEGACY_JSON_FILES = {
  main: "db.json",
  usage: "usage.json",
  disabled: "disabledModels.json",
  details: "request-details.json",
};

function legacyDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), LEGACY_APP_NAME);
  }
  return path.join(os.homedir(), `.${LEGACY_APP_NAME}`);
}

// Does this dir already hold 10Router state? Mere non-emptiness is NOT an
// equivalent test, and using it silently pinned the migration off on every
// Windows desktop install: there the data dir (%APPDATA%/10router) is also
// Electron's userData profile, so Cache/, GPUCache/, Local State … keep it
// non-empty forever.
function hasAppData(dir) {
  if (fs.existsSync(path.join(dir, "db", "data.sqlite"))) return true;
  return Object.values(LEGACY_JSON_FILES).some((name) => fs.existsSync(path.join(dir, name)));
}

// One-time migration: users upgrading from 9Router keep their data in ~/.9router.
// If the legacy dir exists and the new dir holds no 10Router state yet, copy it
// over — force:false so a file we already own (a generated mitm/rootCA.key, say)
// is never replaced by the legacy copy. The legacy dir is left in place so the
// operation can be retried manually.
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

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) {
    migrateLegacyData();
    return defaultDir();
  }

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
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

export const DATA_DIR = getDataDir();
