// Long-term console archive — tees console.log/info/warn/error into a per-day
// file under <dataDir>/logs/app-YYYY-MM-DD.log (local date, append-only, no cap
// by design: this is the durable record of "what did upstream actually answer /
// why did the request fail" that ring-buffer stores like requestDetails (200
// records) and the desktop 5MB server.log deliberately don't keep).
//
// Self-contained by requirement: custom-server.js loads this in the STANDALONE
// build, where src/lib sources are not shipped — Node builtins only, same
// constraint as outboundProxyStandalone.js. Everything is best-effort: any
// failure leaves the original console untouched and the app unbroken.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";

const LEVELS = ["log", "info", "warn", "error"];

/** Local-date key "YYYY-MM-DD" — archives are read by humans, so local, not UTC. */
export function dayKey(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Same resolution as src/lib/dataDir.js: DATA_DIR first, then the platform default. */
export function resolveArchiveDir(env = process.env) {
  if (env.DATA_DIR) return path.join(env.DATA_DIR, "logs");
  if (process.platform === "win32") {
    return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "10router", "logs");
  }
  return path.join(os.homedir(), ".10router", "logs");
}

/**
 * Wrap `target`'s console methods so every line is also appended to
 * `<dir>/app-<local-day>.log` as `<ISO> [level] <formatted>`. The file handle
 * rolls over when the local date changes. Returns the wrapped level names.
 *
 * Callers should pass an explicit `target` in tests; custom-server.js uses the
 * real global console once per process.
 */
export function installConsoleArchive({ target = console, dir = resolveArchiveDir(), now = () => new Date() } = {}) {
  const state = { day: null, fd: null };
  const original = Object.fromEntries(LEVELS.map((level) => [level, target[level]]));

  function fdForDay(day) {
    if (state.fd && state.day === day) return state.fd;
    if (state.fd) {
      try { fs.closeSync(state.fd); } catch { /* already closed */ }
      state.fd = null;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      state.fd = fs.openSync(path.join(dir, `app-${day}.log`), "a");
      state.day = day;
    } catch {
      state.fd = null; // an unwritable archive must never break the app
    }
    return state.fd;
  }

  for (const level of LEVELS) {
    target[level] = (...args) => {
      original[level](...args);
      try {
        const d = now();
        const fd = fdForDay(dayKey(d));
        if (fd) fs.writeSync(fd, `${d.toISOString()} [${level}] ${util.format(...args)}\n`);
      } catch { /* best-effort: the console itself already succeeded */ }
    };
  }
  return LEVELS;
}
