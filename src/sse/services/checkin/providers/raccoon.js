// Raccoon (小浣熊) daily points check-in adapter.
//
// There is no "sign-in" endpoint. The official desktop client GETs
// /api/web/office/v3/setting_info on startup and the server grants the daily
// points there (idempotent per natural day, UTC+8). The only authoritative
// answer is the ledger: GET /api/web/points/v1/bills and sum today's positive
// rows. Rust raccoon/balance.rs::claim_daily_grant follows the same rule
// (setting_info is the trigger, bills decide success).
//
// We additionally snapshot the wallet before/after the trigger so the ledger
// records the real delta (§13.5: amount must equal the upstream balance
// difference). A 0 delta is never reported as `ok`:
//   - bills contain a grant today -> `already`
//   - bills are empty             -> `no-activity`
//
// Reference: our Rust provider (agent2api …/providers/raccoon/balance.rs) and
// Buddy2api (MIT, providers/xiaohuanxiong/quota.py).
import {
  RACCOON_BALANCE_URL,
  RACCOON_BILLS_TIMEOUT_MS,
  RACCOON_BILLS_URL,
  RACCOON_BEIJING_OFFSET_MS,
  RACCOON_DESKTOP_HEADERS,
  RACCOON_REQUEST_TIMEOUT_MS,
  RACCOON_SETTING_INFO_URL,
  RACCOON_UNIT,
} from "open-sse/config/raccoon.js";

const stripBearer = (token) => String(token || "").trim().replace(/^Bearer\s+/i, "");

function accessTokenOf(conn) {
  return stripBearer(conn?.accessToken || conn?.apiKey);
}

function toIntegerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(number) ? Math.floor(number) : null;
}

