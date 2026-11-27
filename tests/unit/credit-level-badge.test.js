/**
 * 定性消耗档徽章（registry `creditLevel`）—— AutoClaw 客户端「消耗」列的
 * 低/中/高。与数字倍率徽章并列，不替代它：上游目录接口
 * autoclaw-model-config 同时给 creditConsumptionLevel（档位）与
 * creditCostFactor（数字），两个都是公布事实，都如实显示。
 *
 * 这里守三件事：纯函数只认三个 canonical 键（未知值不出徽章，绝不猜）、
 * ModelRow 的渲染契约（徽章不被倍率守卫包住）、三语词表齐全（缺键会让
 * 中文界面直接印英文 Low/Medium/High）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { creditLevelBadge, CREDIT_LEVEL_BADGES } from "../../src/shared/utils/creditLevel.js";
import autoclawCn from "../../open-sse/providers/registry/autoclaw-cn.js";
import autoclawIntl from "../../open-sse/providers/registry/autoclaw.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const MODEL_ROW = read("../../src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js");
const locales = {
  "zh-CN": JSON.parse(read("../../public/i18n/literals/zh-CN.json")),
  "zh-TW": JSON.parse(read("../../public/i18n/literals/zh-TW.json")),
};

describe("creditLevelBadge pure resolver", () => {
  it("maps the three canonical keys onto distinct badge specs", () => {
    expect(Object.keys(CREDIT_LEVEL_BADGES)).toEqual(["low", "medium", "high"]);
    const specs = ["low", "medium", "high"].map((k) => creditLevelBadge(k));
    expect(specs.map((s) => s.label)).toEqual(["Low", "Medium", "High"]);
    // 三个视觉不同的标记：同一行同时带倍率徽章时不会读成一个含混的标签。
    expect(new Set(specs.map((s) => s.variant)).size).toBe(3);
    expect(new Set(specs.map((s) => s.icon)).size).toBe(3);
  });

  it("tolerates casing/whitespace but never guesses an unknown tier", () => {
    expect(creditLevelBadge(" High ")).toBe(CREDIT_LEVEL_BADGES.high);
    for (const bad of ["低", "middle", "very-high", "", null, undefined, 0, 3, {}]) {
      expect([JSON.stringify(bad), creditLevelBadge(bad)]).toEqual([JSON.stringify(bad), null]);
    }
  });
});

describe("creditLevel registry flag", () => {
  it("declares a tier on every AutoClaw row, matching the client's 消耗 column", () => {
    // 客户端 2026-11-26 口径：Auto 低 / Auto-Fast 中 / GLM-5.4 高 /
    // GLM-5.3 高 / GLM-5.3-Flash 低 / GLM-5.3-FlashX-Legal 中。
    const expected = {
      "zai_auto": "low",
      "zai_auto-fast": "medium",
      "zai_glm-x-preview": "high",
      "zaicoding_glm-5.3": "high",
      "zai_glm-5.3-flash": "low",
      "zai_glm-5.3-flashx-legal": "medium",
    };
    for (const entry of [autoclawCn, autoclawIntl]) {
      expect(Object.fromEntries(entry.models.map((m) => [m.id, m.creditLevel]))).toEqual(expected);
    }
  });

  it("keeps the tier independent of the published multiplier", () => {
    // 两个事实回答不同问题（「官方标的档」vs「公布的数字」）。同档可以不同
    // 数字（Auto 0.4 与 Flash 0.5 都是「低」），所以不能由数字反推档位。
    const byId = Object.fromEntries(autoclawCn.models.map((m) => [m.id, m]));
    expect(byId["zai_auto"].creditLevel).toBe(byId["zai_glm-5.3-flash"].creditLevel);
    expect(byId["zai_auto"].rateMultiplier).not.toBe(byId["zai_glm-5.3-flash"].rateMultiplier);
    expect(creditLevelBadge(byId["zai_auto"].creditLevel)).not.toBeNull();
    expect(typeof byId["zai_auto"].rateMultiplier).toBe("number");
  });

  it("stores the canonical key, not the upstream's Chinese wording", () => {
    // 注册表保持与语言无关；低/中/高 只在渲染层经 translate 出来。
    for (const m of autoclawCn.models) expect(m.creditLevel).toMatch(/^(low|medium|high)$/);
  });
});

describe("credit-level badge rendering contract", () => {
  it("renders the tier through translate, so zh reads 消耗 低 not Consumption Low", () => {
    expect(MODEL_ROW).toContain('translate("Consumption") + " " + translate(creditLevel.label)');
    expect(MODEL_ROW).toContain('translate("Credit consumption tier")');
    expect(MODEL_ROW).toContain("creditLevel && (");
  });

  it("is NOT wrapped by the multiplier guard — a tier without a number must still show", () => {
    // 与 paidTier/subPriority 同一姿态：倍率缺席时档位徽章不能被一起吞掉。
    expect(MODEL_ROW).not.toContain("displayMultiplier !== null && creditLevel");
    const tierAt = MODEL_ROW.indexOf("creditLevel && (");
    const multiplierAt = MODEL_ROW.indexOf("(displayMultiplier !== null || nightFreeNow) && (");
    expect(tierAt).toBeGreaterThan(0);
    expect(multiplierAt).toBeGreaterThan(0);
    expect(tierAt).toBeLessThan(multiplierAt);
  });

  it("declares the flag in propTypes with the three allowed keys", () => {
    expect(MODEL_ROW).toContain('creditLevel: PropTypes.oneOf(["low", "medium", "high"])');
  });

  it("has every badge literal in both Chinese dictionaries", () => {
    const literals = ["Consumption", "Credit consumption tier", ...Object.values(CREDIT_LEVEL_BADGES).map((s) => s.label)];
    for (const [loc, dict] of Object.entries(locales)) {
      for (const key of literals) {
        expect([loc, key, typeof dict[key]]).toEqual([loc, key, "string"]);
        expect(dict[key].length).toBeGreaterThan(0);
      }
    }
    // 档位词必须真的是那三个字，别被别处的 Low/High 复用成「低配/高配」。
    expect([locales["zh-CN"].Low, locales["zh-CN"].Medium, locales["zh-CN"].High]).toEqual(["低", "中", "高"]);
    expect(locales["zh-CN"].Consumption).toBe("消耗");
  });
});
