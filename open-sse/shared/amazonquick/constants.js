/**
 * Amazon Quick (quick.aws.com) — site constants, URL builders and the
 * credential shape shared by the executor and the connection test.
 *
 * Wire facts, live-verified 2026-11-21 (browser-external curl replay of
 * the web client's own requests; full notes in
 * workspace/research_notes/aws-quick-provider-20261121/):
 *
 *   - Chat is ConversationService's Chat operation, POSTed through the
 *     same-origin qbsproxy:
 *       /sn/account/{awsAccountId}/qbsproxy/quicksight/accounts/{awsAccountId}/conversations/chat?mbtc={csrf}
 *     (the qbsproxy service segment is "quicksight", measured — the
 *     ConversationService smithy client is rewritten onto it).
 *   - Auth is the browser's same-domain cookie session: the full Cookie
 *     header is the credential. The web client adds NO Authorization
 *     header and does NO SigV4 signing on this path (its middleware
 *     stack explicitly removes both; the proxy handles signing
 *     server-side). It does send x-amzn-target: api and the csrf token
 *     (as the mbtc query param, and as x-amzn-csrf-token under a flag —
 *     we send both; the measured curl carried both and was accepted).
 *   - Responses are AWS EventStream binary frames
 *     (application/x-amz-eventstream): textMessageEvent deltas plus a
 *     metadataEvent whose finalTextMessage is the calibrated full text.
 *     There is no CreateConversation operation — a new conversation's
 *     id arrives in the x-amzn-conversation-id response header and in
 *     the event payloads.
 *
 * Credential shape (resolved by resolveAmazonQuickCredentials):
 *   cookie       — full Cookie header of a logged-in quick.aws.com
 *                  session.
 *   awsAccountId — the numeric account id in the page URL
 *                  (/sn/account/<id>/…) and in every qbsproxy path.
 *   csrf         — the mbtc value from any qbsproxy request URL.
 *
 * The dashboard form is a single paste box: the user pastes a whole
 * "Copy as cURL" command from a logged-in tab into the connection's
 * credential field and the three values are extracted from it at
 * resolve time (parseAmazonQuickCurl). The original three-field
 * storage (cookie in the credential field, awsAccountId + csrf in
 * providerSpecificData, or an explicit PSD cookie) still resolves —
 * existing connections keep working untouched.
 *
 * There is no refresh path: when the web session dies, chat answers
 * 401/403 and the user pastes a fresh Copy as cURL. The executor never
 * tries to renew the session.
 */

export const AMAZONQUICK_WEB_BASE = "https://quick.aws.com";

/** qbsproxy service segment for ConversationService + metering (measured). */
export const AMAZONQUICK_QBSPROXY_SERVICE = "quicksight";

/** chatConfig surface for the regular web experience (measured). */
export const AMAZONQUICK_SURFACE_TYPE = "WEB_EXPERIENCE";

/**
 * Browser-class UA, mirroring the other web-session executors
 * (perplexity-web precedent): the session cookie was minted by a real
 * browser, and the edge is happier when the replay looks like one.
 */
export const AMAZONQUICK_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function qbsProxyBase(awsAccountId) {
  return `${AMAZONQUICK_WEB_BASE}/sn/account/${awsAccountId}/qbsproxy/${AMAZONQUICK_QBSPROXY_SERVICE}/accounts/${awsAccountId}`;
}

/** Chat operation URL (POST, EventStream response). */
export function amazonQuickChatUrl(awsAccountId, csrf) {
  return `${qbsProxyBase(awsAccountId)}/conversations/chat?mbtc=${encodeURIComponent(csrf || "")}`;
}

/** ListConversations URL (GET) — the connection test's read-only probe. */
export function amazonQuickListConversationsUrl(awsAccountId, csrf) {
  return `${qbsProxyBase(awsAccountId)}/conversations?mbtc=${encodeURIComponent(csrf || "")}`;
}

// TODO(usage): agent-hours usage is GetAvailableEntitlementUnitsExternal —
// GET /agenticmetering/v1/get-available-entitlement-units through the
// same qbsproxy — but it requires the account's userArn as a query
// param, and nothing in the cookie session exposes the userArn to the
// gateway. Do not fabricate one; wire usage once a source for it exists
// (response shape: entitlements[].{numMinsProvisioned,numMinsAvailable,
// freeTierUsages[]} — see the blueprint's usage section).

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Heuristic: does this string look like a pasted "Copy as cURL"
 * command (as opposed to a bare Cookie header)? Requires the curl
 * word plus at least one flag the harvest needs, so a cookie value
 * that merely contains the substring "curl" is never misread.
 */
