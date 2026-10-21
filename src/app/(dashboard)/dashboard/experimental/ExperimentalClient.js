"use client";

import { useState, useEffect } from "react";
import { Card, Toggle } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import SecurityCard from "./SecurityCard";

// Generic check-in adapters (src/sse/services/checkin/providers/*). Kept in one
// list so a new adapter only needs a settings key + a row here.
const GENERIC_CHECKINS = [
  { key: "traeCheckin", label: "Trae CN auto daily check-in", desc: "Daily checkin_credits claim for CN Trae / Trae SOLO accounts (no check-in exists on the intl site)." },
  { key: "codeartsCheckin", label: "CodeArts daily check-in", desc: "Daily benefit claim for Huawei CodeArts accounts." },
  { key: "officeaceCheckin", label: "OfficeAce daily check-in", desc: "One-shot reward claim for OfficeAce subscription accounts (needs control-plane credentials)." },
  { key: "loomyCheckin", label: "Loomy daily check-in", desc: "Daily first-login points and newcomer tasks for Loomy accounts." },
  { key: "atomcodeCheckin", label: "AtomCode plan claim", desc: "Claims the free CodingPlan when it is available; no daily points." },
  { key: "raccoonCheckin", label: "Raccoon daily check-in", desc: "Daily desktop-login points and reward claims for Raccoon accounts." },
  { key: "lobsteraiCheckin", label: "LobsterAI daily check-in", desc: "Daily activity check-in for LobsterAI accounts." },
];

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

        {/* Experimental — daily check-in / activity credits */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="size-10 rounded-lg flex items-center justify-center bg-amber-500/10 text-amber-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">science</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">{translate("Experimental")}</h3>
          </div>
          <div className="flex flex-col gap-4">
            {/* Global check-in time for every enabled scheduler. */}
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("Daily check-in time")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Local time (HH:mm). All enabled check-ins run at this minute; failures retry about every 2 hours until the day ends.")}
                </p>
              </div>
              <input
                type="time"
                value={settings.checkinTime || "09:00"}
                onChange={(event) =>
                  patch(
                    { checkinTime: event.target.value },
                    "Error updating check-in time:"
                  )
                }
                className="bg-sidebar border border-border rounded-lg px-3 py-2 text-sm text-text-main"
              />
            </div>

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

            {/* MiniMax Code auto daily check-in — subscriptions only (issue #75).
                minimax-free is the no-auth CreditDaddy gateway line; its check-in
                lives inside CreditDaddy, so it is deliberately out of scope. */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("MiniMax Code auto daily check-in")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Automatically check in daily for MiniMax Code subscription accounts to earn free-pack credits (MiniMax Code Free is not covered — its check-in runs inside CreditDaddy)")}
                </p>
              </div>
              <Toggle
                checked={settings.minimaxCheckin === true}
                onChange={() =>
                  patch(
                    { minimaxCheckin: !(settings.minimaxCheckin === true) },
                    "Error toggling MiniMax auto check-in:"
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

            {/* CodeBuddy CN auto compensation & gift claim */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">{translate("CodeBuddy CN auto compensation claim")}</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  {translate("Automatically claim temporary campaign compensation and gifts for CodeBuddy CN accounts")}
                </p>
              </div>
              <Toggle
                checked={settings.codeBuddyCompensation === true}
                onChange={() =>
                  patch(
                    { codeBuddyCompensation: !(settings.codeBuddyCompensation === true) },
                    "Error toggling codebuddy auto compensation:"
                  )
                }
              />
            </div>

            {GENERIC_CHECKINS.map(({ key, label, desc }) => (
              <div
                key={key}
                className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm sm:text-base">{translate(label)}</p>
                  <p className="text-xs sm:text-sm text-text-muted">{translate(desc)}</p>
                </div>
                <Toggle
                  checked={settings[key] === true}
                  onChange={() =>
                    patch(
                      { [key]: !(settings[key] === true) },
                      `Error toggling ${key}:`
                    )
                  }
                />
              </div>
            ))}
          </div>
        </Card>

        {/* Security — dashboard exposure + local-only lockdown (issue #9) */}
        <SecurityCard settings={settings} patch={patch} />
      </div>
    </div>
  );
}
