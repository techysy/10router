// Re-export from open-sse with local logger
import * as log from "../utils/logger.js";
import { getProviderConnectionById, updateProviderConnection } from "../../lib/localDb.js";
import {
  getProjectIdForConnection,
  invalidateProjectId,
  removeConnection,
} from "open-sse/services/projectId.js";
import {
  TOKEN_EXPIRY_BUFFER_MS as BUFFER_MS,
  refreshAccessToken as _refreshAccessToken,
  refreshClaudeOAuthToken as _refreshClaudeOAuthToken,
  refreshGoogleToken as _refreshGoogleToken,
  refreshCodexToken as _refreshCodexToken,
  refreshIflowToken as _refreshIflowToken,
  refreshGitHubToken as _refreshGitHubToken,
  refreshCopilotToken as _refreshCopilotToken,
  getAccessToken as _getAccessToken,
  refreshTokenByProvider as _refreshTokenByProvider,
  formatProviderCredentials as _formatProviderCredentials,
  getAllAccessTokens as _getAllAccessTokens,
  refreshKiroToken as _refreshKiroToken,
  getRefreshLeadMs as _getRefreshLeadMs
} from "open-sse/services/tokenRefresh.js";
import {
  refreshProviderCredentials as _refreshProviderCredentials,
  shouldRefreshCredentials as _shouldRefreshCredentials,
} from "open-sse/services/oauthCredentialManager.js";

export const TOKEN_EXPIRY_BUFFER_MS = BUFFER_MS;

// ─── Re-exports wrapped with local logger ─────────────────────────────────────

export const refreshAccessToken = (provider, refreshToken, credentials) =>
  _refreshAccessToken(provider, refreshToken, credentials, log);

export const refreshClaudeOAuthToken = (refreshToken) =>
  _refreshClaudeOAuthToken(refreshToken, log);

export const refreshGoogleToken = (refreshToken, clientId, clientSecret) =>
  _refreshGoogleToken(refreshToken, clientId, clientSecret, log);

export const refreshCodexToken = (refreshToken) =>
  _refreshCodexToken(refreshToken, log);

export const refreshIflowToken = (refreshToken) =>
  _refreshIflowToken(refreshToken, log);

export const refreshGitHubToken = (refreshToken) =>
  _refreshGitHubToken(refreshToken, log);

export const refreshCopilotToken = (githubAccessToken) =>
  _refreshCopilotToken(githubAccessToken, log);

export const refreshKiroToken = (refreshToken, providerSpecificData) =>
  _refreshKiroToken(refreshToken, providerSpecificData, log);

export const getAccessToken = (provider, credentials) =>
  _getAccessToken(provider, credentials, log);

export const refreshTokenByProvider = (provider, credentials) =>
  _refreshTokenByProvider(provider, credentials, log);

export const formatProviderCredentials = (provider, credentials) =>
  _formatProviderCredentials(provider, credentials, log);

export const getAllAccessTokens = (userInfo) =>
  _getAllAccessTokens(userInfo, log);

export const shouldRefreshCredentials = (provider, credentials) =>
  _shouldRefreshCredentials(provider, credentials);

// ─── Lifecycle hook ───────────────────────────────────────────────────────────

/**
 * Call this when a connection is fully closed / removed.
 * Aborts any in-flight projectId fetch and evicts its cache entry,
 * preventing the module-level Maps from accumulating stale entries.
 *
 * @param {string} connectionId
 */
