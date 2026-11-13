/*
 * DuMate pure-HTTP session bootstrap ("快捷登录") — no headless browser.
 *
 * Reverse-engineered from the login.bce.baidu.com frontend: once the page sees
 * a Baidu passport session, its "quick login" button just navigates to
 *   GET https://login.bce.baidu.com/postlogin/passport/wap
 *       ?activate=true&passportShared=true&redirect=<console URL>
 *       &ocpcContext=<base64url({portraitUrl,username})>
 * which 302s through passport.baidu.com/v3/login/api/auth/ to validate BDUSS
 * and lands a full set of console.bce.baidu.com session cookies
 * (bce-sessionid et al). It only works when the flag cookies the login page's
 * own JS writes are present: bce-login-type=PASSPORT,
 * bce-login-type-detail=SHARED_PASSPORT, bce-fe-load-type=self and the two
 * x-bce-login-redirect-url(-console) markers — missing ones bounce back to the
 * login page.
 *
 *   portrait(pp)   — GET /passport-portrait; validates BDUSS, returns account name
 *   quickLogin(pp) — runs the redirect chain; returns {cookies, account}
 *
 * Errors that mean "the passport is dead, re-login required" carry .reauth.
 * Never logs cookie/token values.
 */

import https from "node:https";
import { Jar } from "./cookies.js";

export const CONSOLE_URL = "https://console.bce.baidu.com/dumate/channel";
const WAP_URL = "https://login.bce.baidu.com/postlogin/passport/wap";
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function get(url, cookieHeader, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request(
      {
        host: u.host,
        path: u.pathname + u.search,
        method: "GET",
        timeout: 20_000,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/json,*/*",
          Referer: "https://login.bce.baidu.com/",
          Cookie: cookieHeader,
          ...(headers || {}),
        },
      },
      (res) => {
        const ch = [];
        res.on("data", (d) => ch.push(d));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch).toString("utf8") }),
        );
      },
    );
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    r.end();
  });
}

function b64urlJson(o) {
  return Buffer.from(JSON.stringify(o), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const reauthError = (msg) => Object.assign(new Error(msg), { reauth: true });

/** Validate the passport and fetch the account name. Returns {username, portraitUrl} or null. */
export async function portrait(pp) {
  const jar = new Jar();
  for (const c of pp) jar.add(c.name, c.value, c.domain || ".baidu.com");
  const r = await get("https://login.bce.baidu.com/passport-portrait", jar.header("login.bce.baidu.com"));
  try {
    const j = JSON.parse(r.body);
    if (j && j.success && j.result && j.result.username) return j.result;
  } catch { /* non-JSON body = not logged in */ }
  return null;
}

/**
 * Trade passport cookies (must contain BDUSS/BDUSS_BFESS) for a full console
 * session jar. Returns {cookies:[{name,value,domain}], account}.
 * Throws .reauth errors when the passport itself is rejected.
 */
export async function quickLogin(pp) {
  if (!pp.some((c) => c.name === "BDUSS" || c.name === "BDUSS_BFESS")) {
    throw reauthError("no Baidu passport cookie (BDUSS) — cannot log in");
  }

  const jar = new Jar();
  for (const c of pp) jar.add(c.name, c.value, c.domain || ".baidu.com");
  // Flag cookies the login page's own JS writes before offering "快捷登录"
  for (const [n, v] of [
    ["bce-login-type", "PASSPORT"],
    ["bce-login-type-detail", "SHARED_PASSPORT"],
    ["bce-fe-load-type", "self"],
    ["x-bce-login-redirect-url", CONSOLE_URL],
    ["x-bce-login-redirect-url-console", CONSOLE_URL],
  ]) {
    jar.add(n, v, ".bce.baidu.com");
  }

  const pf = await portrait(pp).catch(() => null);
  if (!pf) throw reauthError("Baidu passport session rejected (BDUSS not accepted) — re-login required");

  let url =
    WAP_URL + "?activate=true&passportShared=true&redirect=" + CONSOLE_URL +
    "&ocpcContext=" + b64urlJson({ portraitUrl: pf.portraitUrl || "", username: pf.username });

  for (let hop = 0; hop < 10; hop++) {
    const host = new URL(url).hostname;
    const r = await get(url, jar.header(host));
    jar.addSetCookie(r.headers["set-cookie"], host);
    const loc = r.headers.location;
    if (!loc) {
      const onConsole = /^https:\/\/console\.bce\.baidu\.com\//.test(url);
      const hasSess = jar.all().some((c) => c.name === "bce-sessionid" && c.value);
      if (onConsole && r.status === 200 && hasSess) {
        return { cookies: jar.all(), account: pf.username };
      }
      break;
    }
    url = new URL(loc, url).href;
  }
  const hasSess = jar.all().some((c) => c.name === "bce-sessionid" && c.value);
  if (!hasSess) {
    throw reauthError("quick-login did not establish a console session (passport rejected or risk check) — re-login required");
  }
  throw new Error("quick-login redirect chain never reached the console: " + url.slice(0, 120));
}
