/**
 * MiniMax Code (mcode) subscription usage handler
 * Fetches M Plan rate limit windows and the account credits balance, whose
 * batch ledger (积分明细) is aggregated into expiry-day buckets.
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

// ─── Credits ledger (算力币逐包明细) ────────────────────────────────────────────
//
// The membership probe (get_membership_info) only answers THREE aggregate
// numbers (total/purchased/free_remaining_amount) — no expiry anywhere. The
// batch ledger lives on a different endpoint that MiniMax's own client reads
// for Settings → Usage → Credit details (积分明细): GET
// /minimax-cloud/api/v1/credit/details with page_number/page_size/include_expired,
// answering { details: [...], total_count }. Each batch carries credit_type
// (1 = purchased, 2 = check-in / free-pack), granted/consumed/remaining_amount
// as decimal strings ("1,200.5" — thousands separators), and granted_at_ms /
// expire_at_ms (ms epoch; a batch past expire_at_ms is dead).
//
// Verified live 2026-11-16 on #131/#1697/#3710/#187: per-batch remaining sums
// match the membership aggregate to the cent, so the ledger IS the balance's
// composition — bucket it by expiry day (lingxi 同款) instead of emitting one
// row per check-in batch (a month of daily check-ins would be ~30 rows).

// The ledger rides the same signed account client as the check-in calls: the
// gateway checks the signature, and its query convention is the desktop web
// one (device_platform web / is_desktop 1 / desktop_version) rather than the
// mcode client params the commerce endpoints take.
const LEDGER_PAGE = 20;
// Ten pages × 20 = 200 batches is far past any real ledger (#187, the busiest,
// carries 45); stopping there bounds a broken pagination loop.
const LEDGER_MAX_PAGES = 10;

/** Parse a ledger amount string ("1,200.50") → number; null when not one. */
export function ledgerAmount(v, { clampNegative = false } = {}) {
  if (v === null || v === undefined || v === "") return null;
  const t = String(v).replace(/,/g, "").trim();
  if (clampNegative && t.startsWith("-")) {
    return /^\d+(\.\d+)?$/.test(t.slice(1)) ? 0 : null;
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch every ledger batch (paged). Returns [] when the endpoint is
 * unavailable or the envelope is not the documented shape — the caller treats
 * that as "no expiry data" and keeps the plain balance card.
 */
export async function fetchCreditLedger(site, accessToken, userID, proxyOptions = null) {
  const batches = [];
  for (let page = 1; page <= LEDGER_MAX_PAGES; page++) {
    const url = new URL("/minimax-cloud/api/v1/credit/details", site.agent);
    url.search = new URLSearchParams({
      device_platform: "web",
      is_desktop: "1",
      desktop_version: "0.6.12",
      page_number: String(page),
      page_size: String(LEDGER_PAGE),
      include_expired: "false",
    }).toString();
    const { url: signedUrl, init } = signedAccountRequest(site, url.pathname + url.search, {
      access: accessToken,
      userID,
    });
    const res = await proxyAwareFetch(signedUrl, { ...init, signal: AbortSignal.timeout(15000) }, proxyOptions);
    if (!res.ok) return batches.length ? batches : [];
    const env = await res.json().catch(() => null);
    const d = Array.isArray(env?.details) ? env : obj(env?.data);
    const list = Array.isArray(d?.details) ? d.details : null;
    const totalCount = num(d?.total_count);
    if (!list?.length) break;
    batches.push(...list);
    if (Number.isFinite(totalCount) && batches.length >= totalCount) break;
  }
  return batches;
}

/** Bucket name for one expiry day — "12-16 到期" style short date key. */
function ledgerBucketName(dayKey, packs) {
  const short = dayKey ? dayKey.slice(5) : "";
  return `Credits · ${short}${packs > 1 ? ` · ${packs} packs` : ""}`;
}

/**
 * Aggregate live ledger batches into expiry-day buckets (lingxi 到期桶同款):
 * same-day expiry merges into one row (summed granted/remaining), ascending by
 * expiry — FIFO spend semantics. Spent (remaining ≤ 0) and expired batches are
 * dropped: they are history, not headroom, and the bucket sums must reconcile
 * with the membership balance (which only counts live credits).
 *
 * @returns {Array<{key, expireAt, balance, total, packs, purchasedPacks}>}
 */
export function bucketLedgerByExpiry(batches, now = Date.now()) {
  const buckets = new Map();
  for (const b of Array.isArray(batches) ? batches : []) {
    const granted = ledgerAmount(b?.granted_amount);
    const remaining = ledgerAmount(b?.remaining_amount, { clampNegative: true });
    const expMs = num(b?.expire_at_ms);
    if (granted === null || remaining === null) continue;
    if (remaining <= 0) continue; // spent packs are history, not headroom
    if (!(expMs > now)) continue; // expired packs are dead
    const dayKey = new Date(expMs).toISOString().slice(0, 10);
    if (!buckets.has(dayKey)) {
      buckets.set(dayKey, { key: dayKey, expireAt: new Date(expMs).toISOString(), balance: 0, total: 0, packs: 0, purchasedPacks: 0 });
    }
    const bucket = buckets.get(dayKey);
    bucket.balance += remaining;
    bucket.total += granted;
    bucket.packs += 1;
    if (b?.credit_type === 1) bucket.purchasedPacks += 1;
  }
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Bucket → detailOnly quota row (QuotaPackBar 逐包明细 + expiryExtractor). */
function ledgerBucketRow(bucket) {
  return {
    name: ledgerBucketName(bucket.key, bucket.packs),
    used: Math.max(0, bucket.total - bucket.balance),
    total: bucket.total || bucket.balance,
    remaining: bucket.balance,
    resetAt: bucket.expireAt,
    // One-shot expiring packs, NOT windows: recurring must stay false or the
    // extractor treats a drained bucket's reset as a refill point (and
    // isConnectionDepleted keeps a drained pack "available" forever).
    recurring: false,
    displayRemaining: true,
    detailOnly: true,
  };
}

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
  // Callers may pass a path that already carries its own query (the credits
  // ledger needs page_number/page_size/include_expired params that are not
  // part of the mcode client convention) — merge instead of clobbering.
  const extra = new URL(path, site.agent).searchParams;
  for (const [k, v] of extra) {
    if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  }
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
        // M Plan windows REFILL (5h interval / 7d weekly) — they are rate
        // windows, not one-shot packs. Flagging them recurring keeps a drained
        // window's reset time as the badge (when does it come back) and lets
        // the relay red-zone pre-switch the carrier at <5% instead of waiting
        // for upstream 429. Without it, a drained window reads as "account has
        // nothing" and multi-account subscription routing loses its signal.
        recurring: true,
      });
    }
  }
  return out;
}