export function releaseConnection(connectionId) {
  if (!connectionId) return;
  removeConnection(connectionId);
  log.debug("TOKEN_REFRESH", "Released connection resources", { connectionId });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute an ISO expiry timestamp from a relative expiresIn (seconds).
 * @param {number} expiresIn
 * @returns {string}
 */
function toExpiresAt(expiresIn) {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Providers that carry a real Google project ID.
 * @param {string} provider
 * @returns {boolean}
 */
function needsProjectId(provider) {
  return provider === "antigravity" || provider === "gemini-cli";
}

/**
 * Non-blocking: fetch the project ID for a connection after a token refresh and
 * persist it to localDb.  Invalidates the stale cached value first so the fetch
 * always retrieves a fresh one.
 *
 * @param {string} provider
 * @param {string} connectionId
 * @param {string} accessToken
 */
function _refreshProjectId(provider, connectionId, accessToken) {
  if (!needsProjectId(provider) || !connectionId || !accessToken) return;

  // Evict the stale cached entry so getProjectIdForConnection does a real fetch
  invalidateProjectId(connectionId);

  getProjectIdForConnection(connectionId, accessToken)
    .then((projectId) => {
      if (!projectId) return;
      updateProviderCredentials(connectionId, { projectId }).catch((err) => {
        log.debug("TOKEN_REFRESH", "Failed to persist refreshed projectId", {
          connectionId,
          error: err?.message ?? err,
        });
      });
    })
    .catch((err) => {
      log.debug("TOKEN_REFRESH", "Failed to fetch projectId after token refresh", {
        connectionId,
        error: err?.message ?? err,
      });
    });
}

// ─── Local-specific: persist credentials to localDb ──────────────────────────

/**
 * Persist updated credentials for a connection to localDb.
 * Only fields that are present in `newCredentials` are written.
 *
 * @param {string} connectionId
 * @param {object} newCredentials
 * @returns {Promise<boolean>}
 */
export async function updateProviderCredentials(connectionId, newCredentials) {
  try {
    const updates = {};

    if (newCredentials.accessToken)         updates.accessToken  = newCredentials.accessToken;
    if (newCredentials.refreshToken)        updates.refreshToken = newCredentials.refreshToken;
    if (newCredentials.idToken)             updates.idToken = newCredentials.idToken;
    if (newCredentials.lastRefreshAt)       updates.lastRefreshAt = newCredentials.lastRefreshAt;
    if (newCredentials.expiresAt)           updates.expiresAt = newCredentials.expiresAt;
    if (newCredentials.expiresIn) {
      updates.expiresAt = toExpiresAt(newCredentials.expiresIn);
      updates.expiresIn = newCredentials.expiresIn;
    } else if (newCredentials.expiresAt) {
      const expiresAt = normalizeExpiresAt(newCredentials.expiresAt);
      if (expiresAt) {
        updates.expiresAt = expiresAt;
        updates.expiresIn = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      }
    }
    if (newCredentials.providerSpecificData) {
      updates.providerSpecificData = {
        ...(newCredentials.existingProviderSpecificData || {}),
        ...newCredentials.providerSpecificData,
      };
    }
    if (newCredentials.copilotToken || newCredentials.copilotTokenExpiresAt) {
      updates.providerSpecificData = {
        ...(updates.providerSpecificData || newCredentials.existingProviderSpecificData || {}),
        ...(newCredentials.copilotToken ? { copilotToken: newCredentials.copilotToken } : {}),
        ...(newCredentials.copilotTokenExpiresAt ? { copilotTokenExpiresAt: newCredentials.copilotTokenExpiresAt } : {}),
      };
    }
    if (newCredentials.projectId)            updates.projectId = newCredentials.projectId;
    // Every request-path caller passes testStatus: "active" after a refresh —
    // it meant "this channel is serving again", and until now it was silently
    // dropped here. connectionsRepo only auto-clears an "unavailable" status, so
    // any other stuck value stayed stuck.
    if (newCredentials.testStatus !== undefined) updates.testStatus = newCredentials.testStatus;

    const result = await updateProviderConnection(connectionId, updates);
    log.info("TOKEN_REFRESH", "Credentials updated in localDb", {
      connectionId,
      success: !!result
    });
    return !!result;
  } catch (error) {
    log.error("TOKEN_REFRESH", "Error updating credentials in localDb", {
      connectionId,
      error: error.message,
    });
    return false;
  }
}

/**
 * Persist credentials handed back by a refresh on the request path (the
 * `onCredentialsRefreshed` callback shared by the chat / embeddings / fetch /
 * image / search / video handlers).
 *
 * Two reasons this lives here instead of being inlined at each call site:
 *
 *  1. The inlined copies disagreed. Some spread the whole payload, some passed
 *     only { accessToken, refreshToken, providerSpecificData } — silently
 *     dropping `lastRefreshAt` / `expiresAt` / `idToken` / `projectId`.
 *     `lastRefreshAt` is the key the "DB is newer" adoption guard in
 *     checkAndRefreshToken compares on, so those handlers could not benefit
 *     from it at all.
 *  2. A lost write is not always harmless. OpenAI-class providers rotate the
 *     refresh token on every refresh; if the rotated token never reaches the
 *     DB the next request sends a consumed token and upstream revokes the
 *     whole session. Detect that case and fail loudly instead of returning
 *     credentials only this process can see.
 *
 * The rotation check reads the DB only on the failure path, so the happy path
 * pays nothing. `updateProviderCredentials` never throws (returns false).
 *
 * @param {string} connectionId
 * @param {object} newCreds - fields returned by the refresh
 * @param {object} [options]
 * @param {object} [options.providerSpecificData] - existing providerSpecificData to merge under
 * @param {string} [options.provider] - for the log line
 * @param {object} [options.log]
 * @param {string} [options.previousRefreshToken] - pre-refresh value, to skip the failure-path DB read
 * @returns {Promise<boolean>} whether the write landed
 */
/**
 * Raised when refreshed credentials could not be written to the DB AND the
 * refresh token was rotated, which leaves the stored token already consumed.
 * Callers must not swallow this and carry on: the connection is unusable until
 * it is re-authorized, and continuing serves one request while guaranteeing the
 * next one revokes the session. chatCore's blanket `catch` on the refresh path
 * looks for `persistFailed` and lets this one out.
 */
export class CredentialPersistError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialPersistError";
    this.persistFailed = true;
  }
}

