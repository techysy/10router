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

  it("marks every Pro-Only row the client badges with the lock", () => {
    // 2026-11-05 第三版客户端清单：Pro Only 徽章接管了旧积分页的付费锁语义
    // （Claude 系已随目录换代下架，Pro Only 是它的后继）。免费账号无法请求
    // 这批模型，paidTier 就是让 ModelRow 如实告知，而不是让用户撞一个 11102
    // 后误以为目录坏了。可达性未经现网验证（无 Pro 账号）——标记表达的是
    // 客户端公布的档位门槛，不是实测结论。
    const proOnly = intl.models.filter((m) => m.proOnly);
    expect(proOnly.length).toBeGreaterThan(0);
    for (const m of proOnly) {
      expect([m.id, m.paidTier]).toEqual([m.id, true]);
    }
  });

  it("does not mark the models the client shows without the Pro-Only badge", () => {
    // The flag means "subscription-gated", not "unverified". 无徽章行 = 所有
    // 档位可用，标记它们会让用户去追一个不存在的锁。
    for (const id of ["auto", "glm-5.3", "glm-5.3-flash", "kimi-k3", "minimax-m3.1-flash", "hy4-preview", "hy3"]) {
      expect([id, byId[id]?.paidTier]).toEqual([id, undefined]);
    }
  });

  it("keeps the flag independent of the multiplier", () => {
    // The two facts are about different things (price vs access).
    // gpt-6-luna carries both a published rate (0.07) and the lock.
    expect(byId["gpt-6-luna"].paidTier).toBe(true);
    expect(byId["gpt-6-luna"].rateMultiplier).toBe(0.07);
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

  it("explains the badge in a tooltip that does not over-promise a reason", () => {
    // "Paid tier" alone would read as a price tier. But the tooltip must not
    // assert a single cause either: these ids answered 11102 on this machine's
    // account while the credit page showed a "coming soon" panel, so the truth
    // is "tier-gated OR still rolling out" — and a paid user who still gets
    // 11102 should not be sent chasing their plan.
    expect(MODEL_ROW).toContain('translate("Not available on every plan yet — needs a paid tier, or is still rolling out")');
    expect(MODEL_ROW).toContain("<Tooltip");
  });

  it("declares the flag in propTypes so a typo cannot pass silently", () => {
    expect(MODEL_ROW).toContain("paidTier: PropTypes.bool");
  });

  });

describe("subPriority registry flag", () => {
  const cnById = Object.fromEntries(cn.models.map((m) => [m.id, m]));
  const intlById = Object.fromEntries(intl.models.map((m) => [m.id, m]));

  it("marks exactly the rows the client tags 订阅优先", () => {
    // 2026-11-05 目录换代：GLM-5.3 / GLM-5.3-Flash / Kimi-K2.8-Preview(CN) 带
    // 订阅优先标签（intl 的 K2.8-Preview 已下架）。Step-5-Preview 第三版不再
    // 带标签。排队属性与价格/档位无关。
    expect(cnById["glm-5.3"].subPriority).toBe(true);
    expect(cnById["glm-5.3-flash"].subPriority).toBe(true);
    expect(cnById["kimi-k2.8-preview"].subPriority).toBe(true);
    const tagged = [...cn.models, ...intl.models].filter((m) => m.subPriority);
    expect(tagged.map((m) => `${m.id}`).sort()).toEqual([
      "glm-5.3",
      "glm-5.3-flash",
      "kimi-k2.8-preview",
    ]);
  });

  it("does not mark the models that have no such tag", () => {
    // Pro-Only 行带的是 paidTier 锁，不是订阅优先 —— 混淆会把排队声明放到
    // 客户端从未给出的行上。
    for (const m of intl.models.filter((x) => x.proOnly)) {
      expect([m.id, m.subPriority]).toEqual([m.id, undefined]);
    }
  });

  it("keeps the two flags independent on the same row", () => {
    // GLM-5.3 是订阅优先但不在付费锁后面 —— 两个徽章回答不同的问题：
    // "是否限档位？" vs "是否排队优先？"。
    expect(cnById["glm-5.3"].paidTier).toBeUndefined();
    expect(cnById["glm-5.3"].subPriority).toBe(true);
  });

  it("records Step-5-Preview's published rate and 1M context", () => {
    // 第三版客户端 0.33x（旧积分页是 0.43x）；上下文档 300/600/1M，行解析到
    // 1M 上限。
    expect(cnById["step-5-preview"]).toMatchObject({ rateMultiplier: 0.33 });
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
      expect([name, typeof table["Not available on every plan yet — needs a paid tier, or is still rolling out"]]).toEqual([name, "string"]);
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