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

  async resolveProjectAk(credential, projectUrlId = "") {
    return resolveMeooProjectAk(credential, { projectUrlId });
  }

  /**
   * Paste-key import (POST /api/oauth/meoo/import-apikey): verify a
   * control-plane API key (`meoo_ak_…`) and resolve the project service
   * AK with it.
   *
   * Verification rests on the projects/environment leg answering, NOT on
   * identity: a key's scope may cover projects while identity refuses it
   * (observed 2026-11-13), so identity is fetched best-effort for
   * display only. Two failure shapes are distinguished:
   *   - the control plane ACCEPTED the key but no AK can be issued yet
   *     (no project / cloud services disabled / AK missing — MeooApiError
   *     with status 0 and a MEOO_* code): the connection is still created
   *     with akStatus/akError, mirroring resolveLoginExtra, and can pick
   *     the AK up later via refresh-ak;
   *   - the control plane REJECTED the key (HTTP error from the projects
   *     leg in either namespace): rethrown as MeooApiError so the route
   *     can surface Meoo's status + detail to the user verbatim.
   */
  async resolveControlKeyImport(controlKey) {
    const extra = { identity: null, projectApiKey: "", projectUrlId: "", projectName: "", akStatus: "pending", akError: "" };
    try {
      extra.identity = await fetchMeooIdentity(controlKey);
    } catch {
      // Display-only; a scoped key may not be entitled to identity.
    }
    try {
      const ak = await resolveMeooProjectAk(controlKey);
      extra.projectApiKey = ak.projectApiKey;
      extra.projectUrlId = ak.projectUrlId;
      extra.projectName = ak.projectName;
      extra.akStatus = "ok";
    } catch (err) {
      const acceptedButNoAk =
        err instanceof MeooApiError &&
        err.status === 0 &&
        typeof err.code === "string" &&
        err.code.startsWith("MEOO_");
      if (!acceptedButNoAk) throw err;
      extra.akStatus = "error";
      extra.akError = err.message;
    }
    return extra;
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
