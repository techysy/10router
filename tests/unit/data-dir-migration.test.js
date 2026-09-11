import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);
const WIN = process.platform === "win32";

let sandbox;
let prevAppData;
let prevDataDir;

const appdata = () => path.join(sandbox, "Roaming");
const nextDir = () => (WIN ? path.join(appdata(), "10router") : path.join(sandbox, ".10router"));
const legacyDir = () => (WIN ? path.join(appdata(), "9router") : path.join(sandbox, ".9router"));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Both resolvers run the migration as an import side effect, so every case has
// to re-evaluate the module from scratch.
async function loadEsmDataDir() {
  vi.resetModules();
  const mod = await import("../../src/lib/dataDir.js");
  return mod.DATA_DIR;
}

function loadCjsMitmPaths() {
  const id = require.resolve("../../src/mitm/paths.js");
  delete require.cache[id];
  return require("../../src/mitm/paths.js").DATA_DIR;
}

const resolvers = [
  ["src/lib/dataDir.js (ESM)", loadEsmDataDir],
  ["src/mitm/paths.js (CJS)", loadCjsMitmPaths],
];

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "10router-datadir-"));
  prevAppData = process.env.APPDATA;
  prevDataDir = process.env.DATA_DIR;
  delete process.env.DATA_DIR; // the migration only runs on the default dir
  process.env.APPDATA = appdata();
  vi.spyOn(os, "homedir").mockReturnValue(sandbox);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = prevAppData;
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe.each(resolvers)("%s: legacy 9router → 10router data dir migration", (_name, load) => {
  it("still migrates when the target dir holds unrelated files", async () => {
    // Windows desktop installs: Electron keeps its userData profile in this very
    // dir, so Cache/, Local State … make it non-empty before we write anything.
    // Gating on mere non-emptiness pinned the migration off forever.
    write(path.join(nextDir(), "Cache", "data_0"), "chromium");
    write(path.join(nextDir(), "Local State"), "{}");
    write(path.join(legacyDir(), "db", "data.sqlite"), "LEGACY");
    write(path.join(legacyDir(), "machine-id"), "MID");

    expect(await load()).toBe(nextDir());

    expect(fs.readFileSync(path.join(nextDir(), "db", "data.sqlite"), "utf8")).toBe("LEGACY");
    expect(fs.readFileSync(path.join(nextDir(), "machine-id"), "utf8")).toBe("MID");
    expect(fs.existsSync(path.join(nextDir(), "Cache", "data_0"))).toBe(true);
    expect(fs.existsSync(legacyDir())).toBe(true); // kept for a manual retry
  });

  it("leaves an existing SQLite db alone", async () => {
    write(path.join(legacyDir(), "db", "data.sqlite"), "LEGACY");
    write(path.join(legacyDir(), "machine-id"), "MID");
    write(path.join(nextDir(), "db", "data.sqlite"), "MINE");

    await load();

    expect(fs.readFileSync(path.join(nextDir(), "db", "data.sqlite"), "utf8")).toBe("MINE");
    expect(fs.existsSync(path.join(nextDir(), "machine-id"))).toBe(false);
  });

  it("counts the pre-SQLite JSON files as app data too", async () => {
    write(path.join(legacyDir(), "machine-id"), "MID");
    write(path.join(nextDir(), "db.json"), "{}");

    await load();

    expect(fs.existsSync(path.join(nextDir(), "machine-id"))).toBe(false);
  });

  it("does nothing when there is no legacy dir", async () => {
    expect(await load()).toBe(nextDir());
    expect(fs.existsSync(nextDir())).toBe(false);
  });

  it("never overwrites a file we already own", async () => {
    write(path.join(legacyDir(), "db", "data.sqlite"), "LEGACY");
    write(path.join(legacyDir(), "mitm", "rootCA.key"), "legacy-key");
    write(path.join(nextDir(), "mitm", "rootCA.key"), "our-key");

    await load();

    expect(fs.readFileSync(path.join(nextDir(), "db", "data.sqlite"), "utf8")).toBe("LEGACY");
    // The CA is already trusted by the OS/browser — replacing it would silently
    // break TLS interception.
    expect(fs.readFileSync(path.join(nextDir(), "mitm", "rootCA.key"), "utf8")).toBe("our-key");
  });
});
