import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import intl from "../../open-sse/providers/registry/codebuddy-intl.js";
import cn from "../../open-sse/providers/registry/codebuddy-cn.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

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
    // The two facts are about different things (price vs access). Sonnet-4.6
    // carries both (its rate is an alignment to Sonnet-5, not a page figure),
    // so assert the badge does not depend on which multiplier is present.
    const sonnet = byId["claude-sonnet-4.6"];
    expect(sonnet.paidTier).toBe(true);
    // The guard on the multiplier badge must not wrap the paid-tier badge: a
    // paid-tier model with no published rate would then lose its lock entirely.
    expect(MODEL_ROW).not.toContain("displayMultiplier !== null && model.paidTier");
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

  });

describe("subPriority registry flag", () => {
  const cnById = Object.fromEntries(cn.models.map((m) => [m.id, m]));
  const intlById = Object.fromEntries(intl.models.map((m) => [m.id, m]));

  it("marks exactly the rows the credit page tags 订阅优先", () => {
    // Step-5-Preview (CN, 0.43x) and Kimi-K2.8-Preview (0.77x on BOTH lines —
    // one credit system, and the tag was visible on the CN page too). Both are
    // preview models queued ahead for subscribers — a scheduling property that
    // says nothing about price or about whether your account can call them.
    expect(cnById["step-5-preview"].subPriority).toBe(true);
    expect(cnById["kimi-k2.8-preview"].subPriority).toBe(true);
    expect(intlById["kimi-k2.8-preview"].subPriority).toBe(true);
    const tagged = [...cn.models, ...intl.models].filter((m) => m.subPriority);
    expect(tagged.map((m) => `${m.id}`).sort()).toEqual([
      "kimi-k2.8-preview",
      "kimi-k2.8-preview",
      "step-5-preview",
    ]);
  });

  it("does not mark the models that have no such tag", () => {
    // The Claude line carries the paid-tier LOCK, not 订阅优先 — conflating the
    // two would put a queueing claim on rows the page never gave it to.
    for (const m of intl.models.filter((x) => x.id.startsWith("claude-"))) {
      expect([m.id, m.subPriority]).toEqual([m.id, undefined]);
    }
  });

  it("keeps the two flags independent on the same row", () => {
    // Step-5-Preview is 订阅优先 but NOT behind a paid lock on the page, so it
    // must not acquire paidTier by association. The two badges answer different
    // questions: "is it gated?" vs "is it queued ahead?".
    expect(cnById["step-5-preview"].paidTier).toBeUndefined();
    expect(cnById["step-5-preview"].subPriority).toBe(true);
  });

  it("records Step-5-Preview's published rate and 1M context", () => {
    // 0.43x off the 2026-10-09 credit page; the context picker offers
    // 300/600/1M and the row resolves to the 1M ceiling.
    expect(cnById["step-5-preview"]).toMatchObject({ rateMultiplier: 0.43 });
    expect(getCapabilitiesForModel("codebuddy-cn", "step-5-preview").contextWindow).toBe(1000000);
  });
});

describe("subscription-priority badge rendering contract", () => {
  it("renders an info badge with a bolt icon, distinct from the paid-tier lock", () => {
    // info + bolt vs warning + lock: two visually distinct marks, so a row that
    // ever carries both does not read as one ambiguous badge.
    expect(MODEL_ROW).toContain("model.subPriority && (");
    expect(MODEL_ROW).toContain('translate("Sub priority")');
    expect(MODEL_ROW).toContain('translate("Prioritized for subscribers")');
    expect(MODEL_ROW).toContain("subPriority: PropTypes.bool");
    const sub = MODEL_ROW.slice(MODEL_ROW.indexOf("model.subPriority && ("));
    expect(sub.slice(0, 400)).toContain('variant="info"');
    expect(sub.slice(0, 400)).toContain('icon="bolt"');
  });

  it("does not nest the sub-priority badge inside the paid-tier guard", () => {
    // Otherwise a 订阅优先 row without the lock would lose the badge entirely.
    expect(MODEL_ROW).not.toContain("model.paidTier && model.subPriority");
  });
});

describe("paid-tier badge i18n", () => {
  it("has both strings in every locale that has a table", () => {
    // en.json does not exist by design — English falls back to the key itself.
    for (const [name, table] of Object.entries(locales)) {
      expect([name, typeof table["Paid tier"]]).toEqual([name, "string"]);
      expect([name, typeof table["Only available on paid subscription tiers"]]).toEqual([name, "string"]);
      expect([name, typeof table["Sub priority"]]).toEqual([name, "string"]);
      expect([name, typeof table["Prioritized for subscribers"]]).toEqual([name, "string"]);
    }
  });

  it("does not leave a Chinese string sitting in an untranslated slot", () => {
    // The repo convention: zh-CN / zh-TW carry real translations. A copy-pasted
    // simplified form in zh-TW is the failure this catches.
    expect(locales["zh-TW"]["Paid tier"]).toBe("付費檔");
    expect(locales["zh-TW"]["Paid tier"]).not.toBe(locales["zh-CN"]["Paid tier"]);
  });
});