export async function persistRefreshedCredentials(connectionId, newCreds, options = {}) {
  const logger = options.log || log;
  const { providerSpecificData, provider, previousRefreshToken } = options;
  const persisted = await updateProviderCredentials(connectionId, {
    ...newCreds,
    existingProviderSpecificData: providerSpecificData,
    testStatus: "active",
  });
  if (persisted) return true;

  // DB unchanged after a failed write — compare against what the next request
  // would read. A provider that hands back the same refresh token did not
  // rotate, so the stored one is still good and losing the write only costs a
  // redundant refresh later. A different one means the stored token is already
  // consumed upstream.
  const beforeToken =
    previousRefreshToken !== undefined
      ? previousRefreshToken
      : (await getProviderConnectionById(connectionId).catch(() => null))?.refreshToken;
  const rotated = !!newCreds?.refreshToken && (!beforeToken || beforeToken !== newCreds.refreshToken);

  if (rotated) {
    logger.error("TOKEN_REFRESH", "Rotated refresh token could not be persisted — refusing to continue", {
      connectionId,
      provider,
    });
    throw new CredentialPersistError(
      `${provider || "provider"}: refresh token was rotated but could not be saved; re-authorize the connection`
    );
  }
  logger.warn("TOKEN_REFRESH", "Refreshed credentials could not be persisted; continuing on in-memory copy", {
    connectionId,
    provider,
  });
  return false;
}

// ─── Local-specific: proactive token refresh ─────────────────────────────────

/**
 * Check whether the provider token (and, for GitHub, the Copilot token) is
 * about to expire and refresh it proactively.
 *
 * @param {string} provider
 * @param {object} credentials
 * @param {{ force?: boolean }} [options]  force=true skips the on-request lead check
 *   (used by background scheduler which applies a larger lead). Request path omits this.
 * @returns {Promise<object>} updated credentials object
 */