export function looksLikeAmazonQuickCurl(text) {
  if (typeof text !== "string") return false;
  return /(?:^|\s)curl(?:\s|$)/.test(text) && /(?:-H|--header|-b|--cookie)(?:\s|$)/.test(text);
}

/**
 * Extract { cookie, awsAccountId, csrf } from a whole pasted
 * "Copy as cURL" command. Sources, in the order browsers emit them:
 *   cookie       — the -b / --cookie argument, else a "cookie:" header
 *   awsAccountId — the /sn/account/<id>/ (or /accounts/<id>/) segment
 *                  of the request URL
 *   csrf         — the mbtc= query parameter (URL-decoded), else an
 *                  x-amzn-csrf-token header
 * Anything not found comes back empty; the caller reports it as
 * missing rather than guessing.
 */
export function parseAmazonQuickCurl(text) {
  const out = { cookie: "", awsAccountId: "", csrf: "" };
  if (typeof text !== "string" || !text) return out;

  const account = text.match(/\/sn\/account\/(\d+)/) || text.match(/\/accounts\/(\d+)/);
  if (account) out.awsAccountId = account[1];

  const mbtc = text.match(/[?&]mbtc=([^&\s'"\\]+)/);
  if (mbtc) out.csrf = safeDecodeURIComponent(mbtc[1]).trim();

  const cookieFlag = text.match(/(?:^|\s)(?:-b|--cookie)\s+(?:'([^']*)'|"([^"]*)")/);
  if (cookieFlag) out.cookie = (cookieFlag[1] ?? cookieFlag[2] ?? "").trim();

  const headerRe = /(?:^|\s)-H\s+(?:'([^']*)'|"([^"]*)")/g;
  let headerMatch;
  while ((headerMatch = headerRe.exec(text)) !== null) {
    const header = (headerMatch[1] ?? headerMatch[2] ?? "").trim();
    const cookieHeader = header.match(/^cookie\s*:\s*(.+)$/i);
    if (cookieHeader && !out.cookie) out.cookie = cookieHeader[1].trim();
    const csrfHeader = header.match(/^x-amzn-csrf-token\s*:\s*(.+)$/i);
    if (csrfHeader && !out.csrf) out.csrf = csrfHeader[1].trim();
  }
  return out;
}

/**
 * Resolve the three credential values from a connection/executor
 * credentials object. Returns { cookie, awsAccountId, csrf, missing } —
 * `missing` names every field that came back empty so error messages
 * can tell the user exactly what to (re-)paste.
 *
 * Precedence: values extracted from a pasted Copy-as-cURL command
 * (the dashboard's single paste box stores it in the credential
 * field) win per-field — a fresh full capture is newer than any
 * leftover providerSpecificData. Without a curl paste, the original
 * shape applies: PSD cookie, then the credential field as the cookie,
 * with awsAccountId/csrf from PSD.
 */
export function resolveAmazonQuickCredentials(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const fromPsd = (v) => (typeof v === "string" ? v.trim() : "");
  const rawField = typeof credentials?.apiKey === "string" ? credentials.apiKey.trim() : "";
  const psdCookie = fromPsd(psd.cookie);
  const curlText = looksLikeAmazonQuickCurl(rawField)
    ? rawField
    : looksLikeAmazonQuickCurl(psdCookie)
      ? psdCookie
      : "";
  const fromCurl = curlText
    ? parseAmazonQuickCurl(curlText)
    : { cookie: "", awsAccountId: "", csrf: "" };
  const plainPsdCookie = psdCookie && psdCookie !== curlText ? psdCookie : "";
  const plainFieldCookie = rawField && rawField !== curlText ? rawField : "";
  const cookie = fromCurl.cookie || plainPsdCookie || plainFieldCookie;
  const awsAccountId = fromCurl.awsAccountId || fromPsd(psd.awsAccountId);
  const csrf = fromCurl.csrf || fromPsd(psd.csrf);
  const missing = [];
  if (!cookie) missing.push("cookie");
  if (!awsAccountId) missing.push("awsAccountId");
  if (!csrf) missing.push("csrf");
  return { cookie, awsAccountId, csrf, missing };
}

/** Headers every qbsproxy call carries (chat + test + future usage). */
export function buildAmazonQuickHeaders(creds) {
  return {
    "Content-Type": "application/json",
    "x-amzn-target": "api",
    "x-amzn-csrf-token": creds.csrf,
    Cookie: creds.cookie,
    "User-Agent": AMAZONQUICK_USER_AGENT,
  };
}
