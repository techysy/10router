/**
 * Meoo （秒悟） control-plane client + project service AK resolver.
 *
 * Why this exists: Meoo's model gateway (api.meoo.host, OpenAI-compatible)
 * does NOT accept the OAuth access token. Chat calls must carry the
 * per-project "service AK" (meooProjectApiKey), which the control plane
 * (meoo.com /open/v1/cli-compat/*) hands out per project once cloud
 * services are enabled. This module is the single place that knows how to
 * turn an OAuth credential into that AK:
 *
 *   identity   GET  /open/v1/cli-compat/account/identity
 *   projects   GET  /open/v1/cli-compat/projects?page_size=50&view=created
 *   environment GET /open/v1/cli-compat/projects/{urlId}/cloud/environment
 *              → data.meooProjectApiKey (data.enabled === false = cloud off)
 *
 * Behaviour mirrored from the official CLI (@aliyun-meoo/cli 0.5.8):
 *   - control-plane requests carry X-Meoo-Client / X-Meoo-CLI-Version /
 *     X-Meoo-Request-Id headers and `Authorization: Bearer <access token>`
 *     (dist/lib/apiClient.js);
 *   - a 401 with errCode `invalid_token` triggers ONE refresh + retry
 *     (apiClient.js), and proactive refresh happens once the access token
 *     is within 60s of expiry (dist/lib/credentialProvider.js);
 *   - the CLI never auto-picks a project: a project must be bound
 *     (projectConfig.requireProject → NO_PROJECT_BOUND). A gateway has no
 *     per-directory binding, so resolveMeooProjectAk prefers the project
 *     stored on the connection and otherwise takes the first project in
 *     the list — the choice is persisted back into providerSpecificData
 *     by callers, which is the connection-level equivalent of the CLI's
 *     stored currentProject.
 */

import { randomUUID } from "crypto";

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  MEOO_API_BASE_URL,
  MEOO_CLI_COMPAT_VERSION,
  MEOO_IDENTITY_PATH,
  MEOO_PROJECTS_PATH,
  MEOO_REFRESH_EARLY_MS,
  resolveMeooCliClientId,
} from "../shared/meoo/constants.js";

const TOKEN_TIMEOUT_MS = 15_000; // CLI TOKEN_REQUEST_TIMEOUT_MS (oauth.js)
const CONTROL_TIMEOUT_MS = 30_000;

export class MeooApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "MeooApiError";
    this.status = status;
    this.code = code;
  }
}

function isInvalidTokenError(err) {
  return err instanceof MeooApiError && err.status === 401 && err.code === "invalid_token";
}

function controlHeaders(accessToken) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Meoo-Client": "cli",
    "X-Meoo-CLI-Version": MEOO_CLI_COMPAT_VERSION,
    "X-Meoo-Request-Id": `cli_req_${randomUUID()}`,
    Authorization: `Bearer ${accessToken}`,
  };
}

// The CLI's ApiClient treats a body without `success`/`errCode` as raw data,
// unwraps `{ success, data }` envelopes, and throws on `success === false`.
function unwrapEnvelope(body, status) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    if (body.success === false || body.errCode) {
      throw new MeooApiError(
        status,
        body.errCode || body.error?.code || `HTTP_${status}`,
        body.message || body.error?.message || `Meoo request failed (${status})`,
      );
    }
    if ("data" in body) return body.data;
    return body;
  }
  return body;
}

async function meooControlRequest(accessToken, path, { proxyOptions = null, signal = null } = {}) {
  const response = await proxyAwareFetch(
    `${MEOO_API_BASE_URL}${path}`,
    {
      method: "GET",
      headers: controlHeaders(accessToken),
      signal: signal || AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    },
    proxyOptions,
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body?.errCode || body?.code || body?.error?.code || body?.error || `HTTP_${response.status}`;
    const message = body?.message || body?.error?.message || body?.error_description || response.statusText;
    throw new MeooApiError(response.status, String(code), String(message || `Meoo request failed (${response.status})`));
  }
  return unwrapEnvelope(body, response.status);
}

/**
 * GET account/identity. The CLI reads `user.name || user.username`
 * (commands/account.js); the rest of the shape is parsed defensively.
 */
