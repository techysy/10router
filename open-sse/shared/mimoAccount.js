import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

/**
 * Xiaomi MiMo account-session helpers (used for weekly quota).
 *
 * The weekly quota endpoint lives on the account service domain and is authorized
 * by an account session cookie, NOT the sk- API key. Acquiring that cookie mirrors
 * MiMo Desktop: a passToken (persisted in Desktop's cookie store) is exchanged via
 * the passportapi SSO, then authorized for the `mimopc` service, and finally stamped
 * by the mimo-server /api/sts callback into a `serviceToken` cookie.
 *
 * Flow (verified against MiMo Desktop traffic):
 *   1. GET  {api}/api/user/xiaomi/me           -> 302 to account SSO (sid=mimopc)
 *   2. GET  account /pass/serviceLogin?sid=passportapi&_json=true   -> nonce/ssecurity
 *   3. GET  {location}&clientSign=...          -> account-level serviceToken
 *   4. GET  account /pass/serviceLogin?sid=mimopc&callback=<sts>&_json=true
 *   5. GET  {api}/api/sts?...&ticket...        -> Set-Cookie: serviceToken (mimopc scope)
 */

// 账号服务集群。MiMo Desktop 声明五个区域（rn = {CN, SGP, RU, IN, EU}），EU 部署在
// Amsterdam。host 与 SSO sid 命名一一对应：mimo-server-<code> / sid = mimo<code>
// （ams 是唯一非国家码）。host 列表经 /api/user/xiaomi/me 实测验证（对照上游 910db749）。
const API_BASE_BY_REGION = {
  cn: "https://mimo-server-cn.xiaomimimo.com",
  sgp: "https://mimo-server-sgp.xiaomimimo.com",
  ams: "https://mimo-server-ams.xiaomimimo.com",
  ru: "https://mimo-server-ru.xiaomimimo.com",
  in: "https://mimo-server-in.xiaomimimo.com",
};
// 集群 SSO sid —— 与 host 码 1:1：mimo<code>；cn 的集群 sid 是历史名 mimopc。
const SID_BY_REGION = { cn: "mimopc", sgp: "mimosgp", ams: "mimoams", ru: "mimoru", in: "mimoin" };
// 缺省区域回落 CN —— 本仓库 mimo-desktop 卡的历史行为（Desktop cookie 是 CN 集群
// 签发的）；上游新登录默认 SGP，本仓保持 cn 以免破坏存量连接。
const DEFAULT_REGION = "cn";
function regionOf(providerSpecificData = null) {
  return String(providerSpecificData?.region || "").toLowerCase();
}
export function mimoApiBaseFor(providerSpecificData = null) {
  return API_BASE_BY_REGION[regionOf(providerSpecificData)] || API_BASE_BY_REGION[DEFAULT_REGION];
}
function sidForRegion(providerSpecificData = null) {
  return SID_BY_REGION[regionOf(providerSpecificData)] || SID_BY_REGION[DEFAULT_REGION];
}
const API_BASE = API_BASE_BY_REGION[DEFAULT_REGION];
const ACCOUNT_HOST = "account.xiaomi.com";
const API_UA =
  "miNative PC/Normal Windows_NT/10.0.19045 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0";
const SSO_UA = "MiClaw/1.0";
const COOKIE_TTL_MS = 30 * 60 * 1000;
// Windows surfaces a sharing violation on the Desktop's cookie db as EBUSY;
// POSIX gives EACCES/EPERM (or EBUSY under flock).
const LOCKED_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

// Per-account session caches (keyed by passToken hash) so multiple Xiaomi
// accounts / connections can rotate without clobbering each other.
const _cache = new Map(); // key -> { cookie, at }
const _inflight = new Map(); // key -> Promise<cookie|null>

// ─── MiMo Desktop on-disk layout ───────────────────────────────────────────
// MiMo Desktop is an Electron app and keeps TWO independent stores:
//   • its Electron profile  — the Chromium cookie DB holding the passToken
//   • its credential dir    — the auth.json its bundled engine reads/writes
// They live in different roots, so they are resolved separately — but both in
// this one module, so the two can never drift apart.

const DESKTOP_APP_NAME = "Xiaomi MiMo";

