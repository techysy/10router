// Generic check-in scheduler.
//
// Claims the same shape as the three existing per-provider services
// (qoderCheckin / codebuddyCheckin / minimaxCheckin): ~2h tick + jitter, only
// server runtime, fail-open, per-day memo. Differences:
//   - one ticker for every adapter registered in ./registry.js;
//   - the "done today" memo is the ledger table, not a settings map, so the
//     dashboard can show 到账量 and adapters can reconcile before/after;
//   - channel-blocked providers are skipped (a channel that is cooling down
//     should not be poked by the check-in pass either);
//   - sequential on purpose: these are account actions, not user traffic.
import * as log from "../../utils/logger.js";
import { getCheckinAdapters, CHECKIN_SETTING_KEYS } from "./registry.js";
import {
  DEFAULT_CHECKIN_TIME,
  checkinTimeReached,
  nextCheckinDelay,
  normalizeCheckinTime,
} from "./schedule.js";

const RUN_TIMEOUT_MS = 90 * 1000;

let timerHandle = null;
let sweeping = false;
// Last value read from settings. `scheduleNext()` is synchronous; the guarded
// tick refreshes this before scheduling so a settings change is visible on the
// next timer without a restart.
let scheduledTime = DEFAULT_CHECKIN_TIME;

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") {
    return true;
  }
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

export function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function accountLabel(conn) {
  const name = conn.name || conn.displayName || conn.email || `${String(conn.id || "?").slice(0, 8)}…`;
  return name;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`check-in timed out after ${Math.round(ms / 1000)}s`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function scheduleNext() {
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = setTimeout(() => {
    fire().catch(() => {});
  }, nextCheckinDelay(Date.now(), scheduledTime));
  timerHandle.unref?.();
}

async function fire() {
  try {
    const { getSettings } = await import("../../../lib/localDb.js");
    const settings = (await getSettings()) || {};
    scheduledTime = normalizeCheckinTime(settings.checkinTime);
    if (!checkinTimeReached(scheduledTime)) {
      log.debug("CHECKIN", `before daily check-in time ${scheduledTime}; skipping`);
      return;
    }
    await runCheckinSweep({ reason: "scheduled" });
  } finally {
    scheduleNext();
  }
}

export function startCheckinScheduler() {
  if (isNonServerRuntime() || timerHandle) return;
  // Boot pass = catch-up for a process that was down at the configured time.
  // The per-account ledger prevents a duplicate claim.
  fire().catch(() => {});
}

export function stopCheckinScheduler() {
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = null;
}

export function isCheckinSchedulerRunning() {
  return !!timerHandle;
}

/** Re-read settings after a toggle flip; start or stop accordingly. */
export async function refreshCheckinScheduler() {
  try {
    const { getSettings } = await import("../../../lib/localDb.js");
    const settings = (await getSettings()) || {};
    scheduledTime = normalizeCheckinTime(settings.checkinTime);
    if (CHECKIN_SETTING_KEYS.some((k) => settings[k] === true)) {
      if (timerHandle) {
        // Time may have moved earlier/later. Re-evaluate now (ledger makes
        // this idempotent) and schedule against the new value.
        clearTimeout(timerHandle);
        timerHandle = null;
        fire().catch(() => {});
      } else {
        startCheckinScheduler();
      }
    } else {
      stopCheckinScheduler();
    }
  } catch (err) {
    log.warn("CHECKIN", `refresh scheduler failed: ${err?.message || err}`);
  }
}

/**
 * Run one sweep. Manual calls may pass `provider` to narrow the sweep.
 * `allowDisabled` exists only for dry-run diagnostics from the dashboard —
 * scheduled sweeps never bypass the toggle.
 */
export async function runCheckinSweep({
  reason = "manual",
  provider = null,
  force = false,
  dryRun = false,
  allowDisabled = false,
} = {}) {
  if (sweeping) return { ok: false, reason: "busy", results: [] };
  sweeping = true;
  const results = [];
  try {
    const { getSettings, getProviderConnections, getChannelBlock, updateProviderConnection } = await import("../../../lib/localDb.js");
    const { recordCheckinRun, hasCheckinSuccessToday, pruneCheckinRuns } = await import(
      "../../../lib/db/repos/checkinRepo.js"
    );
    await pruneCheckinRuns().catch(() => {});

    const settings = (await getSettings()) || {};
    const adapters = getCheckinAdapters().filter(
      (a) => !provider || a.id === provider || a.providers.includes(provider)
    );
    const enabled = adapters.filter((a) => allowDisabled || settings[a.settingsKey] === true);
    if (!enabled.length) return { ok: true, ran: 0, results, reason: "no-enabled-adapter" };

    const connections = await getProviderConnections();
    const today = dayKey();

    for (const adapter of enabled) {
      const owned = connections.filter(
        (c) => adapter.providers.includes(c.provider) && c.isActive !== false
      );
      for (const conn of owned) {
        const base = {
          provider: conn.provider,
          connectionId: conn.id,
          accountLabel: accountLabel(conn),
        };
        const block = await getChannelBlock(conn.provider).catch(() => null);
        const blockUntil = block?.until ? Date.parse(block.until) : 0;
        if (blockUntil > Date.now() && !force) {
          results.push({ ...base, status: "skipped", reason: "channel-blocked" });
          continue;
        }
        if (!force && (await hasCheckinSuccessToday(conn.provider, conn.id, today).catch(() => false))) {
          results.push({ ...base, status: "already", memo: true });
          continue;
        }

        let outcome;
        try {
          outcome = await withTimeout(adapter.run(conn, { settings, dryRun, today, force }), RUN_TIMEOUT_MS);
        } catch (err) {
          outcome = { status: "failed", message: err?.message || String(err) };
        }

        const record = {
          ...base,
          day: today,
          status: outcome?.status || "failed",
          amount: outcome?.amount,
          unit: outcome?.unit,
          before: outcome?.before,
          after: outcome?.after,
          code: outcome?.code,
          message: outcome?.message,
          at: new Date().toISOString(),
        };
        if (!dryRun) await recordCheckinRun(record).catch(() => {});
        // A check-in can change the balance (daily pool refill, reward claim).
        // Invalidate the cached earliest-expiry so the existing SWR path
        // re-reads usage on the next selection instead of ranking today's
        // pool on yesterday's numbers. No network call here.
        if (!dryRun && (record.status === "ok" || record.status === "already")) {
          await updateProviderConnection(conn.id, { quotaCheckedAt: null }).catch(() => {});
        }
        results.push({
          ...base,
          status: record.status,
          amount: record.amount ?? null,
          message: record.message,
        });
        const amountText = record.amount != null ? ` +${record.amount}${record.unit || ""}` : "";
        log.info("CHECKIN", `${conn.provider} ${base.accountLabel}: ${record.status}${amountText}`);
      }
    }
    return { ok: true, ran: results.filter((r) => r.status !== "skipped").length, results, reason };
  } finally {
    sweeping = false;
  }
}
