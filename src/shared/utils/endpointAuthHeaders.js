/**
 * Resolve custom headers for specific endpoints (e.g. "models", "chat") on compatible nodes.
 *
 * Background (Issue #92):
 * Certain upstream providers (such as iFlytek Loomy, custom internal gateways, etc.) require
 * different authentication headers for different endpoints:
 *   - POST /chat/completions -> Authorization: Bearer <token>
 *   - GET /models -> token: <token> (sending Bearer returns 100002 "missing token")
 *
 * This utility allows declaring an `authHeaders` template object on provider nodes or connections:
 * {
 *   "models": {
 *     "token": "{apiKey}"
 *   }
 * }
 *
 * When an endpoint template matches:
 * 1. Placeholders `{apiKey}` and `{token}` are replaced with the actual API key.
 * 2. If the template defines custom authentication headers and does NOT explicitly include
 *    "Authorization", the default "Authorization: Bearer <key>" is stripped so upstream
 *    gateways won't fail due to unexpected headers.
 */

export function resolveEndpointAuthHeaders(authHeaders, endpoint, apiKey, defaultHeaders = {}) {
  const template = authHeaders?.[endpoint];
  if (!template || typeof template !== "object" || Object.keys(template).length === 0) {
    return { ...defaultHeaders };
  }

  const resolved = { ...defaultHeaders };
  const key = apiKey || "";

  // If the template specifies headers without an Authorization header,
  // strip standard Authorization to prevent conflicting authentication middleware
  const hasExplicitAuth = Object.keys(template).some(
    (k) => k.toLowerCase() === "authorization"
  );
  if (!hasExplicitAuth) {
    delete resolved["Authorization"];
    delete resolved["authorization"];
  }

  for (const [headerName, headerValue] of Object.entries(template)) {
    if (typeof headerValue === "string") {
      resolved[headerName] = headerValue
        .replaceAll("{apiKey}", key)
        .replaceAll("{token}", key);
    } else if (headerValue != null) {
      resolved[headerName] = String(headerValue);
    }
  }

  return resolved;
}
