// Release assets ship a checksum list (#9 item 6, the half that is about downloads
// rather than the in-app updater).
//
// The workflows are the only place this can live — the sums are produced next to
// the artifacts — so the guard is a source assertion. What it protects: someone
// refactoring an upload step must not silently drop the verification list, and the
// three workflows must keep emitting SEPARATE files (they run in parallel, so one
// shared SHA256SUMS.txt would race and drop the other groups).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const server = read(".github/workflows/build-server.yml");
const desktop = read(".github/workflows/build-desktop-win.yml");
const fpk = read(".github/workflows/build-fpk.yml");
const doc = read("docs/zh-CN/verify-downloads.md");

describe("release checksums are generated and attached", () => {
  it("server tarball gets a sums file that is uploaded", () => {
    expect(server).toContain("sha256sum 10router-server.tar.gz > SHA256SUMS-server.txt");
    // both the artifact (non-tag runs) and the release (tag runs).
    // The workflow files are CRLF, so allow \r?\n.
    expect(server).toMatch(/files: \|\r?\n\s+10router-server\.tar\.gz\r?\n\s+SHA256SUMS-server\.txt/);
    expect(server).toMatch(/path: \|\r?\n\s+10router-server\.tar\.gz\r?\n\s+SHA256SUMS-server\.txt/);
  });

  it("desktop installers get a sums file that rides along with release-files/*", () => {
    expect(desktop).toContain("sha256sum *.exe *.7z > SHA256SUMS-desktop.txt");
    // release-files/* already covers everything in that dir, sums included.
    expect(desktop).toContain("files: release-files/*");
  });

  it("fpk files get theirs too", () => {
    // 自 v1.4.0 起 fpk 资产名平台化(10Router-FnOS-… )。Linux 大小写敏感,
    // sums glob / attach glob 必须跟 mv 的重命名同源 — 这里两处都钉,防漂移。
    expect(fpk).toContain('mv 10router.fpk "10Router-FnOS-${VERSION}-${{ matrix.arch }}.fpk"');
    expect(fpk).toContain("sha256sum 10Router-*.fpk > SHA256SUMS-fpk.txt");
    expect(fpk).toMatch(/files: \|\r?\n\s+fpk-assets\/10Router-\*\.fpk\r?\n\s+fpk-assets\/SHA256SUMS-fpk\.txt/);
  });

  it("the three groups use distinct filenames (parallel runs must not race)", () => {
    const names = new Set();
    for (const wf of [server, desktop, fpk]) {
      for (const m of wf.matchAll(/SHA256SUMS-[a-z]+\.txt/g)) names.add(m[0]);
    }
    expect([...names].sort()).toEqual(["SHA256SUMS-desktop.txt", "SHA256SUMS-fpk.txt", "SHA256SUMS-server.txt"]);
    // No shared, group-less name in any *step* — the comments name it on purpose,
    // to explain why the groups are split.
    const codeOnly = (wf) => wf.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
    for (const wf of [server, desktop, fpk]) {
      expect(codeOnly(wf)).not.toMatch(/SHA256SUMS\.txt/);
    }
  });

  it("desktop sums are computed from an explicit file list, so a re-run cannot hash its own output", () => {
    // `sha256sum *` would include the sums file itself (and `> file` truncates it
    // before the read), producing a self-referential entry on the second run.
    expect(desktop).toContain("shopt -s nullglob && sha256sum *.exe *.7z >");
    expect(desktop).not.toMatch(/sha256sum \* >/);
  });

  it("each workflow points at the doc that explains what the sums do and do not prove", () => {
    for (const wf of [server, desktop, fpk]) {
      expect(wf).toContain("docs/zh-CN/verify-downloads.md");
    }
    expect(doc).toContain("sha256sum -c");
    // The honest caveat: a sums file that travels with the artifact is not a
    // third-party proof, and the in-app updater uses npm instead of these files.
    expect(doc).toMatch(/挡不了|not a third-party proof/);
    expect(doc).toContain("npm");
  });
});