/**
 * MiMo Desktop's Electron userData dir (Chromium profile root).
 * Windows honours APPDATA (redirected/roaming profiles), macOS uses Library and
 * Linux follows XDG_CONFIG_HOME — Electron's own per-platform resolution.
 */
export function desktopUserDataDir() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), DESKTOP_APP_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", DESKTOP_APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), DESKTOP_APP_NAME);
}

/**
 * MiMo Desktop's account-partition cookie DB (holds the passToken).
 * A running Desktop holds it with an exclusive lock — see readDesktopPassToken().
 */
export function desktopCookiePath() {
  return path.join(desktopUserDataDir(), "Partitions", "xiaomi-account", "Network", "Cookies");
}

/**
 * Where MiMo Desktop keeps auth.json — NOT inside its Electron profile.
 *
 * Desktop starts its bundled engine with `authDataDir: Vs`, where
 *   Vs = $XDG_DATA_HOME/mimocode  ||  ~/.local/share/mimocode
 * i.e. the XDG *data* dir on every platform — macOS included, no ~/Library here.
 * The standalone mimocode CLI is retired, but it wrote to this same dir, so one
 * path covers both and no CLI-specific candidate exists.
 *
 * When XDG_DATA_HOME is set the default location is still listed second: a user
 * who changed the variable after signing in keeps a working fallback.
 *
 * @returns {string[]} candidates, most authoritative first
 */
export function desktopAuthJsonPaths() {
  const home = os.homedir();
  const fallback = path.join(home, ".local", "share", "mimocode");
  const xdg = process.env.XDG_DATA_HOME;
  const primary = xdg ? path.join(xdg, "mimocode") : fallback;
  const dirs = primary === fallback ? [primary] : [primary, fallback];
  return dirs.map((dir) => path.join(dir, "auth.json"));
}

/**
 * Read the persisted Xiaomi account cookies from MiMo Desktop's Electron profile.
 * The Chromium cookie DB is held with an exclusive lock while Desktop runs, so we
 * copy it first and bail (return null) if that fails.
 *
 * The copy holds a live account session, so it is created owner-only (0600) and is
 * always unlinked again — a stray copy in the shared temp dir would be a credential
 * leak on a multi-user machine.
 *
 * @returns {Promise<Record<string,string>|null>}
 */
async function readDesktopAccountCookies() {
  const src = desktopCookiePath();
  if (!fs.existsSync(src)) return null;
  const tmp = path.join(os.tmpdir(), `10router-mimo-cookies-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`);
  try {
    fs.copyFileSync(src, tmp);
  } catch (err) {
    // A running Xiaomi MiMo Desktop keeps an *exclusive* lock on its cookie db:
    // on Windows even a plain read fails (EBUSY, verified against the installed
    // client), so there is nothing to read around. Surface it as a typed error
    // instead of pretending the session is absent — otherwise "quit the app" is
    // indistinguishable from "never signed in", and both look like a silent no-op.
    if (LOCKED_CODES.has(err?.code)) {
      const locked = new Error("Xiaomi MiMo Desktop is holding its cookie store (quit the app and retry)");
      locked.code = "DESKTOP_LOCKED";
      throw locked;
    }
    return null; // missing/unreadable for any other reason
  }
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best effort — no-op on Windows */
  }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    // The handle must be closed on every path: on Windows an open handle keeps the
    // file locked, the unlink below fails silently, and a copy of the account cookie
    // db would be left behind in the shared temp dir.
    let db = null;
    try {
      db = new DatabaseSync(tmp, { readOnly: true });
      const rows = db.prepare("SELECT name, value FROM cookies WHERE host_key = ?").all("." + ACCOUNT_HOST);
      const jar = Object.fromEntries(rows.map((r) => [r.name, r.value]));
      return jar.passToken ? jar : null;
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  } catch {
    return null;
  } finally {
    await unlinkQuietly(tmp);
  }
}

/** Best-effort removal of the temp copy (retried: AV/indexers can hold it briefly). */
async function unlinkQuietly(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.unlinkSync(file);
      return;
    } catch (err) {
      if (err.code === "ENOENT") return;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 20));
    }
  }
}

