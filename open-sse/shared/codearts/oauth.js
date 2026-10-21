/**
 * CodeArts OAuth refresh half (STS token endpoint).
 *
 * The refresh token is **one-time-use**: a second concurrent refresh with the
 * same token answers `invalid_grant`, and the account has to log in again. Two
 * rules follow:
 *   1. **single-flight** — concurrent 401s must share one in-flight refresh,
 *      keyed by the refresh token (not by account id; a rotated token changes
 *      the key on purpose).
 *   2. **persist first, then sync** — this module never mutates the caller's
 *      credential object. chatCore persists the returned object via
 *      `onCredentialsRefreshed` and only then retries; a failed persist must
 *      abort, not serve one last request off an in-memory-only token.
 *
 * The full login flow (portal ticket + PKCE + loopback callback) is a TODO; the
 * pieces here (PKCE S256, DPoP ES256 low-S, STS exchange/refresh) are the half
 * that must be correct for unattended operation.
 */
import crypto from "node:crypto";

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { CODEARTS_OAUTH_CLIENT_ID, CODEARTS_TOKEN_URL } from "../../config/codearts.js";
import { buildDpopProof, dpopKeyFromPrivateKey } from "./signing.js";

const inFlight = new Map(); // sha256(refreshToken) -> Promise

export function generatePkcePair() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { codeVerifier: verifier, codeChallenge: challenge, codeChallengeMethod: "SHA-256" };
}

function formEncode(value) {
  return encodeURIComponent(String(value));
}

function singleFlight(key, task) {
  if (inFlight.has(key)) return inFlight.get(key);
  const run = Promise.resolve().then(task).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

function privateKeyOf(psd) {
  if (psd.dpopPrivateKeyPem) return crypto.createPrivateKey(psd.dpopPrivateKeyPem);
  const jwk = psd.dpopPrivateJwk;
  if (!jwk?.d) return null;
  return crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, format: "jwk" });
}

async function tokenRequest(form, psd, proxyOptions) {
  const privateKey = privateKeyOf(psd);
  if (!privateKey) throw Object.assign(new Error("CodeArts 缺少 DPoP 私钥，无法续期，请重新登录"), { statusCode: 400 });
  const key = dpopKeyFromPrivateKey(privateKey);
  const proof = buildDpopProof({ privateKey: key.privateKey, publicJwk: key.publicJwk, method: "POST", url: CODEARTS_TOKEN_URL });
  const body = Object.entries(form).map(([name, value]) => `${formEncode(name)}=${formEncode(value)}`).join("&");
  const response = await proxyAwareFetch(CODEARTS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      DPoP: proof,
    },
    body,
    signal: AbortSignal.timeout(20_000),
  }, proxyOptions);
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const error = new Error(`CodeArts 令牌端点返回 ${response.status}：${text.slice(0, 200)}`);
    error.statusCode = response.status;
    error.invalidGrant = text.toLowerCase().includes("invalid_grant");
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("CodeArts 令牌响应不是合法 JSON"), { statusCode: 502 });
  }
  const material = payload?.credentials && typeof payload.credentials === "object" ? payload.credentials : payload;
  const read = (name) => String(material?.[name] ?? payload?.[name] ?? "").trim();
  if (!read("access_key_id") || !read("secret_access_key")) {
    throw Object.assign(new Error("CodeArts 令牌响应里的临时凭据不完整"), { statusCode: 502 });
  }
  return {
    accessKeyId: read("access_key_id"),
    secretAccessKey: read("secret_access_key"),
    securityToken: read("security_token"),
    expiration: read("expiration"),
    refreshToken: read("refresh_token"),
  };
}

/**
 * Refresh AK/SK from an OAuth connection. Returns the next credential bundle
 * (never mutates `credentials`) or `null` when there is no refresh context.
 */
export async function refreshCodeArtsCredential(credentials, { proxyOptions = null } = {}) {
  const psd = credentials?.providerSpecificData || {};
  const refreshToken = String(psd.refreshToken || "").trim();
  const codeVerifier = String(psd.codeVerifier || "").trim();
  if (!refreshToken) return null;
  if (!codeVerifier) {
    throw Object.assign(new Error("CodeArts 凭据缺少 PKCE verifier，无法续期，请重新登录"), { statusCode: 400 });
  }

  const key = crypto.createHash("sha256").update(refreshToken).digest("hex");
  return singleFlight(key, async () => {
    const next = await tokenRequest(
      {
        client_id: CODEARTS_OAUTH_CLIENT_ID,
        code_verifier: codeVerifier,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      },
      psd,
      proxyOptions
    );
    // Identity is not returned by the refresh response; inherit it or the
    // per-account gate and same-account detection lose their stable key.
    const domainId = psd.domainId || credentials?.domainId || "";
    return {
      accessToken: next.accessKeyId,
      refreshToken: next.refreshToken || refreshToken,
      providerSpecificData: {
        ...psd,
        accessKeyId: next.accessKeyId,
        secretAccessKey: next.secretAccessKey,
        securityToken: next.securityToken,
        expiration: next.expiration,
        domainId,
        refreshToken: next.refreshToken || refreshToken,
      },
    };
  });
}
