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
 *
 * 2026-11-16 协议修正(用户桌面版截图证实):官方回调是
 * `127.0.0.1:<port>/auth-callback?code=<30字符带下划线>&state=<64 hex>` ——
 * **code 与 state 成对**,exchange 必须同时携带(见 exchangeDeepaiCode)。
 * 本函数升级为返回 {code, state} 对象;state 缺省 ""(旧 12 字符纯 code 场景)。
 */
export function parseDeepaiCallbackCode(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { code: "", state: "" };
  try {
    const url = new URL(raw);
    const code = url.searchParams.get("code");
    if (code) return { code: code.trim(), state: (url.searchParams.get("state") || "").trim() };
  } catch {
    // not a URL — fall through
  }
  const m = raw.match(/[?&#]code=([^&\s]+)/);
  if (m) {
    let code;
    try {
      code = decodeURIComponent(m[1]).trim();
    } catch {
      code = m[1].trim();
    }
    const sm = raw.match(/[?&#]state=([^&\s]+)/);
    let state = "";
    if (sm) {
      try {
        state = decodeURIComponent(sm[1]).trim();
      } catch {
        state = sm[1].trim();
      }
    }
    return { code, state };
  }
  // A bare code carries no spaces and no URL punctuation.
  if (/^[A-Za-z0-9._~-]{8,}$/.test(raw)) return { code: raw, state: "" };
  return { code: "", state: "" };
}

/**
 * Exchange a desktop_auth code for the account's long-lived API key.
 * Throws an Error carrying the upstream message on failure.
 *
 * 2026-11-16 协议修正:官方桌面端回调同时携带 code 与 state(64 hex),
 * exchange 发 {code, state} —— 只发 {code} 会被上游判 invalid(此前浏览器
 * 流换出的 key 被 /theos 判 auth_required 的另一可疑根因)。旧单参调用
 * (state 为空)仍兼容:仅在有 state 时附带。
 */
export async function exchangeDeepaiCode(code, { fetchImpl = fetch, state = "" } = {}) {
  const value = String(code ?? "").trim();
  if (!value) throw new Error("empty-code");
  const payloadBody = { code: value };
  const stateValue = String(state ?? "").trim();
  if (stateValue) payloadBody.state = stateValue;
  const res = await fetchImpl(`${DEEPAI_API_BASE}/desktop_auth/exchange/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": DEEPAI_USER_AGENT,
    },
    body: JSON.stringify(payloadBody),
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