export function beijingDayKey(nowMs = Date.now()) {
  // Shift into UTC+8 then read UTC fields; the upstream day boundary is
  // Beijing midnight regardless of where this server runs.
  const shifted = new Date(nowMs + RACCOON_BEIJING_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function dataOf(payload) {
  if (payload && typeof payload === "object" && payload.data !== undefined && payload.data !== null) {
    return payload.data;
  }
  return payload;
}

function availableOf(payload) {
  const data = dataOf(payload);
  return data && typeof data === "object" ? toIntegerOrNull(data.available_points) : null;
}

function billItemsOf(payload) {
  const data = dataOf(payload);
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["items", "bills", "list"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

/** Sum today's positive point rows (events can be negative: spends/refunds). */
export function sumTodayGrantPoints(payload, dayKey) {
  let total = 0;
  for (const item of billItemsOf(payload)) {
    if (!item || typeof item !== "object") continue;
    const points = toIntegerOrNull(item.points);
    if (points === null || points <= 0) continue;
    const createdAt = typeof item.created_at === "string" ? item.created_at : "";
    // The upstream stamps ledger rows in Beijing time; compare the date prefix
    // exactly like Rust (created_at.get(..10) == today), not a parsed instant.
    if (createdAt.slice(0, 10) !== dayKey) continue;
    total += points;
  }
  return total;
}

async function requestJson(fetchImpl, url, token, { headers = {}, timeoutMs = RACCOON_REQUEST_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { kind: "network", message: error?.message || String(error) };
  }

  const status = Number(response?.status) || 0;
  let payload = null;
  try {
    const text = typeof response?.text === "function" ? await response.text() : "";
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (status === 401) {
    return { kind: "auth", status, message: "登录态已过期（401）" };
  }
  if (status === 429) {
    return { kind: "limited", status, message: "上游限流（429）" };
  }
  if (response?.ok === false || status >= 400) {
    return { kind: "http", status, message: `上游返回 HTTP ${status}` };
  }
  if (payload && typeof payload === "object" && payload.code !== undefined && Number(payload.code) !== 0) {
    const message = typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : `code=${payload.code}`;
    return { kind: "business", status, code: payload.code, message };
  }
  return { kind: "ok", status, payload };
}

function failureResult(error, { before = null, after = null, message = "" } = {}) {
  const status = error.kind === "auth"
    ? "needs-reauth"
    : error.kind === "limited"
      ? "limited"
      : "failed";
  return {
    status,
    amount: 0,
    unit: RACCOON_UNIT,
    before,
    after,
    code: error.code ?? error.status ?? null,
    message: message || error.message || "request failed",
  };
}

/**
 * Claim today's points for one connection.
 *
 * `ctx.fetch` exists for unit tests; the scheduler calls this with only
 * `{ settings, dryRun, today }` and the global fetch is used.
 * `ctx.now` is likewise a test seam for the Beijing day key.
 */
export async function claimRaccoonDaily(conn, ctx = {}) {
  const token = accessTokenOf(conn);
  if (!token) {
    return {
      status: "needs-reauth",
      amount: 0,
      unit: RACCOON_UNIT,
      before: null,
      after: null,
      message: "连接缺少小浣熊 access token，请重新登录后更新连接",
    };
  }

  const fetchImpl = typeof ctx.fetch === "function" ? ctx.fetch : globalThis.fetch;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const dayKey = beijingDayKey(now);

  const beforeRead = await requestJson(fetchImpl, RACCOON_BALANCE_URL, token);
  if (beforeRead.kind === "auth" || beforeRead.kind === "limited") {
    return failureResult(beforeRead);
  }
  const before = beforeRead.kind === "ok" ? availableOf(beforeRead.payload) : null;
  const beforeError = beforeRead.kind === "ok" ? null : beforeRead.message;

  if (ctx.dryRun === true) {
    const bills = await requestJson(fetchImpl, RACCOON_BILLS_URL, token, {
      timeoutMs: RACCOON_BILLS_TIMEOUT_MS,
    });
    if (bills.kind === "auth" || bills.kind === "limited") {
      return failureResult(bills, { before, message: "dry-run 账单核对失败" });
    }
    if (bills.kind !== "ok") {
      return failureResult(bills, { before, message: "dry-run 未能核对今日入账" });
    }
    const grantedToday = sumTodayGrantPoints(bills.payload, dayKey);
    return {
      status: grantedToday > 0 ? "already" : "no-activity",
      amount: 0,
      unit: RACCOON_UNIT,
      before,
      after: before,
      message: grantedToday > 0
        ? `dry-run：今日账单已有 +${grantedToday}，未触发发放`
        : "dry-run：今日账单无入账，未触发发放",
    };
  }

  // ① Trigger the grant. A failure here is recorded but does not stop the
  //    ledger read: the grant is server-side/idempotent and may still have
  //    landed (Rust keeps going for the same reason).
  const trigger = await requestJson(fetchImpl, RACCOON_SETTING_INFO_URL, token, {
    headers: RACCOON_DESKTOP_HEADERS,
  });
  if (trigger.kind === "auth" || trigger.kind === "limited") {
    return failureResult(trigger, { before });
  }
  const triggerError = trigger.kind === "ok" ? null : trigger.message;

  // ② Authoritative verification: today's ledger rows.
  const bills = await requestJson(fetchImpl, RACCOON_BILLS_URL, token, {
    timeoutMs: RACCOON_BILLS_TIMEOUT_MS,
  });
  if (bills.kind === "auth" || bills.kind === "limited") {
    return failureResult(bills, { before });
  }
  if (bills.kind !== "ok") {
    return failureResult(bills, {
      before,
      message: `未能核对今日入账：${bills.message}`,
    });
  }
  const grantedToday = sumTodayGrantPoints(bills.payload, dayKey);

  // ③ After snapshot for the ledger's before/after reconciliation.
  const afterRead = await requestJson(fetchImpl, RACCOON_BALANCE_URL, token);
  const after = afterRead.kind === "ok" ? availableOf(afterRead.payload) : null;

  const notes = [];
  if (beforeError) notes.push(`领前余额读取失败：${beforeError}`);
  if (afterRead.kind !== "ok") notes.push(`领后余额读取失败：${afterRead.message}`);
  if (triggerError) notes.push(`发放触发失败：${triggerError}`);

  let status;
  let amount = 0;
  if (before !== null && after !== null) {
    const delta = after - before;
    if (delta > 0) {
      status = "ok";
      amount = delta;
    } else {
      // No increase. bills decide whether today simply had nothing to grant
      // or whether it had already been granted before this run.
      status = grantedToday > 0 ? "already" : "no-activity";
    }
  } else if (grantedToday > 0) {
    // Balance snapshot unavailable on one side: fall back to the ledger, which
    // is what Rust uses as the authority.
    status = "ok";
    amount = grantedToday;
  } else {
    status = triggerError ? "failed" : "no-activity";
  }

  let message;
  if (status === "ok") {
    message = `今日积分 +${amount}`;
  } else if (status === "already") {
    message = grantedToday > 0 ? `今日已领取（账单今日入账 +${grantedToday}）` : "今日已领取";
  } else if (status === "no-activity") {
    message = "今日未见积分入账（无活动）";
  } else {
    message = "签到失败";
  }
  if (notes.length) message += `；${notes.join("；")}`;

  return {
    status,
    amount,
    unit: RACCOON_UNIT,
    before,
    after,
    message,
  };
}

export default {
  id: "raccoon",
  providers: ["raccoon"],
  settingsKey: "raccoonCheckin",
  cadence: "daily",
  run(conn, ctx = {}) {
    return claimRaccoonDaily(conn, ctx);
  },
};
