// Shared daily check-in clock.
//
// All check-in services (legacy qoder/codebuddy/minimax + the generic
// adapters) used to start with a ~2h tick. That made the first run depend on
// boot time, not on the user. `checkinTime` is a global HH:mm in the server's
// local timezone; after that minute the day's passes are allowed, and failures
// keep retrying every ~2h until the day ends (the same retry behavior as
// before, just anchored to the configured time instead of boot time).
//
// The delay function deliberately does NOT need "ran today" state:
//   • before today's time  → wait for today's time;
//   • after today's time   → next retry in ~2h, unless that crosses midnight,
//                            in which case wait for tomorrow's time.
// A process that boots after the time therefore runs a catch-up pass
// immediately (the caller calls the guarded tick on start) and then falls into
// the retry cadence. A process that boots before the time waits for it.

export const DEFAULT_CHECKIN_TIME = "09:00";
export const RETRY_MS = 2 * 60 * 60 * 1000;
export const RETRY_JITTER_MS = 10 * 60 * 1000;
// Small offset so every deployment does not hit the upstream at :00:00.
export const DAILY_JITTER_MS = 30 * 1000;

/** "H:mm" / "09:00" → canonical "HH:mm"; anything invalid → fallback. */
export function normalizeCheckinTime(value, fallback = DEFAULT_CHECKIN_TIME) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Minutes since local midnight for a canonical/invalid time. */
export function minuteOfDay(value) {
  const time = normalizeCheckinTime(value);
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

/** Has today's configured check-in time arrived? */
export function checkinTimeReached(value, nowMs = Date.now()) {
  const now = new Date(nowMs);
  return now.getHours() * 60 + now.getMinutes() >= minuteOfDay(value);
}

function todayTarget(nowMs, time) {
  const [hour, minute] = normalizeCheckinTime(time).split(":").map(Number);
  const target = new Date(nowMs);
  target.setHours(hour, minute, 0, 0);
  return target.getTime();
}

function nextDayTarget(nowMs, time) {
  const target = new Date(todayTarget(nowMs, time));
  target.setDate(target.getDate() + 1);
  return target.getTime();
}

function sameLocalDay(aMs, bMs) {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/**
 * Delay until the next scheduled check-in attempt.
 *
 * @param {number} nowMs
 * @param {string} time HH:mm (local)
 * @param {{ rand?: () => number, retryMs?: number, retryJitterMs?: number, dailyJitterMs?: number }} [opts]
 * @returns {number} milliseconds (always > 0)
 */
export function nextCheckinDelay(nowMs = Date.now(), time = DEFAULT_CHECKIN_TIME, opts = {}) {
  const rand = opts.rand || Math.random;
  const retryMs = opts.retryMs ?? RETRY_MS;
  const retryJitterMs = opts.retryJitterMs ?? RETRY_JITTER_MS;
  const dailyJitterMs = opts.dailyJitterMs ?? DAILY_JITTER_MS;

  const today = todayTarget(nowMs, time);
  if (today > nowMs) {
    return Math.max(1, today - nowMs + Math.floor(rand() * dailyJitterMs));
  }

  const retryAt = nowMs + retryMs + Math.floor(rand() * retryJitterMs);
  // A retry that lands on the next calendar day would run before that day's
  // configured time; wait for tomorrow's target instead.
  if (!sameLocalDay(retryAt, nowMs)) {
    return Math.max(1, nextDayTarget(nowMs, time) - nowMs + Math.floor(rand() * dailyJitterMs));
  }
  return Math.max(1, retryAt - nowMs);
}
