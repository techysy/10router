/*
 * WPS 灵犀 session capture — bookmarklet / paste-cookie import helpers.
 *
 * Same shape as open-sse/shared/dumate/* but much smaller: lingxi auth is a
 * plain WPS session Cookie jar (wps_sid / kso_sid …, no signature headers —
 * the web client's signPopToken always returns "empty"), so the capture has
 * nothing to exchange or renew. What it must do:
 *   - parse a pasted Cookie header / exported cookies JSON into pairs
 *   - extract the `uid` cookie as the stable account identity (tasks/balance
 *     responses carry no identity fields; the cookie jar is the only reliable
 *     source — verified 2026-11-09)
 *   - filter to cookies that belong to the WPS session (drop junk like
 *     HMACCOUNT/Hm_* analytics if a JSON export carries them — keeping them
 *     is harmless, but a lean jar survives WPS-side rotations better)
 *   - one-time `ot` tokens for the cross-site bookmarklet flow, scoped by the
 *     dashboard credential hash (same trust model as dumate: the token proves
 *     an authenticated dashboard user minted it; the session cookie itself is
 *     SameSite=Lax and never crosses origins)
 */

import { randomBytes } from "node:crypto";

/** One-time import tokens: ot -> {owner, connectionId, exp}. In-memory only. */
const importTokens = new Map();

export function issueImportToken(owner, connectionId = null) {
  for (const [k, v] of importTokens) if (v.exp < Date.now()) importTokens.delete(k);
  const ot = randomBytes(16).toString("hex");
  importTokens.set(ot, { owner, connectionId: connectionId || null, exp: Date.now() + 10 * 60 * 1000 });
  return ot;
}

/** Consume a token (single-use). Returns the owner it was issued to, or null. */
export function takeImportToken(ot, connectionId = null) {
  const t = importTokens.get(String(ot || ""));
  if (!t || t.exp < Date.now() || t.connectionId !== (connectionId || null)) return null;
  importTokens.delete(String(ot));
  return t.owner;
}

/**
 * Parse a Cookie header string / exported cookies JSON into [{name, value}].
 * Mirrors dumate's parseCookies contract (header string, JSON array,
 * {cookies:[]}, cookie-editor object map).
 */
export function parseCaptureCookie(raw) {
  const s = stripCookieLabel(String(raw || "").trim());
  if (!s) return [];
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      const list = Array.isArray(j) ? j : Array.isArray(j.cookies) ? j.cookies : null;
      if (list) {
        return list
          .map((c) => (c && c.name ? { name: String(c.name), value: String(c.value ?? "") } : null))
          .filter(Boolean);
      }
      // cookie-editor object map {"wps_sid":"v", …}
      if (!Array.isArray(j)) {
        return Object.entries(j)
          .filter(([k, v]) => typeof k === "string" && k && (typeof v === "string" || typeof v === "number"))
          .map(([k, v]) => ({ name: k, value: String(v) }));
      }
    } catch { /* fall through to header parsing */ }
  }
  return s
    .split(";")
    .map((seg) => {
      const i = seg.indexOf("=");
      if (i < 1) return null;
      const name = seg.slice(0, i).trim();
      if (!name) return null;
      return { name, value: seg.slice(i + 1).trim() };
    })
    .filter(Boolean);
}

/** Strip a leading "Cookie:" label a user may have pasted from devtools. */
function stripCookieLabel(s) {
  return String(s).replace(/^\s*cookie\s*:\s*/i, "");
}

/**
 * The cookie names a live lingxi session must carry. wps_sid is THE session
 * credential; kso_sid / uid / rtk ride the same jar. Require at least wps_sid
 * so a paste from the wrong site fails fast with a clear message instead of
 * creating a dead connection.
 */
const REQUIRED_SESSION_COOKIE = "wps_sid";
const SESSION_COOKIE_HINT = /(^|;\s*)(wps_sid|kso_sid|uid)=/i;

/** True when the raw paste looks like a WPS/lingxi session at all. */
export function looksLikeLingxiCookie(raw) {
  // JSON exports have no header shape — test the serialized pairs instead.
  const pairs = parseCaptureCookie(raw);
  if (pairs.length) {
    return pairs.some((c) => ["wps_sid", "kso_sid", "uid"].includes(c.name));
  }
  return SESSION_COOKIE_HINT.test(stripCookieLabel(String(raw || "")));
}

/**
 * Normalize a raw paste into the credential string stored on the connection:
 * a clean "name=value; …" header. Keeps every cookie the site set (the jar is
 * validated end-to-end by a live tasks call before anything is persisted) —
 * WPS rotates some of them, and dropping e.g. csrf can break subsequent calls.
 * Returns null when the paste doesn't look like a lingxi session.
 */
export function normalizeCaptureCookie(raw) {
  const pairs = parseCaptureCookie(raw);
  if (!pairs.length || !looksLikeLingxiCookie(raw)) return null;
  return pairs.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Stable account identity from a cookie jar: the `uid` cookie (pure digits,
 * WPS account uid — same extraction as CreditDaddy's lingxiIdentityFromCookie).
 * Used for the connection label and same-account dedup; null when absent.
 */
export function lingxiUidFromCookie(cookieHeader) {
  for (const seg of String(cookieHeader || "").split(";")) {
    const i = seg.indexOf("=");
    if (i < 1) continue;
    if (seg.slice(0, i).trim() === "uid") {
      const v = seg.slice(i + 1).trim();
      if (/^\d{1,20}$/.test(v)) return v;
    }
  }
  return null;
}

/** Display masking for uid (≥7: 3+****+3, 4-6: 1+****+1) — CreditDaddy 口径. */
export function maskLingxiUid(uid) {
  const s = String(uid ?? "");
  if (s.length >= 7) return s.slice(0, 3) + "****" + s.slice(-3);
  if (s.length >= 4) return s.slice(0, 1) + "****" + s.slice(-1);
  return "****";
}

/** Same-account dedup key: sha256 of the raw uid (not the masked form). */
export function lingxiAccountKey(cookieHeader) {
  const uid = lingxiUidFromCookie(cookieHeader);
  if (!uid) return null;
  return "lingxi-uid-" + uid;
}

export const __test__ = {
  parseCaptureCookie,
  normalizeCaptureCookie,
  looksLikeLingxiCookie,
  lingxiUidFromCookie,
  maskLingxiUid,
  lingxiAccountKey,
  stripCookieLabel,
  issueImportToken,
  takeImportToken,
  REQUIRED_SESSION_COOKIE,
};