export async function fetchMeooIdentity(accessToken, options = {}) {
  const data = await meooControlRequest(accessToken, MEOO_IDENTITY_PATH, options);
  const user = data?.user && typeof data.user === "object" ? data.user : data || {};
  return {
    userId: user.id || user.user_id || user.userId || "",
    username: user.name || user.username || "",
    email: user.email || "",
    edition: user.edition || "",
    tenantId: user.tenant_id || user.tenantId || "",
  };
}

/**
 * GET projects list. Response envelope data = { list, total }; items carry
 * snake_case fields (url_id, name, status, type) — commands/projects/list.js
 * buildProjectListRequest + mapProjectListItem.
 */
export async function fetchMeooProjects(accessToken, options = {}) {
  const data = await meooControlRequest(
    accessToken,
    `${MEOO_PROJECTS_PATH}?page_size=50&view=created`,
    options,
  );
  const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : [];
  return list
    .filter((p) => p && (p.url_id || p.urlId))
    .map((p) => ({
      urlId: p.url_id || p.urlId,
      name: p.name || "",
      status: p.status || "",
      type: p.type || null,
    }));
}

/**
 * GET projects/{urlId}/cloud/environment. data.meooProjectApiKey is the
 * project service AK; data.enabled === false means cloud services are not
 * enabled for the project and no AK is issued (projectConfig.syncProjectEnv).
 */
export async function fetchMeooProjectEnvironment(accessToken, urlId, options = {}) {
  return meooControlRequest(
    accessToken,
    `${MEOO_PROJECTS_PATH}/${encodeURIComponent(urlId)}/cloud/environment`,
    options,
  );
}

/**
 * Resolve the project service AK for an access token.
 * Project choice: explicit projectUrlId → else first project in the list.
 * Throws MeooApiError with code MEOO_NO_PROJECT / MEOO_CLOUD_NOT_ENABLED /
 * MEOO_PROJECT_AK_MISSING for the states the CLI surfaces separately
 * (NO_PROJECT_BOUND; environment.enabled === false).
 */
export async function resolveMeooProjectAk(accessToken, { projectUrlId = "", proxyOptions = null, signal = null } = {}) {
  const options = { proxyOptions, signal };
  const projects = await fetchMeooProjects(accessToken, options);
  if (projects.length === 0) {
    throw new MeooApiError(0, "MEOO_NO_PROJECT", "Meoo account has no project; create one in Meoo first, then re-resolve the project AK");
  }
  const project = (projectUrlId && projects.find((p) => p.urlId === projectUrlId)) || projects[0];
  const environment = await fetchMeooProjectEnvironment(accessToken, project.urlId, options);
  if (environment?.enabled === false) {
    throw new MeooApiError(0, "MEOO_CLOUD_NOT_ENABLED", `Meoo project ${project.urlId} has cloud services disabled; enable cloud services for the project, then re-resolve the project AK`);
  }
  const projectApiKey = environment?.meooProjectApiKey;
  if (typeof projectApiKey !== "string" || !projectApiKey) {
    throw new MeooApiError(0, "MEOO_PROJECT_AK_MISSING", `Meoo project ${project.urlId} environment returned no meooProjectApiKey`);
  }
  return {
    projectApiKey,
    projectUrlId: project.urlId,
    projectName: project.name || "",
  };
}

/**
 * POST /oauth/token (form-encoded), shared by the authorization-code and
 * refresh_token grants — oauth.js exchangeAuthorizationCode /
 * refreshOAuthToken / requestToken. The CLI validates the full response
 * shape (access_token, refresh_token, token_type "Bearer", expires_in > 0,
 * scope, openid, tenant_id); we hard-require the token trio and pass the
 * identity fields through when present.
 */
