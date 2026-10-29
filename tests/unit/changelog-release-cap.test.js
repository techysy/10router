import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  resolveChangelogCap,
  capChangelogByVersion,
  parseVersion,
} from "@/shared/utils/changelogCap";

const rootDir = resolve(__dirname, "../..");
const LOCALES = ["en", "zh-CN", "zh-TW"];
const readChangelog = (locale) =>
  readFileSync(resolve(rootDir, "public/i18n/changelog", `${locale}.md`), "utf8");

// The dashboard modal pulls these files straight from `main`, so a section for a
// version that has not shipped is shown to every installed client, including
// users on older builds. That is exactly what happened when the v1.1.4 notes
// were written during development (91d0463d) while the newest tag was still
// v1.1.3 — hence the runtime cap in ChangelogModal.
const SAMPLE = [
  "# Changelog",
  "",
  "Intro line that must survive.",
  "",
  "## v1.1.4 (2026-09-20)",
  "",
  "### New",
  "",
  "- unreleased feature",
  "",
  "## v1.1.3 (2026-09-20)",
  "",
  "- shipped feature",
  "",
  "## v1.1.2 (2026-09-18)",
  "",
  "- older shipped feature",
  "",
].join("\n");

describe("changelog release cap", () => {
  it("caps at the newer of the published and the running version", () => {
    expect(resolveChangelogCap({ currentVersion: "1.1.3", latestVersion: "1.1.4" })).toBe("1.1.4");
    // A released build must keep seeing its own notes even if npm lags.
    expect(resolveChangelogCap({ currentVersion: "1.1.4", latestVersion: "1.1.3" })).toBe("1.1.4");
    expect(resolveChangelogCap({ currentVersion: "v1.2.0", latestVersion: null })).toBe("1.2.0");
  });

  it("returns no cap when nothing is known, so offline installs show everything", () => {
    expect(resolveChangelogCap({})).toBeNull();
    expect(resolveChangelogCap(undefined)).toBeNull();
    expect(resolveChangelogCap({ currentVersion: "0.0.0-test", latestVersion: "dev" })).toBeNull();
  });

  it("parseVersion refuses anything that is not a triple", () => {
    expect(parseVersion("1.1.4")).toEqual([1, 1, 4]);
    expect(parseVersion("v1.1.4 (2026-09-20)")).toEqual([1, 1, 4]);
    expect(parseVersion("Unreleased")).toBeNull();
    expect(parseVersion("1.1")).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  it("hides a not-yet-released section and keeps everything at or below the cap", () => {
    const out = capChangelogByVersion(SAMPLE, "1.1.3");
    expect(out).not.toMatch(/1\.1\.4/);
    expect(out).not.toMatch(/unreleased feature/);
    expect(out).toMatch(/^# Changelog/);
    expect(out).toContain("Intro line that must survive.");
    expect(out).toContain("## v1.1.3");
    expect(out).toContain("- shipped feature");
    expect(out).toContain("## v1.1.2");
    expect(out).toContain("- older shipped feature");
  });

  it("keeps sub-headings with the section they belong to", () => {
    // "### New" sits under v1.1.4 and must leave with it; body bullets too.
    const out = capChangelogByVersion(SAMPLE, "1.1.3");
    expect(out).not.toContain("### New");
  });

  it("never drops a heading it cannot read as a version", () => {
    const md = "# T\n\n## Unreleased\n\n- wip\n\n## v1.0.0\n\n- shipped\n";
    expect(capChangelogByVersion(md, "1.0.0")).toContain("## Unreleased");
    expect(capChangelogByVersion(md, "1.0.0")).toContain("- wip");
  });

  it("is a no-op without a cap or without markdown", () => {
    expect(capChangelogByVersion(SAMPLE, null)).toBe(SAMPLE);
    expect(capChangelogByVersion(SAMPLE, "nightly")).toBe(SAMPLE);
    expect(capChangelogByVersion("", "1.1.3")).toBe("");
    expect(capChangelogByVersion(undefined, "1.1.3")).toBe("");
  });

  it("collapses the blank-run left behind by a dropped section", () => {
    const out = capChangelogByVersion(SAMPLE, "1.1.3");
    expect(out).not.toMatch(/\n{3,}/);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("survives CRLF markdown (the files are checked out with \r\n on Windows)", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    const out = capChangelogByVersion(crlf, "1.1.3");
    expect(out).not.toMatch(/1\.1\.4/);
    expect(out).toContain("## v1.1.3");
    expect(out).toContain("- older shipped feature");
    // Section bodies must keep their original endings rather than being rebuilt.
    expect(out.split("\n").filter((l) => l.endsWith("\r")).length).toBeGreaterThan(5);
  });

  it("reproduces the released file byte-for-byte when a real leak is capped", () => {
    // zh-CN.md carried the unreleased v1.1.4 section on main (commit 3a649745);
    // capping it at 1.1.3 must yield exactly what the v1.1.3 tag published.
    let leaked, released;
    try {
      leaked = execFileSync("git", ["show", "3a649745:public/i18n/changelog/zh-CN.md"], {
        cwd: rootDir, encoding: "utf8", maxBuffer: 1 << 24, stdio: ["ignore", "pipe", "ignore"],
      });
      released = execFileSync("git", ["show", "v1.1.3:public/i18n/changelog/zh-CN.md"], {
        cwd: rootDir, encoding: "utf8", maxBuffer: 1 << 24, stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return; // no git / shallow clone / rewritten history: nothing to compare
    }
    if (!/^## v1\.1\.4/m.test(leaked)) return; // history rewritten: commit gone
    expect(capChangelogByVersion(leaked, "1.1.3")).toBe(released);
  });
});

describe("served changelog files", () => {
  it("every language lists the same released versions in the same order", () => {
    const headings = (md) => [...md.matchAll(/^## (v?\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
    const baseline = headings(readChangelog("zh-CN"));
    expect(baseline.length).toBeGreaterThan(3);
    for (const locale of LOCALES) {
      expect(headings(readChangelog(locale)), locale).toEqual(baseline);
    }
  });

  it("newest section is the version the changelog was calibrated for (no unreleased lead)", () => {
    // Release commits ("Release: vX.Y.Z — 发版面校准") are the only place these
    // sections are authored, so the top of each file must be a shipped release.
    // Guards against the 91d0463d pattern where dev notes reached `main` early.
    //
    // (The v1.3.0 pre-release early-preview exception once lived here as a
    // PRE_RELEASE_LEAD constant — self-retiring by design: once the tag
    // existed, strict equality resumed. Removed for the v1.5.0 cycle; re-add
    // a lead constant only when the next release intentionally previews its
    // changelog before tagging.)
    const PRE_RELEASE_LEAD = "1.6.5";
    let newestTag = null;
    try {
      newestTag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
        cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim().replace(/^v/, "");
    } catch {
      return; // shallow clone / no tags locally: nothing to compare against
    }
    for (const locale of LOCALES) {
      const top = readChangelog(locale).match(/^## v?(\d+\.\d+\.\d+)/m)[1];
      expect([newestTag, PRE_RELEASE_LEAD], locale).toContain(top);
    }
  });
});
