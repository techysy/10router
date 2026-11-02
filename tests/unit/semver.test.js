import { describe, it, expect } from "vitest";
import { compareSemver, compareVersions, isNewerVersion, parseSemver } from "@/shared/utils/semver.js";

describe("semver: parseSemver", () => {
  it("parses normal versions and strips v prefix", () => {
    expect(parseSemver("1.6.5")).toEqual({ major: 1, minor: 6, patch: 5, prerelease: null });
    expect(parseSemver("v1.6.5")).toEqual({ major: 1, minor: 6, patch: 5, prerelease: null });
  });

  it("parses prerelease tags", () => {
    expect(parseSemver("1.6.2-test.45")).toEqual({ major: 1, minor: 6, patch: 2, prerelease: "test.45" });
    expect(parseSemver("v1.6.2-beta.1")).toEqual({ major: 1, minor: 6, patch: 2, prerelease: "beta.1" });
  });

  it("returns null for invalid strings", () => {
    expect(parseSemver("invalid")).toBeNull();
    expect(parseSemver("")).toBeNull();
    expect(parseSemver(null)).toBeNull();
  });
});

describe("semver: compareSemver and test versions to release", () => {
  it("recognizes 1.6.5 is newer than 1.6.2-test.45 (user issue)", () => {
    expect(compareSemver("1.6.5", "1.6.2-test.45")).toBeGreaterThan(0);
    expect(isNewerVersion("1.6.5", "1.6.2-test.45")).toBe(true);
    expect(isNewerVersion("1.6.2-test.45", "1.6.5")).toBe(false);
  });

  it("treats release 1.6.2 as newer than test version 1.6.2-test.45", () => {
    expect(compareSemver("1.6.2", "1.6.2-test.45")).toBeGreaterThan(0);
    expect(isNewerVersion("1.6.2", "1.6.2-test.45")).toBe(true);
  });

  it("orders test versions numerically", () => {
    expect(compareSemver("1.6.2-test.46", "1.6.2-test.45")).toBeGreaterThan(0);
    expect(compareSemver("1.6.2-test.9", "1.6.2-test.10")).toBeLessThan(0);
    expect(compareSemver("1.6.2-test.45", "1.6.2-test.45")).toBe(0);
  });

  it("compares major and minor correctly across releases", () => {
    expect(compareVersions("2.0.0", "1.9.99")).toBeGreaterThan(0);
    expect(compareVersions("1.7.0", "1.6.5")).toBeGreaterThan(0);
    expect(compareVersions("1.6.4", "1.6.5")).toBeLessThan(0);
    expect(compareVersions("v1.6.5", "1.6.5")).toBe(0);
  });
});
