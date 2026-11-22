/**
 * Off-peak ("idle window") promotion status — pure and JSX-free so unit
 * tests can import it without the component tree.
 *
 * Qoder publishes a per-model `promotion` object on its model catalog:
 *   { active, badge: {en, zh}, description: {en, zh}, timezone,
 *     window_start: "22:00", window_end: "08:00", discount_factor, ... }
 * The window may wrap midnight (22:00 → 08:00). Times are wall-clock in the
 * declared IANA timezone (Asia/Singapore == UTC+8 for Qoder's CN/intl idle
 * events), NOT the browser's — a traveler's laptop must not misread the
 * discount. `active` from the payload is only the state at fetch time; the
 * UI recomputes it live from the window.
 */

/** "22:00" → minutes since midnight; anything malformed → null. */
export function parseClockHM(text) {
  if (typeof text !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Wall-clock seconds-since-midnight + minute/second parts in `timeZone`
 * at instant `nowMs`. Returns null when the timezone is unusable.
 */
export function zonedClock(timeZone, nowMs = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(nowMs));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const h = get("hour");
    const m = get("minute");
    const s = get("second");
    if ([h, m, s].some((n) => !Number.isFinite(n))) return null;
    return { hour: h, minute: m, second: s, secondsOfDay: h * 3600 + m * 60 + s };
  } catch {
    return null; // unknown timezone → no claim rather than a wrong claim
  }
}

/**
 * Live status for an off-peak promotion.
 * @returns {null | { active: boolean, secondsToBoundary: number, windowLabel: string, timezone: string }}
 *   `secondsToBoundary` counts down to the window END while active, to the
 *   next window START while inactive. null → nothing to show (no/invalid
 *   promotion, missing window, unusable timezone).
 */
export function offPeakStatus(promotion, nowMs = Date.now()) {
  if (!promotion || typeof promotion !== "object") return null;
  const start = parseClockHM(promotion.window_start);
  const end = parseClockHM(promotion.window_end);
  if (start === null || end === null || start === end) return null;
  const timezone = promotion.timezone || "Asia/Singapore";
  const clock = zonedClock(timezone, nowMs);
  if (!clock) return null;
  const nowMin = clock.minute + clock.hour * 60;
  const active = start <= end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end;
  const startSec = start * 60;
  const endSec = end * 60;
  let secondsToBoundary;
  if (active) {
    secondsToBoundary = (endSec - clock.secondsOfDay + 86400) % 86400;
  } else {
    secondsToBoundary = (startSec - clock.secondsOfDay + 86400) % 86400;
  }
  return {
    active,
    secondsToBoundary,
    windowLabel: `${promotion.window_start}–${promotion.window_end}`,
    timezone,
  };
}

/** Badge/description text in the reader's language (payload ships {en, zh}). */
export function promotionText(field, locale) {
  if (!field || typeof field !== "object") return "";
  return (locale && String(locale).startsWith("zh") ? field.zh || field.en : field.en || field.zh) || "";
}

/**
 * The promotion's own badge text — the upstream client's wording for WHY a
 * model's price is what it is (QwenWork CN 标准「会员限免」/ ling-3.1「限时1折」,
 * Qoder off-peak banners) — or "" when there is no promotion or it is
 * explicitly deactivated. The multiplier tooltip appends it so a promoted
 * price explains itself; without it a bare `free` reads as a lasting
 * property, which is exactly what a CN 会员限免 row is not (2026-11-23 user
 * report: the badge said nothing about where the free ride comes from).
 */
export function promotionBadgeNote(promotion, locale) {
  if (!promotion || typeof promotion !== "object" || promotion.active === false) return "";
  return promotionText(promotion.badge, locale);
}

/** 46800 → "13:00:00" (hours may exceed 24 never happens: < 86400 by construction). */
export function formatCountdown(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "--:--:--";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}
