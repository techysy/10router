import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPromoFree, promoFreeUntilMs } from "../../src/shared/utils/promoFree.js";
import intl from "../../open-sse/providers/registry/codebuddy-intl.js";
import cn from "../../open-sse/providers/registry/codebuddy-cn.js";

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

describe("codebuddy-intl V4.1-Flash launch promo", () => {
  const entry = intl.models.find((m) => m.id === "deepseek-v4.1-flash");

  it("keeps the published multiplier and marks the promo window separately", () => {
    expect(entry).toMatchObject({ name: "DeepSeek-V4.1-Flash", rateMultiplier: 0.03, promoFreeUntil: "2026-09-24" });
  });

  it("stays multiplier-identical to the CN gateway (shared credit system)", () => {
    // The promo must NOT be written as `rateMultiplier: 0` — that would break
    // this parity and leave a permanent "free" claim behind after the window.
    const cnEntry = cn.models.find((m) => m.id === "deepseek-v4.1-flash");
    expect(entry.rateMultiplier).toBe(cnEntry.rateMultiplier);
  });

  it("does not declare the promo on the CN gateway", () => {
    expect(cn.models.find((m) => m.id === "deepseek-v4.1-flash").promoFreeUntil).toBeUndefined();
  });

  it("is currently inside the window relative to the upstream launch date", () => {
    expect(isPromoFree(entry, Date.parse("2026-09-11T00:00:00Z"))).toBe(true);
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
    expect(MODEL_ROW).toContain("const nightFreeNow = isNightFreeHour(hour, model.nightFree)");
    expect(MODEL_ROW).toContain('translate("Night-free window")');
    expect(MODEL_ROW).toContain("export function isNightFreeHour");
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
