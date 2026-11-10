"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { formatResetTime, getRemainingPercentage } from "./utils";
import { translate } from "@/i18n/runtime";
// Quota name translation lives in shared/utils/quotaName.js so the quota-block
// summary (QuotaPackBar) renders the same localized pack names.
//
// This MUST be a plain import, not `export { translateQuotaName } from "..."`:
// a re-export creates no local binding, so the component's own call at
// `translateQuotaName(quota.name)` below compiled to a bare free identifier and
// threw `ReferenceError: translateQuotaName is not defined` the moment a
// per-pack row was actually rendered — i.e. only after expanding "逐包明细",
// which is what made this look like an intermittent blank page. The named
// export is preserved for ProviderLimitCard / QuotaProgressBar / index.js.
import { translateQuotaName } from "@/shared/utils/quotaName";
import { isExpiredPack, isResettingRow, isSpentPack, meterTone } from "@/shared/utils/quotaRows";
import QuotaMeter, { TONE_TEXT, meterSolid, quotaDateWord } from "@/shared/components/QuotaMeter";
import { cn } from "@/shared/utils/cn";

// Rows revealed per "show more" click. Not pages: a pager with Prev/Next and a
// "Showing x–y" box was heavier than the card it sat in.
const STEP = 10;

export { translateQuotaName };

function fmtAmount(n) {
  return Number(Number(n || 0).toFixed(2)).toLocaleString("en-US");
}

/** Absolute local time for the hover title ("2026-10-15 14:00"). */
function fullDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getFullYear() > 2099) return "";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function isPlanPack(q) {
  const n = String(q?.name || "").trim();
  return n === "Plan Credits" || n === "套餐内 Credits" || n.startsWith("Plan ");
}

function sortQuotas(quotas, sortMode) {
  if (sortMode === "remaining-asc") {
    return [...quotas].sort((a, b) => a.pct - b.pct || a.name.localeCompare(b.name));
  }

  if (sortMode === "remaining-desc") {
    return [...quotas].sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
  }

  // 默认排序：核心月度/订阅套餐行（Plan Credits / 套餐内 Credits）置顶展示在首位，
  // 避免其因为到期日较长而被几十个快到期的短期活动/每日赠送包挤到明细最底部。
  return [...quotas].sort((a, b) => {
    const aPlan = isPlanPack(a);
    const bPlan = isPlanPack(b);
    if (aPlan && !bPlan) return -1;
    if (!aPlan && bPlan) return 1;
    return (a.index ?? 0) - (b.index ?? 0);
  });
}

/**
 * One per-pack row — the SAME two-line item as the card's QuotaRow above it:
 *
 *   ■ 赠送包 3                         55.33 / 100　10-15 到期   ⊘
 *   [=============               ]
 *
 * The date is absolute like the card's; the relative countdown and the full
 * timestamp are on hover. The hide control stays faint until the row is hovered
 * or focused, so 45 rows do not carry 45 loud eye icons.
 */
function QuotaDetailRow({ quota, now, onHide }) {
  const tone = meterTone(quota, quota.pct);
  const resets = isResettingRow(quota);
  const expired = isExpiredPack(quota, now);
  const hasDate = Boolean(quota.resetAt) && new Date(quota.resetAt).getFullYear() <= 2099;
  const countdown = hasDate ? formatResetTime(quota.resetAt) : "-";
  const dateTitle = hasDate
    ? [fullDateTime(quota.resetAt), countdown !== "-" ? countdown : null].filter(Boolean).join(" · ")
    : undefined;

  // percentScale rows normalize the RPC's remaining fraction to 0–100 — there is
  // no real count, so they read as a percent. Everything else reads REMAINING /
  // total like the card; the used amount is on hover.
  const amount = quota.percentScale
    ? `${quota.pct}%`
    : quota.unlimited
      ? "∞"
      : `${fmtAmount(Math.max(0, quota.total - quota.used))} / ${fmtAmount(quota.total)}`;

  return (
    <div className="group min-w-0 space-y-1 py-1">
      <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] tabular-nums">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="size-[8px] shrink-0 rounded-[2px]" style={{ background: meterSolid(quota.pct) }} aria-hidden="true" />
          <span className="truncate text-text">{translateQuotaName(quota.name)}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span
            className={TONE_TEXT[tone]}
            title={quota.percentScale || quota.unlimited ? undefined : `${translate("Used")} ${fmtAmount(quota.used)}`}
          >
            {amount}
          </span>
          {hasDate ? (
            <span className="text-text-muted" title={dateTitle}>
              {quotaDateWord(resets, quota.resetAt, { expired })}
            </span>
          ) : null}
          {onHide ? (
            <button
              type="button"
              onClick={() => onHide(quota)}
              className="-my-1 inline-flex size-5 items-center justify-center rounded text-text-muted opacity-30 transition hover:bg-black/5 hover:text-text group-hover:opacity-100 focus-visible:opacity-100 dark:hover:bg-white/5"
              title={translate("Hide this quota row")}
              aria-label={`${translate("Hide this quota row")}: ${translateQuotaName(quota.name)}`}
            >
              <span className="material-symbols-outlined text-[14px]">visibility_off</span>
            </button>
          ) : null}
        </span>
      </div>
      <QuotaMeter pct={quota.pct} />
    </div>
  );
}

