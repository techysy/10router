import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCAN_DIRS = ["src", "cli", "open-sse", "scripts"];
const SCAN_ROOT_FILES = ["custom-server.js", "next.config.mjs"];

// `cli/app` is a generated copy of the root tree (untracked build output) and may
// legitimately lag until the next build; its `.bak*` snapshots likewise. `desktop/dist`
// and `.next*` are bundles.
function isSource(file) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
  if (rel === "cli/app" || rel.startsWith("cli/app/") || rel.startsWith("cli/app.")) return false;
  if (rel.includes("node_modules/")) return false;
  if (rel.includes("/dist/") || rel.startsWith("dist/")) return false;
  if (rel.includes("/.next") || rel.startsWith(".next")) return false;
  return /\.(js|mjs|cjs)$/.test(file);
}

// isSource already rejects every file under node_modules / .next* / dist, so
// don't pay the traversal either — a cli/app backup alone drags in a full
// node_modules tree, and the walk runs against the live tree on every test run.
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".next")) continue;
      yield* walk(p);
    } else if (isSource(p)) yield p;
  }
}

function sourceFiles() {
  const out = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO_ROOT, d);
    if (fs.existsSync(abs)) out.push(...walk(abs));
  }
  for (const f of SCAN_ROOT_FILES) {
    const abs = path.join(REPO_ROOT, f);
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

const LEGACY_ENV = /process\.env\.NINEROUTER_[A-Z0-9_]+/;
const CURRENT_ENV = /process\.env\.TENROUTER_/;

// A fallback is often wrapped across lines (`A\n  || B\n  || C`). Fold the
// continuation back so the rule stays "same statement" rather than "same line",
// which would either miss a bare legacy read or force unreadable one-liners.
function toLogicalLines(src) {
  return src.replace(/\r?\n\s*(\|\||&&)\s*/g, " $1 ").split(/\r?\n/);
}

describe("9Router → 10Router env var rebrand", () => {
  it("reads TENROUTER_* first, keeping NINEROUTER_* only as a fallback in the same statement", () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      toLogicalLines(fs.readFileSync(file, "utf8")).forEach((line, i) => {
        if (!LEGACY_ENV.test(line)) return;
        // A legacy read is only acceptable when its replacement is right there,
        // so the two names can never drift apart unnoticed.
        if (!CURRENT_ENV.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the architecture doc in step with the code it documents", () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, "docs/zh-CN/ARCHITECTURE.md"), "utf8");
    expect(doc).toContain("TENROUTER_PEER_TOKEN");
    expect(doc).not.toContain("NINEROUTER_PEER_TOKEN");
  });

  it("wires the token through both ends of the stamping chain", () => {
    const server = fs.readFileSync(path.join(REPO_ROOT, "custom-server.js"), "utf8");
    const peer = fs.readFileSync(path.join(REPO_ROOT, "src/lib/auth/trustedPeer.js"), "utf8");
    expect(server).toContain("process.env.TENROUTER_PEER_TOKEN = PEER_TOKEN");
    expect(peer).toContain("process.env.TENROUTER_PEER_TOKEN");
  });
});
