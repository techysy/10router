/**
 * Meoo （秒悟） constants — ported from the official CLI (@aliyun-meoo/cli
 * 0.5.8, dist/lib/oauth.js + config.js), cross-checked 2026-11-13.
 *
 * Endpoint set:
 *   meoo.com          - control plane: OAuth (/oauth/*) + cli-compat API
 *                       (/open/v1/cli-compat/*), DEFAULT_API_BASE_URL in the
 *                       CLI's config.js.
 *   api.meoo.host     - model gateway (OpenAI-compatible), NOT part of the
 *                       CLI's control-plane traffic: the CLI hands the
 *                       project service AK to local apps, which then call
 *                       this gateway directly.
 *
 * The OAuth client is a PUBLIC client (no secret): the CLI ships both ids
 * in plaintext and picks one by API hostname (resolveMeooCliClientId).
 * Production is used only for exact production hostnames; anything else
 * (pre-release, localhost) gets the test client.
 */

export const MEOO_API_BASE_URL = "https://meoo.com";
export const MEOO_GATEWAY_BASE_URL = "https://api.meoo.host/meoo-ai/compatible-mode/v1";
export const MEOO_GATEWAY_MODELS_URL = `${MEOO_GATEWAY_BASE_URL}/models`;
export const MEOO_GATEWAY_CHAT_URL = `${MEOO_GATEWAY_BASE_URL}/chat/completions`;

export const MEOO_CLI_PRODUCTION_CLIENT_ID = "meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh";
export const MEOO_CLI_TEST_CLIENT_ID = "meoo_app_SFNvmHUFNePxyyfGjCd9hyaE";

// oauth.js MEOO_CLI_SCOPES — the only scope the CLI requests.
export const MEOO_CLI_SCOPES = ["cli.compat"];
export const MEOO_OAUTH_SCOPE = MEOO_CLI_SCOPES.join(" ");

const MEOO_PRODUCTION_HOSTNAMES = new Set(["meoo.com", "gray-meoo.aliyun-inc.com"]);

/**
 * Mirror of the CLI's resolveMeooCliClientId(apiBaseUrl): production client
 * only when the API base hostname is an exact production hostname.
 */
export function resolveMeooCliClientId(apiBaseUrl = MEOO_API_BASE_URL) {
  let hostname = "";
  try {
    hostname = new URL(apiBaseUrl).hostname.toLowerCase();
  } catch {
    hostname = "";
  }
  return MEOO_PRODUCTION_HOSTNAMES.has(hostname)
    ? MEOO_CLI_PRODUCTION_CLIENT_ID
    : MEOO_CLI_TEST_CLIENT_ID;
}

export const MEOO_AUTHORIZE_URL = `${MEOO_API_BASE_URL}/oauth/authorize`;
export const MEOO_TOKEN_URL = `${MEOO_API_BASE_URL}/oauth/token`;
export const MEOO_REVOKE_URL = `${MEOO_API_BASE_URL}/oauth/revoke`;

// cli-compat control-plane paths (apiClient.js / projectConfig.js /
// commands/projects/list.js in the CLI).
export const MEOO_IDENTITY_PATH = "/open/v1/cli-compat/account/identity";
export const MEOO_POINTS_PATH = "/open/v1/cli-compat/account/points";
export const MEOO_PROJECTS_PATH = "/open/v1/cli-compat/projects";

// The cli-compat endpoints expect the CLI's client headers (apiClient.js
// sends X-Meoo-Client: cli + its own package version on every request).
// 0.5.8 is the CLI version this integration was built against.
export const MEOO_CLI_COMPAT_VERSION = "0.5.8";

// credentialProvider.js REFRESH_EARLY_MS — the CLI refreshes its access
// token once it is within 60s of expiry.
export const MEOO_REFRESH_EARLY_MS = 60_000;
