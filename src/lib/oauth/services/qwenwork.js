import { QoderService } from "./qoder.js";

/**
 * QwenWork OAuth Service — the Qoder device-token flow with QwenWork's
 * site differences:
 *   1. The authorization URL carries `client_id` and `redirect_uri`
 *      (Qoder's landing page knows its own client; QwenWork's gateway
 *      page is shared across the desktop apps and asks for both).
 *   2. Poll answers 200 with an empty body while the user is still
 *      deciding — that is "pending", not an error.
 *   3. There is no /api/v1/userinfo; the profile comes from the
 *      account-context endpoint, nested under `data.user`.
 *
 * Everything else (PKCE pair, nonce, machine_id, poll query shape, expiry
 * parsing) is inherited from QoderService verbatim — the two products'
 * desktop clients run the same flow code.
 */

const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class QwenWorkService extends QoderService {
  /**
   * @param {object} site - One entry of QWENWORK_SITES
   *   (shared/qwenwork/constants.js): gateway endpoints + client identity.
   */
  constructor(site) {
    super({
      deviceTokenUrl: site.deviceTokenUrl,
      loginUrl: site.loginUrl,
      userInfoUrl: site.userInfoUrl,
    });
    this.clientId = site.clientId;
    this.redirectUri = site.redirectUri;
  }

  initiateDeviceFlow() {
    const flow = super.initiateDeviceFlow();
    const url = new URL(flow.verificationUriComplete);
    url.searchParams.set("client_id", this.clientId);
    if (this.redirectUri) url.searchParams.set("redirect_uri", this.redirectUri);
    return { ...flow, verificationUriComplete: url.toString() };
  }

  /**
   * Single poll attempt. Same contract as QoderService.pollDeviceToken,
   * plus: 200 without a token means the user hasn't finished (pending).
   */
  async pollDeviceToken({ nonce, codeVerifier }) {
    if (!nonce || !codeVerifier) {
      throw new Error("pollDeviceToken: missing nonce or code verifier");
    }
    const url = `${this.deviceTokenUrl}?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(codeVerifier)}&challenge_method=S256`;

    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Go-http-client/2.0",
      },
    });

    if (response.status === 202 || response.status === 404) {
      return { status: "pending" };
    }

    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}

    if (!response.ok) {
      const detail = body?.errorMessage || body?.message || `HTTP ${response.status}`;
      throw new Error(`QwenWork device token poll failed: ${detail}`);
    }

    // Authorized flows return the token; a 200 without one is the gateway
    // saying "registered, still waiting" (observed on the live gateway).
    if (!body?.token) {
      return { status: "pending" };
    }

    const expireMs = QoderService.parseExpiry(body.expires_at, body.expires_in);

    return {
      status: "ok",
      accessToken: body.token,
      refreshToken: body.refresh_token || "",
      userId: body.user_id || "",
      expireTime: expireMs,
      rawResponse: body,
    };
  }

  /**
   * Profile lookup via account-context. Best-effort — failures return
   * empty strings and never block login. The poll response's user_id
   * remains the primary identity; this only fills name/email/org.
   */
  async fetchUserInfo(accessToken) {
    try {
      const response = await fetchWithTimeout(this.userInfoUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "User-Agent": "Go-http-client/2.0",
        },
      });
      if (!response.ok) return { name: "", email: "", organizationId: "" };
      const body = await response.json().catch(() => null);
      const data = body?.data ?? body ?? {};
      const user = data.user ?? data;
      return {
        name: (user.name || user.nickname || user.username || "").trim(),
        email: (user.email || "").trim(),
        organizationId: (data.organization_id || user.organization_id || user.org_id || "").trim(),
      };
    } catch {
      return { name: "", email: "", organizationId: "" };
    }
  }
}
