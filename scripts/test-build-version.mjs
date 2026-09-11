#!/usr/bin/env node
/**
 * Temporary test-build version stamp.
 *
 * Local "build → replace in place → verify" testing needs an artifact that can be
 * told apart from both the last release and the next one. Rebuilding with the
 * RELEASED version produces a second artifact with the same version but different
 * contents (the 1.0.8 trap: four installers, three different payloads), and
 * committing the release bump early means the release step has nothing to do.
 *
 * So local test builds carry `X.Y.Z-test.N`, which is:
 *   - never committed (--revert puts all four files back),
 *   - strictly greater than the current release, so a running install's updater
 *     never offers to "upgrade" to it as a downgrade,
 *   - visible in one place from the dashboard / installer / fpk filename.
 *
 * The three package.json files are the single source: fnos-packaging/manifest is
 * synced from the root one by scripts/sync-manifest-version.mjs (prebuild:fpk), so
 * Windows and fnOS test builds always carry the same stamp.
 *
 * Usage:
 *   node scripts/test-build-version.mjs --check
 *   node scripts/test-build-version.mjs 1.1.0-test.1
 *   node scripts/test-build-version.mjs --revert
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file the test stamp touches — and therefore every file --revert restores. */
const VERSION_FILES = [
  "package.json",
  "cli/package.json",
  "desktop/package.json",
  "fnos-packaging/manifest",
];

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function readVersion(file) {
  if (file.endsWith("manifest")) {
    const line = readFileSync(join(ROOT, file), "utf8").match(/^version\s*=\s*(.+)$/m);
    return line ? line[1].trim() : null;
  }
  return JSON.parse(readFileSync(join(ROOT, file), "utf8")).version;
}

/**
 * Replace a JSON `"version": "<current>"` value without reformatting the file.
 * JSON.stringify() would rewrite indentation of untouched lines, which both churns
 * the diff and defeats the version-only guard in revert().
 */
function writeJsonVersion(file, current, next) {
  const path = join(ROOT, file);
  const text = readFileSync(path, "utf8");
  const re = new RegExp(`("version"\\s*:\\s*")${current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(")`);
  if (!re.test(text)) throw new Error(`${file}: could not find "version": "${current}"`);
  writeFileSync(path, text.replace(re, `$1${next}$2`));
  const written = readVersion(file);
  if (written !== next) throw new Error(`${file}: expected ${next}, wrote ${written}`);
}

/** Latest release tag, e.g. "v1.0.8" -> "1.0.8" ("" when no tag is reachable). */
function lastRelease() {
  try {
    return git(["describe", "--tags", "--abbrev=0", "--match", "v*"]).trim().replace(/^v/, "");
  } catch {
    return "";
  }
}

/** Minimal semver compare, enough for `X.Y.Z[-test.N]`: <0, 0, >0. */
export function compareSemver(a, b) {
  const parse = (v) => {
    const [core, ...pre] = v.split("-");
    return { nums: core.split(".").map(Number), pre: pre.join("-") };
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d;
  }
  // A prerelease sorts BELOW the same core version, so an install on 1.0.8 is never
  // silently "upgraded" to 1.0.8-test.1.
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const [an, bn] = [x.pre.split("."), y.pre.split(".")];
  for (let i = 0; i < Math.max(an.length, bn.length); i += 1) {
    const [ai, bi] = [an[i], bn[i]];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const [numA, numB] = [Number(ai), Number(bi)];
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
      if (numA !== numB) return numA - numB;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/**
 * A --revert that can never eat unrelated work.
 *
 * `git checkout -- <file>` discards EVERYTHING uncommitted in that file, not just
 * the version line — which is how a revert once threw away a finished fix. So
 * revert refuses unless every changed line in every file is a version line.
 */

// Match the assignment itself, not the word "version": a script named
// `test-version` (or any comment mentioning versions) would otherwise pass and be
// discarded by the revert.
export const VERSION_LINE = /^[+-]\s*(?:"version"\s*:\s*"|version\s*=)/;

function assertVersionOnlyChanges() {
  const offenders = [];
  for (const file of VERSION_FILES) {
    const diff = git(["diff", "-U0", "--", file]);
    const changed = diff.split("\n").filter((l) => /^[+-][^+-]/.test(l));
    const stray = changed.filter((l) => !VERSION_LINE.test(l));
    if (stray.length) offenders.push(`${file}: ${stray[0].trim().slice(0, 80)}`);
  }
  if (offenders.length) {
    throw new Error(
      `refusing to revert — these files carry changes beyond the version stamp:\n  ${offenders.join("\n  ")}\n` +
        `Commit or stash them first; a blind \`git checkout --\` would discard them.`,
    );
  }
}

function main() {
  const [, , arg] = process.argv;

  if (!arg || arg === "--check" || arg === "-c") {
    const rows = VERSION_FILES.map((f) => `${f}=${readVersion(f)}`);
    const dirty = git(["status", "--porcelain", "--", ...VERSION_FILES]).trim();
    console.log(`release tag: ${lastRelease() || "(none)"}`);
    console.log(rows.join("  "));
    console.log(dirty ? "stamped (uncommitted)" : "clean");
    process.exit(0);
  }

  if (arg === "--revert" || arg === "-r") {
    assertVersionOnlyChanges();
    const changed = VERSION_FILES.filter((f) => git(["status", "--porcelain", "--", f]).trim());
    if (!changed.length) {
      console.log("nothing to revert — no version stamp present");
      process.exit(0);
    }
    git(["checkout", "--", ...changed]);
    console.log(`reverted: ${changed.join(", ")}`);
    console.log(VERSION_FILES.map((f) => `${f}=${readVersion(f)}`).join("  "));
    process.exit(0);
  }

  const target = arg;
  const force = process.argv.includes("--force");
  if (!/^\d+\.\d+\.\d+-test\.\d+$/.test(target) && !force) {
    console.error(`refusing to stamp "${target}" — test builds must look like X.Y.Z-test.N (use --force to override)`);
    process.exit(1);
  }
  const released = lastRelease();
  if (released && compareSemver(target, released) <= 0) {
    console.error(
      `refusing to stamp "${target}" — not greater than the last release (${released}).\n` +
        `A lower version makes the in-app updater offer a downgrade on the machine you are about to test.`,
    );
    process.exit(1);
  }

  const current = readVersion("package.json");
  if (current === target) {
    console.log(`already stamped ${target}`);
    process.exit(0);
  }
  for (const file of ["package.json", "cli/package.json", "desktop/package.json"]) {
    writeJsonVersion(file, readVersion(file), target);
  }
  // Keep fnOS in lockstep with npm/desktop; the same script the fpk build runs.
  execFileSync(process.execPath, [join(ROOT, "scripts", "sync-manifest-version.mjs")], { cwd: ROOT });

  console.log(`stamped ${current} -> ${target} (${VERSION_FILES.length} files, uncommitted)`);
  console.log(VERSION_FILES.map((f) => `${f}=${readVersion(f)}`).join("  "));
  console.log(`remember: node scripts/test-build-version.mjs --revert   # after testing`);
}

// Only when run as a CLI — importing this module (tests) must not touch the repo.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
