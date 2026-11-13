/*
 * DuMate QR-code login — pure HTTP reimplementation of the Baidu Passport
 * (tangram) QR flow. No headless browser anywhere.
 *
 *   1. GET passport.baidu.com/v2/api/getqrcode?tpl=bceplat&gid=<guid>&callback=<jsonp>
 *        -> {sign, imgurl}
 *   2. GET /v2/api/qrcode?sign=..&lp=pc&qrloginfrom=pc   -> QR PNG (fetched
 *        server-side; the dashboard gets a data URI, so the client never needs
 *        direct access to passport.baidu.com)
 *   3. GET /channel/unicast?channel_id=<sign>&tpl=bceplat   (30s long-poll)
 *        errno==1                        -> keep waiting
 *        errno==0 && channel_v.status==1 -> scanned, awaiting confirm
 *        errno==0 && channel_v.status==0 -> confirmed -> step 4
 *        errno==50000                    -> risk-control block
 *   4. GET /v3/login/main/qrbdusslogin?bduss=<channel_v.v>&u=<enc(channel_v.u)>&...
 *        -> errInfo.no==0, Set-Cookie drops the passport cookies
 *        (BDUSS/STOKEN/PTOKEN/UBI/BAIDUID); data.u is the return URL
 *   5. Follow data.u into console.bce.baidu.com -> bce-sessionid; when missing,
 *      fall back to session.js quickLogin (the same verified wap chain).
 *   6. Keep bce-sessionid + the passport cookies, serialized as the
 *      connection's apiKey credential.
 *
 * qrbdusslogin quirks found while reverse-engineering the SDK:
 *   - `u` is single-encoded on the wire (the SDK decodeURIComponent's
 *     channel_v.u, then the jsonp layer encodes it once). Double-encoding it
 *     makes Baidu answer errInfo.no=200.
 *   - channel_v.u can be empty — the SDK falls back to the page's configured
 *     return URL; we use the DuMate console URL the same way.
 *   - apiver/tt/lang/maskId/fileId are auto-appended SDK params; without them
 *     the same errInfo.no=200 comes back.
 *   - The response is JSONP wrapping a JS object literal with single-quoted
 *     keys — strict JSON.parse fails, so fields are extracted with tolerant
 *     regexes as fallback.
 *   - The QR PNG is a 1-bit transparent image that is invisible on dark
 *     backgrounds — the UI always renders it on white.
 *
 * Session status contract (polled by the dashboard modal):
 *   starting | waiting | scanned | confirming | authorized | saving |
 *   success | expired | cancelled | error
 * `authorized` means the credential is in s.creds and the caller (API route)
 * should persist+test it, then finish(s,"success").
 */

import https from "node:https";
import { randomBytes, createHash } from "node:crypto";
import { Jar, keepCookie, serializeCreds, slimCookie, bare, parseCookies, passportCookies, PASSPORT_NAMES } from "./cookies.js";
import { quickLogin, portrait, CONSOLE_URL, UA } from "./session.js";

const QR_TTL_MS = 10 * 60_000; // Baidu QR codes live about 10 minutes
const SESSION_KEEP_MS = 15 * 60_000;

const log = (lvl, msg) => { try { console[lvl === "warn" ? "warn" : "log"](`[dumate-qr] ${msg}`); } catch { /* noop */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpsGet(url, jar, timeoutMs, s) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request(
      {
        host: u.host,
        path: u.pathname + u.search,
        method: "GET",
        timeout: timeoutMs,
        headers: { "User-Agent": UA, Accept: "*/*", Referer: "https://login.bce.baidu.com/", Cookie: jar ? jar.header(u.hostname) : "" },
      },
      (res) => {
        if (jar) jar.addSetCookie(res.headers["set-cookie"], u.hostname);
        const ch = [];
        res.on("data", (d) => ch.push(d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch) }));
      },
    );
    if (s) s.req = r;
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", (e) => { if (s && s.cancelled) return resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }); reject(e); });
    r.end();
  });
}

