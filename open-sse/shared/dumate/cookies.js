/*
 * DuMate (百度搭子) shared cookie utilities.
 *
 * A DuMate connection's apiKey stores the Baidu login cookies in one of three
 * paste/serialize formats:
 *   - "a=b; c=d" cookie header string (manual paste / document.cookie)
 *   - exported cookie JSON: [{name,value,domain}] or {cookies:[...]}
 *   - our own JSON: {src:"dumate-qr"|"dumate-import", v:1, account, savedAt, cookies:[...]}
 *
 * The passport subset (BDUSS/STOKEN/PTOKEN/UBI/…) on baidu.com /
 * passport.baidu.com is what powers silent renewal (session.js quickLogin);
 * bce-sessionid on console.bce.baidu.com is the live console session used for
 * the gateway token exchange. Never log cookie values.
 */

import { createHash } from "node:crypto";

export const PASSPORT_NAMES = [
  "BDUSS", "BDUSS_BFESS", "STOKEN", "PTOKEN", "UBI", "UBI_BFESS",
  "BAIDUID", "BAIDUID_BFESS", "PASSID",
];
// These are host cookies on passport.baidu.com, not .baidu.com domain cookies.
const PASSPORT_HOST_ONLY = new Set(["STOKEN", "PTOKEN", "UBI", "UBI_BFESS", "PASSID"]);

export const bare = (d) => String(d || "").replace(/^\./, "").toLowerCase();

export function isConsoleCookie(c) {
  if (!c || !c.name) return false;
  const d = bare(c.domain);
  if (c.name === "bce-sessionid") return !d || d === "bce.baidu.com" || d === "console.bce.baidu.com";
  return false;
}

export function isStorableCookie(c) {
  if (!c || !c.name || c.value == null || c.value === "") return false;
  if (isConsoleCookie(c)) return true;
  const d = bare(c.domain);
  if (d) return (d === "baidu.com" || d === "passport.baidu.com") && PASSPORT_NAMES.includes(c.name);
  return PASSPORT_NAMES.includes(c.name);
}

/** Minimal domain-aware cookie jar: name@domain -> {name,value,domain}. */
export class Jar {
  constructor() { this.m = new Map(); }
  add(name, value, domain) {
    if (!name || value == null || value === "") return;
    this.m.set(name + "@" + bare(domain), { name, value: String(value), domain: bare(domain) });
  }
  addSetCookie(setCookieHeaders, fromHost) {
    for (const s of setCookieHeaders || []) {
      const parts = String(s).split(";");
      const nv = parts[0];
      const i = nv.indexOf("=");
      if (i <= 0) continue;
      const name = nv.slice(0, i).trim();
      const value = nv.slice(i + 1).trim();
      if (!value) continue;
      let domain = fromHost;
      for (const p of parts.slice(1)) {
        const j = p.indexOf("=");
        if (j > 0 && /^domain$/i.test(p.slice(0, j).trim())) domain = p.slice(j + 1).trim();
      }
      this.add(name, value, domain);
    }
  }
  /** cookies a browser would send to `host` (host == domain or host is a subdomain) */
  forHost(host) {
    const h = bare(host);
    return [...this.m.values()].filter((c) => h === c.domain || h.endsWith("." + c.domain));
  }
  header(host) { return this.forHost(host).map((c) => `${c.name}=${c.value}`).join("; "); }
  all() { return [...this.m.values()]; }
  has(name) { return [...this.m.values()].some((c) => c.name === name && c.value); }
}

/** Parse a pasted/stored credential into [{name,value,domain?}]. */
export function parseCookies(input) {
  let s = String(input ?? "").trim();
  if (!s) return [];
  if (s[0] === "[" || s[0] === "{") {
    let j;
    try { j = JSON.parse(s); } catch { j = null; }
    if (j) {
      let arr = Array.isArray(j) ? j : Array.isArray(j.cookies) ? j.cookies : null;
      if (!arr && typeof j === "object") arr = Object.entries(j).map(([name, value]) => ({ name, value: String(value) }));
      return (arr || [])
        .filter((c) => c && typeof c.name === "string" && c.name && c.value != null)
        .map((c) => ({ name: c.name.trim(), value: String(c.value), domain: c.domain || undefined }));
    }
  }
  s = s.replace(/^cookie\s*:\s*/i, "");
  const out = [];
  for (const part of s.split(/;\s*|\r?\n/)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (name) out.push({ name, value: part.slice(i + 1).trim() });
  }
  return out;
}

export const cookieHeader = (arr) => arr.filter((c) => c.name).map((c) => `${c.name}=${c.value}`).join("; ");

/** Keep only what the provider needs: the console session + the passport set. */
export function keepCookie(c) {
  if (c && c.value == null) {
    if (isConsoleCookie(c)) return true;
    const d = bare(c.domain);
    return PASSPORT_NAMES.includes(c.name) && (d === "baidu.com" || d === "passport.baidu.com");
  }
  return isStorableCookie(c);
}

export function slimCookie(c) {
  const o = { name: c.name, value: c.value, domain: c.domain, path: c.path || "/" };
  if (typeof c.expires === "number" && c.expires > 0) o.expires = Math.round(c.expires);
  if (c.httpOnly) o.httpOnly = true;
  if (c.secure) o.secure = true;
  if (c.sameSite) o.sameSite = c.sameSite;
  return o;
}

export function serializeCreds(cookies, account, src) {
  return JSON.stringify({
    src: src || "dumate-qr",
    v: 1,
    account: account || undefined,
    savedAt: new Date().toISOString(),
    cookies: cookies.map(slimCookie),
  });
}

/** Passport cookies out of any supported credential format (for renewal). */
export function passportCookies(raw) {
  const s = String(raw ?? "").trim();
  let arr = null;
  if (s[0] === "{" || s[0] === "[") {
    try {
      const j = JSON.parse(s);
      arr = Array.isArray(j) ? j : Array.isArray(j.cookies) ? j.cookies : null;
    } catch { /* fall through to header-string parse */ }
  }
  if (arr) {
    return arr
      .filter((c) => c && c.name && c.value != null && PASSPORT_NAMES.includes(c.name) && !/^bce/i.test(c.name) &&
        (c.domain ? ["baidu.com", "passport.baidu.com"].includes(bare(c.domain)) : true))
      .map((c) => c.domain
        ? slimCookie(c)
        : { name: c.name, value: String(c.value), domain: PASSPORT_HOST_ONLY.has(c.name) ? "passport.baidu.com" : ".baidu.com", path: "/" });
  }
  const out = [];
  for (const part of s.replace(/^cookie\s*:\s*/i, "").split(/;\s*|\r?\n/)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (PASSPORT_NAMES.includes(name)) {
      out.push({ name, value: part.slice(i + 1).trim(), domain: PASSPORT_HOST_ONLY.has(name) ? "passport.baidu.com" : ".baidu.com", path: "/" });
    }
  }
  return out;
}

export const hasPassport = (raw) =>
  passportCookies(raw).some((c) => c.name === "BDUSS" || c.name === "BDUSS_BFESS");

export function passportKey(raw) {
  const b = passportCookies(raw)
    .filter((c) => c.name === "BDUSS" || c.name === "BDUSS_BFESS")
    .map((c) => c.value)
    .sort()
    .join("|");
  return b ? createHash("sha256").update(b).digest("hex").slice(0, 24) : null;
}

export function accountFrom(raw) {
  try { const j = JSON.parse(raw); return j && j.account; } catch { return undefined; }
}
