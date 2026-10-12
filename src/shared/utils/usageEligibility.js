import { USAGE_APIKEY_PROVIDERS, USAGE_COOKIE_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";

/**
 * Whether a provider connection has a quota/usage API worth querying — the one
 * rule behind the dashboard's Provider Limits list (/api/providers/client) and
 * the external read-only overview (/api/usage/quotas). Keep it shared: when the
 * two drifted, the overview listed providers with no usage API at all
 * ("Usage API not implemented for kilocode"), and external dashboards counted
 * them as broken connections.
 */
export function isUsageEligible(connection) {
  return USAGE_SUPPORTED_PROVIDERS.includes(connection.provider) && (
    connection.authType === "oauth" ||
    USAGE_APIKEY_PROVIDERS.includes(connection.provider) ||
    (connection.authType === "cookie" && USAGE_COOKIE_PROVIDERS?.includes(connection.provider))
  );
}
