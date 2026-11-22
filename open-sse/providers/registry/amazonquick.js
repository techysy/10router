// Amazon Quick (quick.aws.com) — AWS's agentic work assistant (the
// Q Business successor). There is no public chat API and no OAuth app
// registration for third parties: the web client's Chat operation is
// the only door, and it authenticates with the browser's same-domain
// cookie session (no Authorization header, no SigV4 — the qbsproxy
// signs server-side). A connection stores ONE paste: a whole
// "Copy as cURL" command from a logged-in tab, kept in the
// connection's credential field; cookie / awsAccountId / csrf are
// extracted from it at resolve time (shared/amazonquick/constants.js).
// The original three-field storage (cookie in the credential field,
// awsAccountId + csrf in providerSpecificData) still resolves for
// connections created before the single-paste form.
// Chat runs through qbsproxy's "quicksight" service segment and
// answers AWS EventStream frames — see shared/amazonquick/constants.js
// and executors/amazonquick.js. Live-verified 2026-11-21 by replaying
// the web client's own requests outside the browser (200, real agent
// answers). The session is not refreshable: when it expires, chat
// answers 401/403 and the user pastes a fresh Copy as cURL.
//
// Models are the three performanceMode tiers only (fast / smart /
// advanced — see services/amazonquickModels.js); the mode rides the
// request body, the upstream picks the actual model mix per tier.
export default {
  id: "amazonquick",
  priority: 36,
  alias: "aq",
  uiAlias: "aq",
  display: {
    name: "Amazon Quick",
    icon: "bolt",
    color: "#FF9900",
    textIcon: "AQ",
    website: "https://quick.aws.com",
    notice: {
      text: "Amazon Quick has no public API key: calls ride your logged-in quick.aws.com web session — just paste a Copy as cURL from your browser and the rest is extracted automatically. Usage draws on your Quick plan's monthly agent hours.",
      signupUrl: "https://quick.aws.com",
    },
  },
  category: "apikey",
  authModes: ["apikey"],
  authType: "cookie",
  hasProviderSpecificData: true,
  authHint: "① 先打开 quick.aws.com 登录，在聊天框随便发一句话；② 按 F12 点『网络』，找一条叫 ws-rpc 的请求，右键 → 复制 → Copy as cURL；③ 整段粘到上方框里保存就行。测试变红了，重复一遍即可。",
  transport: {
    // The executor composes the per-account qbsproxy chat URL from
    // providerSpecificData; baseUrl is only the site root.
    baseUrl: "https://quick.aws.com",
    headers: {},
    // Agent turns are slow (measured ~2 min for a first answer); the
    // connect/first-frame budget must not cut them off.
    timeoutMs: 300000,
    stallTimeoutMs: 300000,
  },
  models: [
    { id: "fast", name: "Fast" },
    { id: "smart", name: "Smart" },
    { id: "advanced", name: "Advanced" },
  ],
  features: {
    // TODO(usage): agent-hours usage (GetAvailableEntitlementUnitsExternal)
    // requires the account's userArn, which the cookie session does not
    // expose to the gateway — no usage card until a source for it exists.
    // Endpoint + response shape are recorded in shared/amazonquick/constants.js.
  },
};
