import { describe, it, expect } from "vitest";

// The CLI side of scripts/test-build-version.mjs stamps the four version files, so
// these tests import it only for the two pure pieces: the semver ordering that
// decides whether a test build would look like a downgrade, and the diff-line
// predicate that decides whether --revert is allowed to run at all.
// Importing must not touch the repo (the CLI body is behind an import.meta.url guard).
import { compareSemver, VERSION_LINE } from "../../scripts/test-build-version.mjs";

describe("test-build-version: semver ordering", () => {
  it("treats a prerelease as BELOW its own release", () => {
    // Stamping 1.0.8-test.1 while 1.0.8 is on a user's machine would let the
    // installed version report "no update" — or worse, offer a downgrade.
    expect(compareSemver("1.0.8-test.1", "1.0.8")).toBeLessThan(0);
    expect(compareSemver("1.0.8", "1.0.8-test.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.8", "1.0.8")).toBe(0);
  });

  it("orders a test build above the previous release", () => {
    expect(compareSemver("1.1.0-test.1", "1.0.8")).toBeGreaterThan(0);
    expect(compareSemver("1.0.9-test.1", "1.0.8")).toBeGreaterThan(0);
  });

  it("compares the test counter numerically, not as text", () => {
    expect(compareSemver("1.1.0-test.10", "1.1.0-test.9")).toBeGreaterThan(0);
    expect(compareSemver("1.1.0-test.2", "1.1.0-test.10")).toBeLessThan(0);
  });

  it("compares the numeric core before the prerelease", () => {
    expect(compareSemver("2.0.0-test.1", "1.99.99")).toBeGreaterThan(0);
    expect(compareSemver("1.2.0", "1.10.0")).toBeLessThan(0);
  });
});

describe("test-build-version: version-only diff lines", () => {
  it("accepts an actual version assignment", () => {
    expect(VERSION_LINE.test('-  "version": "1.0.8",')).toBe(true);
    expect(VERSION_LINE.test('+  "version": "1.1.0-test.1",')).toBe(true);
    expect(VERSION_LINE.test("-version               = 1.0.8")).toBe(true);
    expect(VERSION_LINE.test("+version               = 1.1.0-test.1")).toBe(true);
  });

  it("rejects other changed lines, even ones mentioning version", () => {
    // The regression that motivated matching the assignment itself: a script named
    // `test-version` contains the word "version", so a /version/i guard would have
    // let --revert discard it.
    expect(VERSION_LINE.test('+    "test-version": "node scripts/test-build-version.mjs"')).toBe(false);
    expect(VERSION_LINE.test('-    "cli:publish": "npm --prefix cli run publish:cli"')).toBe(false);
    expect(VERSION_LINE.test("+// bump the version later")).toBe(false);
    expect(VERSION_LINE.test('+  "productName": "10Router",')).toBe(false);
  });
});