export async function checkAndRefreshToken(provider, credentials, options = {}) {
  let creds = { ...credentials };
  if (!creds.connectionId && creds.id) {
    creds.connectionId = creds.id;
  }

  // 采纳 DB 里更新的凭据：OpenAI 每次刷新都会轮换 refresh token，另一进程（usage
  // 轮询、auto-ping、后台刷新器）可能刚刷过。拿内存里的旧快照再刷属于"复用"，会
  // 吊销整个 session（账号被登出——上游 0bc7f86e）。DB 较新时直接采纳，不再刷新。
  if (creds.connectionId) {
    const latest = await getProviderConnectionById(creds.connectionId).catch(() => null);
    const latestRefreshMs = Date.parse(latest?.lastRefreshAt || "");
    const credsRefreshMs = Date.parse(creds.lastRefreshAt || "");
    const dbIsNewer = Number.isFinite(latestRefreshMs)
      && (!Number.isFinite(credsRefreshMs) || latestRefreshMs > credsRefreshMs);
    if (dbIsNewer && latest.refreshToken && latest.refreshToken !== creds.refreshToken) {
      creds = {
        ...creds,
        refreshToken: latest.refreshToken,
        accessToken: latest.accessToken || creds.accessToken,
        expiresAt: latest.expiresAt || latest.tokenExpiresAt || creds.expiresAt,
        lastRefreshAt: latest.lastRefreshAt || creds.lastRefreshAt,
      };
    }
  }

  const force = options?.force === true;

  // ── 1. Regular access-token expiry ────────────────────────────────────────
  if (force || _shouldRefreshCredentials(provider, creds)) {
    const expiresAt = creds.expiresAt ? new Date(creds.expiresAt).getTime() : null;
    const remaining = expiresAt ? expiresAt - Date.now() : null;
    const refreshLead = _getRefreshLeadMs(provider);

    log.info("TOKEN_REFRESH", "Refreshing provider credentials proactively", {
      provider,
      expiresIn: remaining === null ? null : Math.round(remaining / 1000),
      refreshLeadMs: refreshLead,
      lastRefreshAt: creds.lastRefreshAt || null,
    });

    const newCreds = await _refreshProviderCredentials(provider, creds, log);
    if (newCreds?.accessToken || newCreds?.apiKey || newCreds?.copilotToken) {
      // Persist to DB. Losing this write is not always harmless: OpenAI-class
      // providers rotate the refresh token on every refresh, so the previous one
      // is consumed the moment upstream accepts it. If the rotated token never
      // reaches the DB, the next request reads the consumed one, sends it, and
      // upstream revokes the whole session — the "DB is newer" adoption above
      // cannot recover this, because a lost write leaves the DB *older*, and
      // that guard only adopts when the DB is newer. persistRefreshedCredentials
      // detects rotation and fails the refresh loudly in that case.
      await persistRefreshedCredentials(creds.connectionId, newCreds, {
        providerSpecificData: creds.providerSpecificData,
        previousRefreshToken: creds.refreshToken,
        provider,
        log,
      });

      creds = {
        ...creds,
        ...newCreds,
        expiresAt: newCreds.expiresIn
          ? toExpiresAt(newCreds.expiresIn)
          : normalizeExpiresAt(newCreds.expiresAt) || newCreds.expiresAt || creds.expiresAt,
        providerSpecificData: newCreds.providerSpecificData
          ? { ...creds.providerSpecificData, ...newCreds.providerSpecificData }
          : creds.providerSpecificData,
      };

      // Non-blocking: refresh projectId with the new access token
      _refreshProjectId(provider, creds.connectionId, creds.accessToken);
    }
  }

  // ── 2. GitHub Copilot token expiry ────────────────────────────────────────
  if (provider === "github") {
    const copilotToken = creds.providerSpecificData?.copilotToken;
    const copilotExpiresAt = creds.providerSpecificData?.copilotTokenExpiresAt
      ? creds.providerSpecificData.copilotTokenExpiresAt * 1000
      : 0;
    const now              = Date.now();
    const remaining        = copilotExpiresAt - now;

    if (!copilotToken || remaining < TOKEN_EXPIRY_BUFFER_MS) {
      log.info("TOKEN_REFRESH", "Copilot token expiring soon or missing, refreshing proactively", {
        provider,
        expiresIn: copilotToken ? Math.round(remaining / 1000) : "missing",
      });

      const copilotTokenResult = await refreshCopilotToken(creds.accessToken);
      if (copilotTokenResult) {
        const updatedSpecific = {
          ...creds.providerSpecificData,
          copilotToken:          copilotTokenResult.token,
          copilotTokenExpiresAt: copilotTokenResult.expiresAt,
        };

        // The Copilot token is derived from an unchanged GitHub access token, so
        // a lost write here is not a rotation hazard — it is re-derived on the
        // next request. Warn rather than fail the request.
        const persisted = await updateProviderCredentials(creds.connectionId, {
          providerSpecificData: updatedSpecific,
        });
        if (!persisted) {
          log.warn("TOKEN_REFRESH", "Copilot token could not be persisted; it will be re-derived", {
            connectionId: creds.connectionId,
          });
        }

        creds.providerSpecificData = updatedSpecific;
        creds.copilotToken = copilotTokenResult.token;
      }
    }
  }

  return creds;
}

// ─── Local-specific: combined GitHub + Copilot refresh ───────────────────────

/**
 * Refresh the GitHub OAuth token and immediately exchange it for a fresh
 * Copilot token.
 *
 * @param {object} credentials  – must contain `refreshToken`
 * @returns {Promise<object|null>} merged credentials or the raw GitHub credentials on Copilot failure
 */
export async function refreshGitHubAndCopilotTokens(credentials) {
  const newGitHubCreds = await refreshGitHubToken(credentials.refreshToken);
  if (!newGitHubCreds?.accessToken) return newGitHubCreds;

  const copilotToken = await refreshCopilotToken(newGitHubCreds.accessToken);
  if (!copilotToken) return newGitHubCreds;

  return {
    ...newGitHubCreds,
    providerSpecificData: {
      copilotToken:          copilotToken.token,
      copilotTokenExpiresAt: copilotToken.expiresAt,
    },
  };
}
