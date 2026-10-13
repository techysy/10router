/**
 * MiniMax Code (mcode) subscription usage handler
 * Fetches M Plan rate limit windows and optional account credits balance.
 */

import { createHash } from "node:crypto";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const SIGN_SECRET = "I*7Cf%WZ#S&%1RlZJ&C2";

const SITES = {
  "minimax-code": {
    agent: "https://agent.minimaxi.com",
    platform: "https://www.minimaxi.com",
    lang: "zh",
  },
  "minimax-code-global": {
    agent: "https://agent.minimax.io",
    platform: "https://platform.minimax.io",
    lang: "en",
  },
};

const md5 = (s) => createHash("md5").update(s).digest("hex");
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (o, k) => (typeof o?.[k] === "string" && o[k].trim() ? o[k].trim() : undefined);

export function signedAccountRequest(site, path, { access, userID, body, now = Date.now(), tzOffsetSec = new Date().getTimezoneOffset() * -60 } = {}) {
  const url = new URL(path, site.agent);
  url.search = new URLSearchParams({
    device_platform: "mcode",
    biz_id: "3",
    app_id: "3001",
    version_code: "22201",
    unix: String(now),
    timezone_offset: String(tzOffsetSec),
    sys_language: site.lang,
    lang: site.lang,
    device_id: "0",
    os_name: process.platform,
    browser_name: "mcode",
    user_id: String(userID ?? "").trim() || "0",
    client: "mcode",
  }).toString();
  const at = url.pathname + url.search;
  const ts = Math.floor(now / 1000);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "MiniMaxCode",
    Authorization: `Bearer ${access}`,
    yy: json === undefined
      ? md5(`${encodeURIComponent(at)}_{}${md5(String(now))}ooui`)
      : md5(`${encodeURIComponent(at)}_${json}${md5(String(now))}ooui`),
    "x-timestamp": String(ts),
    "x-signature": json === undefined ? md5(`${ts}${SIGN_SECRET}`) : md5(`${ts}${SIGN_SECRET}${json}`),
  };
  return { url: url.toString(), init: { method: json === undefined ? "GET" : "POST", headers, ...(json === undefined ? {} : { body: json }) } };
}

export function parsePlanWindows(body) {
  const br = obj(body?.base_resp);
  if (br && typeof br.status_code === "number" && br.status_code !== 0) {
    throw new Error(str(br, "status_msg") ?? `MiniMax said ${br.status_code}`);
  }
  if (!br && !Array.isArray(body?.model_remains)) throw new Error("no plan in the reply");
  const ms = (n) => (n < 1e12 ? n * 1000 : n);
  const zero = (v) => num(v) === 0;
  const out = [];

  for (const k of Array.isArray(body.model_remains) ? body.model_remains : []) {
    const name = String(k?.model_name ?? "").trim();
    if (!name || (num(k.current_interval_status) === 3 && num(k.current_weekly_status) === 3 && zero(k.current_interval_total_count) && zero(k.current_weekly_total_count))) {
      continue;
    }
    const general = name.toLowerCase() === "general";
    for (const x of [
      { left: num(k.current_interval_remaining_percent), status: num(k.current_interval_status) ?? 0, start: num(k.start_time) ?? 0, end: num(k.end_time) ?? 0, week: false },
      { left: num(k.current_weekly_remaining_percent), status: num(k.current_weekly_status) ?? 0, start: num(k.weekly_start_time) ?? 0, end: num(k.weekly_end_time) ?? 0, week: true },
    ]) {
      if (x.status === 3 || (x.left === undefined && x.status !== 2)) continue;
      const left = x.status === 2 ? 0 : Math.max(0, Math.min(100, x.left));
      let span = 0;
      if (x.start > 0 && x.end > x.start) span = ms(x.end) - ms(x.start);
      else if (x.week) span = 7 * 86400_000;

      const label = x.week ? "7 days"
        : span > 86400_000 && span % 86400_000 === 0 ? `${span / 86400_000} days`
        : span >= 3600_000 && span % 3600_000 === 0 ? `${span / 3600_000} hours`
        : span > 0 ? `${Math.floor(span / 60_000)} minutes`
        : "Allowance";
      const windowName = general ? label : `${name[0].toUpperCase() + name.slice(1)} · ${label}`;
      out.push({
        name: windowName,
        used: 100 - left,
        total: 100,
        remaining: left,
        remainingPercentage: left,
        resetAt: x.end > 0 ? new Date(ms(x.end)).toISOString() : null,
      });
    }
  }
  return out;
}

export async function getMiniMaxCodeUsage(accessToken, provider, proxyOptions = null, providerSpecificData = null) {
  const site = SITES[provider];
  if (!site || !accessToken) {
    return { message: `Usage API not implemented for ${provider}` };
  }

  const quotas = {};
  let lastError = null;

  // 1. Fetch M Plan rate windows (plain Bearer endpoint)
  try {
    const groupId = providerSpecificData?.opGroupId;
    const res = await proxyAwareFetch(`${site.platform}/v1/api/openplatform/coding_plan/remains`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(groupId ? { "X-Group-Id": groupId } : {}),
      },
      signal: AbortSignal.timeout(15000),
    }, proxyOptions);

    if (res.status === 401 || res.status === 403) {
      return { message: "MiniMax Code session expired or unauthorized. Please re-authenticate." };
    }

    if (res.ok) {
      const data = await res.json().catch(() => null);
      const windows = parsePlanWindows(data);
      for (const w of windows) {
        quotas[w.name] = w;
      }
    }
  } catch (err) {
    lastError = err;
  }

  // 2. Fetch Account/Credits info (Signed account API, fail-soft)
  try {
    const userID = providerSpecificData?.realUserID;
    const { url, init } = signedAccountRequest(site, "/matrix/api/v1/commerce/get_membership_info", {
      access: accessToken,
      userID,
      body: {},
    });

    const res = await proxyAwareFetch(url, init, proxyOptions);
    if (res.ok) {
      const env = await res.json().catch(() => null);
      const d = obj(env?.data);
      const sum = obj(env?.op_credit_summary) ?? obj(d?.op_credit_summary);
      const balStr = str(sum, "total_remaining_amount") ?? str(env, "opcredit_balance") ?? str(d, "opcredit_balance");
      if (balStr !== undefined) {
        const balNum = Number(balStr);
        quotas["Credits"] = {
          name: "Credits",
          used: 0,
          total: Number.isFinite(balNum) ? balNum : 0,
          remaining: Number.isFinite(balNum) ? balNum : 0,
          isCreditBalance: true,
          currency: "credits",
        };
      }
    }
  } catch {
    // Fail-soft: Account API credits reading is optional
  }

  if (Object.keys(quotas).length === 0) {
    if (lastError) {
      return { message: `MiniMax Code usage fetch failed: ${lastError.message}` };
    }
    return { message: "No active MiniMax Code subscription found." };
  }

  return { quotas };
}