QuotaDetailRow.propTypes = {
  quota: PropTypes.object.isRequired,
  now: PropTypes.number.isRequired,
  onHide: PropTypes.func,
};

/** First `limit` rows + a "show N more" button — the one way lists grow here. */
function RowList({ rows, now, onHide, limit, onMore }) {
  const rest = rows.length - limit;
  return (
    <>
      {rows.slice(0, limit).map((quota) => (
        <QuotaDetailRow key={`${quota.name}-${quota.index}`} quota={quota} now={now} onHide={onHide} />
      ))}
      {rest > 0 && (
        <button
          type="button"
          onClick={onMore}
          className="w-full rounded-md py-1 text-[11px] text-text-muted transition-colors hover:bg-black/5 hover:text-text dark:hover:bg-white/5"
        >
          {translate("Show {count} more").replace("{count}", String(Math.min(STEP, rest)))}
        </button>
      )}
    </>
  );
}

RowList.propTypes = {
  rows: PropTypes.array.isRequired,
  now: PropTypes.number.isRequired,
  onHide: PropTypes.func,
  limit: PropTypes.number.isRequired,
  onMore: PropTypes.func.isRequired,
};

/**
 * Per-pack details (逐包明细). Live rows first; one-shot packs that are used up
 * or expired can never come back, so they fold into a collapsed history group
 * instead of being paged through ahead of — or mixed in with — the live ones.
 *
 * Expansion state deliberately survives the card's auto-refresh: resetting it
 * whenever `quotas` changed collapsed what the user had just opened.
 */
export default function QuotaTable({
  quotas = [],
  sortMode = "default",
  showSortLabel = false,
  onHideQuota = null,
}) {
  const [liveLimit, setLiveLimit] = useState(STEP);
  const [historyLimit, setHistoryLimit] = useState(STEP);
  const [historyOpen, setHistoryOpen] = useState(false);
  // "Now" for the expired test: taken at mount (details open on expand) and
  // re-taken whenever fresh quota data lands — the card's auto-refresh refetch
  // every 60s must age the classification, or a pack crossing its expiry while
  // the page stays open keeps rendering as active until a full remount. An
  // effect, not the render body, so a render never reads the clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
  }, [quotas]);

  const { live, history } = useMemo(() => {
    const at = now;
    const rows = quotas.map((quota, index) => ({
      ...quota,
      index,
      used: Number(quota.used || 0),
      total: Number(quota.total || 0),
      pct: getRemainingPercentage(quota),
    }));
    const sorted = sortQuotas(rows, sortMode);
    return {
      live: sorted.filter((q) => !isSpentPack(q, at)),
      history: sorted.filter((q) => isSpentPack(q, at)),
    };
  }, [quotas, sortMode, now]);

  if (!quotas || quotas.length === 0) {
    return null;
  }

  const onHide = typeof onHideQuota === "function" ? onHideQuota : null;

  return (
    <div className="space-y-0.5">
      {showSortLabel && (
        <div className="pb-1 text-[10px] text-text-muted">{translate("Sorted by account remaining")}</div>
      )}

      <RowList
        rows={live}
        now={now}
        onHide={onHide}
        limit={liveLimit}
        onMore={() => setLiveLimit((n) => n + STEP)}
      />

      {history.length > 0 && (
        <div className={cn(live.length > 0 && "mt-1 border-t border-black/5 pt-1 dark:border-white/5")}>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className="flex w-full items-center gap-1 rounded-md py-1 text-[11px] text-text-muted transition-colors hover:bg-black/5 hover:text-text dark:hover:bg-white/5"
            aria-expanded={historyOpen}
          >
            <span className="material-symbols-outlined text-[14px]">
              {historyOpen ? "expand_less" : "expand_more"}
            </span>
            {translate("Used up / expired")}
            <span className="tabular-nums opacity-60">({history.length})</span>
          </button>
          {historyOpen && (
            <div className="opacity-60">
              <RowList
                rows={history}
                now={now}
                onHide={onHide}
                limit={historyLimit}
                onMore={() => setHistoryLimit((n) => n + STEP)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

QuotaTable.propTypes = {
  quotas: PropTypes.array,
  sortMode: PropTypes.string,
  showSortLabel: PropTypes.bool,
  onHideQuota: PropTypes.func,
};
