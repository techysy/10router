import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The regression gate only means something if it has been seen to fire. For a
 * long time it compared nothing but `assertionResults.filter(status==="failed")`
 * — so a suite that died on import, a test that silently downgraded to
 * `skipped`, and a test that disappeared outright all left it green. Two real
 * regressions went through it that way. This file drives the gate against each
 * class of failure and asserts it complains.
 *
 * Each case gets a miniature baseline and a matching miniature report: the gate
 * checks the whole inventory for tests that vanished, so a one-test report
 * against the real 5000-entry baseline would (correctly) report everything else
 * as missing.
 */
const here = dirname(fileURLToPath(import.meta.url));
const baselineDir = resolve(here, "..", "__baseline__");
const gateScript = join(baselineDir, "verify-no-regression.mjs");

function runGate({ inventory, knownFails = [], report }) {
  const dir = mkdtempSync(join(tmpdir(), "10router-gate-"));
  try {
    cpSync(gateScript, join(dir, "verify-no-regression.mjs"));
    writeFileSync(
      join(dir, "known-inventory.json"),
      JSON.stringify(inventory, null, 2)
    );
    writeFileSync(join(dir, "known-fails.txt"), knownFails.join("\n") + (knownFails.length ? "\n" : ""));
    const resultsPath = join(dir, "results.json");
    writeFileSync(resultsPath, JSON.stringify(report));
    try {
      const stdout = execFileSync("node", ["verify-no-regression.mjs", resultsPath], {
        cwd: dir,
        encoding: "utf8",
      });
      return { fired: false, code: 0, output: stdout };
    } catch (e) {
      return { fired: true, code: e.status, output: `${e.stdout || ""}${e.stderr || ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FILE = "/abs/path/tests/unit/example.test.js";
const ALPHA = "tests/unit/example.test.js :: alpha works";
const BETA = "tests/unit/example.test.js :: beta works";

const healthyInventory = { [ALPHA]: "passed", [BETA]: "passed" };

function healthyReport() {
  return {
    testResults: [
      {
        name: FILE,
        status: "passed",
        assertionResults: [
          { fullName: "alpha works", status: "passed" },
          { fullName: "beta works", status: "passed" },
        ],
      },
    ],
  };
}

describe("the regression gate actually fires", () => {
  it("stays green when every known state is unchanged", () => {
    const res = runGate({ inventory: healthyInventory, report: healthyReport() });
    expect(res.fired).toBe(false);
    expect(res.output).toContain("No regression");
  });

  it("fires on a new failure that is not in the baseline", () => {
    const report = healthyReport();
    report.testResults[0].assertionResults[0].status = "failed";
    const res = runGate({ inventory: healthyInventory, report });
    expect(res.fired).toBe(true);
    expect(res.output).toContain("pass→fail");
    expect(res.output).toContain(ALPHA);
  });

  it("does NOT fire on a failure already catalogued in known-fails", () => {
    const report = healthyReport();
    report.testResults[0].assertionResults[0].status = "failed";
    report.testResults[0].status = "failed";
    const res = runGate({
      inventory: healthyInventory,
      knownFails: [ALPHA],
      report,
    });
    expect(res.fired).toBe(false);
    expect(res.output).toContain("No regression");
  });

  it("fires when a passing test silently downgrades to skipped", () => {
    const report = healthyReport();
    report.testResults[0].assertionResults[0].status = "skipped";
    const res = runGate({ inventory: healthyInventory, report });
    expect(res.fired).toBe(true);
    expect(res.output).toContain("pass→skip");
    expect(res.output).toContain(ALPHA);
  });

  it("fires when a test disappears from the run entirely", () => {
    // Nothing fails — the test simply is not there any more (file deleted,
    // describe commented out, import now throwing before it registers).
    const report = healthyReport();
    report.testResults[0].assertionResults.splice(0, 1);
    const res = runGate({ inventory: healthyInventory, report });
    expect(res.fired).toBe(true);
    expect(res.output).toContain("no longer runs");
    expect(res.output).toContain(ALPHA);
    // The surviving test must not be blamed.
    expect(res.output).not.toContain(BETA);
  });

  it("fires on a suite-level failure with no assertion failures at all", () => {
    // A file that dies on import or teardown has zero failed assertions, which
    // is exactly the shape the old gate could not see.
    const report = {
      testResults: [
        {
          name: FILE,
          status: "failed",
          message: "Error: Cannot find package 'lowdb'",
          assertionResults: [],
        },
      ],
    };
    const res = runGate({ inventory: healthyInventory, report });
    expect(res.fired).toBe(true);
    expect(res.output).toContain("suite-level");
  });

  it("catalogues suite-level failures in known-fails so they stay visible", () => {
    // The two files that fail on import in a plain checkout (embeddings.cloud
    // needs the out-of-repo `cloud/` worker; db-benchmark needs the retired
    // `lowdb`) must be named in the baseline, not silently absorbed.
    const known = readFileSync(join(baselineDir, "known-fails.txt"), "utf8");
    expect(known).toContain("embeddings.cloud.test.js :: [suite-level failure]");
    expect(known).toContain("db-benchmark.test.js :: [suite-level failure]");
  });

  it("shipped inventory keys every entry as `tests/… :: fullName`", () => {
    const inventory = JSON.parse(
      readFileSync(join(baselineDir, "known-inventory.json"), "utf8")
    );
    const keys = Object.keys(inventory);
    expect(keys.length).toBeGreaterThan(1000);
    expect(keys.filter((k) => !k.startsWith("tests/") || !k.includes(" :: "))).toEqual([]);
  });
});