// geo-redirect 检测用共享实现（open-sse/utils/error.js geoRedirectNote）——
// issue #101：agent.minimax.io 在 CN 网络 307 重定向到 CN 域名家族。
import { geoRedirectNote } from "../../utils/error.js";

/** Live bucket list → quotas rows, plus the headline's expiringBatch signal. */
function ledgerQuotas(buckets) {
  const quotas = {};
  const soonest = buckets[0];
  for (const b of buckets) {
    const row = ledgerBucketRow(b);
    quotas[row.name] = row;
  }
  return { quotas, soonest };
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
    const planUrl = `${site.platform}/v1/api/openplatform/coding_plan/remains`;
    const res = await proxyAwareFetch(planUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(groupId ? { "X-Group-Id": groupId } : {}),
      },
      signal: AbortSignal.timeout(15000),
    }, proxyOptions);

    if (res.status === 401 || res.status === 403) {
      const geo = geoRedirectNote(planUrl, res);
      if (geo) return { message: geo };
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
    const geo = geoRedirectNote(url, res);
    if (geo) return { message: geo };
    if (res.ok) {
      const env = await res.json().catch(() => null);
      const d = obj(env?.data);
      const sum = obj(env?.op_credit_summary) ?? obj(d?.op_credit_summary);
      const balStr = str(sum, "total_remaining_amount") ?? str(env, "opcredit_balance") ?? str(d, "opcredit_balance");
      if (balStr !== undefined) {
        const balNum = Number(balStr);
        const creditsRow = {
          name: "Credits",
          used: 0,
          total: Number.isFinite(balNum) ? balNum : 0,
          remaining: Number.isFinite(balNum) ? balNum : 0,
          isCreditBalance: true,
          currency: "credits",
        };
        quotas["Credits"] = creditsRow;

        // 逐包到期（积分明细账本，fail-soft）：桶是余额的构成明细——
        // 同日到期并格、升序 FIFO。成功时 Credits 行挂 summarizesDetail +
        // expiringBatch（头部「N · Xd后到期」通道），桶行 detailOnly 进
        // 逐包明细；账本拿不到时维持原储值单值卡（与旧行为一致）。
        try {
          const batches = await fetchCreditLedger(site, accessToken, userID, proxyOptions);
          const buckets = bucketLedgerByExpiry(batches);
          if (buckets.length > 0) {
            const { quotas: bucketQuotas, soonest } = ledgerQuotas(buckets);
            Object.assign(quotas, bucketQuotas);
            creditsRow.summarizesDetail = true;
            creditsRow.recurring = false;
            creditsRow.resetAt = soonest.expireAt;
            creditsRow.expiringBatch = { remaining: soonest.balance, resetAt: soonest.expireAt };
          }
        } catch {
          // Ledger is optional — the balance card stands alone without it.
        }
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
