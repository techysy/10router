import { CROLI_CONFIG } from "@/lib/oauth/constants/oauth";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

/** OAuth/account connectivity only; deliberately never calls the model gateway.
 * `effectiveProxy` is the resolveConnectionProxyConfig shape, not a fetch fn. */
export async function testCroliConnection(connection, effectiveProxy = null, fetchImpl = proxyAwareFetch) {
  if (typeof connection?.accessToken !== "string" || !connection.accessToken.trim()) {
    return { valid: false, error: "No access token", refreshed: false };
  }
  try {
    const response = await fetchImpl(`${CROLI_CONFIG.creditsBaseUrl}/v1/account/balance`, {
      method: "GET",
      headers: { Authorization: `Bearer ${connection.accessToken}`, Accept: "application/json" },
    }, effectiveProxy);
    if (!response.ok) {
      return { valid: false, error: response.status === 401 ? "Token invalid or revoked"
        : response.status === 403 ? "Access denied" : `Croli API returned ${response.status}`, refreshed: false };
    }
    const body = await response.json().catch(() => null);
    const balance = body?.balance;
    const valid = balance !== null && balance !== undefined && balance !== "" && typeof balance !== "boolean"
      && typeof balance !== "object" && Number.isFinite(Number(balance)) && Number(balance) >= 0;
    return valid ? { valid: true, error: null, refreshed: false }
      : { valid: false, error: "Croli returned an invalid balance response", refreshed: false };
  } catch (error) {
    return { valid: false, error: `Croli test failed: ${String(error?.message || "network error").slice(0, 160)}`, refreshed: false };
  }
}
