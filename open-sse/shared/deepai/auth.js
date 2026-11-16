/**
 * DeepAI Code browser sign-in (the desktop app's own desktop_auth flow),
 * shared by the dashboard exchange route. No desktop app is involved:
 *
 *   1. The user's browser opens
 *      GET /deepai_code/desktop_auth/?state=<32 hex>&port=<n> and signs
 *      in with Google/Apple.
 *   2. DeepAI redirects the browser to
 *      http://127.0.0.1:<port>/auth-callback?code=... — nothing needs to
 *      listen there; the user copies the address-bar URL back into the
 *      dashboard (the port only has to be a plausible non-zero value).
 *   3. The server exchanges the code:
 *      POST /deepai_code/desktop_auth/exchange/ {code}
 *      -> {api_key, username, is_pro}.
 *
 * Verified live 2026-11-16: the state must be 32 lowercase hex chars
 * (a dashed UUID is rejected 400 "Invalid desktop sign-in request"),
 * port=0 is rejected the same way, and a bogus code gets a clean
 * 400 {"error":"invalid code"} from the exchange endpoint.
 */

import { DEEPAI_API_BASE, DEEPAI_USER_AGENT } from "./constants.js";

export const DEEPAI_AUTH_ORIGIN = "https://api.deepai.org";

/** The sign-in page URL the dashboard opens in the user's browser. */
export function buildDeepaiAuthUrl(state, port) {
  return `${DEEPAI_AUTH_ORIGIN}/deepai_code/desktop_auth/?state=${state}&port=${port}`;
}

/**
 * Pull the one-time code out of whatever the user pasted: the full
 * 127.0.0.1 callback URL, a bare query string, or the code itself.
 * Returns "" when nothing code-shaped is present.
 */
export function parseDeepaiCallbackCode(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const code = url.searchParams.get("code");
    if (code) return code.trim();
  } catch {
    // not a URL — fall through
  }
  const m = raw.match(/[?&#]code=([^&\s]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]).trim();
    } catch {
      return m[1].trim();
    }
  }
  // A bare code carries no spaces and no URL punctuation.
  if (/^[A-Za-z0-9._~-]{8,}$/.test(raw)) return raw;
  return "";
}

/**
 * Exchange a desktop_auth code for the account's long-lived API key.
 * Throws an Error carrying the upstream message on failure.
 */
export async function exchangeDeepaiCode(code, { fetchImpl = fetch } = {}) {
  const value = String(code ?? "").trim();
  if (!value) throw new Error("empty-code");
  const res = await fetchImpl(`${DEEPAI_API_BASE}/desktop_auth/exchange/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": DEEPAI_USER_AGENT,
    },
    body: JSON.stringify({ code: value }),
    redirect: "error",
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String(payload?.error || `exchange HTTP ${res.status}`));
  }
  const apiKey = String(payload?.api_key ?? "").trim();
  if (!apiKey || /\s/.test(apiKey)) throw new Error("invalid-exchange-response");
  return {
    apiKey,
    username: String(payload?.username ?? "").trim(),
    isPro: Boolean(payload?.is_pro),
  };
}
