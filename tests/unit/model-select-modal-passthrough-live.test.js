/**
 * ModelSelectModal — passthrough providers join the live catalog (2026-11-23
 * user report: combo picker showed only the 4 hand-built qwenwork aliases
 * while the provider detail page listed the full live directory).
 *
 * qwenwork / qwenwork-cn are passthroughModels providers: the picker's
 * passthrough branch only read aliases + custom models + the static roster,
 * never the per-connection live catalog the detail page renders. Source
 * guards pin: the provider list, the live-row merge in the passthrough
 * branch (prefix strip → alias value shape), the fail-open fallback, and
 * the rate badge on live rows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const src = readFileSync(abs("src/shared/components/ModelSelectModal.js"), "utf8");

describe("ModelSelectModal passthrough live catalog", () => {
  it("fetches the live catalog for qwenwork and qwenwork-cn too", () => {
    const match = src.match(/const LIVE_CATALOG_PROVIDERS\s*=\s*\[([^\]]+)\]/);
    expect(match).toBeTruthy();
    expect(match[1]).toContain('"qwenwork"');
    expect(match[1]).toContain('"qwenwork-cn"');
  });

  it("merges live rows into the passthrough branch, not only the standard branch", () => {
    // The merge lives inside the passthroughModels branch: it strips the
    // provider-prefixed live id (qwenwork-cn/flash → flash) before composing
    // the value, so combo values stay <alias>/<modelKey> (qwc/flash).
    expect(src).toContain("const livePrefix");
    expect(src).toMatch(/m\.id\.startsWith\(livePrefix\)/);
    expect(src).toMatch(/value:\s*`\$\{alias\}\/\$\{modelKey\}`/);
    expect(src).toContain("isLive: true");
  });

  it("keeps alias/custom rows ahead of live rows and never empties the pool on failure", () => {
    // Live rows are appended (alias + custom + static first) and gated on a
    // non-empty fetched list — a failed/empty fetch leaves the old pool.
    expect(src).toMatch(/providerLiveModels\.length > 0/);
    expect(src).toMatch(/combined = combined\.concat\(/);
  });

  it("dedupes live rows against hardcoded static entries", () => {
    // qwen4-max exists in both the static roster and the live catalog; the
    // static values must be in `seen` before live rows are appended.
    expect(src).toMatch(/for \(const m of hardcoded\) seen\.add\(m\.value\);/);
  });

  it("renders the ModelRow-consistent rate badge on live rows", () => {
    expect(src).toMatch(/model\.isLive && typeof model\.rateMultiplier === "number"/);
    expect(src).toContain('translate("Credit multiplier")');
    expect(src).toContain("standard rate");
  });
});
