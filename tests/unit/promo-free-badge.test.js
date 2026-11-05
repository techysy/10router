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

describe("codebuddy intl Hy3/Hy4 free-now promo", () => {
  // 2026-11-05 第三版客户端：V4.1-Flash 的 10-31 限免已随目录换代结束（该行
  // promoFreeUntil 移除，回归 0.11x 原价）；Hy3/Hy4 的 Free now 窗口成为
  // intl 侧限免的现存实例。CN 侧同窗不同价（0.05/0.29 原价），两侧独立。
  for (const [id, until] of [["hy4-preview", "2026-11-15T00:00:00+08:00"], ["hy3", "2026-11-15T00:00:00+08:00"]]) {
    it(`${id}: carries the client's window and stays rate-bearing after it`, () => {
      const entry = intl.models.find((m) => m.id === id);
      expect(entry.promoFreeUntil).toBe(until);
      expect(entry.promoFreeNote).toMatch(/每日赠送/);
      expect(isPromoFree(entry, Date.parse("2026-11-14T00:00:00+08:00"))).toBe(true);
      expect(isPromoFree(entry, Date.parse("2026-11-15T00:00:01+08:00"))).toBe(false);
    });
  }

  it("V4.1-Flash promo ended with the catalog generation — back to plain 0.11x", () => {
    const entry = intl.models.find((m) => m.id === "deepseek-v4.1-flash");
    expect(entry).toMatchObject({ rateMultiplier: 0.11 });
    expect(entry.promoFreeUntil).toBeUndefined();
  });

  it("CN Hy3/Hy4 keep their own dated promo (independent rate cards)", () => {
    for (const [id, rate] of [["hy3", 0.05], ["hy4", 0.29]]) {
      const m = cn.models.find((x) => x.id === id);
      expect(m.rateMultiplier).toBe(rate);
      expect(m.promoFreeUntil).toBe("2026-11-15T00:00:00+08:00");
    }
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

describe("qoder / qoder-cn 的 DeepSeek-V4.1-Flash-1017 限免", () => {
  // 2026-10-20 Qoder 客户端模型卡：dfmodel = DeepSeek-V4.1-Flash-1017，
  // 个人版 0.0x 至 2026-10-25 00:00 (UTC+8)，之后回 0.1x。
  for (const [name, entry] of [["qoder", intlQoder], ["qoder-cn", cnQoder]]) {
    it(`${name}: dfmodel 名称与限免窗口正确`, () => {
      const m = entry.models.find((x) => x.id === "dfmodel");
      expect(m).toMatchObject({
        name: "DeepSeek-V4.1-Flash 1017",
        // 必须是带时区的 ISO：裸日期会被解析成 UTC 零点，等于多送 8 小时
        promoFreeUntil: "2026-10-25T00:00:00+08:00",
      });
      expect(isPromoFree(m, Date.parse("2026-10-24T23:59:59+08:00"))).toBe(true);
      expect(isPromoFree(m, Date.parse("2026-10-25T00:00:01+08:00"))).toBe(false);
    });
  }
});
