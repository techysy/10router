"use client";

import { useState, useEffect } from "react";
import { Card, Toggle } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import SecurityCard from "./SecurityCard";

// One automation = one card. Keeps the Experimental page's check-in/claim
// section scannable as the number of provider lines grows (grid wraps to a
// second column on sm+).
function CheckinCard({ title, desc, checked, onToggle }) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-xl border p-3 transition-colors ${
        checked
          ? "border-primary/40 bg-primary/5"
          : "border-border/60 bg-bg-alt/50"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-sm leading-snug min-w-0">{title}</p>
        <Toggle checked={checked} onChange={onToggle} />
      </div>
      <p className="text-xs leading-relaxed text-text-muted">{desc}</p>
    </div>
  );
}

// Beta toggles lifted out of Settings. They all act on provider *accounts*
// rather than on request routing (credential transfer, daily check-in and
// activity-credit probes), so they live on their own page instead of sharing
// the general Settings card stack. Auto-compaction moved to Token Saver.
export default function ExperimentalClient() {
  const [settings, setSettings] = useState({});

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
            <p className="text-xs text-primary/80 pt-1 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[14px]">tune</span>
              {translate("Quota card display preferences have moved to the Quota Tracker toolbar.")}
            </p>
          </div>
        </Card>

        {/* Experimental — daily check-in / activity credits. One card per
            provider automation: the grid scales as more claim/check-in lines
            land (Meoo joined 2026-11-14), instead of a long toggle stack. */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="size-10 rounded-lg flex items-center justify-center bg-amber-500/10 text-amber-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">science</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">{translate("Experimental")}</h3>
          </div>
          <p className="text-xs text-text-muted mb-3">
            {translate("Daily check-in / credit-claim automations, one card per provider line")}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Qoder auto daily credit claim */}
            <CheckinCard
              title={translate("Qoder auto daily credit claim")}
              desc={translate("Automatically claim daily campaign credits for Qoder and Qoder CN accounts")}
              checked={settings.qoderCheckin === true}
              onToggle={() =>
                patch(
                  { qoderCheckin: !(settings.qoderCheckin === true) },
                  "Error toggling Qoder auto check-in:"
                )
              }
            />

            {/* MiniMax Code auto daily check-in — subscriptions only (issue #75).
                minimax-free is the no-auth CreditDaddy gateway line; its check-in
                lives inside CreditDaddy, so it is deliberately out of scope. */}
            <CheckinCard
              title={translate("MiniMax Code auto daily check-in")}
              desc={translate("Automatically check in daily for MiniMax Code subscription accounts to earn free-pack credits (MiniMax Code Free is not covered — its check-in runs inside CreditDaddy)")}
              checked={settings.minimaxCheckin === true}
              onToggle={() =>
                patch(
                  { minimaxCheckin: !(settings.minimaxCheckin === true) },
                  "Error toggling MiniMax auto check-in:"
                )
              }
            />

            {/* Trae CN auto daily check-in — ug/checkin_credits (ported from
                CreditDaddy traeClient). Only site=cn connections participate;
                the intl trae line has no check-in product on the upstream. */}
            <CheckinCard
              title={translate("Trae auto daily check-in")}
              desc={translate("Automatically check in Trae CN connections daily to claim the free daily credits — international trae.ai connections are not covered (the upstream registers this endpoint on the CN site only)")}
              checked={settings.traeCheckin === true}
              onToggle={() =>
                patch(
                  { traeCheckin: !(settings.traeCheckin === true) },
                  "Error toggling Trae auto check-in:"
                )
              }
            />

            {/* Meoo auto daily credit claim — the daily-login gift has no claim
                endpoint; the scheduler fires the same login-equivalent action the
                manual route uses and verifies the ledger delta. Replaces the
                manual button on the quota card (2026-11-14 user feedback). */}
            <CheckinCard
              title={translate("Meoo auto daily credit claim")}
              desc={translate("Automatically trigger the daily login for Meoo connections and verify the 2000-point gift lands — replaces the manual button on the quota card")}
              checked={settings.meooCheckin === true}
              onToggle={() =>
                patch(
                  { meooCheckin: !(settings.meooCheckin === true) },
                  "Error toggling Meoo auto check-in:"
                )
              }
            />

            {/* CodeBuddy CN auto daily check-in (shares the UI slot with import/export) */}
            <CheckinCard
              title={translate("CodeBuddy CN auto daily check-in")}
              desc={translate("Automatically check in accounts daily (retries all day until confirmed)")}
              checked={settings.codeBuddyCheckin === true}
              onToggle={() =>
                patch(
                  { codeBuddyCheckin: !(settings.codeBuddyCheckin === true) },
                  "Error toggling codebuddy auto check-in:"
                )
              }
            />

            {/* CodeBuddy CN auto compensation & gift claim */}
            <CheckinCard
              title={translate("CodeBuddy CN auto compensation claim")}
              desc={translate("Automatically claim temporary campaign compensation and gifts for CodeBuddy CN accounts")}
              checked={settings.codeBuddyCompensation === true}
              onToggle={() =>
                patch(
                  { codeBuddyCompensation: !(settings.codeBuddyCompensation === true) },
                  "Error toggling codebuddy auto compensation:"
                )
              }
            />
          </div>
          <p className="text-xs text-text-muted italic pt-3 mt-3 border-t border-border/50">
            {translate("Import / Export moved behind the check-in button — turn off auto check-in to show them again")}
          </p>
        </Card>

        {/* Security — dashboard exposure + local-only lockdown (issue #9) */}
        <SecurityCard settings={settings} patch={patch} />
      </div>
    </div>
  );
}
