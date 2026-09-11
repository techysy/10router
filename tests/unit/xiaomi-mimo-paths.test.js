import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// MiMo Desktop keeps TWO stores in two different roots:
//   • Electron profile  → Chromium cookie DB (passToken)     [desktopCookiePath]
//   • credential dir    → auth.json (bundled engine)         [desktopAuthJsonPaths]
// Desktop's own bootstrap passes `authDataDir: Vs` (XDG data dir) into its
// engine, which is why auth.json is NOT under the Electron profile — not on any
// platform, macOS included. These cases pin that down, per platform.

const FAKE = { home: "" };

// Only `homedir` is mocked (never tmpdir — the runner writes its own scratch files).
const actualOs = await vi.importActual("node:os");
vi.mock("node:os", () => ({
  ...actualOs,
  homedir: () => FAKE.home,
  default: { ...actualOs.default, homedir: () => FAKE.home },
}));

const { desktopUserDataDir, desktopCookiePath, desktopAuthJsonPaths } = await import(
  "../../open-sse/shared/mimoAccount.js"
);

const ENV_KEYS = ["APPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];
const savedEnv = {};
const savedPlatform = process.platform;

function setPlatform(value) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
  FAKE.home = path.join(path.sep, "home", "tester");
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  setPlatform(savedPlatform);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe("MiMo Desktop credential paths", () => {
  describe("Electron profile (cookie store)", () => {
    it("Windows: honours APPDATA so redirected/roaming profiles still resolve", () => {
      setPlatform("win32");
      process.env.APPDATA = path.join(path.sep, "roaming", "YangYu");
      expect(desktopUserDataDir()).toBe(path.join(path.sep, "roaming", "YangYu", "Xiaomi MiMo"));
      expect(desktopCookiePath()).toBe(
        path.join(path.sep, "roaming", "YangYu", "Xiaomi MiMo", "Partitions", "xiaomi-account", "Network", "Cookies"),
      );
    });

    it("Windows: falls back to <home>/AppData/Roaming when APPDATA is unset", () => {
      setPlatform("win32");
      expect(desktopUserDataDir()).toBe(path.join(FAKE.home, "AppData", "Roaming", "Xiaomi MiMo"));
    });

    it("macOS: uses Library/Application Support", () => {
      setPlatform("darwin");
      expect(desktopCookiePath()).toBe(
        path.join(FAKE.home, "Library", "Application Support", "Xiaomi MiMo", "Partitions", "xiaomi-account", "Network", "Cookies"),
      );
    });

    it("Linux: follows XDG_CONFIG_HOME and defaults to ~/.config", () => {
      setPlatform("linux");
      expect(desktopUserDataDir()).toBe(path.join(FAKE.home, ".config", "Xiaomi MiMo"));

      process.env.XDG_CONFIG_HOME = path.join(path.sep, "xdg", "cfg");
      expect(desktopUserDataDir()).toBe(path.join(path.sep, "xdg", "cfg", "Xiaomi MiMo"));
    });
  });

  describe("auth.json (engine credential dir)", () => {
    it("defaults to the XDG data dir on every platform", () => {
      for (const platform of ["win32", "darwin", "linux"]) {
        setPlatform(platform);
        expect(desktopAuthJsonPaths()).toEqual([
          path.join(FAKE.home, ".local", "share", "mimocode", "auth.json"),
        ]);
      }
    });

    it("prefers $XDG_DATA_HOME and keeps the default location as a fallback", () => {
      process.env.XDG_DATA_HOME = path.join(path.sep, "xdg", "data");
      expect(desktopAuthJsonPaths()).toEqual([
        path.join(path.sep, "xdg", "data", "mimocode", "auth.json"),
        path.join(FAKE.home, ".local", "share", "mimocode", "auth.json"),
      ]);
    });

    it("does not duplicate the path when XDG_DATA_HOME points at the default root", () => {
      process.env.XDG_DATA_HOME = path.join(FAKE.home, ".local", "share");
      expect(desktopAuthJsonPaths()).toEqual([
        path.join(FAKE.home, ".local", "share", "mimocode", "auth.json"),
      ]);
    });

    it("never looks inside the Electron profile (that is where auth.json is NOT)", () => {
      for (const platform of ["win32", "darwin", "linux"]) {
        setPlatform(platform);
        const profile = desktopUserDataDir();
        for (const candidate of desktopAuthJsonPaths()) {
          expect(candidate.startsWith(profile + path.sep)).toBe(false);
        }
        // …and the retired CLI's macOS Library guess is gone for good.
        expect(desktopAuthJsonPaths().some((p) => p.includes("Application Support"))).toBe(false);
      }
    });
  });

  it("auto-import route resolves candidates through this module, not its own list", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "src", "app", "api", "oauth", "xiaomi-mimo", "auto-import", "route.js"),
      "utf-8",
    );
    expect(src).toContain('from "open-sse/shared/mimoAccount.js"');
    expect(src).toContain("desktopAuthJsonPaths()");
    expect(src).not.toMatch(/function getCandidatePaths/);
  });
});
