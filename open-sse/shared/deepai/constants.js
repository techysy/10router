/**
 * DeepAI Code (deepai.org) — desktop coding agent whose sign-in happens
 * in the app (Google/Apple). The app exchanges the login for a long-lived
 * account API key (UUID format). No desktop app is required: the key
 * is issued through the same browser sign-in the app uses
 * (GET /deepai_code/desktop_auth/?state=<32 hex>&port=<loopback port>,
 * then POST /deepai_code/desktop_auth/exchange/ {code}); a signed-in
 * app stores it at ~/.deepai-code/userdata/secrets/deepai-account.bin.
 * Inference calls carry it in a custom `Api-Key` header (NOT
 * Authorization) plus the billing-lane header `X-DeepAI-Code-Theos`.
 * Verified live against the production API on 2026-11-16 (models /
 * theos / chat all 200 from a plain script, no app process involved).
 */

export const DEEPAI_API_BASE = "https://api.deepai.org/deepai_code";
export const DEEPAI_CHAT_URL = `${DEEPAI_API_BASE}/chat/completions`;
export const DEEPAI_MODELS_URL = `${DEEPAI_API_BASE}/models`;
export const DEEPAI_THEOS_URL = `${DEEPAI_API_BASE}/theos`;

// Billing-lane protocol version. The desktop client moved to "4" on
// 2026-11-07; lanes "2", "4" and "6" were all verified accepted on
// 2026-11-16 (an outdated lane is rejected with 426). We track the
// desktop's current value.
export const DEEPAI_THEOS_LANE = "4";

// Upstream rejects the Node/fetch default UA on /chat/completions
// (400), so every call carries an explicit, identifiable UA.
export const DEEPAI_USER_AGENT = "10router-deepai/1.0";

export function buildDeepaiHeaders(apiKey) {
  return {
    Accept: "application/json",
    "User-Agent": DEEPAI_USER_AGENT,
    "Api-Key": apiKey,
    "X-DeepAI-Code-Theos": DEEPAI_THEOS_LANE,
  };
}
