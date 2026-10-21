// Raccoon (小浣熊 / xiaohuanxiong.com) upstream constants.
//
// One origin serves three independent API surfaces; keeping them here (instead
// of re-typing the host in the registry, the usage handler, the check-in
// adapter and the token refresher) is what keeps them from drifting apart:
//
//   LLM     /api/web/llm/v2/chat/completions   OpenAI-compatible chat (Bearer JWT)
//   points  /api/web/points/v1/{balance,bills} wallet balances + ledger
//   auth    /api/web/auth/v1/{refresh,entitlement_info}
//   office  /api/web/office/v3/setting_info    desktop startup probe = daily grant trigger
//
// `RACCOON_LLM_BASE_URL` mirrors our Rust provider's DEFAULT_LLM_BASE_URL
// (agent2api …/providers/raccoon/mod.rs). The web client calls the same origin
// for all surfaces; the model port is NOT `api.xiaohuanxiong.com`.

export const RACCOON_ORIGIN = "https://xiaohuanxiong.com";

export const RACCOON_LLM_BASE_URL = `${RACCOON_ORIGIN}/api/web/llm/v2`;
export const RACCOON_CHAT_COMPLETIONS_URL = `${RACCOON_LLM_BASE_URL}/chat/completions`;

export const RACCOON_POINTS_BASE_URL = `${RACCOON_ORIGIN}/api/web/points/v1`;
export const RACCOON_BALANCE_URL = `${RACCOON_POINTS_BASE_URL}/balance`;

// The bills endpoint is slow (observed ~9s for limit=20), so the check-in
// adapter uses the longer RACCOON_BILLS_TIMEOUT_MS for it.
export const RACCOON_GRANT_CHECK_LIMIT = 20;
export const RACCOON_BILLS_URL =
  `${RACCOON_POINTS_BASE_URL}/bills?paging.limit=${RACCOON_GRANT_CHECK_LIMIT}&paging.offset=0`;

export const RACCOON_AUTH_API_BASE = `${RACCOON_ORIGIN}/api/web/auth/v1`;
export const RACCOON_ENTITLEMENT_URL = `${RACCOON_AUTH_API_BASE}/entitlement_info`;
// Rotating refresh endpoint: POST {"refresh_token": "..."} ->
// data.access_token + data.refresh_token (Rust raccoon/credentials.rs).
export const RACCOON_REFRESH_URL = `${RACCOON_AUTH_API_BASE}/refresh`;

export const RACCOON_OFFICE_API_BASE = `${RACCOON_ORIGIN}/api/web/office/v3`;
// GET here is the daily-points grant trigger (idempotent per day; the official
// desktop client probes it at startup). The response's point_grant_popups /
// point_grant_toast are notifications, not the authoritative amount.
export const RACCOON_SETTING_INFO_URL = `${RACCOON_OFFICE_API_BASE}/setting_info`;

// Upstream identity headers the desktop client sends on the grant trigger.
// Without them the server treats the request as a plain web read and does not
// run the desktop-login grant path.
export const RACCOON_DESKTOP_HEADERS = Object.freeze({
  "X-Client-Platform": "desktop-windows",
  "X-Client-Version": "v1.0.0",
  "X-Raccoon-Language": "zh",
});

export const RACCOON_UNIT = "积分";

// Wallet order is the desktop client's display order (Rust balance.rs
// WALLET_LABELS) and must stay stable: the usage card renders rows in this order.
export const RACCOON_WALLETS = Object.freeze([
  { key: "daily_points", label: "每日积分" },
  { key: "monthly_points", label: "每月会员积分" },
  { key: "reward_points", label: "奖励积分" },
  { key: "topup_points", label: "充值积分" },
]);

// Frozen top-up points are NOT spendable and are not part of available_points;
// they get their own row so "充值积分" does not appear to under-report.
export const RACCOON_TOPUP_FROZEN = Object.freeze({
  key: "topup_frozen",
  label: "充值积分（冻结）",
});

// Balance / entitlement calls are short reads; the Rust provider uses 20s.
export const RACCOON_REQUEST_TIMEOUT_MS = 20_000;
export const RACCOON_BILLS_TIMEOUT_MS = 25_000;

// Access tokens live ~2h (refresh tokens rotate on every refresh and live
// ~30d). The JWT exp claim wins when present; this is only the fallback for a
// refresh response that omits both exp and expires_in.
export const RACCOON_ACCESS_TOKEN_TTL_SEC = 2 * 60 * 60;

// Upstream natural day is UTC+8 (Rust core::beijing). Computing "today" in the
// machine timezone would mis-classify the last 8 hours of every day on
// non-China deployments.
export const RACCOON_BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
