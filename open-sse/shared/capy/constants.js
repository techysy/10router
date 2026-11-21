/**
 * Capy.ai protocol constants — reverse-verified against @capy/desktop 0.9.2.
 *
 * Auth surface:
 *   clerk.capy.ai  — Clerk Frontend API (native API enabled). Login produces a
 *                    client JWT carrying a rotating_token (the durable
 *                    credential, equivalent to a refresh token) plus a session
 *                    id; every FAPI response returns a possibly-rotated client
 *                    JWT in its `Authorization` response header.
 *   api.capy.ai    — private app API rooted at `/app`. It accepts the 60-second
 *                    session JWT minted per-session by FAPI. The mint call MUST
 *                    send `Origin: capy://app` or the issued JWT lacks the
 *                    `azp` claim and /app/* answers 401 to it.
 *
 * Execution surface:
 *   Threads ("jams") live under /app/orgs/:orgId/jams. A thread without a
 *   project must target an enrolled device ({deviceId, workspace{kind:
 *   "worktree"}}) — the agent then runs on that device. Agent replies arrive
 *   as `assistant` events; the user-visible text is the `message_user` tool
 *   call's args.text (state:"final" ends the turn).
 */

export const CAPY_FAPI_BASE = "https://clerk.capy.ai";
export const CAPY_API_BASE = "https://api.capy.ai";
export const CAPY_APP_PREFIX = "/app";
export const CAPY_ORIGIN = "capy://app";

// Exact Clerk params shipped by the desktop's request pipeline (ire()).
export const CAPY_CLERK_API_VERSION = "2026-08-20";
export const CAPY_CLERK_JS_VERSION = "6.43.1";

export const CAPY_SESSION_TOKEN_TTL_MS = 55_000; // minted JWTs live ~60s; refresh a little early
export const CAPY_DEFAULT_TIMEOUT_MS = 20_000;

// ── Client-surface headers (reverse-verified from @capy/desktop 0.9.2 renderer) ──
// The desktop sends x-capy-client-surface=desktop, x-capy-client-features
// (message-edit,visual,ads-models) and x-capy-client-id on every /app/* call.
// The server gates ad-funded (free) models on the `ads-models` feature flag
// plus surface=desktop — without these headers the jam create is rejected
// for ad-supported models (HTTP 400/403).
export const CAPY_CLIENT_SURFACE = "desktop";
export const CAPY_CLIENT_FEATURES = "message-edit,visual,ads-models";
export const CAPY_CLIENT_ID_HEADER = "x-capy-client-id";
export const CAPY_CLIENT_SURFACE_HEADER = "x-capy-client-surface";
export const CAPY_CLIENT_FEATURES_HEADER = "x-capy-client-features";

/** Generate a 32-char hex client id (same shape as desktop's crypto.randomUUID
 *  with dashes stripped). Persisted per-connection so the server sees a stable
 *  client identity across requests. */
export function makeCapyClientId() {
  const uuid = (globalThis.crypto?.randomUUID?.() ??
    "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx");
  return uuid.replace(/-/g, "");
}

// Jam event kinds/blocks the executor cares about.
export const CAPY_EVENT_ASSISTANT = "assistant";
export const CAPY_EVENT_MESSAGE = "message";
export const CAPY_EVENT_ERROR = "error";
export const CAPY_TOOL_MESSAGE_USER = "message_user";
export const CAPY_MESSAGE_STATE_FINAL = "final";
