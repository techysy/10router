/*
 * DuMateExecutor — DuMate (百度搭子) web-cookie provider.
 *
 * Credential (connection.apiKey) = the Baidu login cookies, either pasted as a
 * Cookie header / exported cookies JSON, or written by the QR login flow
 * (see open-sse/shared/dumate/). Per request the cookies are exchanged for a
 * DuMate gateway token (shared/dumate/token.js, cached + auto re-issued),
 * which then authorizes the OpenAI-compatible gateway.
 *
 * Auth-lifecycle split:
 *   - execute() ensures a gateway token and retries once on a gateway 401/403
 *     with a freshly exchanged token (cookies still good, token just stale).
 *   - refreshCredentials() (chatCore calls it on 401/403) runs the full
 *     tokenFor(): token exchange, and on "not logged in" a silent relogin via
 *     the stored Baidu passport cookies. Returning {apiKey, accessToken} makes
 *     chatCore persist the rotated cookie blob + new token; returning
 *     {error:"invalid_grant"} marks the connection needs-reauth through the
 *     standard pipeline.
 */

import { BaseExecutor } from "./base.js";
import { GATEWAY, UA, tokenFor, REAUTH_MSG } from "../shared/dumate/token.js";

export class DumateExecutor extends BaseExecutor {
  constructor(provider = "dumate", config = {}) {
    super(provider, { baseUrl: `${GATEWAY}/chat/completions`, ...config });
  }

  buildUrl() {
    return `${GATEWAY}/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const h = {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Accept: stream ? "text/event-stream" : "application/json",
    };
    const t = credentials?.__dumateToken;
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }

  authFail(args, msg) {
    return {
      response: new Response(
        JSON.stringify({ error: { message: msg, type: "authentication_error", code: "needs_reauth" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
      url: this.buildUrl(),
      headers: {},
      transformedBody: args.body,
    };
  }

  /**
   * Ensure credentials.__dumateToken is a live gateway token. On "not logged
   * in" this may silently renew the cookie blob (tokenFor returns the new
   * credential in .raw — adopted in-memory here; the refresh path persists it).
   */
  async ensureToken(credentials, force) {
    const r = await tokenFor(credentials.apiKey, { force });
    if (r.raw !== credentials.apiKey) credentials.apiKey = r.raw;
    Object.defineProperty(credentials, "__dumateToken", {
      value: r.token, enumerable: false, configurable: true, writable: true,
    });
    credentials.__dumateTokenExp = r.exp;
    return r;
  }

  async execute(args) {
    const credentials = args.credentials || (args.credentials = {});
    let fresh = false;
    try {
      const r = await this.ensureToken(credentials, false);
      fresh = r.fresh;
    } catch (e) {
      if (e.expired) return this.authFail(args, e.message);
      throw e;
    }

    let res = await super.execute(args);
    const st = res?.response?.status;
    if (!fresh && (st === 401 || st === 403)) {
      args.log?.info?.("TOKEN", `dumate gateway ${st}; re-issuing token from cookies and retrying once`);
      try {
        await this.ensureToken(credentials, true);
        try { await res.response.body?.cancel?.(); } catch { /* noop */ }
        res = await super.execute(args);
      } catch (e) {
        if (e.expired) return this.authFail(args, e.message);
        args.log?.warn?.("TOKEN", `dumate token re-issue failed: ${e.message}`);
      }
    }
    return res;
  }

  /**
   * chatCore calls this on 401/403. Runs the full tokenFor() — including the
   * silent passport relogin — and hands back what the framework persists:
   *   success -> {apiKey: renewed cookie blob, accessToken: gateway token}
   *   dead login -> {error:"invalid_grant"} -> standard needs-reauth mark
   */
  async refreshCredentials(credentials, log) {
    try {
      const r = await tokenFor(credentials.apiKey, { force: true });
      log?.info?.("TOKEN", `dumate: ${r.renewed ? "silent relogin + " : ""}token re-issued, valid until ${new Date(r.exp).toISOString()}`);
      return {
        apiKey: r.raw,
        accessToken: r.token,
        expiresAt: new Date(r.exp).toISOString(),
      };
    } catch (e) {
      log?.warn?.("TOKEN", `dumate: token refresh failed: ${String(e.message).slice(0, 160)}`);
      return e.expired
        ? { error: "invalid_grant", error_description: e.message || REAUTH_MSG }
        : null; // transient — account fallback handles it, don't mark needs-reauth
    }
  }
}
