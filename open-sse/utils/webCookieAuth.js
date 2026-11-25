// Cookie-input normalization for web-cookie providers.
// Accepts whatever the user pasted (bare value, `name=value`, full DevTools
// blob, or a cookie-editor JSON array) and produces a `Cookie` header string.

export function stripCookieInputPrefix(rawValue) {
  const trimmed = (rawValue || "").trim();
  if (!trimmed) return "";

  const withoutBearer = trimmed.replace(/^bearer\s+/i, "");
  return withoutBearer.replace(/^cookie:\s*/i, "").trim();
}

/**
 * Parse a JSON array of cookie objects and produce a Cookie header string.
 *
 * Accepts the format exported by browser cookie-editor extensions / DevTools:
 * [{"name":"sso","value":"eyJ0eXAi...","domain":".example.com","path":"/"}]
 */
export function parseJsonCookiesToHeader(rawValue) {
  const trimmed = (rawValue || "").trim();
  if (!trimmed || !trimmed.startsWith("[")) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) return "";

  const parts = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid cookie JSON at index ${i}: expected an object`);
    }
    if (typeof entry.name !== "string" || !entry.name) {
      throw new Error(`Invalid cookie JSON at index ${i}: missing required field 'name'`);
    }
    if (typeof entry.value !== "string") {
      throw new Error(`Invalid cookie JSON at index ${i}: missing required field 'value'`);
    }
    parts.push(`${entry.name}=${entry.value}`);
  }

  return parts.join("; ");
}

export function normalizeSessionCookieHeader(rawValue, defaultCookieName) {
  const stripped = stripCookieInputPrefix(rawValue);
  if (!stripped) return "";

  const jsonResult = parseJsonCookiesToHeader(stripped);
  if (jsonResult !== null) {
    return jsonResult;
  }

  if (stripped.includes("=")) {
    return stripped;
  }

  return `${defaultCookieName}=${stripped}`;
}

/**
 * Extract a single cookie's value from whatever the user pasted. Handles:
 *   - bare value:                "eyJ0eXAi..."              → "eyJ0eXAi..."
 *   - single pair:               "sso=eyJ0eXAi..."          → "eyJ0eXAi..."
 *   - full DevTools cookie blob: "foo=1; sso=eyJ...; bar=2" → "eyJ..."
 * Returns "" if a blob is given that does not contain the named cookie.
 */
export function extractCookieValue(rawValue, cookieName) {
  const trimmed = stripCookieInputPrefix(rawValue);
  if (!trimmed) return "";

  if (trimmed.includes(";")) {
    const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = trimmed.match(new RegExp("(?:^|;\\s*)" + escaped + "=([^;\\s]+)"));
    return match ? match[1] : "";
  }

  const prefix = `${cookieName}=`;
  if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);

  return trimmed;
}

/**
 * Build the `Cookie` header value for grok.com from whatever the user pasted.
 *
 * Always emits `sso=<value>`. When the pasted blob also carries the paired
 * `sso-rw` write cookie, it is forwarded too — Grok's anti-bot rejects requests
 * that send `sso` without `sso-rw`. The Cloudflare cookies `cf_clearance` and
 * `__cf_bm` are forwarded the same way when present. Like `sso-rw`, each is
 * appended only when it appears as a real cookie pair, so a bare `sso` blob
 * still produces exactly `sso=<value>`.
 */
export function buildGrokCookieHeader(rawValue) {
  const sso = extractCookieValue(rawValue, "sso");
  if (!sso) return "";

  const parts = [`sso=${sso}`];
  for (const name of ["sso-rw", "cf_clearance", "__cf_bm"]) {
    if (new RegExp("(?:^|;\\s*)" + name + "=").test(rawValue)) {
      const value = extractCookieValue(rawValue, name);
      if (value) parts.push(`${name}=${value}`);
    }
  }
  return parts.join("; ");
}
