import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPromoFree, promoFreeUntilMs } from "../../src/shared/utils/promoFree.js";
import intl from "../../open-sse/providers/registry/codebuddy-intl.js";
import cn from "../../open-sse/providers/registry/codebuddy-cn.js";
import intlQoder from "../../open-sse/providers/registry/qoder.js";
import cnQoder from "../../open-sse/providers/registry/qoder-cn.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const MODEL_ROW = read("../../src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js");

describe("promoFree / promoFreeUntil", () => {
  const model = { rateMultiplier: 0.03, promoFreeUntil: "2026-09-24" };

  it("is free before the window closes and not free after", () => {
    expect(isPromoFree(model, Date.parse("2026-09-10T00:00:00Z"))).toBe(true);
    expect(isPromoFree(model, Date.parse("2026-09-23T23:59:59Z"))).toBe(true);
    // the stored date is the first instant it is NO LONGER free (UTC midnight)
    expect(isPromoFree(model, Date.parse("2026-09-24T00:00:00Z"))).toBe(false);
    expect(isPromoFree(model, Date.parse("2026-09-25T12:00:00Z"))).toBe(false);
  });

  it("treats a missing or unusable value as no promo, never as free forever", () => {
    expect(promoFreeUntilMs({})).toBeNull();
    expect(promoFreeUntilMs({ promoFreeUntil: "" })).toBeNull();
    expect(promoFreeUntilMs({ promoFreeUntil: "   " })).toBeNull();
    expect(promoFreeUntilMs({ promoFreeUntil: "not-a-date" })).toBeNull();
    expect(promoFreeUntilMs({ promoFreeUntil: 20260924 })).toBeNull();
    expect(promoFreeUntilMs(undefined)).toBeNull();
    expect(isPromoFree({ promoFreeUntil: "not-a-date" })).toBe(false);
  });

  it("resolves a bare ISO date at UTC midnight", () => {
    expect(promoFreeUntilMs({ promoFreeUntil: "2026-09-24" })).toBe(Date.parse("2026-09-24T00:00:00Z"));
  });
});

describe("codebuddy intl Hy4 free-now promo", () => {
  // 2026-11-16 第四版客户端：Hy3 从清单消失（撤行，见 codebuddy-intl-models）；
  // Hy4 的 Free now 窗口续期（卡片文案「Nov 16-30: Receive a daily free
  // allowance」）—— intl 侧限免的现存实例。CN 侧同窗不同价（0.05/0.29 原价），
  // 两侧独立。
  it("hy4-preview: carries the client's renewed window and stays rate-bearing after it", () => {
    // 2026-11-18 用户纠正（国际版截图）：Hy4 与 Hy4 flash 是两个独立模型。
    // Hy4 = 0.29x 正常计费（无 promoFreeUntil）；Free now 窗口属于 hy4-flash。
    const hy4 = intl.models.find((m) => m.id === "hy4-preview");
    expect(hy4.promoFreeUntil).toBeUndefined();
    expect(hy4.rateMultiplier).toBeGreaterThan(0);
    const flash = intl.models.find((m) => m.id === "hy4-flash");
    expect(flash.promoFreeUntil).toBe("2026-11-30T00:00:00+08:00");
    expect(flash.promoFreeNote).toMatch(/每日赠送/);
    expect(isPromoFree(flash, Date.parse("2026-11-29T00:00:00+08:00"))).toBe(true);
    expect(isPromoFree(flash, Date.parse("2026-11-30T00:00:01+08:00"))).toBe(false);
  });

  it("V4.1-Flash promo ended with the catalog generation — back to plain 0.11x", () => {
    const entry = intl.models.find((m) => m.id === "deepseek-v4.1-flash");
    expect(entry).toMatchObject({ rateMultiplier: 0.11 });
    expect(entry.promoFreeUntil).toBeUndefined();
  });

  it("CN Hy4 keeps its own renewed dated promo; Hy3 retired CN-side too (4th edition)", () => {
    // 2026-11-16 第四版：CN 客户端同样撤下 Hy3、Hy4 限免续窗 11-30——两侧同日
    // 同口径。原价口径不变（限免结束后按 rateMultiplier 计）。
    expect(cn.models.find((x) => x.id === "hy3")).toBeUndefined();
    // 2026-11-18：Hy4 是独立模型、正常计费 0.29x（限免只属于 hy4-flash）。
    const hy4 = cn.models.find((x) => x.id === "hy4");
    expect(hy4.rateMultiplier).toBe(0.29);
    expect(hy4.promoFreeUntil).toBeUndefined();
  });

  it("CN hy4-flash: new daily-grant promo row (id spelling pending live probe)", () => {
    // 与 intl 侧同款同窗（11-16 至 11-30）；rateMultiplier 0 交 promoFree 表达
    // 免费窗，窗口结束前需现网复核回填原价。
    const m = cn.models.find((x) => x.id === "hy4-flash");
    expect(m.rateMultiplier).toBe(0);
    expect(m.promoFreeUntil).toBe("2026-11-30T00:00:00+08:00");
    expect(m.promoFreeNote).toMatch(/每日赠送/);
    expect(isPromoFree(m, Date.parse("2026-11-29T00:00:00+08:00"))).toBe(true);
    expect(isPromoFree(m, Date.parse("2026-11-30T00:00:01+08:00"))).toBe(false);
  });
});

