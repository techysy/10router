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

  it("treats an active promotion as a DISCOUNT, not as free — only multiplier 0 badges free", () => {
    // 2026-11-27 CN live probe (four real accounts, identical): glm-5.4
    // 「首发上线」ships price_factor 1.2 + an active promotion, and
    // ling-3.1-flash 「限时1折」ships 0.1 + an active promotion. The badge
    // used to read `rateMultiplier === 0 || model.promotion`, so both of
    // those paid rows rendered as green `free` in the combo picker while the
    // detail page (ModelRow: showFreeBadge from the multiplier alone) said
    // 1.20x / 0.10x — two surfaces, two prices, one of them a lie. Free is
    // decided solely by the multiplier, because the catalog side already
    // gated it (price_factor 0 with no active promotion → multiplier null).
    const badge = src.slice(src.indexOf("model.isLive && typeof model.rateMultiplier"));
    expect(badge).toMatch(/model\.rateMultiplier === 0\s*\?\s*"free"/);
    expect(badge.slice(0, badge.indexOf("translate(\"Credit multiplier\")"))).not.toMatch(/model\.promotion/);
    // The promotion's own text still travels — into the tooltip, same helper
    // ModelRow uses, so the wording matches between the two surfaces.
    expect(src).toContain("promotionBadgeNote");
    expect(src).toMatch(/const promoNote = promoBadgeNote\(model\.promotion\);/);
    expect(src).toMatch(/\$\{promoNote \? ` \(\$\{promoNote\}\)` : ""\}/);
  });
});
