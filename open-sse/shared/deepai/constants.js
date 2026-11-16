/**
 * DeepAI Code (deepai.org) — desktop coding agent whose sign-in happens
 * in the app (Google/Apple). The app exchanges the login for a long-lived
 * account API key (UUID format) stored locally at
 * ~/.deepai-code/userdata/secrets/deepai-account.bin; inference calls
 * carry it in a custom `Api-Key` header (NOT Authorization) plus the
 * billing-lane header `X-DeepAI-Code-Theos: 2`. Verified live against
 * the production API on 2026-11-16 (models / theos / chat all 200 from
 * a plain script, no app process involved).
 */

export const DEEPAI_API_BASE = "https://api.deepai.org/deepai_code";
export const DEEPAI_CHAT_URL = `${DEEPAI_API_BASE}/chat/completions`;
export const DEEPAI_MODELS_URL = `${DEEPAI_API_BASE}/models`;
export const DEEPAI_THEOS_URL = `${DEEPAI_API_BASE}/theos`;

// Billing-lane protocol version the desktop client sends. The /theos
// ledger currently reports lane_version 6 server-side, but lane "2" is
// what the shipped client puts on the wire and what inference accepts.
export const DEEPAI_THEOS_LANE = "2";

export function buildDeepaiHeaders(apiKey) {
  return {
    Accept: "application/json",
    "Api-Key": apiKey,
    "X-DeepAI-Code-Theos": DEEPAI_THEOS_LANE,
  };
}
