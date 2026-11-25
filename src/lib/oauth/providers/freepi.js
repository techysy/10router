import crypto from "crypto";
import { FREEPI_CONFIG } from "open-sse/config/freepi.js";

// FreePi — GitHub device flow brokered by api.freepi.ai.
// 1. POST /auth/github/device {} → {session_id, user_code, verification_uri(_complete), interval, expires_in}
// 2. POST /auth/consent {session_id, consent_version} — required before polling
//    (accepts freepi.ai/terms on the user's behalf; the dashboard shows the terms link)
// 3. POST /auth/token {session_id} → {status:"pending"} | {token}
const headers = { "Content-Type": "application/json", Accept: "application/json" };

function jwtExpiresIn(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    const left = Number(claims.exp) - Math.floor(Date.now() / 1000);
    return left > 0 ? left : undefined;
  } catch {
    return undefined;
  }
}

const freepi = {
  config: FREEPI_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const res = await fetch(config.deviceUrl, { method: "POST", headers, body: "{}" });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.session_id || !data?.user_code) {
      throw new Error(`FreePi device start failed: ${data?.code || data?.error || res.status}`);
    }
    const consent = await fetch(config.consentUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: data.session_id, consent_version: config.consentVersion }),
    });
    if (!consent.ok) throw new Error(`FreePi consent failed (HTTP ${consent.status})`);
    return {
      device_code: data.session_id,
      user_code: data.user_code,
      verification_uri: data.verification_uri || "https://github.com/login/device",
      verification_uri_complete: data.verification_uri_complete,
      interval: data.interval || config.pollInterval / 1000,
      expires_in: data.expires_in,
    };
  },
  pollToken: async (config, sessionId) => {
    const res = await fetch(config.tokenUrl, { method: "POST", headers, body: JSON.stringify({ session_id: sessionId }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok && typeof data?.token === "string" && data.token) {
      return { ok: true, data: { access_token: data.token } };
    }
    if (res.ok && (data?.status === "pending" || data?.retry_after)) {
      return { ok: true, data: { error: data.retry_after ? "slow_down" : "authorization_pending" } };
    }
    return { ok: false, data: { error: data?.code || data?.message || `http_${res.status}` } };
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    expiresIn: jwtExpiresIn(tokens.access_token) || FREEPI_CONFIG.tokenLifetimeSeconds,
    providerSpecificData: {
      // One stable session id per connection: the server leases concurrency to it.
      sessionId: crypto.randomUUID(),
    },
  }),
};

export default freepi;
