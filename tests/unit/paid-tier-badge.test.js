import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import intl from "../../open-sse/providers/registry/codebuddy-intl.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const MODEL_ROW = read("../../src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js");
const locales = {
  "zh-CN": JSON.parse(read("../../public/i18n/literals/zh-CN.json")),
  "zh-TW": JSON.parse(read("../../public/i18n/literals/zh-TW.json")),
};

describe("paidTier registry flag", () => {
  const byId = Object.fromEntries(intl.models.map((m) => [m.id, m]));

  it("marks the whole Claude family the credit page shows behind a lock", () => {
    // 2026-10-09 credit page: every Claude row carries the paid-tier lock. The
    // flag is what lets ModelRow say so, instead of a user discovering it as a
    // 11102 and concluding the catalog is broken.
    const claude = intl.models.filter((m) => m.id.startsWith("claude-"));
    expect(claude.length).toBe(8);
    for (const m of claude) expect([m.id, m.paidTier]).toEqual([m.id, true]);
  });

  it("does not mark the models that answer on a free account", () => {
    // The flag means "subscription-gated", not "unverified". These all answer
    // 200 on a free tier, so marking them would send users chasing a lock that
    // is not the reason anything fails.
    for (const id of ["gpt-6-astra", "gpt-6-sol", "glm-5.3", "kimi-k3", "hy4-preview", "hy3"]) {
      expect([id, byId[id].paidTier]).toEqual([id, undefined]);
    }
  });

  it("keeps the flag independent of the multiplier", () => {
    // claude-sonnet-4.6 has no published rate AND is paid-tier; the badge must
    // still render. The two facts are about different things (price vs access),
    // and collapsing them would hide one whenever the other is missing.
    const sonnet = byId["claude-sonnet-4.6"];
    expect(sonnet.rateMultiplier).toBeUndefined();
    expect(sonnet.paidTier).toBe(true);
  });
});

describe("paid-tier badge rendering contract", () => {
  it("renders a warning badge with a lock icon when the flag is set", () => {
    expect(MODEL_ROW).toContain("model.paidTier && (");
    expect(MODEL_ROW).toContain('variant="warning"');
    expect(MODEL_ROW).toContain('icon="lock"');
    expect(MODEL_ROW).toContain('translate("Paid tier")');
  });

  it("explains the badge in a tooltip rather than in the label", () => {
    // "Paid tier" alone would read as a price tier. The tooltip carries the
    // part that actually matters: availability follows the account's plan.
    expect(MODEL_ROW).toContain('translate("Only available on paid subscription tiers")');
    expect(MODEL_ROW).toContain("<Tooltip");
  });

  it("declares the flag in propTypes so a typo cannot pass silently", () => {
    expect(MODEL_ROW).toContain("paidTier: PropTypes.bool");
  });

  it("does not couple the badge to the multiplier badge", () => {
    // The multiplier badge is guarded by `displayMultiplier !== null`, which a
    // model without a published rate never enters. Guarding the paid-tier badge
    // the same way would make it invisible exactly where it matters most.
    expect(MODEL_ROW).not.toContain("displayMultiplier !== null && model.paidTier");
  });
});

describe("paid-tier badge i18n", () => {
  it("has both strings in every locale that has a table", () => {
    // en.json does not exist by design — English falls back to the key itself.
    for (const [name, table] of Object.entries(locales)) {
      expect([name, typeof table["Paid tier"]]).toEqual([name, "string"]);
      expect([name, typeof table["Only available on paid subscription tiers"]]).toEqual([name, "string"]);
    }
  });

  it("does not leave a Chinese string sitting in an untranslated slot", () => {
    // The repo convention: zh-CN / zh-TW carry real translations. A copy-pasted
    // simplified form in zh-TW is the failure this catches.
    expect(locales["zh-TW"]["Paid tier"]).toBe("付費檔");
    expect(locales["zh-TW"]["Paid tier"]).not.toBe(locales["zh-CN"]["Paid tier"]);
  });
});