/*
 * DuMate gateway token exchange + silent cookie renewal.
 *
 *   POST https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions  (OpenAI-compatible)
 * requires a gateway token obtained from
 *   GET https://console.bce.baidu.com/api/dumate/app/token/get  -> {code:0,result:{token,expired_at}}
 * using the console session cookies. The token lives ~12h; it is cached
 * (keyed by a hash of the stored credential) and re-exchanged 10 min early.
 *
 * When the console session is dead ("not logged in": 302 / login page / 401)
 * but the credential still holds passport cookies, tokenFor() runs one silent
 * relogin through session.js quickLogin and returns the new cookie blob as
 * `raw` — the caller persists it as the connection's new apiKey (see the
 * executor's refreshCredentials, whose return value is persisted by chatCore).
 *
 * Failures that mean the underlying Baidu login is dead carry .expired=true
 * (.reauth bubbles up from session.js); other failures are transient.
 */

import { createHash } from "node:crypto";
import { parseCookies, cookieHeader, bare, keepCookie, slimCookie, serializeCreds, passportCookies, hasPassport, passportKey, accountFrom, isConsoleCookie } from "./cookies.js";
import { quickLogin } from "./session.js";
import { httpGet } from "./http.js";

const CONSOLE = "console.bce.baidu.com";
const TOKEN_PATH = "/api/dumate/app/token/get";
export const GATEWAY = "https://dumate-svc.baidu.com/gateway/apis/v1";
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const EARLY_MS = 10 * 60_000;
const MAX_TTL_MS = 12 * 3600_000;
const FAIL_BACKOFF_MS = 5 * 60_000;
const RENEWED_TTL_MS = 6 * 3600_000;

export const REAUTH_MSG =
  "Baidu login expired — re-authenticate this connection (QR login or paste fresh cookies from a logged-in baidu.com session)";

const log = (msg) => { try { console.log(`[dumate] ${msg}`); } catch { /* noop */ } };

const expiredError = (msg) => Object.assign(new Error(msg || REAUTH_MSG), { expired: true });

const cookieKey = (raw) => createHash("sha256").update(String(raw || "")).digest("hex").slice(0, 24);

/** cookie blob -> {token, exp} ; throws .expired when the login session is dead. */
export async function exchangeToken(rawCookie, { proxyOptions = null } = {}) {
  const arr = parseCookies(rawCookie);
  if (!arr.length) {
    throw Object.assign(expiredError("no cookies parsed — paste a Cookie header string or an exported cookies JSON"), { parse: true });
  }
  // Only send what a browser would send to console.bce.baidu.com — QR-login
  // creds also carry passport.baidu.com cookies that must not leak there.
  const sendable = arr.filter(isConsoleCookie);
  if (!sendable.length) throw expiredError("no console session cookie — login state needs renewal");
  const r = await httpGet(`https://${CONSOLE}${TOKEN_PATH}`, {
    timeoutMs: 25_000,
    proxyOptions,
    jar: { header: () => cookieHeader(sendable), addSetCookie() {} },
    headers: { Accept: "application/json", Referer: `https://${CONSOLE}/` },
  });
  if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) throw expiredError();
  let p;
  try { p = JSON.parse(r.body); } catch { throw new Error("DuMate token exchange returned invalid JSON"); }
  if (p?.code !== 0 || !p?.result?.token) {
    const m = typeof p?.message === "object" ? (p.message.global || JSON.stringify(p.message)) : (p?.message || p?.code);
    if (/登录|login|未授权|unauthori|过期|expire/i.test(String(m))) throw expiredError();
    throw new Error("DuMate token exchange failed: " + String(m).slice(0, 200));
  }
  const exp = Date.parse(p.result.expired_at || "");
  const expMs = Math.min(Number.isFinite(exp) ? exp : Date.now() + 3600_000, Date.now() + MAX_TTL_MS);
  return { token: p.result.token, exp: expMs };
}

