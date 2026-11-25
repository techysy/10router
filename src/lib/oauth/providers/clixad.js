import { CLIXAD_CONFIG } from "open-sse/config/clixad.js";

// Clixad — GitHub device flow proxied by the Clixad gateway.
// start: POST /v1/auth/device/start → {session, user_code, verification_uri, interval, expires_in}
// poll:  POST /v1/auth/device/poll {session} → {status:"pending"} | {status:"complete", token, userId, email, login}
const headers = { "Content-Type": "application/json", Accept: "application/json", "X-Clixad-Client": CLIXAD_CONFIG.clientHeader };

const clixad = {
  config: CLIXAD_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const res = await fetch(config.deviceStartUrl, { method: "POST", headers, body: "{}" });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.session || !data?.user_code) {
      throw new Error(`Clixad device start failed: ${data?.error || res.status}`);
    }
    return {
      device_code: data.session,
      user_code: data.user_code,
      verification_uri: data.verification_uri || "https://github.com/login/device",
      interval: data.interval || config.pollInterval / 1000,
      expires_in: data.expires_in,
    };
  },
  pollToken: async (config, session) => {
    const res = await fetch(config.devicePollUrl, { method: "POST", headers, body: JSON.stringify({ session }) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data?.error === "signup_closed") {
      return { ok: false, data: { error: "signup_closed", error_description: "Clixad signup is waitlisted; an invite code is required" } };
    }
    const status = data?.status;
    if (status === "complete" && data.token) {
      return { ok: true, data: { access_token: data.token, user: { id: data.userId, email: data.email, login: data.login } } };
    }
    if (!status || status === "pending" || status === "slow_down") {
      if (!res.ok && data?.error) return { ok: false, data: { error: data.error } };
      return { ok: true, data: { error: status === "slow_down" ? "slow_down" : "authorization_pending" } };
    }
    return { ok: false, data: { error: status || data?.error || "unknown_error" } };
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    // No expiry and no refresh: the gateway answers 401 "invalid token" when it dies.
    expiresIn: undefined,
    email: tokens.user?.email || undefined,
    name: tokens.user?.login || undefined,
    displayName: tokens.user?.login || undefined,
    providerSpecificData: { userId: String(tokens.user?.id || ""), login: tokens.user?.login || "" },
  }),
};

export default clixad;