describe("promo badge rendering contract", () => {
  it("routes the badge through the promo-aware multiplier", () => {
    expect(MODEL_ROW).toContain('from "@/shared/utils/promoFree"');
    expect(MODEL_ROW).toContain("const promoFree = rateMultiplier !== null && rateMultiplier > 0 && isPromoFree(model)");
    expect(MODEL_ROW).toContain("const displayMultiplier = promoFree ? 0 : rateMultiplier");
  });

  it("uses displayMultiplier for the label and the variant, and explains the promo in the tooltip", () => {
    // nightFree (codebuddy-cn hy4-preview) joins the free condition but the
    // promo-aware multiplier chain stays intact beneath it.
    expect(MODEL_ROW).toContain("const showFreeBadge = nightFreeNow || displayMultiplier === 0");
    expect(MODEL_ROW).toContain('{showFreeBadge ? "free" : `${displayMultiplier.toFixed(2)}x`}');
    expect(MODEL_ROW).toContain('variant={showFreeBadge ? "success" : "default"}');
    expect(MODEL_ROW).toContain('translate("promo free until")');
  });

  it("night-free window drives the free badge and is time-window based", () => {
    expect(MODEL_ROW).toContain('from "@/shared/utils/nightFree"');
    expect(MODEL_ROW).toContain("const nightFreeNow = isNightFreeHour(hour, model.nightFree)");
    expect(MODEL_ROW).toContain('translate("Night-free window")');
    // the pure window check lives in its own util (tests import it directly)
    const UTIL = read("../../src/shared/utils/nightFree.js");
    expect(UTIL).toContain("export function isNightFreeHour");
  });

  it("keeps the `free` label a literal (it is never translated)", () => {
    // house rule: the badge label is the literal lowercase `free` in every locale
    for (const locale of ["zh-CN", "zh-TW"]) {
      const dict = JSON.parse(read(`../../public/i18n/literals/${locale}.json`));
      expect(dict["free"]).toBeUndefined();
    }
  });

  it("has a locale entry for the promo tooltip in every shipped locale", () => {
    for (const locale of ["zh-CN", "zh-TW"]) {
      const dict = JSON.parse(read(`../../public/i18n/literals/${locale}.json`));
      expect(typeof dict["promo free until"]).toBe("string");
      expect(dict["promo free until"].length).toBeGreaterThan(0);
    }
  });
});

describe("qoder / qoder-cn 的 dfmodel（2026-11-18 live 探测）", () => {
  // 2026-11-18 live 目录探测：dfmodel 显示名已是「DeepSeek-Flash」，
  // 限免窗口已过（原 2026-10-25 到期），现按 0.1x 正常计费。
  for (const [name, entry] of [["qoder", intlQoder], ["qoder-cn", cnQoder]]) {
    it(`${name}: dfmodel 名称与计费正确`, () => {
      const m = entry.models.find((x) => x.id === "dfmodel");
      expect(m).toMatchObject({ name: "DeepSeek-Flash", rateMultiplier: 0.1 });
      expect(m.promoFreeUntil).toBeUndefined();
    });
  }
});
