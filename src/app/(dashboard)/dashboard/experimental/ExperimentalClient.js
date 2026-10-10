"use client";

import { useState, useEffect } from "react";
import { Card, Toggle } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import SecurityCard from "./SecurityCard";

// Beta toggles lifted out of Settings. They all act on provider *accounts*
// rather than on request routing (credential transfer, daily check-in and
// activity-credit probes), so they live on their own page instead of sharing
// the general Settings card stack. Auto-compaction moved to Token Saver.
export default function ExperimentalClient() {
  const [settings, setSettings] = useState({});
  // Client-side view preference (localStorage), read by the quota page — not a
  // server setting, so it does not go through /api/settings.
  const [hideNoQuota, setHideNoQuota] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem("quotaHideNoQuota") === "1",
  );
  // Depleted sibling of hideNoQuota (same localStorage pattern, key read by
  // the quota page): hide cards whose quota fetch completed with every pack at
  // absolute zero (0 余额 / 0 积分). Distinct from "no quota" — a message-only
  // card (cloud MiMo note, Token Plan) is no-quota, not zero-balance, so the
  // two toggles are independent and compose when both are on.
  const [hideZeroBalance, setHideZeroBalance] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem("quotaHideZeroBalance") === "1",
  );
  // Same client-side view preference as hideNoQuota, key read by the quota
  // page: draw contained subscription windows (滚动 ⊂ 每周 ⊂ 月度) as one
  // nested concentric track instead of split flat rows.
  const [nestedCycle, setNestedCycle] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem("quotaNestedCycle") === "1",
  );

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("quotaHideNoQuota", hideNoQuota ? "1" : "0");
    }
  }, [hideNoQuota]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("quotaHideZeroBalance", hideZeroBalance ? "1" : "0");
    }
  }, [hideZeroBalance]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("quotaNestedCycle", nestedCycle ? "1" : "0");
    }
  }, [nestedCycle]);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => setSettings(data || {}))
      .catch((err) => console.error("Failed to fetch settings:", err));
  }, []);

  const patch = async (body, label) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
      }
    } catch (error) {
      console.log(label, error);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-0">
      <div className="flex flex-col gap-6">
        {/* Providers — cross-account credential transfer */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="size-10 rounded-lg flex items-center justify-center bg-cyan-500/10 text-cyan-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">device_hub</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">{translate("Providers")}</h3>
          </div>
          <div className="flex flex-col gap-4">
            {/* Quota page view toggle — moved here because the quota toolbar
                was getting crowded. Writes the localStorage pref that page reads. */}
            <div className="flex items-start sm:items-center justify-between gap-4 pb-4 border-b border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("Hide no-quota provider cards")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Quota page view: hide cards that have no quota to display")}
                </p>
              </div>
              <Toggle
                checked={hideNoQuota}
                onChange={() => setHideNoQuota((prev) => !prev)}
              />
            </div>

            {/* Depleted sibling of the toggle above — hides cards whose packs
                are ALL at zero balance (0 余额 / 0 积分). Shares the
                isConnectionDepleted predicate with the bulk disable action. */}
            <div className="flex items-start sm:items-center justify-between gap-4 pb-4 border-b border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("Hide zero-balance provider cards")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Quota page view: hide cards whose quota is fully depleted (0 balance / 0 credits)")}
                </p>
              </div>
              <Toggle
                checked={hideZeroBalance}
                onChange={() => setHideZeroBalance((prev) => !prev)}
              />
            </div>

            {/* Cycle quota display shape — flat split rows (default, monthly
                anchored at the bottom) vs the previous nested concentric
                track. Takes effect on the next quota-page load. */}
            <div className="flex items-start sm:items-center justify-between gap-4 pb-4 border-b border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("Nested cycle quota bars")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Draw contained windows (rolling ⊂ weekly ⊂ monthly) as one nested track instead of flat rows")}
                </p>
              </div>
              <Toggle
                checked={nestedCycle}
                onChange={() => setNestedCycle((prev) => !prev)}
              />
            </div>

            {/* OAuth account import/export (provider detail pages, all OAuth providers) */}
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("OAuth import / export")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Show Import / Export buttons on OAuth provider pages (encrypted transfer, experimental)")}
                </p>
              </div>
              <Toggle
                checked={settings.codeBuddyOAuthImport === true}
                onChange={() =>
                  patch(
                    { codeBuddyOAuthImport: !(settings.codeBuddyOAuthImport === true) },
                    "Error toggling codebuddy OAuth import:"
                  )
                }
              />
            </div>
            <p className="text-xs text-text-muted italic pt-2 border-t border-border/50">
              {translate("Import / Export moved behind the check-in button — turn off auto check-in to show them again")}
            </p>
          </div>
        </Card>

        {/* Experimental — daily check-in / activity credits */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="size-10 rounded-lg flex items-center justify-center bg-amber-500/10 text-amber-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">science</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">{translate("Experimental")}</h3>
          </div>
          <div className="flex flex-col gap-4">
            {/* Qoder auto daily credit claim */}
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("Qoder auto daily credit claim")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Automatically claim daily campaign credits for Qoder and Qoder CN accounts")}
                </p>
              </div>
              <Toggle
                checked={settings.qoderCheckin === true}
                onChange={() =>
                  patch(
                    { qoderCheckin: !(settings.qoderCheckin === true) },
                    "Error toggling Qoder auto check-in:"
                  )
                }
              />
            </div>

            {/* CodeBuddy intl daily active-session probe (campaign credits) */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("CodeBuddy daily active session")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Send one free-tier chat request per account daily so the activity credits are granted")}
                </p>
              </div>
              <Toggle
                checked={settings.codeBuddyIntlSession === true}
                onChange={() =>
                  patch(
                    { codeBuddyIntlSession: !(settings.codeBuddyIntlSession === true) },
                    "Error toggling codebuddy intl daily session:"
                  )
                }
              />
            </div>

            {/* CodeBuddy CN auto daily check-in (shares the UI slot with import/export) */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("CodeBuddy CN auto daily check-in")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Automatically check in accounts daily (retries all day until confirmed)")}
                </p>
              </div>
              <Toggle
                checked={settings.codeBuddyCheckin === true}
                onChange={() =>
                  patch(
                    { codeBuddyCheckin: !(settings.codeBuddyCheckin === true) },
                    "Error toggling codebuddy auto check-in:"
                  )
                }
              />
            </div>
          </div>
        </Card>

        {/* Security — dashboard exposure + local-only lockdown (issue #9) */}
        <SecurityCard settings={settings} patch={patch} />
      </div>
    </div>
  );
}
