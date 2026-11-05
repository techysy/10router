import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../../");

describe("test-build-version N+1 gate (scripts/test-build-version.mjs)", () => {
  it("strictly refuses to stamp an already-used or decremented test.N round", () => {
    let threw = false;
    try {
      execFileSync(
        process.execPath,
        [join(ROOT, "scripts/test-build-version.mjs"), "1.7.0-test.1"],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (e) {
      threw = true;
      const output = (e.stderr || "") + (e.stdout || "");
      expect(output).toContain("ALREADY used for 1.7.0");
      expect(output).toContain("Test builds must strictly increment N+1");
    }
    expect(threw).toBe(true);
  });

  it("permits stamping with --force override even if round was used", () => {
    const output = execFileSync(
      process.execPath,
      [join(ROOT, "scripts/test-build-version.mjs"), "1.7.0-test.1", "--force"],
      { cwd: ROOT, encoding: "utf8" }
    );
    expect(output).toContain("stamped");
    // Revert immediately to keep tree clean
    execFileSync(
      process.execPath,
      [join(ROOT, "scripts/test-build-version.mjs"), "--revert"],
      { cwd: ROOT, encoding: "utf8" }
    );
  });
});
