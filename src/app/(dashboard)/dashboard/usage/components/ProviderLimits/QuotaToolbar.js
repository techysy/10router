"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { Popover, MenuItem } from "@/shared/components/PopoverMenu";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";
import { ACCOUNT_FILTER_OPTIONS, QUOTA_SORT_OPTIONS, REFRESH_INTERVAL_OPTIONS } from "./utils";

/**
 * Quota tracker toolbar — one control language for every button here:
 * 32px tall, 8px radius, hairline border on the surface colour, and ONE active
 * state (primary tint). Filters sit on the left, actions on the right.
 *
 * The two bulk actions actually disable / enable accounts, so they live behind
 * a "批量操作" menu with a line of explanation each, instead of being loud
 * red/green buttons one misclick away from the filters.
 */
const CONTROL =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-black/10 bg-surface px-2.5 text-xs text-text transition-colors hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/[0.06]";
const ACTIVE = "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15";
const ICON = "material-symbols-outlined text-[16px] leading-none";
// Icon-only square buttons (sort / refresh / preferences): same shell WITHOUT
// CONTROL's px-2.5 (w-8 + px-2.5 squeezed the 16px glyph into a 12px box) and
// with the colours swapped whole — `cn` is a plain join with no tailwind-merge,
// so ACTIVE's bg/border/text classes fighting CONTROL's same-property classes
// resolved by stylesheet order, which is what painted the "Resets first"
// button as a squashed pink chip. Same rule as the segmented controls above:
// the shell carries no colour, the state class carries all of it.
const ICON_BTN =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-xs transition-colors disabled:opacity-50";
const ICON_BTN_OFF =
  "border-black/10 bg-surface text-text hover:bg-black/[0.04] dark:border-white/10 dark:hover:bg-white/[0.06]";
const ICON_BTN_ON = ACTIVE;
// Icon stand-ins for the account filter's labels at phone widths — same
// glyph language as the bulk menu (block / check_circle).
const ACCOUNT_FILTER_ICONS = { all: "apps", active: "check_circle", inactive: "block" };

function ProviderGlyph({ provider, size = 16 }) {
  if (provider === "all") return <span className={cn(ICON, "text-text-muted")}>apps</span>;
  return (
    <ProviderIcon
      src={`/providers/${provider}.png`}
      alt={provider}
      size={size}
      className="rounded object-contain"
      fallbackText={provider.slice(0, 2).toUpperCase()}
    />
  );
}

ProviderGlyph.propTypes = { provider: PropTypes.string.isRequired, size: PropTypes.number };