async function requestMeooToken(params, { apiBaseUrl = MEOO_API_BASE_URL, proxyOptions = null } = {}) {
  const response = await proxyAwareFetch(
    `${apiBaseUrl}/oauth/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: resolveMeooCliClientId(apiBaseUrl),
        ...params,
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    },
    proxyOptions,
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new MeooApiError(
      response.status,
      String(body?.error || `HTTP_${response.status}`),
      String(body?.error_description || response.statusText || "Meoo OAuth request failed"),
    );
  }
  if (
    typeof body?.access_token !== "string" ||
    typeof body?.refresh_token !== "string" ||
    !Number.isFinite(Number(body?.expires_in)) ||
    Number(body?.expires_in) <= 0
  ) {
    throw new MeooApiError(response.status, "invalid_token_response", "Meoo OAuth token response is missing required fields");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: Number(body.expires_in),
    scope: typeof body.scope === "string" ? body.scope : "",
    openid: typeof body.openid === "string" ? body.openid : "",
    tenantId: typeof body.tenant_id === "string" ? body.tenant_id : "",
  };
}

export async function exchangeMeooAuthorizationCode({ code, redirectUri, codeVerifier, apiBaseUrl = MEOO_API_BASE_URL, proxyOptions = null }) {
  return requestMeooToken(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    },
    { apiBaseUrl, proxyOptions },
  );
}

export async function refreshMeooOAuthTokens(refreshToken, { apiBaseUrl = MEOO_API_BASE_URL, proxyOptions = null } = {}) {
  return requestMeooToken(
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    { apiBaseUrl, proxyOptions },
  );
}

function parseTimeMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Full credential resolution for a stored Meoo connection: refresh the
 * OAuth token when it is expired / inside the CLI's 60s early-refresh
 * window (or when the control plane rejects it with invalid_token), then
 * (re-)resolve the project service AK.
 *
 * Returns the mergeRefreshedCredentials-compatible shape:
 *   { accessToken?, refreshToken?, expiresIn?, apiKey,
 *     providerSpecificData: { projectUrlId, projectName, projectApiKey,
 *                             akResolvedAt, akStatus, openid?, tenantId? } }
 * Token fields are present only when a refresh actually happened.
 */
export async function resolveMeooCredentials(credentials, { proxyOptions = null, log = null, forceRefresh = false } = {}) {
  if (!credentials?.refreshToken && !credentials?.accessToken) {
    throw new MeooApiError(0, "MEOO_NO_CREDENTIALS", "Meoo connection has no OAuth tokens");
  }
  const psd = credentials.providerSpecificData || {};
  let accessToken = credentials.accessToken || "";
  let tokenPart = null;

  const expiresAtMs = parseTimeMs(credentials.expiresAt);
  const tokenFresh = !!accessToken && expiresAtMs !== null && expiresAtMs - Date.now() > MEOO_REFRESH_EARLY_MS;
  if (credentials.refreshToken && (forceRefresh || !tokenFresh)) {
    tokenPart = await refreshMeooOAuthTokens(credentials.refreshToken, { proxyOptions });
    accessToken = tokenPart.accessToken;
  }

  let ak;
  try {
    ak = await resolveMeooProjectAk(accessToken, { projectUrlId: psd.projectUrlId || "", proxyOptions });
  } catch (err) {
    // apiClient.js: one forced refresh + retry on 401 invalid_token when
    // the token we used was not just refreshed.
    if (!tokenPart && credentials.refreshToken && isInvalidTokenError(err)) {
      log?.warn?.("MEOO", "Control plane rejected access token (invalid_token); refreshing once and retrying AK resolution");
      tokenPart = await refreshMeooOAuthTokens(credentials.refreshToken, { proxyOptions });
      accessToken = tokenPart.accessToken;
      try {
        ak = await resolveMeooProjectAk(accessToken, { projectUrlId: psd.projectUrlId || "", proxyOptions });
      } catch (retryErr) {
        if (tokenPart) retryErr.refreshed = tokenPart;
        throw retryErr;
      }
    } else {
      // If the token leg already rotated the pair, surface it on the error
      // so callers can persist the new tokens even though AK resolution
      // failed — losing a rotated refresh token would kill the connection.
      if (tokenPart) err.refreshed = tokenPart;
      throw err;
    }
  }

  return {
    ...(tokenPart || {}),
    apiKey: ak.projectApiKey,
    providerSpecificData: {
      projectUrlId: ak.projectUrlId,
      projectName: ak.projectName,
      projectApiKey: ak.projectApiKey,
      akResolvedAt: new Date().toISOString(),
      akStatus: "ok",
      ...(tokenPart?.openid ? { openid: tokenPart.openid } : {}),
      ...(tokenPart?.tenantId ? { tenantId: tokenPart.tenantId } : {}),
    },
  };
}