/**
 * Read just the passToken + identity cookies from Desktop's profile.
 * Exported so the connect flow can persist a per-account passToken into the
 * connection's providerSpecificData — this is what enables multi-account rotation.
 * @returns {Promise<{passToken:string, userId:string|null, cUserId:string|null}|null>}
 */
export async function readDesktopPassToken() {
  try {
    const jar = await readDesktopAccountCookies();
    if (!jar?.passToken) return null;
    return { passToken: jar.passToken, userId: jar.userId || null, cUserId: jar.cUserId || null };
  } catch (err) {
    // Let the callers tell "locked" apart from "no session" and act on it.
    if (err?.code === "DESKTOP_LOCKED") throw err;
    return null;
  }
}

function signatureClientSign(nonce, ssecurity) {
  const input = `nonce=${nonce}` + (ssecurity && ssecurity.trim() ? `&${ssecurity}` : "");
  return encodeURIComponent(crypto.createHash("sha1").update(input).digest("base64"));
}

function absorbSetCookie(jar, res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const m = /^([^=]+)=([^;]*)/.exec(c.trim());
    if (m && m[2]) jar[m[1]] = m[2];
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Exchange a passToken for a mimo-server service session cookie.
 * @returns {Promise<string|null>} Cookie header value, or null on failure.
 */
async function acquireServiceCookie(passJar, proxyOptions, providerSpecificData = null) {
  const jar = { ...passJar };
  const ck = () => cookieHeader(jar);
  const apiBase = mimoApiBaseFor(providerSpecificData);
  const clusterSid = sidForRegion(providerSpecificData);

  // 1. Unauthenticated API call -> 302 carrying the sts callback (sid=mimopc)
  // Every step carries a hard 10s timeout: the connection-test path awaits this
  // whole chain, and one hung SSO hop used to freeze the dashboard's Test
  // spinner indefinitely (the outer 15s probe timeout never gets reached).
  const r1 = await proxyAwareFetch(
    `${apiBase}/api/user/xiaomi/me`,
    { redirect: "manual", headers: { "User-Agent": API_UA, Cookie: ck() }, signal: AbortSignal.timeout(10000) },
    proxyOptions,
  );
  const redirect = r1.headers.get("location");
  if (!redirect) return null;
  const stsCallback = new URL(redirect).searchParams.get("callback");
  if (!stsCallback) return null;

  // 2. passportapi SSO phase 1 -> nonce + ssecurity
  const sso1 = await proxyAwareFetch(
    `https://${ACCOUNT_HOST}/pass/serviceLogin?sid=passportapi&_json=true`,
    { headers: { Cookie: ck(), "User-Agent": SSO_UA, Accept: "application/json" }, signal: AbortSignal.timeout(10000) },
    proxyOptions,
  );
  const j1 = JSON.parse((await sso1.text()).replace(/^&&&START&&&/, ""));
  const nonce = j1.nonce || (j1.location ? new URL(j1.location).searchParams.get("nonce") : null);
  if (!nonce || !j1.location) return null;

  // 3. passportapi SSO phase 2 -> account-level serviceToken
  const sso2 = await proxyAwareFetch(
    `${j1.location}&clientSign=${signatureClientSign(nonce, j1.ssecurity)}`,
    { redirect: "manual", headers: { Cookie: ck(), "User-Agent": SSO_UA }, signal: AbortSignal.timeout(10000) },
    proxyOptions,
  );
  absorbSetCookie(jar, sso2);

  // 4. 集群 SSO -> sts callback carrying a ticket（sid 随区域：mimopc/mimosgp/…）
  const sso3 = await proxyAwareFetch(
    `https://${ACCOUNT_HOST}/pass/serviceLogin?sid=${encodeURIComponent(clusterSid)}&callback=${encodeURIComponent(stsCallback)}&_json=true`,
    { headers: { Cookie: ck(), "User-Agent": SSO_UA, Accept: "application/json" }, signal: AbortSignal.timeout(10000) },
    proxyOptions,
  );
  const j3 = JSON.parse((await sso3.text()).replace(/^&&&START&&&/, ""));
  absorbSetCookie(jar, sso3);
  if (!j3?.location || !/\/api\/sts/.test(j3.location)) return null;

  // 5. sts callback -> Set-Cookie: serviceToken (mimopc scope)
  const sts = await proxyAwareFetch(
    j3.location,
    { redirect: "manual", headers: { "User-Agent": API_UA, Cookie: ck() }, signal: AbortSignal.timeout(10000) },
    proxyOptions,
  );
  absorbSetCookie(jar, sts);

  const needed = ["serviceToken", "mimopc_ph", "mimopc_slh", "userId"];
  if (!jar.serviceToken) return null;
  const out = {};
  for (const k of needed) if (jar[k]) out[k] = jar[k];
  return cookieHeader(out);
}

/**
 * Get (and cache) the mimo-server account cookie.
 * @param {object|null} providerSpecificData - may carry `mimoPassToken` override
 */
async function getServiceCookie(providerSpecificData, proxyOptions) {
  let passJar = providerSpecificData?.mimoPassToken
    ? { passToken: providerSpecificData.mimoPassToken, userId: providerSpecificData.mimoUserId, cUserId: providerSpecificData.mimoCUserId }
    : null;
  if (!passJar) {
    try {
      passJar = await readDesktopAccountCookies();
    } catch (err) {
      // Usage must degrade, never throw — but keep the reason diagnosable.
      if (err?.code === "DESKTOP_LOCKED") return { cookie: null, reason: "desktop-locked" };
      throw err;
    }
  }
  if (!passJar) return { cookie: null, reason: "no-pass-token" };

  // One cached session per passToken+region — the same Xiaomi account issues a
  // different serviceToken per cluster, so the region is part of the cache key.
  const key = crypto.createHash("sha256").update(`${passJar.passToken}|${regionOf(providerSpecificData)}`).digest("hex");

  const cached = _cache.get(key);
  if (cached && Date.now() - cached.at < COOKIE_TTL_MS) {
    return { cookie: cached.cookie };
  }

  // De-dupe concurrent handshakes for the same account: a burst of requests must
  // not each run the full 5-step SSO chain.
  const inflight = _inflight.get(key);
  if (inflight) {
    const cookie = await inflight;
    return cookie ? { cookie } : { cookie: null, reason: "sso-failed" };
  }

  const promise = (async () => {
    try {
      return await acquireServiceCookie(passJar, proxyOptions, providerSpecificData);
    } catch {
      return null; // network/parse failure — callers degrade, never throw
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, promise);

  const cookie = await promise;
  if (!cookie) return { cookie: null, reason: "sso-failed" };
  _cache.set(key, { cookie, at: Date.now() });
  return { cookie };
}

/** Drop cached sessions so the next call re-runs the handshake (e.g. after a 401). */
export function invalidateMimoAccountCookieCache() {
  _cache.clear();
}

/** mimo-server account API base + the User-Agent its backend expects. */
export const MIMO_API_BASE = API_BASE;
export const MIMO_API_UA = API_UA;

/**
 * Resolve the mimo-server account-session cookie, for upstream /api/route/* calls.
 * @returns {Promise<string|null>} Cookie header value, or null when unavailable.
 */
export async function getMimoAccountCookie(providerSpecificData = null, proxyOptions = null) {
  try {
    const { cookie } = await getServiceCookie(providerSpecificData, proxyOptions);
    return cookie;
  } catch {
    return null;
  }
}

/**
 * Fetch the weekly quota from the account service.
 * @returns {Promise<{percent?:number, resetDate?:string, resetAt?:number, error?:string}>}
 */
export async function getMimoAccountUsage(providerSpecificData = null, proxyOptions = null) {
  const { cookie, reason } = await getServiceCookie(providerSpecificData, proxyOptions);
  if (!cookie) {
    return { error: reason === "no-pass-token" || reason === "desktop-locked" ? "no-session" : "session-failed" };
  }
  try {
    const res = await proxyAwareFetch(
      `${mimoApiBaseFor(providerSpecificData)}/api/user/usage`,
      { headers: { "User-Agent": API_UA, Cookie: cookie, Accept: "application/json" }, signal: AbortSignal.timeout(10000) },
      proxyOptions,
    );
    if (!res.ok) return { error: `http-${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data || data.code !== 0 || !data.data) return { error: "bad-response" };
    return { percent: data.data.percent, resetDate: data.data.resetDate, resetAt: data.data.resetAt };
  } catch (e) {
    return { error: e.message };
  }
}
