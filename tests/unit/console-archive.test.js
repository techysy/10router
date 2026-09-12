import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dayKey, resolveArchiveDir, installConsoleArchive } from "../../src/lib/consoleArchiveStandalone.mjs";

function fakeConsole() {
  const calls = [];
  const target = {};
  for (const level of ["log", "info", "warn", "error"]) {
    target[level] = (...args) => calls.push([level, ...args]);
  }
  return { target, calls };
}

describe("console archive — per-day file tee", () => {
  it("writes wrapped lines into app-<day>.log and still calls the original", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-"));
    const { target, calls } = fakeConsole();
    // UTC-anchored instant so the ISO prefix assertion is timezone-stable.
    const fixed = new Date("2026-09-12T08:30:00Z");
    installConsoleArchive({ target, dir, now: () => fixed });

    target.log("hello", { a: 1 });
    target.error("boom");

    expect(calls.map((c) => c[0])).toEqual(["log", "error"]);
    const text = fs.readFileSync(path.join(dir, `app-${dayKey(fixed)}.log`), "utf8");
    expect(text).toContain("2026-09-12T08:30:00");
    expect(text).toContain("[log] hello { a: 1 }");
    expect(text).toContain("[error] boom");
  });

  it("rolls to a new file when the local date changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-"));
    const { target } = fakeConsole();
    let d = new Date("2026-09-12T23:59:59");
    installConsoleArchive({ target, dir, now: () => d });

    target.log("day1");
    d = new Date("2026-09-13T00:00:01");
    target.log("day2");

    expect(fs.readFileSync(path.join(dir, "app-2026-09-12.log"), "utf8")).toContain("day1");
    expect(fs.readFileSync(path.join(dir, "app-2026-09-13.log"), "utf8")).toContain("day2");
  });

  it("survives an unwritable archive dir without breaking the console", () => {
    const { target, calls } = fakeConsole();
    const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "archive-")), "nope");
    fs.writeFileSync(blocked, "not a dir");

    installConsoleArchive({ target, dir: blocked, now: () => new Date("2026-09-12T00:00:00") });
    expect(() => target.warn("still works")).not.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("dayKey is zero-padded local date", () => {
    expect(dayKey(new Date(2026, 8, 3, 7, 5))).toBe("2026-09-03");
  });
});

describe("resolveArchiveDir", () => {
  it("honors DATA_DIR first", () => {
    expect(resolveArchiveDir({ DATA_DIR: "/data/x" })).toBe(path.join("/data/x", "logs"));
  });

  it("falls back to the platform data dir like dataDir.js", () => {
    const dir = resolveArchiveDir({});
    if (process.platform === "win32") {
      expect(dir).toBe(path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "10router", "logs"));
    } else {
      expect(dir).toBe(path.join(os.homedir(), ".10router", "logs"));
    }
  });
});
