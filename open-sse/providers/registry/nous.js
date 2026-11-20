// Nous Portal (portal.nousresearch.com) — Nous Research's model API,
// built into Hermes Agent as the `nous` provider. Sign-in is the OAuth
// 2.0 Device Authorization Grant (RFC 8628) exactly as shipped in the
// open-source Hermes client (hermes_cli/auth_nous.py +
// auth_device_flow.py): public client_id "hermes-cli", scope
// "inference:invoke", no secret, no PKCE, no redirect. The access token
// (JWT) is itself the inference credential on the OpenAI-compatible
// https://inference-api.nousresearch.com/v1.
//
// Free models (ids ending in ":free") are served by the API with NO
// credit card on the account: the card/plan gate lives only in client
// pickers (Hermes greys out paid models for free accounts client-side;
// its model_aliases bypass the catalog by design). This entry therefore
// hardcodes the current ":free" roster in the static model list — the
// gateway equivalent of that alias trick — so a free account sees and
// can call them even if a live catalog response ever filters them out.
// Paid models on a free account fail upstream with 403
// subscription_required, which is the portal's plan entitlement, not a
// gateway error.
//
// Refresh tokens are SINGLE-USE and rotating, and the refresh call is
// non-standard: the refresh token travels in the `x-nous-refresh-token`
// header (see services/tokenRefresh refreshNousToken). Replaying an old
// refresh token revokes the whole session, so the gateway must be the
// only refresher for a connection — do not sign the same Portal account
// into Hermes CLI at the same time.
export default {
  id: "nous",
  priority: 34,
  alias: "nous",
  uiAlias: "nous",
  display: {
    name: "Nous Portal",
    icon: "auto_awesome",
    color: "#0F766E",
    textIcon: "NP",
    website: "https://portal.nousresearch.com",
    notice: {
      text: "Sign in with your own Nous Portal account via device code (the same public Hermes client). Free models like qwen/qwen4-max:free work with no credit card; each user signs in with their own account.",
      signupUrl: "https://portal.nousresearch.com",
      apiKeyUrl: "https://portal.nousresearch.com",
    },
  },
  category: "freeTier",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint: "Nous Portal API key — create one in the Portal dashboard; or use OAuth device-code sign-in (recommended, no card needed for free models)",
  transport: {
    baseUrl: "https://inference-api.nousresearch.com/v1/chat/completions",
    validateUrl: "https://inference-api.nousresearch.com/v1/models",
    headers: {},
    timeoutMs: 120000,
  },
  // Live catalog: GET /v1/models with the connection's access token.
  // The static list below (notably the ":free" roster) stays as the
  // always-available baseline regardless of catalog filtering.
  modelsFetcher: { url: "https://inference-api.nousresearch.com/v1/models", type: "openai" },
  passthroughModels: true,
  models: [
    { id: "qwen/qwen4-max:free", name: "Qwen4 Max (Free)" },
    { id: "meituan/longcat-2.5:free", name: "LongCat 2.5 (Free)" },
    { id: "stepfun/step-3.7-flash:free", name: "Step 3.7 Flash (Free)" },
    { id: "tencent/hy4-flash:free", name: "HY4 Flash (Free)" },
    { id: "upstage/solar-mini4:free", name: "Solar Mini 4 (Free)" },
    { id: "qwen/qwen4-max", name: "Qwen4 Max" },
  ],
  oauth: {
    // Public OAuth client shipped inside the open-source Hermes Agent
    // (hermes_cli/auth_constants.py / PROVIDER_REGISTRY["nous"]):
    // device grant, no secret, no PKCE, no redirect URI to register.
    clientId: "hermes-cli",
    deviceCodeUrl: "https://portal.nousresearch.com/api/oauth/device/code",
    tokenUrl: "https://portal.nousresearch.com/api/oauth/token",
    refreshUrl: "https://portal.nousresearch.com/api/oauth/token",
    scope: "inference:invoke",
    refreshLeadMs: 5 * 60 * 1000,
  },
};
