import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";
import { isAutoUpdateCheckEnabled, syncUpdateCheckMarker } from "@/lib/updateCheck";
import { hasOwnDashboardCredential, setDashboardAuthCookie } from "@/lib/auth/dashboardSession";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

/**
 * Restart the legacy schedulers so a new `checkinTime` takes effect now rather
 * than on their next ~2h timer. Stop+start (start is idempotent) re-reads
 * settings and schedules against the configured minute.
 */
async function rescheduleLegacyCheckinSchedulers(settings) {
  const jobs = [];
  if (settings.qoderCheckin === true) {
    jobs.push(
      import("@/sse/services/qoderCheckin.js").then((m) => {
        m.stopQoderCheckin();
        m.startQoderCheckin();
      })
    );
  }
  if (settings.codeBuddyCheckin === true || settings.codeBuddyCompensation === true) {
    jobs.push(
      import("@/sse/services/codebuddyCheckin.js").then((m) => {
        m.stopCodebuddyCheckin();
        m.startCodebuddyCheckin();
      })
    );
  }
  if (settings.minimaxCheckin === true) {
    jobs.push(
      import("@/sse/services/minimaxCheckin.js").then((m) => {
        m.stopMinimaxCheckin();
        m.startMinimaxCheckin();
      })
    );
  }
  await Promise.allSettled(jobs);
}

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    // Hiding the login-off banner is a decision about THIS off-period. Turning the
    // check back on forgets it, so a later switch-off warns again.
    if (body.requireLogin === true) body.hideLoginOffBanner = false;

    // An empty / whitespace-only password is never valid (issue #33). Checked on
    // the key's presence, not its truthiness: `if (body.newPassword)` used to let
    // "" slip through silently while the rest of the request still applied.
    const settingPassword = Object.prototype.hasOwnProperty.call(body, "newPassword");
    if (settingPassword && (typeof body.newPassword !== "string" || !body.newPassword.trim())) {
      return NextResponse.json({ error: "Password cannot be empty", code: "PASSWORD_EMPTY" }, { status: 400 });
    }

    // Turning the log-in check on needs a credential the operator actually knows:
    // a stored password (existing or set in this same request) or SSO. The
    // bootstrap INITIAL_PASSWORD does not count — on fnOS it is generated at
    // install time into a file the user never sees, and enabling the check on it
    // alone locked people out with every password rejected (issue #33).
    if (body.requireLogin === true && !settingPassword) {
      const current = await getSettings();
      if (!hasOwnDashboardCredential({ ...current, ...body })) {
        return NextResponse.json(
          { error: "Set a dashboard password before turning on the log-in check.", code: "PASSWORD_REQUIRED" },
          { status: 400 },
        );
      }
    }

    // If updating password, hash it
    if (settingPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting a password: there is no stored hash to compare
        // against. Reaching this branch already required passing the guard,
        // which admits only authenticated clients — or, when nothing is
        // configured at all, the loopback operator (see
        // dashboardGuard.isAuthenticated). No literal fallback belongs here: the
        // old code also accepted the hardcoded "123456", which is exactly what
        // let a remote caller on a fresh 0.0.0.0 install take the dashboard over
        // (issue #9).
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    const settings = await updateSettings(body);

    // The CLI launcher checks for updates before the server exists; it reads a
    // marker file, not the database.
    if (Object.prototype.hasOwnProperty.call(body, "autoUpdateCheck")) {
      syncUpdateCheckMarker(isAutoUpdateCheckEnabled(settings));
    }

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    // Experimental CodeBuddy CN auto check-in / compensation: when any toggle flips on at
    // runtime, (re)start the scheduler. It re-reads the flags on every fire, so
    // turning it off later needs no extra wiring. Module is idempotent.
    // (The intl daily active-session probe is retired and no longer starts the scheduler.)
    if (
      (Object.prototype.hasOwnProperty.call(body, "codeBuddyCheckin") && settings.codeBuddyCheckin === true) ||
      (Object.prototype.hasOwnProperty.call(body, "codeBuddyCompensation") && settings.codeBuddyCompensation === true)
    ) {
      import("@/sse/services/codebuddyCheckin.js")
        .then(({ startCodebuddyCheckin }) => startCodebuddyCheckin())
        .catch((error) => console.warn("[CodeBuddyCheckin] start failed:", error.message));
    }

    // Auto daily credit claim for Qoder & Qoder CN
    if (Object.prototype.hasOwnProperty.call(body, "qoderCheckin")) {
      if (settings.qoderCheckin === true) {
        import("@/sse/services/qoderCheckin.js")
          .then(({ startQoderCheckin }) => startQoderCheckin())
          .catch((error) => console.warn("[QoderCheckin] start failed:", error.message));
      } else {
        import("@/sse/services/qoderCheckin.js")
          .then(({ stopQoderCheckin }) => stopQoderCheckin())
          .catch((error) => console.warn("[QoderCheckin] stop failed:", error.message));
      }
    }

    // Auto daily check-in for MiniMax Code subscriptions (issue #75)
    if (Object.prototype.hasOwnProperty.call(body, "minimaxCheckin")) {
      if (settings.minimaxCheckin === true) {
        import("@/sse/services/minimaxCheckin.js")
          .then(({ startMinimaxCheckin }) => startMinimaxCheckin())
          .catch((error) => console.warn("[MinimaxCheckin] start failed:", error.message));
      } else {
        import("@/sse/services/minimaxCheckin.js")
          .then(({ stopMinimaxCheckin }) => stopMinimaxCheckin())
          .catch((error) => console.warn("[MinimaxCheckin] stop failed:", error.message));
      }
    }

    // W1 generic check-in adapters (raccoon / atomcode / lobsterai). One
    // scheduler for all; refresh re-reads the toggles and starts or stops.
    if (
      Object.prototype.hasOwnProperty.call(body, "raccoonCheckin") ||
      Object.prototype.hasOwnProperty.call(body, "atomcodeCheckin") ||
      Object.prototype.hasOwnProperty.call(body, "lobsteraiCheckin") ||
      Object.prototype.hasOwnProperty.call(body, "loomyCheckin") ||
      Object.prototype.hasOwnProperty.call(body, "officeaceCheckin") ||
      Object.prototype.hasOwnProperty.call(body, "codeartsCheckin") ||
      Object.prototype.hasOwnProperty.call(body, "traeCheckin") ||
      Object.prototype.hasOwnProperty.call(body, "checkinTime")
    ) {
      import("@/sse/services/checkin/scheduler.js")
        .then(({ refreshCheckinScheduler }) => refreshCheckinScheduler())
        .catch((error) => console.warn("[Checkin] refresh failed:", error.message));
    }

    // A time change affects every scheduler, including the three legacy ones.
    if (Object.prototype.hasOwnProperty.call(body, "checkinTime")) {
      rescheduleLegacyCheckinSchedulers(settings).catch((error) =>
        console.warn("[Checkin] legacy reschedule failed:", error.message)
      );
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    // Establishing protection used to kick the operator straight to the login
    // page: they were admitted by loopback trust or open access (no auth
    // cookie), and the moment a password exists / requireLogin turns on the
    // guard demands one. The caller already passed every check this route
    // enforces (authenticated session, current-password verify when a hash
    // existed), so hand them a session instead of locking them out of the
    // change they just made (设置→安全 开启「需要登录」被踢出).
    if (settingPassword || body.requireLogin === true) {
      const cookieStore = await cookies();
      await setDashboardAuthCookie(cookieStore, request);
    }
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
