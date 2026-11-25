// The N+1 round gate on scripts/test-build-version.mjs.
//
// This test used to invoke the script against the REAL checkout: it read the
// developer's gitignored `.test-round.json` (which CI never has, so the
// "already used" case silently passed through) and, on the --force path,
// stamped package.json / cli / desktop / fnos manifest in place and reverted
// them. That made it fail on a clean checkout and race every other worker that
// reads package.json.
//
// Both directions are fixed by pointing the script at a throwaway ledger
// (TEST_BUILD_ROUND_FILE) and asserting the refusal path only — the --force
// case is what used to write files, and it is already covered by
// tests/unit/test-build-version.test.js at the unit level.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../../");
const SCRIPT = join(ROOT, "scripts/test-build-version.mjs");

let dir;
let roundFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "10router-round-"));
  roundFile = join(dir, "rounds.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (args) =>
  execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TEST_BUILD_ROUND_FILE: roundFile },
  });

describe("test-build-version N+1 gate (scripts/test-build-version.mjs)", () => {
  it("refuses an already-used round", () => {
    // Round 3 is on the ledger, so re-stamping it must be rejected.
    writeFileSync(roundFile, JSON.stringify({ "1.7.0": 3 }));

    expect(() => run(["1.7.0-test.3"])).toThrow(/ALREADY used for 1\.7\.0/);
    expect(() => run(["1.7.0-test.3"])).toThrow(/Test builds must strictly increment N\+1/);
  });

  it("refuses a decremented round too", () => {
    writeFileSync(roundFile, JSON.stringify({ "1.7.0": 5 }));
    expect(() => run(["1.7.0-test.1"])).toThrow(/ALREADY used/);
  });

  it("names the next valid round in the refusal", () => {
    // Guards the boundary this gate is easy to get wrong: `<=` (refuse) vs `<`.
    writeFileSync(roundFile, JSON.stringify({ "1.7.0": 6 }));
    // test.6 is on the ledger → refused, and the message points at test.7.
    expect(() => run(["1.7.0-test.6"])).toThrow(/Next valid version: 1\.7\.0-test\.7/);
  });

  it("an unused round gets past the N+1 gate", () => {
    // Round 7 is above the ledger, so the N+1 rule must wave it through. The
    // run is stopped by the NEXT guard (release comparison) instead — that
    // keeps this test on the read-only path rather than stamping the tree.
    writeFileSync(roundFile, JSON.stringify({ "1.7.0": 6 }));
    let message = "";
    try {
      run(["1.0.0-test.7"]);
    } catch (e) {
      message = (e.stderr || "") + (e.stdout || "");
    }
    expect(message).not.toContain("ALREADY used");
    expect(message).not.toContain("strictly increment N+1");
  });
});
