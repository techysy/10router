import { ATOMCODE_CONFIG } from "../../config/atomcode.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { dedupRefresh } from "../../services/tokenRefresh/dedup.js";

export class AtomCodeError extends Error {
  constructor(message, status = 502, code = "ATOMCODE_ERROR") {
    super(message);
    this.name = "AtomCodeError";
    this.status = status;
    this.code = code;
  }
}

// Connect-phase failures only: nothing was sent, so a retry cannot replay a
// one-shot state/refresh token.
const RETRYABLE_CONNECT_ERRORS = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN"]);
const MAX_CONNECT_RETRIES = 2;

const baseHeaders = () => ({ Accept: "application/json", "User-Agent": ATOMCODE_CONFIG.userAgent });

async function request(url, init = {}, proxyOptions = null) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await proxyAwareFetch(url, {
        ...init,
        headers: { ...baseHeaders(), ...init.headers },
        signal: AbortSignal.timeout(ATOMCODE_CONFIG.requestTimeoutMs),
      }, proxyOptions);
    } catch (error) {
      const code = String(error?.cause?.code || error?.code || "");
      if (attempt < MAX_CONNECT_RETRIES && RETRYABLE_CONNECT_ERRORS.has(code)) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw new AtomCodeError(`AtomGit endpoint unreachable (${code || error?.name || "network error"})`, 502, "NETWORK_ERROR");
    }
  }
}

async function json(response) {
  return response.json().catch(() => null);
}

/** Step 1: open a broker login session → { state, loginUrl }. */
export async function startAtomCodeLogin(proxyOptions = null) {
  const res = await request(`${ATOMCODE_CONFIG.loginUrl}?provider=atomgit`, { cache: "no-store" }, proxyOptions);
  const body = await json(res);
  if (!res.ok || typeof body?.state !== "string" || typeof body?.login_url !== "string") {
    throw new AtomCodeError(`AtomGit login start failed (HTTP ${res.status})`);
  }
  // The official client strips force_login so an existing AtomGit session is reused.
  const loginUrl = body.login_url.replace(/([?&])force_login=true&?/, "$1").replace(/[?&]$/, "");
  return { state: body.state, loginUrl };
}

/** Step 2: poll the broker. Returns null while pending, the token payload once authorized. */
export async function pollAtomCodeLogin(state, proxyOptions = null) {
  const q = `state=${encodeURIComponent(state)}`;
  const check = await request(`${ATOMCODE_CONFIG.checkUrl}?${q}`, { cache: "no-store" }, proxyOptions);
  const checked = await json(check);
  if (!check.ok || checked?.valid !== true) return null;
  const res = await request(`${ATOMCODE_CONFIG.tokenUrl}?${q}`, { cache: "no-store" }, proxyOptions);
  const body = await json(res);
  if (!res.ok || typeof body?.access_token !== "string" || !body.access_token) {
    throw new AtomCodeError(`AtomGit token exchange failed (HTTP ${res.status})`, 502, "EXCHANGE_FAILED");
  }
  return body;
}

export async function refreshAtomCodeToken(refreshToken, log, proxyOptions = null) {
  if (!refreshToken) return null;
  return dedupRefresh("atomcode", refreshToken, async () => {
    try {
      const res = await request(ATOMCODE_CONFIG.refreshUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }, proxyOptions);
      const body = await json(res);
      if (!res.ok || typeof body?.access_token !== "string") {
        log?.warn?.("TOKEN_REFRESH", `AtomCode refresh failed (HTTP ${res.status})`);
        return res.status === 400 || res.status === 401 || res.status === 403 ? { error: "invalid_grant" } : null;
      }
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token || refreshToken,
        expiresIn: Number(body.expires_in) > 0 ? Number(body.expires_in) : 7 * 24 * 3600,
      };
    } catch (error) {
      log?.warn?.("TOKEN_REFRESH", `AtomCode refresh failed (${error?.code || "network error"})`);
      return null;
    }
  }, log);
}

const planHeaders = (token) => ({ Authorization: `Bearer ${token}` });

/** Claim the best free CodingPlan tier the account qualifies for (idempotent). */
export async function claimAtomCodePlan(token, proxyOptions = null) {
  let last = null;
  for (const plan of ATOMCODE_CONFIG.claimPlans) {
    try {
      const res = await request(`${ATOMCODE_CONFIG.codingPlanApi}/claim-v2`, {
        method: "POST",
        headers: { ...planHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ plan_type: plan }),
      }, proxyOptions);
      const body = await json(res);
      last = body;
      if (res.ok && body?.success) return { planType: body.plan_type || plan, planName: body.plan_name || plan, duplicate: !!body.duplicate };
    } catch (error) {
      last = { message: error?.message };
    }
  }
  return { planType: null, planName: null, error: last?.message || "claim_failed" };
}

export async function fetchAtomCodeStatus(token, proxyOptions = null) {
  const res = await request(`${ATOMCODE_CONFIG.codingPlanApi}/status-v2`, { headers: planHeaders(token) }, proxyOptions);
  if (res.status === 401 || res.status === 403) throw new AtomCodeError("AtomGit sign-in expired", 401, "AUTH_EXPIRED");
  const body = await json(res);
  if (!res.ok || !body) throw new AtomCodeError(`CodingPlan status failed (HTTP ${res.status})`);
  return body;
}

/** Live model catalogue for a tier → [{id, name, contextWindow, maxOutput, vision}] (plan_available only). */
export async function fetchAtomCodeModels(token, planType = "Lite", proxyOptions = null) {
  const tier = /^pro/i.test(planType || "") ? "Pro" : /^max/i.test(planType || "") ? "Max" : "Lite";
  const res = await request(`${ATOMCODE_CONFIG.codingPlanApi}/models-v3?plan_type=${tier}`, { headers: planHeaders(token) }, proxyOptions);
  const body = await json(res);
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  return list
    .filter((m) => m && m.plan_available !== false && typeof m.display_model_name === "string")
    .map((m) => ({
      id: m.display_model_name,
      name: m.alias || m.display_model_name,
      contextWindow: Number(m.context_window) || undefined,
      maxOutput: Number(m.max_output_tokens || m.max_tokens) || undefined,
      vision: m.supports_vision === true,
    }));
}
