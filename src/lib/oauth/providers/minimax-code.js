import { MINIMAX_CODE_CONFIG, MINIMAX_CODE_GLOBAL_CONFIG } from "../constants/oauth.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SIGN_IN_TIMEOUT_SEC = 600;

function str(o, k) {
  return typeof o?.[k] === "string" && o[k].trim() ? o[k].trim() : undefined;
}

function pos(o, k) {
  return typeof o?.[k] === "number" && Number.isFinite(o[k]) && o[k] > 0 ? o[k] : undefined;
}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(30000),
  });
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = { error: `invalid_json_response (HTTP ${res.status})` };
  }
  return { status: res.status, body };
}

function normalizeDeadline(body) {
  const expiresIn = pos(body, "expires_in");
  const expiredIn = pos(body, "expired_in");
  if (expiresIn) return expiresIn;
  if (!expiredIn) return undefined;
  return expiredIn < 1e12 ? expiredIn : Math.max(1, Math.ceil((expiredIn - Date.now()) / 1000));
}

function normalizeInterval(body, pollByUser) {
  const interval = pos(body, "interval");
  if (!interval) return 5;
  if (!pollByUser) return interval;
  return interval >= 60 ? Math.round(interval / 1000) : interval;
}

export function createMinimaxCodeProvider(config) {
  return {
    config,
    flowType: "device_code",

    async requestDeviceCode(cfg, codeChallenge) {
      if (!codeChallenge) throw new Error("MiniMax Code sign-in requires a PKCE code challenge");
      const { status, body } = await postForm(cfg.deviceUrl, {
        client_id: cfg.clientId,
        scope: cfg.scope,
        audience: cfg.audience,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      const userCode = str(body, "user_code");
      const deviceCode = str(body, "device_code");
      const uri = str(body, "verification_uri_complete") ?? str(body, "verification_uri") ?? str(body, "verification_url");

      if (!userCode || !uri) {
        throw new Error(`MiniMax device code response unusable (HTTP ${status})`);
      }

      const pollByUser = !deviceCode;
      return {
        device_code: deviceCode ?? userCode,
        user_code: userCode,
        verification_uri: uri,
        verification_uri_complete: str(body, "verification_uri_complete") || uri,
        expires_in: normalizeDeadline(body) ?? SIGN_IN_TIMEOUT_SEC,
        interval: normalizeInterval(body, pollByUser),
        _minimaxPollByUser: pollByUser,
      };
    },

    async pollToken(cfg, deviceCode, codeVerifier, extraData) {
      if (!deviceCode) return { ok: true, data: { error: "authorization_pending" } };
      const fields = {
        grant_type: DEVICE_GRANT,
        ...(extraData?._minimaxPollByUser ? { user_code: deviceCode } : { device_code: deviceCode }),
        client_id: cfg.clientId,
        code_verifier: codeVerifier,
      };
      const { body } = await postForm(cfg.tokenUrl, fields);

      const status = str(body, "status");
      if (status === "pending") return { ok: true, data: { error: "authorization_pending" } };
      if (status === "slow_down") return { ok: true, data: { error: "slow_down" } };
      if (status === "denied" || status === "access_denied") return { ok: true, data: { error: "access_denied" } };
      if (status === "expired" || status === "expired_token") return { ok: true, data: { error: "expired_token" } };
      if (status) return { ok: true, data: { error: `unexpected_status:${status}` } };

      if (str(body, "error")) {
        return { ok: true, data: { error: str(body, "error"), error_description: str(body, "error_description") } };
      }

      if (!str(body, "access_token")) return { ok: true, data: { error: "no_access_token" } };
      return { ok: true, data: body };
    },

    mapTokens(data) {
      const expiresIn = pos(data, "expires_in");
      return {
        accessToken: str(data, "access_token"),
        refreshToken: str(data, "refresh_token") ?? "",
        expiresIn: expiresIn ?? 3600,
        providerSpecificData: {
          authMethod: "device_code",
        },
      };
    },
  };
}

export const minimaxCode = createMinimaxCodeProvider(MINIMAX_CODE_CONFIG);
export const minimaxCodeGlobal = createMinimaxCodeProvider(MINIMAX_CODE_GLOBAL_CONFIG);
