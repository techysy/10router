import PropTypes from "prop-types";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge, CapacityBadges, Tooltip } from "@/shared/components";
import { isPromoFree } from "@/shared/utils/promoFree";
import { isNightFreeHour } from "@/shared/utils/nightFree";
import { offPeakStatus, promotionText } from "@/shared/utils/offPeak";
import { translate, getCurrentLocale } from "@/i18n/runtime";

// Local hour, re-evaluated every minute so a row crosses the night boundary
// live without a remount.
function useLocalHour() {
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const t = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(t);
  }, []);
  return hour;
}

// Off-peak windows flip at HH:MM boundaries, so the leaf badge needs a
// finer tick than the hourly one above — 30s is well inside a minute and
// cheap (one shared interval per row, cleared on unmount).
function useOffPeakClock(promotion) {
  const [now, setNow] = useState(() => Date.now());
  // Primitive dep: the promotion OBJECT identity churns whenever the page
  // re-renders (models array is rebuilt), which would reset the interval
  // before it ever fires. The window definition is what actually matters.
  const windowKey = promotion ? `${promotion.window_start}|${promotion.window_end}|${promotion.timezone}` : null;
  useEffect(() => {
    if (!windowKey) return undefined;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [windowKey]);
  return offPeakStatus(promotion, now);
}

// The two numbers only reach the OpenAI-style model list once they're positive
// integers; anything else is treated as "not set".
const parseCapsNumber = (v) => {
  const n = Number(String(v).trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

// Pin context window / max output for one model (catalog windows are missing
// or stale for many models, and clients that read context_length need the
// real number). Saved through /api/models/caps; consumed by /v1/models,
// /api/models badges, and server-side auto-compaction.
//
// Two things this panel used to get wrong:
//   - it was styled `bg-background`, which is not a token this theme defines
//     (the palette is --color-bg / --color-surface / --color-sidebar …), so
//     Tailwind emitted no declaration at all and the model rows behind it read
//     straight through the panel. It is `bg-surface` now — the opaque raised
//     surface — with the inputs on `bg-bg` so a field is visible against it;
//   - it was an absolutely-positioned child of the row, so it could only paint
//     within the row list: clipped at the bottom on the last rows, and at the
//     mercy of any ancestor stacking context. It is a portal anchored to the
//     button now, and it opens upward when there is more room above.
// `baseCaps` is the un-overridden value, shown per field so a pin visibly
// replaces a real number instead of an "e.g. …" guess.
const CAPS_PANEL_W = 300;

function CapsField({ label, builtIn, value, onChange, invalid, autoFocus }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between gap-2 text-text-muted">
        <span>{label}</span>
        {builtIn ? (
          <span className="font-mono text-[10px] text-text-subtle">
            {translate("Built-in")} {builtIn}
          </span>
        ) : null}
      </span>
      <input
        type="number"
        min="1"
        step="1"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={builtIn ? String(builtIn) : translate("Not set")}
        className={`rounded-md border bg-bg px-2 py-1.5 font-mono text-text focus:outline-none ${invalid ? "border-red-500" : "border-border focus:border-primary"}`}
      />
    </label>
  );
}

function CapsEditor({ caps, baseCaps, pinned, label, onSave }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState(null);
  const [cw, setCw] = useState("");
  const [mo, setMo] = useState("");
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  const builtInCw = baseCaps?.contextWindow ?? null;
  const builtInMo = baseCaps?.maxOutput ?? null;
  const parsedCw = parseCapsNumber(cw);
  const parsedMo = parseCapsNumber(mo);
  // Empty means "no pin", so it is not a validation error; non-empty must parse.
  const badCw = cw.trim() !== "" && parsedCw === null;
  const badMo = mo.trim() !== "" && parsedMo === null;
  // Not blocked, just flagged: a catalog value that contradicts itself is worth
  // seeing before it is saved, but it is the user's number to set.
  const inverted = parsedCw !== null && parsedMo !== null && parsedMo > parsedCw;
  const canSave = !busy && !badCw && !badMo;

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = panelRef.current?.offsetWidth || CAPS_PANEL_W;
    const h = panelRef.current?.offsetHeight || 300;
    const margin = 8;
    const below = window.innerHeight - r.bottom - margin;
    // Only flip when the other side genuinely has more room, so a short viewport
    // does not oscillate between the two.
    const flip = below < h && r.top - margin > below;
    setPos({
      left: Math.min(Math.max(margin, r.right - w), Math.max(margin, window.innerWidth - w - margin)),
      top: flip ? undefined : r.bottom + 6,
      bottom: flip ? window.innerHeight - r.top + 6 : undefined,
    });
  }, []);

  // Re-read the effective values on every open so caps that changed elsewhere
  // (custom-model edit, another tab) show up. Done here rather than in an effect
  // keyed on `open`: setState-in-effect is both a lint error and a cascading
  // render, and the panel is only ever opened from this one button.
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setCw(caps?.contextWindow ? String(caps.contextWindow) : "");
    setMo(caps?.maxOutput ? String(caps.maxOutput) : "");
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // A fixed panel does not follow its row, and the page scrolls the list —
    // re-anchor (or close) rather than drift away from the button.
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  // Runs once the panel is in the DOM, so the flip uses its real height instead
  // of the estimate the first pass had to guess.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  const submit = async (clear) => {
    setBusy(true);
    try {
      await onSave(clear
        ? { contextWindow: null, maxOutput: null }
        : { contextWindow: parsedCw, maxOutput: parsedMo });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={btnRef}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`rounded p-0.5 transition-colors hover:bg-sidebar ${pinned ? "text-primary" : "text-text-muted hover:text-primary"}`}
        title={translate("Model limits")}
      >
        <span className="material-symbols-outlined text-sm">tune</span>
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={translate("Model limits")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSave) {
              e.preventDefault();
              submit(false);
            }
          }}
          style={{
            position: "fixed",
            width: CAPS_PANEL_W,
            left: pos?.left ?? 0,
            top: pos?.top,
            bottom: pos?.bottom,
            visibility: pos ? "visible" : "hidden",
          }}
          className="z-50 flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-3 text-xs shadow-[var(--shadow-elev)]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border-subtle pb-2">
            <span className="min-w-0 truncate font-medium text-text">{label || translate("Model limits")}</span>
            {pinned ? (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                {translate("Overridden")}
              </span>
            ) : null}
          </div>
          <CapsField
            label={translate("Context window")}
            builtIn={builtInCw}
            value={cw}
            onChange={setCw}
            invalid={badCw}
            autoFocus
          />
          <CapsField
            label={translate("Max output")}
            builtIn={builtInMo}
            value={mo}
            onChange={setMo}
            invalid={badMo}
          />
          {(badCw || badMo) && (
            <p className="text-[10px] leading-snug text-red-500">
              {translate("Enter a whole number greater than 0")}
            </p>
          )}
          {inverted && (
            <p className="text-[10px] leading-snug text-amber-600 dark:text-amber-400">
              {translate("Max output is larger than the context window")}
            </p>
          )}
          <p className="text-[10px] leading-snug text-text-muted/70">
            {translate("Overrides the built-in catalog values")}
          </p>
          <div className="flex items-center justify-end gap-2 border-t border-border-subtle pt-2">
            <button
              className="rounded px-2 py-1 text-text-muted hover:text-red-500 disabled:opacity-40"
              onClick={() => submit(true)}
              disabled={busy || !pinned}
            >
              {translate("Restore built-in")}
            </button>
            <button
              className="rounded bg-primary px-2.5 py-1 text-white disabled:opacity-50"
              onClick={() => submit(false)}
              disabled={!canSave}
            >
              {translate("Save")}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting, onDisable, onEnable, caps, baseCaps, thinkingSuffix, onSaveCaps, capsPinned }) {
  const hour = useLocalHour();
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  // Credit cost multiplier (registry `rateMultiplier`, published per model by
  // credit-metered providers such as codebuddy-cn / codebuddy-intl / kiro).
  // 0 = rides the free quota. Shown as a badge only when the provider declares
  // one — most providers have no credit system and stay unbadged.
  const rateMultiplier = typeof model.rateMultiplier === "number" ? model.rateMultiplier : null;
  // Night-free models (e.g. codebuddy-cn hy4-preview): the free quota applies
  // only inside the declared local-hours window; outside it the daytime
  // multiplier applies (unpublished → no badge, never a misleading 0x).
  const nightFreeNow = isNightFreeHour(hour, model.nightFree);
  // A dated promo (registry `promoFreeUntil`) shows the same green `free` badge
  // while it runs and drops back to the real multiplier once it closes — the
  // published multiplier is never overwritten, so nothing needs cleaning up by
  // hand and the CN/intl shared-credit parity stays intact.
  const promoFree = rateMultiplier !== null && rateMultiplier > 0 && isPromoFree(model);
  const displayMultiplier = promoFree ? 0 : rateMultiplier;
  const showFreeBadge = nightFreeNow || displayMultiplier === 0;
  // Off-peak leaf (Qoder): the server itself swaps price_factor when the
  // window opens, so the number above is already the discounted one — this
  // badge only announces WHY it dropped, and flips green inside the window.
  const offPeak = useOffPeakClock(model.promotion);
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border";

  const iconColor = testStatus === "ok"
    ? "#22c55e"
    : testStatus === "error"
    ? "#ef4444"
    : undefined;

  return (
    <div className={`group min-w-0 max-w-full rounded-lg border px-3 py-2 ${borderColor} hover:bg-sidebar/50`}>
      <div className="flex min-w-0 items-start gap-2 sm:items-center">
        <span
          className="material-symbols-outlined shrink-0 text-base"
          style={iconColor ? { color: iconColor } : undefined}
        >
          {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy"}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <code className="max-w-[72vw] truncate rounded bg-sidebar px-1.5 py-0.5 font-mono text-xs text-text-muted sm:max-w-[360px]">{displayModel}</code>
          <span className="flex min-w-0 items-center text-[9px] gap-1 pl-1">
            {model.name && <span className="truncate text-[9px] italic text-text-muted/70">{model.name}</span>}
            <CapacityBadges caps={caps} colorOverride="text-text-muted/70" size={12} />
            {/* Paid-tier model (registry `paidTier`): the credit page lists it
                behind a subscription lock, so whether it answers depends on the
                account's plan — not a fault, and not the same as "verified to
                work here". Distinct from the multiplier badge below, which
                states a price. */}
            {model.paidTier && (
              <Tooltip
                text={translate("Only available on paid subscription tiers")}
              >
                <Badge
                  size="sm"
                  variant="warning"
                  icon="lock"
                  className="shrink-0 cursor-help leading-none"
                >
                  {translate("Paid tier")}
                </Badge>
              </Tooltip>
            )}
            {(displayMultiplier !== null || nightFreeNow) && (
              <Tooltip
                text={
                  nightFreeNow
                    ? `${translate("Night-free window")} (23:00–08:00) — ${translate("rides the free quota")}`
                    : promoFree
                    ? translate("Credit multiplier") + `: ${rateMultiplier}x — ` + translate("promo free until") + ` ${model.promoFreeUntil}`
                    : displayMultiplier === 0
                    ? translate("Credit multiplier") + ": 0x — " + translate("rides the free quota")
                    : translate("Credit multiplier") + `: ${displayMultiplier}x`
                }
              >
                <Badge
                  size="sm"
                  variant={showFreeBadge ? "success" : "default"}
                  className={`shrink-0 cursor-help leading-none${showFreeBadge ? "" : " font-mono"}`}
                >
                  {showFreeBadge ? "free" : `${displayMultiplier.toFixed(2)}x`}
                </Badge>
              </Tooltip>
            )}
            {offPeak && (
              <Tooltip
                text={[
                  promotionText(model.promotion?.badge, getCurrentLocale()) || translate("Off-peak discount"),
                  promotionText(model.promotion?.description, getCurrentLocale()),
                  `${offPeak.windowLabel} ${offPeak.timezone}${offPeak.active ? ` — ${translate("active now")}` : ""}`,
                ].filter(Boolean).join(" · ")}
              >
                <Badge
                  size="sm"
                  variant={offPeak.active ? "success" : "default"}
                  className="shrink-0 cursor-help leading-none"
                >
                  <span className="material-symbols-outlined align-[-1px]" style={{ fontSize: 10 }}>eco</span>
                </Badge>
              </Tooltip>
            )}
          </span>
        </div>
        {onSaveCaps && (
          <CapsEditor
            caps={caps}
            baseCaps={baseCaps}
            pinned={capsPinned}
            label={model.name || fullModel}
            onSave={onSaveCaps}
          />
        )}
        {onTest && (
          <div className="relative shrink-0 group/btn">
            <button
              onClick={onTest}
              disabled={isTesting}
              className={`rounded p-0.5 text-text-muted transition-opacity hover:bg-sidebar hover:text-primary ${isTesting ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"}`}
            >
              <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                {isTesting ? "progress_activity" : "science"}
              </span>
            </button>
            <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {isTesting ? "Testing..." : "Test"}
            </span>
          </div>
        )}
        <div className="relative shrink-0 group/btn">
          <button
            onClick={() => onCopy(displayModel, `model-${model.id}`)}
            className="rounded p-0.5 text-text-muted hover:bg-sidebar hover:text-primary"
          >
            <span className="material-symbols-outlined text-sm">
              {copied === `model-${model.id}` ? "check" : "content_copy"}
            </span>
          </button>
          <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
            {copied === `model-${model.id}` ? "Copied!" : "Copy"}
          </span>
        </div>
        {isCustom ? (
          <button
            onClick={onDeleteAlias}
            className="ml-auto rounded p-0.5 text-text-muted opacity-100 transition-opacity hover:bg-red-500/10 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100"
            title="Remove custom model"
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        ) : onEnable ? (
          // Disabled-model rows: the primary action flips to "+ enable" (green),
          // everything else (name, badges, Test, Copy) stays identical to active
          // rows so users can evaluate a model BEFORE exposing it. Issue #14-B.
          <button
            onClick={onEnable}
            className="ml-auto rounded p-0.5 text-text-muted opacity-100 transition-opacity hover:bg-green-500/10 hover:text-green-500"
            title={translate("Enable this model")}
          >
            <span className="material-symbols-outlined text-sm">add</span>
          </button>
        ) : onDisable ? (
          <button
            onClick={onDisable}
            className="ml-auto rounded p-0.5 text-text-muted opacity-100 transition-opacity hover:bg-red-500/10 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100"
            title="Disable this model"
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({
    id: PropTypes.string.isRequired,
    rateMultiplier: PropTypes.number,
    // Listed behind a subscription lock on the provider's credit page.
    paidTier: PropTypes.bool,
    // Server-published off-peak window (Qoder catalog `promotion`).
    promotion: PropTypes.object,
    nightFree: PropTypes.shape({ from: PropTypes.number, to: PropTypes.number }),
  }).isRequired,
  fullModel: PropTypes.string.isRequired,
  alias: PropTypes.string,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  onEnable: PropTypes.func,
  caps: PropTypes.object,
  // Un-overridden caps, so the editor can show what a pin replaces.
  baseCaps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
  // Present on the provider page: enables the per-model context-window pin UI.
  onSaveCaps: PropTypes.func,
  capsPinned: PropTypes.bool,
};
