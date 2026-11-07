/**
 * Off-peak pricing support for the Qoder family: pure window math
 * (offPeak.js), the live-pricing overlay (qoderLivePricing.js), and the
 * wiring guards that keep the catalog fields flowing to the badges.
 * Real Intl (no mocks) — instants are pinned so Asia/Singapore offsets are
 * exact.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  parseClockHM,
  zonedClock,
  offPeakStatus,
  promotionText,
  formatCountdown,
} from "../../src/shared/utils/offPeak.js";
import { mergeQoderLivePricing } from "../../src/shared/utils/qoderLivePricing.js";

const PROMO = {
  active: false,
  badge: { en: "Off-Peak 60% off", zh: "错峰 4 折" },
  description: { en: "Off-Peak 60% off (10 PM-8 AM UTC+8)", zh: "错峰时段4折优惠（10 PM-8 AM UTC+8）" },
  timezone: "Asia/Singapore",
  discount_factor: 0.4,
  window_start: "22:00",
  window_end: "08:00",
};

describe("parseClockHM", () => {
  it("parses valid HH:MM into minutes", () => {
    expect(parseClockHM("22:00")).toBe(22 * 60);
    expect(parseClockHM("8:05")).toBe(8 * 60 + 5);
    expect(parseClockHM("00:00")).toBe(0);
  });
  it("rejects junk", () => {
    expect(parseClockHM("24:00")).toBeNull();
    expect(parseClockHM("12:60")).toBeNull();
    expect(parseClockHM("noon")).toBeNull();
    expect(parseClockHM(null)).toBeNull();
    expect(parseClockHM(22)).toBeNull();
  });
});

describe("zonedClock", () => {
  it("reads wall-clock in the declared timezone (SGT = UTC+8, no DST)", () => {
    // 2026-09-18T15:00:05Z → 23:00:05 Asia/Singapore
    const c = zonedClock("Asia/Singapore", Date.UTC(2026, 8, 18, 15, 0, 5));
    expect(c).toMatchObject({ hour: 23, minute: 0, second: 5 });
    expect(c.secondsOfDay).toBe(23 * 3600 + 5);
  });
  it("returns null for an unusable timezone (no claim rather than a wrong claim)", () => {
    expect(zonedClock("Mars/Olympus_Mons", Date.now())).toBeNull();
  });
});

describe("offPeakStatus", () => {
  const at = (utcIso) => Date.parse(utcIso);

  it("inside the window (23:00 SGT): active, counts down to 08:00 SGT", () => {
    const s = offPeakStatus(PROMO, at("2026-09-18T15:00:05Z")); // 23:00:05 SGT
    expect(s.active).toBe(true);
    expect(s.secondsToBoundary).toBe(9 * 3600 - 5); // to 08:00 SGT
  });

  it("outside the window (09:00 SGT): inactive, counts down to 22:00 SGT", () => {
    const s = offPeakStatus(PROMO, at("2026-09-18T01:00:00Z")); // 09:00 SGT
    expect(s.active).toBe(false);
    expect(s.secondsToBoundary).toBe(13 * 3600); // to 22:00 SGT
  });

  it("boundaries: start inclusive, end exclusive", () => {
    expect(offPeakStatus(PROMO, at("2026-09-17T14:00:00Z")).active).toBe(true); // 22:00:00 SGT
    expect(offPeakStatus(PROMO, at("2026-09-18T00:00:00Z")).active).toBe(false); // 08:00:00 SGT
  });

  it("handles a non-wrapping window (01:00→03:00)", () => {
    const p = { ...PROMO, window_start: "01:00", window_end: "03:00" };
    expect(offPeakStatus(p, at("2026-09-17T17:30:00Z")).active).toBe(true); // 01:30 SGT
    expect(offPeakStatus(p, at("2026-09-17T16:30:00Z")).active).toBe(false); // 00:30 SGT
  });

  it("null for missing window, equal start/end, or unusable timezone", () => {
    expect(offPeakStatus(null)).toBeNull();
    expect(offPeakStatus({ window_start: "22:00" })).toBeNull();
    expect(offPeakStatus({ ...PROMO, window_start: "08:00" })).toBeNull();
    expect(offPeakStatus({ ...PROMO, timezone: "Mars/Olympus_Mons" })).toBeNull();
  });
});

describe("promotionText / formatCountdown", () => {
  it("picks the reader's language with fallback", () => {
    expect(promotionText(PROMO.badge, "zh-CN")).toBe("错峰 4 折");
    expect(promotionText(PROMO.badge, "en")).toBe("Off-Peak 60% off");
    expect(promotionText({ en: "Only EN" }, "zh-TW")).toBe("Only EN");
    expect(promotionText(undefined, "zh")).toBe("");
  });
  it("formats seconds as H:MM:SS with a sane failure mode", () => {
    expect(formatCountdown(46800)).toBe("13:00:00");
    expect(formatCountdown(59)).toBe("00:00:59");
    expect(formatCountdown(-1)).toBe("--:--:--");
  });
});

describe("mergeQoderLivePricing", () => {
  const staticModels = [
    { id: "qfmodel", name: "Qwen3.8-Flash" },
    { id: "auto", name: "Auto" },
  ];
  it("overlays server pricing onto matching rows, keeps the rest untouched", () => {
    const live = [
      { id: "qoder-cn/qfmodel", rateMultiplier: 0, promotion: PROMO },
      { id: "qoder-cn/only-live", rateMultiplier: 9 },
    ];
    const out = mergeQoderLivePricing(staticModels, live);
    expect(out[0]).toMatchObject({ id: "qfmodel", name: "Qwen3.8-Flash", rateMultiplier: 0, promotion: PROMO });
    expect(out[1]).toEqual({ id: "auto", name: "Auto" }); // no live twin → verbatim
    expect(out).toHaveLength(2); // live-only models are NOT injected (static list is the source of truth)
  });
  it("null live pricing falls back to the static row (never fabricates 0x)", () => {
    const out = mergeQoderLivePricing(
      [{ id: "auto", rateMultiplier: 1 }],
      [{ id: "qoder/auto", rateMultiplier: null, promotion: null }],
    );
    expect(out[0].rateMultiplier).toBe(1);
    expect(out[0].promotion).toBeNull();
  });
  it("限免行保留注册表原价，不被实时 0x 覆盖（否则看不到截止时间与恢复价格）", () => {
    const withPromo = [
      { id: "dfmodel", name: "DeepSeek-V4.1-Flash 1017", rateMultiplier: 0.1, promoFreeUntil: "2026-10-25T00:00:00+08:00" },
    ];
    const live = [{ id: "qoder-cn/dfmodel", rateMultiplier: 0, promotion: null }];
    const out = mergeQoderLivePricing(withPromo, live);
    expect(out[0].rateMultiplier).toBe(0.1);              // 原价保留 → badge 走 promo 分支显示 free
    expect(out[0].promoFreeUntil).toBe("2026-10-25T00:00:00+08:00"); // 截止时间不丢
  });
  it("无限免标记的行仍用实时倍率（账户真实价格，含 off-peak）", () => {
    const plain = [{ id: "qfmodel", name: "Qwen3.8-Flash", rateMultiplier: 0.34 }];
    const live = [{ id: "qoder/qfmodel", rateMultiplier: 0 }];
    expect(mergeQoderLivePricing(plain, live)[0].rateMultiplier).toBe(0);
  });
  it("live 原价透传（originalRateMultiplier）—— 0× 徽章的 tooltip 才有原价可显", () => {
    const plain = [{ id: "lmodel", name: "QoDuck", rateMultiplier: 0.5 }];
    const live = [{ id: "qoder-cn/lmodel", rateMultiplier: 0, originalRateMultiplier: 0.5, promotion: null }];
    const out = mergeQoderLivePricing(plain, live);
    expect(out[0].rateMultiplier).toBe(0);                  // 现价 = 限免 0×
    expect(out[0].originalRateMultiplier).toBe(0.5);        // 原价不被合并吃掉
  });
  it("empty live catalog (fetch failed) → static list verbatim", () => {
    expect(mergeQoderLivePricing(staticModels, [])).toBe(staticModels);
  });
});

describe("catalog → badge wiring guards", () => {
  it("qoderModels maps price_factor/promotion onto the model entries", () => {
    const src = readFileSync(new URL("../../open-sse/services/qoderModels.js", import.meta.url), "utf8");
    expect(src).toMatch(/rateMultiplier:\s*typeof entry\.price_factor === "number"/);
    expect(src).toMatch(/originalRateMultiplier:\s*typeof entry\.original_price_factor === "number"/);
    expect(src).toMatch(/promotion:\s*entry\.promotion/);
  });
  it("the models route serves BOTH qoder regions through one resolver and forwards the fields", () => {
    const src = readFileSync(new URL("../../src/app/api/providers/[id]/models/route.js", import.meta.url), "utf8");
    expect(src).toMatch(/"qoder-cn":\s*\{\s*customResolver:\s*resolveQoderCatalog/);
    expect(src).toMatch(/provider:\s*connection\.provider,/); // CN connections dial the CN gateway
    expect(src).toMatch(/rateMultiplier:\s*m\.rateMultiplier,\s*\n\s*originalRateMultiplier:\s*m\.originalRateMultiplier,\s*\n\s*promotion:\s*m\.promotion,/);
  });
  it("the provider page overlays live pricing and renders the countdown banner", () => {
    const src = readFileSync(new URL("../../src/app/(dashboard)/dashboard/providers/[id]/page.js", import.meta.url), "utf8");
    expect(src).toContain("mergeQoderLivePricing(staticModels, liveModels)");
    expect(src).toContain("<OffPeakBanner promotion={offPeakPromotion}");
  });
});

// Regression guard for the 2026-09-19 report ("倍率和免费徽章怎么没有做"):
// the badge data exists server-side, but the client only ever fetched
// liveModels for cursor, so the qoder pages merged against an empty array
// and rendered no badges/banner at all. The fetch gate must keep the whole
// qoder family in scope.
describe("live-pricing fetch wiring (client gate)", () => {
  const pageSrc = readFileSync(new URL("../../src/app/(dashboard)/dashboard/providers/[id]/page.js", import.meta.url), "utf8");

  it("fetches the live catalog for cursor AND the qoder family", () => {
    expect(pageSrc).toMatch(/providerId !== "cursor" && !isQoderFamily/);
  });

  it("registers q37fmodel (Qwen3.7-Flash) so the lone custom row is retired", () => {
    const registry = readFileSync(new URL("../../open-sse/providers/registry/qoder-cn.js", import.meta.url), "utf8");
    expect(registry).toMatch(/id: "q37fmodel", name: "Qwen3.7-Flash"/);
  });
});
