/**
 * CodeArts dispatch gates — all three live *before* the upstream call.
 *
 *   · pool rate limiter: 50 req/s is an **aggregate** ceiling for the whole
 *     account pool (Rust/community measurement), not a per-account one. It is
 *     enforced at module scope so every executor instance shares the bucket.
 *   · per-account session gate: upstream allows 3 concurrent chat sessions
 *     (4th answers HTTP 400 `TM.00001041`). Our local gate is 3 too, but the
 *     upstream does not free a slot when the HTTP body ends — it waits for the
 *     `chat-session/heartbeat` idle. Community clients release on `[DONE]`;
 *     zombie slots after `[DONE]` are common, so in practice only 1–2 lanes
 *     remain usable. We release on stream end AND keep a hard deadline so a
 *     hung stream cannot leak a slot for the process lifetime.
 *   · size gate: a measured floor (not a guess) of bodies the upstream rejects.
 */
import {
  CODEARTS_DEFAULT_SESSION_LIMIT,
  CODEARTS_MAX_SESSION_LIMIT,
  CODEARTS_POOL_RATE_PER_SECOND,
  CODEARTS_SIZE_GATE_TTL_MS,
} from "../../config/codearts.js";

// ── pool-wide rate limiter ────────────────────────────────────────────────
const MIN_INTERVAL_MS = 1000 / CODEARTS_POOL_RATE_PER_SECOND;
let nextDispatchAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the next pool-wide dispatch slot. Simple in-process pacing: 50
 * tokens/s are spread evenly, so a burst of 200 queued requests drains in
 * ~4 s instead of tripping `81101.429`. Multi-process deployments still need
 * an external limiter — noted as a TODO in the integration plan.
 */
export async function acquirePoolDispatchSlot() {
  const now = Date.now();
  const scheduled = Math.max(now, nextDispatchAt);
  nextDispatchAt = scheduled + MIN_INTERVAL_MS;
  const wait = scheduled - now;
  if (wait > 0) await sleep(wait);
  return () => {}; // rate slots are time-based, nothing to release
}

// ── per-account session gate ──────────────────────────────────────────────
const activeSessions = new Map();

export class CodeArtsConcurrencyError extends Error {
  constructor(limit) {
    super(`CodeArts 账号并发会话已达上限（${limit}，含 [DONE] 后未释放的僵尸槽），稍后重试`);
    this.name = "CodeArtsConcurrencyError";
    this.statusCode = 400;
    this.code = "00001041";
  }
}

export function acquireSessionSlot(key, limitOverride) {
  const limit = Math.min(
    CODEARTS_MAX_SESSION_LIMIT,
    Math.max(1, Number(limitOverride) || CODEARTS_DEFAULT_SESSION_LIMIT)
  );
  const used = activeSessions.get(key) || 0;
  // Deliberately NOT waiting here: a local queue would hold the client request
  // behind a stream that may never free its upstream slot. The caller turns this
  // into a short-cooldown error (see errorConfig rule for 00001041).
  if (used >= limit) throw new CodeArtsConcurrencyError(limit);
  activeSessions.set(key, used + 1);
  let released = false;
  return {
    key,
    limit,
    release() {
      if (released) return;
      released = true;
      const current = activeSessions.get(key) || 0;
      if (current <= 1) activeSessions.delete(key);
      else activeSessions.set(key, current - 1);
    },
  };
}

export function activeSessionCount(key) {
  return activeSessions.get(key) || 0;
}

/** Test-only: drop every slot. */
export function __resetSessionGate() {
  activeSessions.clear();
}

/**
 * Release a session slot when the response body finishes. Also arms a hard
 * deadline: `[DONE]` followed by a never-closing socket is exactly the zombie
 * shape we cannot see at header time.
 */
export function releaseSlotOnResponseEnd(response, release, timeoutMs = 10 * 60 * 1000) {
  const timer = setTimeout(release, timeoutMs);
  timer.unref?.();
  if (!response?.body) {
    release();
    clearTimeout(timer);
    return response;
  }
  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const step = await reader.read();
        if (step.done) {
          release();
          clearTimeout(timer);
          controller.close();
        } else {
          controller.enqueue(step.value);
        }
      } catch (error) {
        release();
        clearTimeout(timer);
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// ── size gate ─────────────────────────────────────────────────────────────
let sizeGate = null; // { floorBytes, expiresAt }

/**
 * Remember a measured size failure. Narrows only (a higher measurement never
 * widens the gate) and never extends the TTL. Returns true on the transition
 * "no gate -> gate", so callers log once instead of per request.
 */
export function holdSizeGate(wireBytes, nowMs = Date.now()) {
  const blockedBefore = Boolean(sizeGate && sizeGate.expiresAt > nowMs);
  if (sizeGate && sizeGate.expiresAt > nowMs) {
    sizeGate.floorBytes = Math.min(sizeGate.floorBytes, Math.max(0, wireBytes));
  } else {
    sizeGate = { floorBytes: Math.max(0, wireBytes), expiresAt: nowMs + CODEARTS_SIZE_GATE_TTL_MS };
  }
  return !blockedBefore;
}

export function sizeGateFloor(nowMs = Date.now()) {
  return sizeGate && sizeGate.expiresAt > nowMs ? sizeGate.floorBytes : null;
}

export function sizeGateMsLeft(nowMs = Date.now()) {
  return sizeGate ? Math.max(0, sizeGate.expiresAt - nowMs) : 0;
}

export function __resetSizeGate() {
  sizeGate = null;
}
