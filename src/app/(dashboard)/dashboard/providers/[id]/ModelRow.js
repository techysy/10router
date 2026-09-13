import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import { Badge, CapacityBadges, Tooltip } from "@/shared/components";
import { isPromoFree } from "@/shared/utils/promoFree";
import { isNightFreeHour } from "@/shared/utils/nightFree";
import { translate } from "@/i18n/runtime";

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

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting, onDisable, onEnable, caps, thinkingSuffix }) {
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
          </span>
        </div>
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
  thinkingSuffix: PropTypes.string,
};
