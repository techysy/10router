import { ORCATERM_CONFIG } from "../../config/orcaterm.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { dedupRefresh } from "../../services/tokenRefresh/dedup.js";

export class OrcaTermError extends Error {
  constructor(message, status = 502, code = "ORCATERM_ERROR") {
    super(message);
    this.name = "OrcaTermError";
    this.status = status;
    this.code = code;
  }
}

export function readOrcaTermClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : {};
  } catch {
    return {};
  }
}

// Errors raised before any request bytes are sent, so a retry cannot replay a single-use code.
const RETRYABLE_CONNECT_ERRORS = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN"]);
const MAX_CONNECT_RETRIES = 3;

async function requestJson(url, init, proxyOptions) {
  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await proxyAwareFetch(url, {
        ...init,
        redirect: "error",
        headers: { Accept: "application/json", ...init?.headers },
        signal: AbortSignal.timeout(ORCATERM_CONFIG.requestTimeoutMs),
      }, proxyOptions);
      break;
    } catch (error) {
      const code = String(error?.cause?.code || error?.code || "");
      if (attempt < MAX_CONNECT_RETRIES && RETRYABLE_CONNECT_ERRORS.has(code)) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      throw new OrcaTermError(
        `OrcaTerm endpoint unreachable (${code || error?.name || "network error"}); please retry`,
        502,
        "NETWORK_ERROR",
      );
    }
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw new OrcaTermError(
      `OrcaTerm authentication endpoint returned HTTP ${response.status}`,
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }
  return body;
}

function checkResult(body) {
  if (body.code != null && String(body.code) !== "0") {
    const code = String(body.code).replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80);
    const tooEarly = /not[_ .-]*(?:yet[_ .-]*)?expired|too[_ .-]*early/i.test(`${code} ${body.message || ""}`);
    const expired = !tooEarly && (
      /EXPIRED|INVALID|MISMATCH|UNAUTH|401|403/i.test(code) ||
      /token.*(expired|invalid)|unauthorized|not logged in/i.test(String(body.message || ""))
    );
    throw new OrcaTermError(
      `OrcaTerm sign-in failed (${code || "upstream error"}). Please start a new sign-in.`,
      expired ? 401 : 502,
      code || "ORCATERM_ERROR",
    );
  }
}

function normalizeToken(data, requireIdentity = false) {
  const accessToken = data?.accessToken || data?.AccessToken;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new OrcaTermError("OrcaTerm returned no access token");
  }
  const claims = readOrcaTermClaims(accessToken);
  const userId = String(data.userId ?? claims.userId ?? "");
  if (requireIdentity && !userId) throw new OrcaTermError("OrcaTerm returned no account identity");
  const claimedLifetime = Number(claims.exp) - Math.floor(Date.now() / 1000);
  if (Number.isFinite(claimedLifetime) && claimedLifetime <= 0) {
    throw new OrcaTermError("OrcaTerm returned an expired token", 401, "TOKEN_EXPIRED");
  }
  const lifetime = Number(data.expiresIn ?? data.ExpiresIn);
  const expiresIn = claimedLifetime > 0
    ? claimedLifetime
    : lifetime > 0 ? lifetime : ORCATERM_CONFIG.tokenLifetimeSeconds;
  return {
    accessToken,
    // This API renews the current access token; it issues no separate refresh token.
    refreshToken: accessToken,
    expiresIn,
    userId,
    displayName: String(data.providerUsername ?? claims.providerUsername ?? ""),
  };
}

export async function startOrcaTermLogin() {
  const body = await requestJson(ORCATERM_CONFIG.wechatConfigUrl, { cache: "no-store" });
  checkResult(body);
  const data = body.data;
  if (
    typeof data?.appid !== "string" || !data.appid ||
    typeof data.state !== "string" || !data.state ||
    data.redirect_uri !== ORCATERM_CONFIG.bridgeUrl ||
    data.scope !== "snsapi_login"
  ) {
    throw new OrcaTermError("OrcaTerm returned an unsupported WeChat sign-in configuration");
  }
  return {
    appid: data.appid,
    state: data.state,
    redirectUri: data.redirect_uri,
    scope: data.scope,
  };
}

export async function exchangeOrcaTermCode(code, state) {
  const body = await requestJson(ORCATERM_CONFIG.exchangeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, state }),
  });
  checkResult(body);
  return normalizeToken(body.data, true);
}

export async function refreshOrcaTermToken(token, log, proxyOptions = null) {
  if (!token) return null;
  return dedupRefresh("orcaterm", token, async () => {
    try {
      const body = await requestJson(ORCATERM_CONFIG.refreshUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "OAuthRefreshToken", data: { accessToken: token } }),
      }, proxyOptions);
      checkResult(body);
      const result = body.data?.Response ?? body.data;
      if (result?.Error) {
        const code = String(result.Error.Code || "");
        if (!/not.?expired|too.?early/i.test(code) && /expired|invalid|unauth|authfailure/i.test(code)) {
          return { error: "invalid_grant" };
        }
        return null;
      }
      const { accessToken, refreshToken, expiresIn } = normalizeToken(result);
      return { accessToken, refreshToken, expiresIn };
    } catch (error) {
      log?.warn?.("TOKEN_REFRESH", `OrcaTerm renewal failed (${error?.code || "network error"})`);
      return error?.status === 401 ? { error: "invalid_grant" } : null;
    }
  }, log);
}

export async function fetchOrcaTermBilling(token, proxyOptions = null) {
  if (!token) throw new OrcaTermError("OrcaTerm sign-in is required", 401);
  const action = "DescribeUserBillingStatus";
  const body = await requestJson(`${ORCATERM_CONFIG.apiUrl}?action=${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORCATERM_CONFIG.origin,
      Referer: `${ORCATERM_CONFIG.origin}/terminal`,
      "X-Referer": `${ORCATERM_CONFIG.origin}/terminal`,
      Cookie: `ot_session=${token}`,
    },
    body: JSON.stringify({ action, data: {} }),
  }, proxyOptions);
  checkResult(body);
  const result = body.data?.Response;
  if (!result || result.Error) {
    const code = String(result?.Error?.Code || "");
    throw new OrcaTermError(
      "OrcaTerm could not validate this account; please sign in again",
      /auth|token|session|login|expired|invalid/i.test(code) ? 401 : 502,
    );
  }
  return result;
}
