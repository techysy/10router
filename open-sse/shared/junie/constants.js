// Junie (JetBrains) free lane — wire constants, single source of truth.
//
// The free tier is Junie Lite: one model slot whose backend JetBrains
// swaps at will (officially GPT-6 Luna per the 2026-11-21 Lite docs; the
// CLI's own logs show this account actually ran Qwen/Qwen3.6-27B-FP8).
// The lane was reverse-engineered from the official CLI binary
// (IngrazzioLicenseHeadersKt.applyIngrazzioHeaders) and live-verified
// 2026-11-23 from Tokyo with a free JetBrains account:
//
//   POST https://ingrazzio-cloud-prod.labs.jb.gg/llm/vllm/v1/chat/completions
//   Authorization: Bearer <JBA **id_token**>   (NOT the access_token)
//   X-Forced-License-Free: true                (the decisive header)
//   X-Accept-EAP-License: false
//   X-Accept-Release-License: false
//
// Streaming requests must carry stream_options.include_usage=true or
// the lane answers 400. There is no /models endpoint on the lane — the
// model list is static (registry/junie.js).
//
// Auth is JBA OAuth 2.0 authorization-code + PKCE (public client
// "junie-cli", the CLI's own): the user approves on
// junie.jetbrains.com/cli-auth and the browser redirects to the
// registered http://localhost:62345, which nothing serves — the user
// pastes the full redirect URL back into the dashboard (paste-callback,
// same shape as croli). Refresh tokens are SINGLE-USE and rotating:
// every refresh response's new refresh_token must be persisted, and the
// gateway must be the only refresher for a connection.

export const JUNIE_CHAT_URL =
  "https://ingrazzio-cloud-prod.labs.jb.gg/llm/vllm/v1/chat/completions";
export const JUNIE_AUTH_TEST_URL =
  "https://ingrazzio-cloud-prod.labs.jb.gg/auth/test";

export const JUNIE_TOKEN_URL = "https://oauth.account.jetbrains.com/oauth2/token";
export const JUNIE_AUTHORIZE_URL = "https://junie.jetbrains.com/cli-auth";
export const JUNIE_CLIENT_ID = "junie-cli";
export const JUNIE_SCOPE = "offline_access openid jb-authn-service";
export const JUNIE_REDIRECT_URI = "http://localhost:62345";

// User-facing model key (registry models list). The executor maps it to
// the upstream string below — if JetBrains swaps the Lite backend, this
// one constant is the only place that changes.
export const JUNIE_MODEL_ID = "junie-lite";
export const JUNIE_UPSTREAM_MODEL = "Qwen/Qwen3.6-27B-FP8";

// The three license headers the CLI sends for a Free license, verbatim.
export const JUNIE_FREE_HEADERS = {
  "X-Forced-License-Free": "true",
  "X-Accept-EAP-License": "false",
  "X-Accept-Release-License": "false",
};

export function resolveJunieUpstreamModel(model) {
  // Single-model lane: every user-facing key lands on the Lite backend.
  return JUNIE_UPSTREAM_MODEL;
}
