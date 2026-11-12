/**
 * Meoo （秒悟） OAuth + control-plane service.
 *
 * Thin app-side wrapper over the engine-side core in
 * open-sse/services/meooAk.js (single source for the cli-compat protocol):
 * token exchange/refresh against POST https://meoo.com/oauth/token, and
 * the post-login project service AK resolution
 * (identity → projects → cloud/environment → meooProjectApiKey).
 */

import {
  MeooApiError,
  exchangeMeooAuthorizationCode,
  fetchMeooIdentity,
  refreshMeooOAuthTokens,
  resolveMeooCredentials,
  resolveMeooProjectAk,
} from "open-sse/services/meooAk.js";

export { MeooApiError };

export class MeooService {
  async exchangeAuthorizationCode({ code, redirectUri, codeVerifier }) {
    return exchangeMeooAuthorizationCode({ code, redirectUri, codeVerifier });
  }

  async refreshAccessToken(refreshToken) {
    const tokens = await refreshMeooOAuthTokens(refreshToken);
    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
      scope: tokens.scope,
      openid: tokens.openid,
      tenant_id: tokens.tenantId,
    };
  }

  async fetchIdentity(accessToken) {
    return fetchMeooIdentity(accessToken);
  }

  async resolveProjectAk(accessToken, projectUrlId = "") {
    return resolveMeooProjectAk(accessToken, { projectUrlId });
  }

  /**
   * Post-login resolution used by the provider's postExchange hook.
   * Never throws: a login whose AK cannot be resolved yet (no project, or
   * cloud services not enabled — both normal first-run states in Meoo,
   * where login and project binding are separate steps, exactly like the
   * CLI) still produces a connection; the failure is reported back as
   * akStatus/akError so the dashboard can say what to do next, and the
   * AK can be picked up later via POST /api/oauth/meoo/refresh-ak.
   */
  async resolveLoginExtra(accessToken) {
    const extra = { identity: null, projectApiKey: "", projectUrlId: "", projectName: "", akStatus: "pending", akError: "" };
    try {
      extra.identity = await fetchMeooIdentity(accessToken);
    } catch {
      // Identity is display-only; AK resolution is the critical path.
    }
    try {
      const ak = await resolveMeooProjectAk(accessToken);
      extra.projectApiKey = ak.projectApiKey;
      extra.projectUrlId = ak.projectUrlId;
      extra.projectName = ak.projectName;
      extra.akStatus = "ok";
    } catch (err) {
      extra.akStatus = "error";
      extra.akError = err?.message || String(err);
    }
    return extra;
  }

  /** Full refresh + AK re-resolution for a stored connection's credentials. */
  async resolveCredentials(credentials, options = {}) {
    return resolveMeooCredentials(credentials, options);
  }
}

export default MeooService;