export default function QuotaToolbar({
  view = "cards",
  onViewChange,
  providerFilter,
  providerOptions,
  providerLabel,
  onProviderChange,
  accountFilter,
  onAccountChange,
  showCodexSort,
  quotaSortMode,
  onQuotaSortChange,
  expiringFirst,
  onToggleExpiringFirst,
  onDisableDepleted,
  onEnableAvailable,
  bulkToggling,
  autoRefresh,
  onToggleAutoRefresh,
  countdown,
  refreshIntervalMs,
  onChangeRefreshInterval,
  refreshingAll,
  onRefreshAll,
  accountCount,
  onOpenPreferences,
}) {
  const [providerOpen, setProviderOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [intervalOpen, setIntervalOpen] = useState(false);
  const cards = view === "cards";

  return (
    // `@container`: the label-collapse ladder below measures THIS bar, not the
    // viewport — the sidebar eats ~300px of the window and can also collapse,
    // so viewport breakpoints fire at the wrong width and the filter row wraps
    // to a second line. Tiers (see the test for the full width math): account
    // count first, then the bulk label, then the auto-refresh label, then the
    // tab labels.
    <div className="@container flex flex-wrap items-center gap-2">
      {/* ── View ────────────────────────────────────────────────── */}
      {onViewChange && (
        <div
          role="tablist"
          aria-label={translate("View")}
          className="flex h-8 items-center rounded-lg border border-black/10 bg-surface p-0.5 dark:border-white/10"
        >
          {[
            { value: "cards", icon: "grid_view", label: translate("Cards") },
            { value: "windows", icon: "date_range", label: translate("Quota windows") },
          ].map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={view === tab.value}
              aria-label={tab.label}
              onClick={() => onViewChange(tab.value)}
              className={cn(
                "flex h-full items-center gap-1 rounded-md px-2.5 text-xs transition-colors",
                view === tab.value ? "bg-primary/10 font-medium text-primary" : "text-text-muted hover:text-text",
              )}
            >
              <span className={cn(ICON, "text-[15px]")}>{tab.icon}</span>
              <span className="hidden @min-[900px]:inline">{tab.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Filters ───────────────────────────────────────────────
          Below 640px of THIS bar the group becomes a full-width second
          row — ordered after the view tabs and the actions, which share
          the first row — so a phone gets exactly two tidy rows instead
          of three ragged ones. No overflow scrolling: the provider menu
          pops over the cards below and must not be clipped. */}
      <div className="flex min-w-0 items-center gap-2 @max-[640px]:order-last @max-[640px]:w-full">
      <div className="relative min-w-0">
        <button
          type="button"
          onClick={() => setProviderOpen((v) => !v)}
          className={cn(CONTROL, providerFilter !== "all" && ACTIVE)}
          aria-haspopup="menu"
          aria-expanded={providerOpen}
          title={translate("Filter quota providers")}
        >
          <ProviderGlyph provider={providerFilter} />
          <span className="max-w-[9rem] truncate capitalize @max-[640px]:max-w-[5rem]">{providerLabel}</span>
          <span className={cn(ICON, "text-[14px] text-text-muted")}>expand_more</span>
        </button>
        <Popover open={providerOpen} onClose={() => setProviderOpen(false)} className="w-64">
          <MenuItem
            selected={providerFilter === "all"}
            icon={<ProviderGlyph provider="all" size={18} />}
            onClick={() => {
              onProviderChange("all");
              setProviderOpen(false);
            }}
          >
            {translate("All providers")}
          </MenuItem>
          <div className="my-1 h-px bg-black/5 dark:bg-white/10" />
          <div className="max-h-72 overflow-y-auto">
            {providerOptions.map((provider) => (
              <MenuItem
                key={provider}
                selected={providerFilter === provider}
                icon={<ProviderGlyph provider={provider} size={18} />}
                onClick={() => {
                  onProviderChange(provider);
                  setProviderOpen(false);
                }}
              >
                <span className="capitalize">{provider}</span>
              </MenuItem>
            ))}
          </div>
        </Popover>
      </div>

      {/* Account status: a segmented control — the state is visible at a
          glance, so no "filter is active" banner is needed below. On a
          phone the labels give way to icons (same glyph language as the
          bulk menu) and the button keeps the label as its accessible name. */}
      <div
        role="radiogroup"
        aria-label={translate("Filter accounts by status")}
        className="flex h-8 shrink-0 items-center rounded-lg border border-black/10 bg-surface p-0.5 dark:border-white/10"
      >
        {ACCOUNT_FILTER_OPTIONS.map((option) => {
          const on = accountFilter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={translate(option.label)}
              onClick={() => onAccountChange(option.value)}
              className={cn(
                "flex h-full items-center gap-1 rounded-md px-2.5 text-xs transition-colors @max-[640px]:px-2",
                on ? "bg-primary/10 font-medium text-primary" : "text-text-muted hover:text-text",
              )}
            >
              <span className={cn(ICON, "hidden text-[14px] @max-[640px]:inline")}>
                {ACCOUNT_FILTER_ICONS[option.value]}
              </span>
              <span className="@max-[640px]:hidden">{translate(option.label)}</span>
            </button>
          );
        })}
      </div>

      {/* Sort: icon-only, like the refresh button — the label was wrapping the
          toolbar onto a second row. The tooltip (and the accessible name) carry
          what it does; `aria-pressed` says whether it is on. */}
      {cards && (
      <button
        type="button"
        onClick={onToggleExpiringFirst}
        aria-pressed={expiringFirst}
        className={cn(ICON_BTN, expiringFirst ? ICON_BTN_ON : ICON_BTN_OFF)}
        title={translate("Sort accounts by earliest reset or expiry time")}
        aria-label={translate("Resets first")}
      >
        <span className={ICON}>hourglass_top</span>
      </button>
      )}

      {cards && showCodexSort && (
        <select
          value={quotaSortMode}
          onChange={(event) => onQuotaSortChange(event.target.value)}
          className={cn(CONTROL, "pr-1 outline-none")}
          aria-label={translate("Sort Codex quotas by remaining")}
        >
          {QUOTA_SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {translate(option.label)}
            </option>
          ))}
        </select>
      )}
      </div>

      {/* ── Actions ───────────────────────────────────────────────
          Below 640px the group stays on the first row with the view tabs
          (order-2) while the filters drop to their own full-width row. */}
      <div className="ml-auto flex items-center gap-2 @max-[640px]:order-2">
        {/* Collapsed first: pure information, and the pagination summary
            below the cards already carries a count. */}
        {cards && Number.isFinite(accountCount) && (
          <span className="hidden text-xs tabular-nums text-text-muted @min-[1130px]:inline">
            {translate("{count} accounts").replace("{count}", String(accountCount))}
          </span>
        )}

        {cards && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setBulkOpen((v) => !v)}
            disabled={bulkToggling}
            className={CONTROL}
            aria-haspopup="menu"
            aria-expanded={bulkOpen}
            title={translate("Bulk actions")}
            aria-label={translate("Bulk actions")}
          >
            <span className={ICON}>{bulkToggling ? "progress_activity" : "checklist"}</span>
            <span className="hidden @min-[1060px]:inline">{translate("Bulk actions")}</span>
            <span className={cn(ICON, "text-[14px] text-text-muted")}>expand_more</span>
          </button>
          <Popover open={bulkOpen} onClose={() => setBulkOpen(false)} align="right" className="w-72">
            <MenuItem
              disabled={bulkToggling}
              icon={<span className={cn(ICON, "mt-px text-red-500")}>block</span>}
              hint={translate("Disable connections with depleted quota on the current page")}
              onClick={() => {
                setBulkOpen(false);
                onDisableDepleted();
              }}
            >
              {translate("Turn off Empty")}
            </MenuItem>
            <MenuItem
              disabled={bulkToggling}
              icon={<span className={cn(ICON, "mt-px text-emerald-500")}>check_circle</span>}
              hint={translate("Enable connections that still have quota on the current page")}
              onClick={() => {
                setBulkOpen(false);
                onEnableAvailable();
              }}
            >
              {translate("Turn on Available")}
            </MenuItem>
          </Popover>
        </div>
        )}

        {/* Auto-refresh: a real switch, with the countdown and interval dropdown beside it. */}
        {cards && (
          <div className="flex items-center">
            <button
              type="button"
              role="switch"
              aria-checked={autoRefresh}
              onClick={onToggleAutoRefresh}
              className={cn(CONTROL, autoRefresh && "rounded-r-none border-r-0")}
              title={translate(autoRefresh ? "Disable auto-refresh" : "Enable auto-refresh")}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "relative h-4 w-7 rounded-full transition-colors",
                  autoRefresh ? "bg-primary" : "bg-black/15 dark:bg-white/20",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-3 rounded-full bg-white shadow transition-[left]",
                    autoRefresh ? "left-[14px]" : "left-0.5",
                  )}
                />
              </span>
              <span className="hidden @min-[980px]:inline">{translate("Auto-refresh")}</span>
              {autoRefresh && (
                <span className="w-7 text-right text-[11px] tabular-nums text-text-muted">
                  {countdown >= 60 ? `${Math.ceil(countdown / 60)}m` : `${countdown}s`}
                </span>
              )}
            </button>
            {autoRefresh && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIntervalOpen((v) => !v)}
                  className={cn(CONTROL, "rounded-l-none px-1.5 text-text-muted hover:text-text")}
                  title={translate("Change refresh interval")}
                  aria-label={translate("Change refresh interval")}
                >
                  <span className={cn(ICON, "text-[14px]")}>expand_more</span>
                </button>
                <Popover open={intervalOpen} onClose={() => setIntervalOpen(false)} align="right" className="w-36">
                  {REFRESH_INTERVAL_OPTIONS.map((opt) => (
                    <MenuItem
                      key={opt.value}
                      selected={refreshIntervalMs === opt.value}
                      onClick={() => {
                        setIntervalOpen(false);
                        onChangeRefreshInterval?.(opt.value);
                      }}
                    >
                      {opt.label}
                    </MenuItem>
                  ))}
                </Popover>
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onRefreshAll}
          disabled={refreshingAll}
          className={cn(ICON_BTN, ICON_BTN_OFF)}
          title={translate("Refresh all")}
          aria-label={translate("Refresh all")}
        >
          <span className={cn(ICON, refreshingAll && "animate-spin")}>refresh</span>
        </button>

        {onOpenPreferences && (
          <button
            type="button"
            onClick={onOpenPreferences}
            className={cn(ICON_BTN, ICON_BTN_OFF)}
            title={translate("Card display preferences")}
            aria-label={translate("Card display preferences")}
          >
            <span className={ICON}>tune</span>
          </button>
        )}
      </div>
    </div>
  );
}

QuotaToolbar.propTypes = {
  view: PropTypes.oneOf(["cards", "windows"]),
  onViewChange: PropTypes.func,
  providerFilter: PropTypes.string.isRequired,
  providerOptions: PropTypes.arrayOf(PropTypes.string).isRequired,
  providerLabel: PropTypes.node,
  onProviderChange: PropTypes.func.isRequired,
  accountFilter: PropTypes.string.isRequired,
  onAccountChange: PropTypes.func.isRequired,
  showCodexSort: PropTypes.bool,
  quotaSortMode: PropTypes.string,
  onQuotaSortChange: PropTypes.func,
  expiringFirst: PropTypes.bool,
  onToggleExpiringFirst: PropTypes.func.isRequired,
  onDisableDepleted: PropTypes.func.isRequired,
  onEnableAvailable: PropTypes.func.isRequired,
  bulkToggling: PropTypes.bool,
  autoRefresh: PropTypes.bool,
  onToggleAutoRefresh: PropTypes.func.isRequired,
  countdown: PropTypes.number,
  refreshingAll: PropTypes.bool,
  onRefreshAll: PropTypes.func.isRequired,
  accountCount: PropTypes.number,
  onOpenPreferences: PropTypes.func,
};
