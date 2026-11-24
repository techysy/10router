"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { translate } from "@/i18n/runtime";
import { healthHue, shortDate, shortDuration } from "@/shared/utils/quotaRows";

/**
 * The one visual language for every quota meter (card rows, pool bar, nested
 * cycle track, per-pack table). Change a token here, never at a call site:
 *
 *   track   5px, 3px radius, neutral grey — the UNUSED part is always the bare
 *           track, never a separately painted "used" chunk
 *   fill    = remaining, coloured by HOW MUCH is left (healthHue): emerald when
 *           full, through green / amber / orange, red when nearly gone — a
 *           soft left-light → right-deep gradient, never a flat slab. Whether a
 *           row resets or expires is said by its date ("重置" / "到期"), not by
 *           its colour. Exception: the segmented pack pool (QuotaPackBar
 *           renderPoolBar) keeps one fixed green — too many segments to tint.
 */
export const METER_HEIGHT_PX = 5;
export const METER_RADIUS = "rounded-[3px]";
export const METER_TRACK = "bg-black/10 dark:bg-white/10";

/** Solid health colour — swatches, pool segments. */
export function meterSolid(pct) {
  return `hsl(${healthHue(pct)} 68% 46%)`;
}

/** Gradient health fill for a bar (inline style). */
export function meterFill(pct) {
  const h = healthHue(pct);
  return { backgroundImage: `linear-gradient(90deg, hsl(${h} 72% 58%), hsl(${h} 70% 44%))` };
}

export const TONE_TEXT = {
  reset: "text-text-muted",
  expire: "text-text-muted",
  critical: "text-red-600 dark:text-red-400",
};

/**
 * The one date phrase on quota UI. A FUTURE reset/expiry is a countdown whose
 * precision follows magnitude — "5h 20m 后重置" says what "10-01 重置" cannot
 * for a rolling window; a past expiry stays an absolute "09-20 已过期"; a
 * used-up pack (0 left, expiry ahead) renders the absolute "{date} 到期" — its
 * date is a record, not a deadline, and a countdown over 0 credits is noise
 * (2026-11-24 用户报). The slot lives in the translation (word order differs
 * by language); locales without the key fall back to English, so the phrase
 * never drops out.
 */
export function quotaDateWord(resets, iso, { expired = false, usedUp = false } = {}) {
  if (expired) return translate("expired {date}").replace("{date}", shortDate(iso));
  if (usedUp) return translate(resets ? "resets {date}" : "expires {date}").replace("{date}", shortDate(iso));
  const duration = shortDuration(iso);
  if (duration) return translate(resets ? "resets in {duration}" : "expires in {duration}").replace("{duration}", duration);
  return translate(resets ? "resets {date}" : "expires {date}").replace("{date}", shortDate(iso));
}

/** Bare track. Children are the fills (a plain bar, segments, nested bands). */
export function MeterTrack({ height = METER_HEIGHT_PX, className, children, ...rest }) {
  return (
    <div
      className={cn("relative w-full overflow-hidden", METER_RADIUS, METER_TRACK, className)}
      style={{ height: `${height}px` }}
      {...rest}
    >
      {children}
    </div>
  );
}

MeterTrack.propTypes = {
  height: PropTypes.number,
  className: PropTypes.string,
  children: PropTypes.node,
};

/**
 * A single-fill meter: `pct` of the track. `colorPct` picks the colour when it
 * differs from the width — a stored balance is drawn full but is not "100%
 * healthy" of anything; it passes its own.
 */
export default function QuotaMeter({ pct = 0, colorPct = null, title, ...rest }) {
  const width = Math.min(100, Math.max(0, Number(pct) || 0));
  return (
    <MeterTrack title={title} {...rest}>
      <div
        className={cn("h-full transition-[width] duration-300", METER_RADIUS)}
        style={{ width: `${width}%`, ...meterFill(colorPct ?? width) }}
      />
    </MeterTrack>
  );
}

QuotaMeter.propTypes = {
  pct: PropTypes.number,
  colorPct: PropTypes.number,
  title: PropTypes.string,
};
