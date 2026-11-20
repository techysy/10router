import { NOUS_CONFIG } from "../constants/oauth.js";
import { extractEmailFromAccessToken } from "../providerHelpers.js";

// Nous Portal — OAuth 2.0 Device Authorization Grant (RFC 8628), wire-
// compatible with the open-source Hermes Agent client
// (hermes_cli/auth_device_flow.py): form-encoded posts, public
// client_id "hermes-cli", scope "inference:invoke", no secret, no PKCE,
// no redirect URI. The token response may carry `inference_base_url`;
// the canonical inference host is fixed in the provider registry.
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const ACCOUNT_URL = "https://portal.nousresearch.com/api/oauth/account";

const nous = {
  config: NOUS_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetch(config.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        scope: config.scope,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Nous device code request failed: ${error}`);
    }

    return await response.json();
  },
  pollToken: async (config, deviceCode) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: config.clientId,
      }),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      const text = await response.text();
      data = { error: "invalid_response", error_description: text };
    }

    // Device flow: 400 + authorization_pending is expected while the
    // user is approving on the Portal page.
    const pending =
      data?.error === "authorization_pending" || data?.error === "slow_down";
    return {
      ok: response.ok || pending,
      data,
    };
  },
  postExchange: async (tokens) => {
    // Best-effort account profile (plan / email) for the connection
    // card — non-fatal if the endpoint shape changes.
    try {
      const res = await fetch(ACCOUNT_URL, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: "application/json",
        },
      });
      if (res.ok) return { account: await res.json() };
    } catch {
      /* ignore */
    }
    return { account: null };
  },
  mapTokens: (tokens, extra) => {
    const account = extra?.account || null;
    const email =
      account?.email ||
      account?.user?.email ||
      extractEmailFromAccessToken(tokens.access_token) ||
      null;
    const displayName =
      account?.name || account?.user?.name || account?.username || null;
    // Portal account payload reports billing state; a zero monthly
    // charge is the free plan (Hermes derives the tier the same way).
    const monthlyCharge =
      account?.monthly_charge ?? account?.billing?.monthly_charge ?? null;
    const plan =
      account?.plan ||
      account?.subscription_tier ||
      (monthlyCharge === 0 ? "free" : null);

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresIn: tokens.expires_in,
      // Absolute expiry so the proactive refresh path rotates the pair
      // before the access JWT lapses (refresh tokens are single-use —
      // see refreshNousToken in open-sse/services/tokenRefresh).
      expiresAt,
      scope: tokens.scope,
      email: email || undefined,
      displayName: displayName || undefined,
      providerSpecificData: {
        authMethod: "device_code",
        email: email || null,
        plan: plan || null,
        monthlyCharge,
      },
    };
  },
};

export default nous;
