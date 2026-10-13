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
