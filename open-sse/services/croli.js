import definition from "../providers/registry/croli.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

export const CROLI_CONFIG = definition.oauth;
const TIMEOUT_MS = 20_000;

export class CroliApiError extends Error {
  constructor(code, status = 502) {
    super(`Croli ${code}`);
    this.name = "CroliApiError";
    this.code = code;
    this.status = status;
  }
}
const credential = (value) => typeof value === "string" && value.length <= 8192 && value.trim() && !/[\x00-\x20\x7f]/.test(value) ? value : null;

async function requestJSON(url, init, { fetchImpl = proxyAwareFetch, proxyOptions = null } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }, proxyOptions);
  } catch { throw new CroliApiError("connection_failed"); }
  let data;
  try { data = await response.json(); } catch { throw new CroliApiError("invalid_response", response.ok ? 502 : response.status); }
  if (!response.ok) {
    const missingAccount = response.status === 404 && (data?.code === "account_not_found" || data?.error === "account_not_found");
    const code = missingAccount ? "account_not_found" : response.status === 401 ? "authentication_failed" : response.status === 403 ? "access_denied" : "upstream_error";
    throw new CroliApiError(code, response.status);
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.success === false || data.error) throw new CroliApiError("invalid_response");
  return data;
}

// Only provision the credits account after the precise account_not_found signal.
export async function bootstrapCroliAccount(accessToken, options = {}) {
  if (!credential(accessToken)) throw new CroliApiError("missing_access_token", 401);
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  const bootstrap = () => requestJSON(CROLI_CONFIG.bootstrapUrl, { method: "POST", headers }, options);
  try { return await bootstrap(); } catch (error) {
    if (error.code !== "account_not_found" || error.status !== 404) throw error;
    await requestJSON(CROLI_CONFIG.resourceUrl, { headers }, options);
    return bootstrap();
  }
}

export async function fetchCroliOpsHome(accessToken, options = {}) {
  if (!credential(accessToken)) throw new CroliApiError("missing_access_token", 401);
  const readHome = () => requestJSON(CROLI_CONFIG.opsHomeUrl, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }, options);
  try { return await readHome(); } catch (error) {
    if (!options.ensureAccount || error.code !== "account_not_found" || error.status !== 404) throw error;
    await bootstrapCroliAccount(accessToken, options);
    return readHome();
  }
}

export async function fetchCroliBalance(accessToken, options = {}) {
  if (!credential(accessToken)) throw new CroliApiError("missing_access_token", 401);
  return requestJSON(CROLI_CONFIG.balanceUrl, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }, options);
}