const cache = new Map(); // cookieKey -> {t, exp, pending}
export async function getToken(rawCookie, force = false, proxyOptions = null) {
  const k = cookieKey(rawCookie);
  const c = cache.get(k) || {};
  if (!force && c.t && Date.now() < c.exp - EARLY_MS) return { token: c.t, exp: c.exp, fresh: false };
  if (c.pending) return c.pending;
  const pending = exchangeToken(rawCookie, { proxyOptions })
    .then((r) => { cache.set(k, { t: r.token, exp: r.exp }); return { token: r.token, exp: r.exp, fresh: true }; })
    .finally(() => { const cur = cache.get(k); if (cur && cur.pending === pending) delete cur.pending; });
  cache.set(k, { ...c, pending });
  return pending;
}

/* ---------------- silent relogin via passport cookies ---------------- */
const renewed = new Map();   // cookieKey(old raw) -> {raw: new raw, at}
const renewing = new Map();  // passportKey -> Promise<new raw>
const renewFail = new Map(); // passportKey -> {at, err} (back-off after a failed relogin)

function latestRaw(raw) {
  let r = raw;
  for (let i = 0; i < 5; i++) {
    const n = renewed.get(cookieKey(r));
    if (!n || Date.now() - n.at > RENEWED_TTL_MS) break;
    r = n.raw;
  }
  return r;
}

/**
 * One silent relogin: passport cookies -> quickLogin -> fresh console session.
 * Returns the serialized new credential. Concurrent renewals for the same
 * passport coalesce; failures back off for FAIL_BACKOFF_MS so a dead passport
 * doesn't spam Baidu on every request.
 */
export async function renewCookies(raw, logLine, proxyOptions = null) {
  const pk = passportKey(raw);
  const f = renewFail.get(pk);
  if (f && Date.now() - f.at < FAIL_BACKOFF_MS) throw f.err;
  if (renewing.has(pk)) return renewing.get(pk);
  const p = (async () => {
    try {
      const t0 = Date.now();
      const pp = passportCookies(raw);
      const { cookies, account } = await quickLogin(pp, proxyOptions);
      const kept = cookies.filter(keepCookie);
      if (!kept.some((c) => c.name === "bce-sessionid" && c.value)) {
        throw new Error("quick-login produced no bce-sessionid");
      }
      const names = new Set(kept.map((c) => c.name + "@" + bare(c.domain)));
      for (const c of pp) if (!names.has(c.name + "@" + bare(c.domain))) kept.push(slimCookie(c));
      const nraw = serializeCreds(kept, account || accountFrom(raw));
      renewed.set(cookieKey(raw), { raw: nraw, at: Date.now() });
      renewFail.delete(pk);
      log(`silent relogin ok in ${Math.round((Date.now() - t0) / 1000)}s (${kept.length} cookies)`);
      return nraw;
    } catch (e) {
      if (!e.reauth) {
        log(`silent relogin transient failure: ${String(e.message).slice(0, 160)}`);
        throw e;
      }
      const err = expiredError(e.message);
      if (!e.busy) renewFail.set(pk, { at: Date.now(), err });
      log(`silent relogin failed: ${String(e.message).slice(0, 160)}`);
      throw err;
    }
  })().finally(() => renewing.delete(pk));
  renewing.set(pk, p);
  return p;
}

/**
 * Token for a stored credential. On "not logged in" with a usable passport,
 * performs one silent relogin and returns {token, exp, raw, renewed:true} —
 * `raw` is the new credential the caller must persist (apiKey).
 */
export async function tokenFor(rawIn, { force = false, proxyOptions = null } = {}) {
  let raw = latestRaw(rawIn);
  try {
    const r = await getToken(raw, force, proxyOptions);
    return { ...r, raw };
  } catch (e) {
    if (!e.expired || e.parse || !hasPassport(raw)) throw e;
    raw = await renewCookies(raw, undefined, proxyOptions);
    const r = await getToken(raw, true, proxyOptions);
    return { ...r, raw, renewed: true };
  }
}

/** Test hooks: in-memory state the unit tests can inspect/reset. */
export const _tokenState = { cache, renewed, renewing, renewFail };
