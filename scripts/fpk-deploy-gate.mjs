#!/usr/bin/env node
// Pre-transfer gate for fpk hot-replace tarballs. Run on the build machine
// BEFORE the tarball leaves for the NAS — a payload that fails here must
// never be uploaded (2026-11-07 incident: a symlinked node_modules produced
// an 11.5MB tarball whose node_modules was a single dangling symlink; the
// NAS service never came back up and the operator had to reinstall 1.6.6).
//
// Usage:
//   node scripts/fpk-deploy-gate.mjs <server.tar.gz> //     [--expect-file <path-in-tar> --expect-regex <pattern>]... //     [--min-size-mb 30] [--min-entries 3000] [--min-nm-files 200] [--allow-release]
//
// Gates: size floor · entry-count floor · node_modules real-file count ·
// absolute-symlink poison · version must be -test.N · BUILD_ID non-empty ·
// per-commit markers extracted from the tarball itself (not the build tree —
// on-disk checks pass through symlinks that the tarball may have flattened).
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

const argv = process.argv.slice(2);
const tarball = argv[0];
if (!tarball) { console.error("usage: fpk-deploy-gate.mjs <server.tar.gz> [--expect-file p --expect-regex r]..."); process.exit(1); }

const expects = [];
let minSizeMb = 30, minEntries = 3000, minNmFiles = 200, allowRelease = false;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--expect-file") expects.push({ file: argv[++i] });
  else if (argv[i] === "--expect-regex") { if (!expects.length) { console.error("--expect-regex without --expect-file"); process.exit(1); } expects[expects.length - 1].regex = argv[++i]; }
  else if (argv[i] === "--min-size-mb") minSizeMb = Number(argv[++i]);
  else if (argv[i] === "--min-entries") minEntries = Number(argv[++i]);
  else if (argv[i] === "--min-nm-files") minNmFiles = Number(argv[++i]);
  else if (argv[i] === "--allow-release") allowRelease = true;
}
const want = new Map(expects.map((e) => [e.file, e]));

const fails = [];
const pass = (m) => console.log("  ok   " + m);
const bad = (m) => { console.log("  FAIL " + m); fails.push(m); };

console.log("gate " + tarball);
const mb = statSync(tarball).size / 1048576;
(mb >= minSizeMb ? pass : bad)("size " + mb.toFixed(1) + "MB (floor " + minSizeMb + "MB)");

const run = (cmd, opts = {}) => execFileSync("tar", cmd, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });

const listing = run(["-tzf", tarball]).split("\n").map((l) => l.replace(/^\.\//, "")).filter(Boolean);
(listing.length >= minEntries ? pass : bad)("entries " + listing.length + " (floor " + minEntries + ")");

const nmFiles = listing.filter((p) => p.startsWith("node_modules/") && !p.endsWith("/")).length;
(nmFiles >= minNmFiles ? pass : bad)("node_modules real files " + nmFiles + " (floor " + minNmFiles + ") — a symlinked node_modules payloads as ~0");

// GNU/bsdtar long listings both render symlinks as '... -> target'; absolute
// targets are the poison pattern (they resolve on the build machine only).
const long = run(["-tvzf", tarball]);
const poison = long.split("\n").filter((l) => l.includes(" -> ") && / -> \//.test(l.slice(l.indexOf(" -> ") + 4)));
(poison.length === 0 ? pass : bad)("absolute symlinks in payload: " + poison.length + (poison.length ? "\n    " + poison.slice(0, 5).join("\n    ") : ""));

const readTar = (path) => { for (const p of [path, "./" + path]) { try { return run(["-xzOf", tarball, p], { stdio: ["ignore", "pipe", "ignore"] }); } catch {} } return null; };

const pkg = readTar("package.json");
let version = "?";
try { version = JSON.parse(pkg).version; } catch {}
const versionOk = /-test\.\d+$/.test(version) || allowRelease;
(versionOk ? pass : bad)("version " + version + (versionOk ? "" : " — release numbers must never be hot-deployed (one version number = one payload)"));

const buildId = (readTar(".next/BUILD_ID") || "").trim();
(buildId.length >= 8 ? pass : bad)("BUILD_ID " + (buildId || "MISSING"));

for (const [file, e] of want) {
  const content = readTar(file);
  if (content === null) { bad("marker file missing from tarball: " + file); continue; }
  if (!e.regex) { pass("marker file present: " + file); continue; }
  (new RegExp(e.regex).test(content) ? pass : bad)("marker /" + e.regex + "/ in " + file);
}

if (fails.length) { console.log("GATE FAIL (" + fails.length + ") — do NOT transfer"); process.exit(1); }
console.log("GATE PASS");