const unjsonp = (t) => { const m = /^[^(]*\(([\s\S]*)\)\s*;?\s*$/.exec(t); return JSON.parse(m ? m[1] : t); };
// qrbdusslogin answers with a JS object literal ('data': single-quoted key) —
// strict JSON.parse throws, so fields get a regex fallback.
const jsoNo = (t) => { const m = /"no"\s*:\s*"?\s*(-?\d+)/.exec(t); return m ? +m[1] : null; };
const jsoU = (t) => { const m = /"u"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t); return m ? m[1].replace(/\\\//g, "/").replace(/\\\\/g, "\\") : null; };
const guid = () => [7, 4, 4, 4, 12].map((n) => randomBytes(8).toString("hex").toUpperCase().slice(0, n)).join("-");
const logPage = () => encodeURIComponent(`traceId:pc_loginv5_${Math.floor(Date.now() / 1000)},logPage:loginv5`);

async function runQr(s) {
  const jar = new Jar();
  const GID = guid(), CB = "tangram_guid_" + Date.now(), LP = logPage();
  try {
    // 1) getqrcode
    const r1 = await httpsGet(
      `https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrloginfrom=pc&gid=${GID}&callback=${CB}&apiver=v3&tt=${Date.now()}&tpl=bceplat&logPage=${LP}&_=${Date.now()}`,
      jar, 20_000, s);
    if (s.cancelled) return;
    let j1 = null; try { j1 = unjsonp(r1.body.toString("utf8")); } catch { /* handled below */ }
    if (!j1 || +j1.errno !== 0 || !j1.sign) throw new Error("QR generation failed: errno=" + (j1 ? j1.errno : r1.status));
    const sign = j1.sign;

    // 2) QR image (server-side fetch -> data URI)
    const imgUrl =
      "https://" + String(j1.imgurl || "passport.baidu.com/v2/api/qrcode?sign=" + sign).replace(/^https?:\/\//, "") +
      `&lp=pc&qrloginfrom=pc&logPage=${LP}`;
    const r2 = await httpsGet(imgUrl, jar, 20_000, s);
    if (s.cancelled) return;
    if (r2.status !== 200 || !/image/.test(String(r2.headers["content-type"] || ""))) {
      throw new Error("QR image fetch failed: HTTP " + r2.status);
    }
    s.qr = "data:image/png;base64," + r2.body.toString("base64");
    s.expiresAt = Date.now() + QR_TTL_MS;
    s.status = "waiting";
    log("info", `QR (http) ready for session ${s.id.slice(0, 6)}`);

    // 3) unicast long-poll until confirmed / expired / cancelled
    let cv = null, errs = 0;
    while (!s.cancelled) {
      if (Date.now() > s.expiresAt) { finish(s, "expired"); return; }
      let d = null;
      try {
        const r3 = await httpsGet(
          `https://passport.baidu.com/channel/unicast?channel_id=${sign}&gid=${GID}&tpl=bceplat&_sdkFrom=1&callback=${CB}&apiver=v3&tt=${Date.now()}&_=${Date.now()}`,
          jar, 40_000, s);
        if (s.cancelled) return;
        d = unjsonp(r3.body.toString("utf8"));
        errs = 0;
      } catch (e) {
        if (s.cancelled) return;
        if (++errs >= 5) throw new Error("scan-status polling failed: " + e.message);
        await sleep(2000); continue;
      }
      if (+d.errno === 50000) throw new Error("Baidu risk control blocked this QR login — retry later or use cookie import");
      let cvo = null; try { cvo = typeof d.channel_v === "string" ? JSON.parse(d.channel_v) : d.channel_v; } catch { /* keep polling */ }
      if (cvo && +cvo.status === 0) { cv = cvo; break; }
      if (cvo && +cvo.status === 1 && s.status === "waiting") s.status = "scanned";
    }
    if (s.cancelled || !cv || !cv.v) {
      if (!s.cancelled) finish(s, "error", "login confirmed but no ticket was returned");
      return;
    }
    s.status = "confirming";

    // 4) qrbdusslogin — drops the passport cookies; empty cv.u falls back to
    // the console URL (same as the SDK's me.config.u default)
    const r4 = await httpsGet(
      `https://passport.baidu.com/v3/login/main/qrbdusslogin?v=${Date.now()}` +
        `&bduss=${encodeURIComponent(cv.v)}&u=${encodeURIComponent(cv.u || CONSOLE_URL)}` +
        `&loginVersion=v5&qrcode=1&tpl=bceplat&maskId=&fileId=&lang=&apiver=v3&tt=${Date.now()}&callback=${CB}&_=${Date.now()}`,
      jar, 20_000, s);
    if (s.cancelled) return;
    const body4 = r4.body.toString("utf8");
    let j4 = null; try { j4 = unjsonp(body4); } catch { /* object-literal body — regex fallback below */ }
    const no = j4 && j4.errInfo ? +j4.errInfo.no : jsoNo(body4);
    if (no !== 0) throw new Error("login confirm failed: errInfo.no=" + (no == null ? r4.status : no));
    const ret = (j4 && j4.data && j4.data.u) || jsoU(body4) || cv.u;

    // 5) follow the return-URL chain into console.bce.baidu.com
    if (ret) {
      let url = ret;
      for (let hop = 0; hop < 10; hop++) {
        const rr = await httpsGet(url, jar, 20_000, s);
        if (s.cancelled) return;
        const loc = rr.headers.location;
        if (!loc) break;
        url = new URL(loc, url).href;
      }
    }

    // 6) bce-sessionid missing -> the verified quick-login chain as fallback
    if (!jar.has("bce-sessionid")) {
      const pp = jar.all().filter((c) => PASSPORT_NAMES.includes(c.name));
      if (pp.some((c) => c.name === "BDUSS" || c.name === "BDUSS_BFESS")) {
        const out = await quickLogin(pp);
        for (const c of out.cookies) jar.add(c.name, c.value, c.domain);
      }
    }
    const kept = jar.all().filter(keepCookie);
    if (!kept.some((c) => c.name === "bce-sessionid" && c.value)) {
      throw new Error("QR login succeeded but no console session was established (missing bce-sessionid)");
    }
    if (!kept.some((c) => c.name === "BDUSS" || c.name === "BDUSS_BFESS")) {
      log("warn", "QR login without BDUSS cookie: silent renewal will not be possible");
    }
    let account;
    try { const p = await portrait(kept); account = p && p.username; } catch { /* cosmetic only */ }
    s.creds = serializeCreds(kept, account);
    if (!s.connectionId && account) s.connName = `DuMate 百度搭子（${account}）`;
    s.status = "authorized";
    log("info", `QR login (http) ok for session ${s.id.slice(0, 6)} (${kept.length} cookies)`);
  } catch (e) {
    if (!s.cancelled) {
      finish(s, "error", String(e && e.message || e).split("\n")[0].slice(0, 200));
      log("warn", `QR session ${s.id.slice(0, 6)} failed: ${s.error}`);
    }
  } finally {
    if (s.cancelled && !s.doneAt) finish(s, "cancelled");
    s.req = null;
  }
}

/* ---------------- sessions ---------------- */
const sessions = new Map();

function gc() {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.doneAt && now - s.doneAt > SESSION_KEEP_MS) sessions.delete(k);
}

export function finish(s, status, error) {
  if (s.doneAt && s.status !== "authorized") return;
  s.status = status;
  if (error) s.error = error;
  s.doneAt = Date.now();
}

export function pub(s) {
  const o = { sid: s.id, status: s.status, connectionId: s.connectionId || null };
  if (s.qr && ["waiting", "scanned", "confirming"].includes(s.status)) { o.qr = s.qr; o.expiresAt = s.expiresAt; }
  if (s.error) o.error = s.error;
  if (s.tokenExpiresAt) o.tokenExpiresAt = s.tokenExpiresAt;
  if (s.connectionName) o.connectionName = s.connectionName;
  return o;
}

export const ownerHash = (headers) =>
  createHash("sha256").update(String(headers.cookie || "") + "\n" + String(headers.authorization || "")).digest("hex");

export function getSession(sid, owner) {
  gc();
  const s = sessions.get(String(sid || ""));
  if (!s || s.owner !== owner) return null;
  return s;
}

/** Start a new QR session; any still-open session owned by the same caller is cancelled. */
export function startSession({ connectionId = null, owner }) {
  gc();
  for (const s of sessions.values()) {
    if (s.owner === owner && !s.doneAt) {
      s.cancelled = true;
      finish(s, "cancelled");
      if (s.req) try { s.req.destroy(); } catch { /* noop */ }
    }
  }
  const s = { id: randomBytes(12).toString("hex"), owner, connectionId, status: "starting", startedAt: Date.now() };
  sessions.set(s.id, s);
  runQr(s); // async — progresses via status polling
  return s;
}

export function cancelSession(s) {
  if (!s.doneAt && s.status !== "saving") {
    s.cancelled = true;
    finish(s, "cancelled");
    if (s.req) try { s.req.destroy(); } catch { /* noop */ }
  }
  return s;
}

/* ---------------- bookmarklet one-time import tokens ----------------
 * auth_token is SameSite=Lax + httpOnly: a cross-site bookmarklet POST from
 * *.baidu.com cannot carry it. import-init (session-authed) mints a one-shot
 * token the bookmarklet replays instead. */
const importTokens = new Map(); // ot -> {owner, exp}
export function issueImportToken(owner) {
  for (const [k, v] of importTokens) if (v.exp < Date.now()) importTokens.delete(k);
  const ot = randomBytes(16).toString("hex");
  importTokens.set(ot, { owner, exp: Date.now() + 10 * 60 * 1000 });
  return ot;
}
/** Consume a token (single-use). Returns the owner it was issued to, or null. */
export function takeImportToken(ot) {
  const t = importTokens.get(String(ot || ""));
  if (!t || t.exp < Date.now()) return null;
  importTokens.delete(String(ot));
  return t.owner;
}

/* ---------------- cookie import (paste / bookmarklet) ----------------
 * Turns pasted cookies into a stored credential. Path 1: the paste already
 * holds a console session (bce-sessionid) -> validated by the caller's token
 * exchange. Path 2: passport cookies only -> quickLogin bootstraps the console
 * session first. Returns {creds, account} or throws with a user-facing message. */
export async function importCookies(rawIn) {
  const parsed = parseCookies(rawIn);
  if (!parsed.length) throw new Error("no cookies parsed — paste `BDUSS=xx; BAIDUID=yy` or an exported cookies JSON");

  // Path 1: full export already containing the console session
  if (parsed.some((c) => c.name === "bce-sessionid" && c.value)) {
    const { exchangeToken } = await import("./token.js");
    try {
      await exchangeToken(rawIn);
      return { creds: serializeCreds(parsed, undefined, "dumate-import"), account: undefined };
    } catch { /* fall through to passport path */ }
  }

  // Path 2: passport only -> quick-login to build the console session
  const pp = passportCookies(rawIn);
  if (!pp.some((c) => c.name === "BDUSS" || c.name === "BDUSS_BFESS")) {
    throw new Error("no usable Baidu login state: BDUSS is required at minimum (log in on passport.baidu.com first; a full export with bce-sessionid also works)");
  }
  if (!pp.some((c) => /^STOKEN|^PTOKEN|^UBI/.test(c.name))) {
    throw new Error("BDUSS alone is not enough: STOKEN, PTOKEN and UBI are also required — export the full cookie set");
  }
  const out = await quickLogin(pp);
  const kept = out.cookies.filter(keepCookie);
  const names = new Set(kept.map((c) => c.name + "@" + bare(c.domain)));
  for (const c of pp) if (!names.has(c.name + "@" + bare(c.domain))) kept.push(slimCookie(c));
  return { creds: serializeCreds(kept, out.account, "dumate-import"), account: out.account };
}

export const _sessions = sessions;

// Re-exports used by the routes/executor
export { parseCookies, passportCookies } from "./cookies.js";
export { hasPassport } from "./cookies.js";
