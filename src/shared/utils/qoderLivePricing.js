/**
 * Overlay server-published Qoder pricing onto the static registry models.
 *
 * The provider page's official model list is the static catalog (ids are the
 * raw Qoder keys: "qfmodel", "qmodel_38max", …), while /api/providers/[id]/models
 * returns the LIVE catalog with ids prefixed "<provider>/<key>". The live
 * entries carry the promo-aware pricing the static file can't know about
 * (price_factor currently 0 for a free window, the off-peak promotion object
 * with its 22:00–08:00 window). This joins them by bare key and copies only
 * the pricing fields — names/capabilities stay the curated static ones.
 *
 * 限免（promoFreeUntil）必须**保留**：Qoder 的限时免费在实时目录里表现为
 * rateMultiplier 0，若直接覆盖，注册表里「原价 0.1x + 限免标记」的组合会被压成
 * 一个光秃秃的 0x —— 用户看到的是「一直免费」，看不到截止时间，也更看不到
 * 恢复计费后的价格。因此：
 *   · 静态行有 promoFreeUntil 时，倍率仍取注册表的原价（0.1x），让 badge 走
 *     promo 分支显示 `free` + 「原价 0.1x — 限时免费至 …」的 tooltip；
 *   · 没有限免标记的行才用实时倍率（那是账户真实价格，含 off-peak 折扣）。
 *
 * Pure + JSX-free for unit tests.
 */
export function mergeQoderLivePricing(staticModels, liveModels) {
  if (!Array.isArray(staticModels)) return staticModels;
  if (!Array.isArray(liveModels) || liveModels.length === 0) return staticModels;
  const byKey = new Map(liveModels.map((m) => [String(m.id).split("/").pop(), m]));
  return staticModels.map((sm) => {
    const live = byKey.get(sm.id);
    if (!live) return sm;
    const hasPromo = typeof sm.promoFreeUntil === "string" && sm.promoFreeUntil.trim() !== "";
    const liveMultiplier = typeof live.rateMultiplier === "number" ? live.rateMultiplier : null;
    return {
      ...sm,
      // 限免期间保留注册表原价；否则用实时值（可能为 0 = 真·免费额度）
      rateMultiplier: hasPromo
        ? (typeof sm.rateMultiplier === "number" ? sm.rateMultiplier : liveMultiplier)
        : (liveMultiplier ?? sm.rateMultiplier),
      promoFreeUntil: sm.promoFreeUntil,
      // 促销原价：live 目录带 original_price_factor 时透传，0× 徽章的 tooltip
      // 用它显示「原价 x」——限免抹掉的只是现价，不是价格这个事实。
      originalRateMultiplier: live.originalRateMultiplier ?? sm.originalRateMultiplier ?? null,
      promotion: live.promotion ?? sm.promotion ?? null,
    };
  });
}
