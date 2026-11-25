// Settings → Security → "Check for updates automatically".
//
// Some operators pin a version on purpose and do not want the instance to keep
// asking the npm registry or showing new-version notices. Off means: /api/version
// makes no registry call and reports no update (so the sidebar banner and the
// tray's startup balloon stay quiet), and the CLI launcher — which checks before
// the server exists — skips its own check via a marker file. Explicit checks
// (?check=1: the "Check now" button, the tray's "Check for updates") still work.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-updatecheck-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;

const mocks = vi.hoisted(() => ({
  settings: { autoUpdateCheck: true },
  registryCalls: 0,
  latest: "9.9.9",
}));

vi.mock("https", () => {
  const get = (url, opts, cb) => {
    mocks.registryCalls++;
    const res = new EventEmitter();
    process.nextTick(() => {
      cb(res);
      res.emit("data", JSON.stringify({ version: mocks.latest }));
      res.emit("end");
    });
    return { on() { return this; }, destroy() {} };
  };
  return { default: { get }, get };
});
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => mocks.settings,
  updateSettings: async (u) => ({ ...mocks.settings, ...u }),
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));

const readSource = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const MARKER = path.join(tempDir, "update-check-disabled");

async function version(query = "") {
  vi.resetModules();
  const { GET } = await import("../../src/app/api/version/route.js");
  return (await GET(new Request(`http://localhost/api/version${query}`))).json();
}

beforeEach(() => {
  mocks.registryCalls = 0;
  global.__npmVersionCache = { value: null, fetchedAt: 0 };
});
afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("/api/version honours the setting", () => {
  it("on (default): refreshes from the registry in the background", async () => {
    mocks.settings = { autoUpdateCheck: true };
    const data = await version();
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.registryCalls).toBe(1);
    expect(data.updateCheck).toBe(true);
  });

  it("off: no registry call, no update reported — not even a stale cached one", async () => {
    mocks.settings = { autoUpdateCheck: false };
    global.__npmVersionCache = { value: "9.9.9", fetchedAt: Date.now() }; // cached before it was switched off
    const data = await version();
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.registryCalls).toBe(0);
    expect(data).toMatchObject({ latestVersion: null, hasUpdate: false, updateCheck: false });
    expect(data.currentVersion).toBeTruthy(); // the probes' fields stay intact
  });

  it("off + ?check=1 (explicit): asks the registry now and reports the update", async () => {
    mocks.settings = { autoUpdateCheck: false };
    const data = await version("?check=1");
    expect(mocks.registryCalls).toBe(1);
    expect(data).toMatchObject({ latestVersion: "9.9.9", hasUpdate: true, updateCheck: false });
  });
});

describe("the CLI launcher's marker follows the setting", () => {
  it("PATCH autoUpdateCheck=false writes the marker, true removes it", async () => {
    vi.resetModules();
    const { PATCH } = await import("../../src/app/api/settings/route.js");
    const patch = (body) => PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    mocks.settings = { autoUpdateCheck: true };
    await patch({ autoUpdateCheck: false });
    expect(fs.existsSync(MARKER)).toBe(true);
    await patch({ autoUpdateCheck: true });
    expect(fs.existsSync(MARKER)).toBe(false);
  });

  it("boot re-derives the marker from the database", () => {
    const init = readSource("src/shared/services/initializeApp.js");
    expect(init).toContain("syncUpdateCheckMarker(isAutoUpdateCheckEnabled(settings))");
  });

  it("the launcher skips its registry check when the marker exists (same name on both sides)", () => {
    const cli = readSource("cli/cli.js");
    const server = readSource("src/lib/updateCheck.js");
    expect(server).toContain('UPDATE_CHECK_DISABLED_MARKER = "update-check-disabled"');
    expect(cli).toContain('UPDATE_CHECK_DISABLED_MARKER = "update-check-disabled"');
    expect(cli).toContain("if (skipUpdate || autoUpdateCheckDisabled())");
  });
});

describe("desktop tray", () => {
  const main = readSource("desktop/main.js");
  it("the manual 'Check for updates' is explicit (?check=1)", () => {
    const fn = main.slice(main.indexOf("async function checkForUpdates()"), main.indexOf("async function backgroundCheckForUpdates()"));
    expect(fn).toContain("/api/version?check=1");
  });
  it("the background check uses the plain probe, so it goes quiet when checks are off", () => {
    const fn = main.slice(main.indexOf("async function backgroundCheckForUpdates()"), main.indexOf("async function backgroundPreDownload("));
    expect(fn).toContain("/api/version`");
    expect(fn).not.toContain("check=1");
  });
});

describe("settings page", () => {
  const profile = readSource("src/app/(dashboard)/dashboard/profile/page.js");
  it("offers the switch in the Security card and a manual check", () => {
    expect(profile).toContain('translate("Check for updates automatically")');
    expect(profile).toContain("checked={settings.autoUpdateCheck !== false}");
    expect(profile).toContain('fetch("/api/version?check=1"');
  });
  it("every new string has zh-CN and zh-TW text", () => {
    const literals = [
      "Check for updates automatically",
      "When OFF, 10Router no longer contacts the update server on its own or shows new-version notices — including security fixes. You can still check by hand.",
      "Check now",
      "Could not reach the update server. Try again later.",
      "New version available: v${latest} (installed v${current})",
      "You are on the latest version (v${current}).",
    ];
    for (const locale of ["zh-CN", "zh-TW"]) {
      const table = JSON.parse(readSource(`public/i18n/literals/${locale}.json`));
      expect(literals.filter((k) => !table[k]), locale).toEqual([]);
    }
  });
});
