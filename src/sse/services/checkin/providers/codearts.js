// CodeArts daily welfare adapter — delivery -> claim -> confirm.
//
// CodeArts does not have a "sign-in" endpoint. Each Beijing day the IDE asks
// `GET /v1/ops/delivery?channel=IDE` for the campaign list, claims the daily
// campaign (`POST /v1/ops/claim`, body carries campaignId + idempotentKey), then
// confirms it (`POST /v1/ops/confirm`). `code:0` on claim/confirm only means
// "accepted"; the ledger is only updated after re-reading delivery and seeing
// CONFIRMED/CONSUMED (Rust welfare.rs).
//
// State machine quirks:
//   · `status:"CLAIMED"` is NOT terminal — the claim was accepted but not
//     confirmed. That campaign must skip claim and go straight to confirm.
//     Re-claiming it burns a write against the upstream's risk control.
//   · `40001 未到权益刷新时间` arrives as **HTTP 200 with code 40001** (not a
//     4xx). It is "not yet", not "failed": report `no-activity` and do not mark
//     the day done, so the next 2h tick tries again.
//   · The idempotent key must exist before the write is sent (a crash between
//     "request sent" and "response received" then retries with the same key).
//     We keep it in-process because 10router has no welfare ledger table yet;
//     a durable ledger is a TODO.
//   · **Coupling with inference**: an account with an unclaimed benefit has no
//     benefit profile, and every benefit-model request is answered
//     `InferHub.4004.200 benefit not found`. The usage handler self-heals by
//     calling the benefit claim endpoint; this adapter is the daily path that
//     keeps the profile alive. Do not treat this as a pure side channel.
import {
  CODEARTS_BASE_URL,
  CODEARTS_CLAIM_PATH,
  CODEARTS_CONFIRM_PATH,
  CODEARTS_DELIVERY_PATH,
  CODEARTS_WELFARE_NOT_YET_CODE,
} from "open-sse/config/codearts.js";
import { codeArtsFetch, resolveCodeArtsCredential } from "open-sse/shared/codearts/client.js";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
// Rust welfare.rs: at most 6 write attempts per day, at least 10 minutes apart.
const MAX_WRITES_PER_DAY = 6;
const MIN_WRITE_GAP_MS = 10 * 60 * 1000;

const writeLedger = new Map(); // connId -> { day, attempts, lastAt }
const idempotentKeys = new Map(); // connId::campaignId -> key

export function beijingDayKey(nowMs = Date.now()) {
  const shifted = new Date(nowMs + BEIJING_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Campaigns this adapter may claim automatically: the daily login credit only. */
export function isDailyCampaign(item) {
  const kind = String(item?.type || "");
  const unit = String(item?.benefitUnit || "");
  return (kind === "USER_LOGIN" || kind === "DAILY_CLAIM") && unit === "CREDIT" && item?.campaignId != null;
}

function isConfirmed(item) {
  const status = String(item?.status || "");
  return item?.claimable !== true && (status === "CONFIRMED" || status === "CONSUMED");
}

function hasWork(item) {
  return item?.claimable === true || String(item?.status || "") === "CLAIMED";
}

function campaignKey(item) {
  return String(item?.campaignId ?? "");
}

function excerpt(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text || "").slice(0, 300);
}

/** One signed welfare call; resolves to `{ok, code, data, message}` or a failure kind. */
async function welfareCall(connection, credential, method, path, body) {
  let response;
  try {
    response = await codeArtsFetch(`${CODEARTS_BASE_URL}${path}`, {
      method,
      body: body ? JSON.stringify(body) : "",
      headers: {
        "Agent-Type": "PromptCenter",
        "X-Language": "en-us",
      },
      credential,
      timeoutMs: 20_000,
    });
  } catch (error) {
    return { kind: "failed", message: `网络错误：${error?.message || error}` };
  }
  const text = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    return { kind: "needs-reauth", status: response.status, message: "CodeArts 凭据已失效（401/403）" };
  }
  if (response.status === 429) {
    return { kind: "limited", status: 429, message: "上游限流（429）" };
  }
  if (!response.ok) {
    return { kind: "failed", status: response.status, message: `HTTP ${response.status}: ${excerpt(text)}` };
  }
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    return { kind: "failed", message: `活动接口返回非 JSON：${excerpt(text)}` };
  }
  const code = payload?.code;
  if (String(code) === CODEARTS_WELFARE_NOT_YET_CODE) {
    // HTTP 200 + code 40001 = "not yet", not a failure. Never mark the day done.
    return { kind: "not-yet", code, message: String(payload?.message || payload?.msg || "未到权益刷新时间") };
  }
  if (Number(code) !== 0) {
    return { kind: "failed", code, message: `活动接口未确认成功（code=${code ?? "missing"}）：${excerpt(payload?.message || payload?.msg || payload)}` };
  }
  return { kind: "ok", code, data: payload?.data ?? null, raw: payload };
}

function result(status, extra = {}) {
  return { status, amount: 0, unit: "credits", before: null, after: null, ...extra };
}

function writeAllowed(connId, nowMs) {
  const day = beijingDayKey(nowMs);
  const ledger = writeLedger.get(connId);
  if (!ledger || ledger.day !== day) return true;
  if (ledger.attempts >= MAX_WRITES_PER_DAY) return false;
  return nowMs - ledger.lastAt >= MIN_WRITE_GAP_MS;
}

function recordWrite(connId, nowMs) {
  const day = beijingDayKey(nowMs);
  const ledger = writeLedger.get(connId);
  if (!ledger || ledger.day !== day) writeLedger.set(connId, { day, attempts: 1, lastAt: nowMs });
  else writeLedger.set(connId, { day, attempts: ledger.attempts + 1, lastAt: nowMs });
}

export async function claimCodeArtsWelfare(connection, { now = Date.now(), fetch: _fetch = null } = {}) {
  const credential = resolveCodeArtsCredential(connection);
  if (!credential) {
    return result("failed", { message: "CodeArts 凭据不完整：需要 accessKeyId / secretAccessKey" });
  }
  const connId = connection?.id || credential.domainId || credential.accessKeyId;

  // 1) delivery
  const delivered = await welfareCall(connection, credential, "GET", CODEARTS_DELIVERY_PATH);
  if (delivered.kind === "needs-reauth" || delivered.kind === "limited" || delivered.kind === "failed") {
    return result(delivered.kind, { message: delivered.message, code: delivered.code });
  }
  if (delivered.kind === "not-yet") {
    return result("no-activity", { message: delivered.message, code: delivered.code });
  }
  const items = Array.isArray(delivered.data?.items) ? delivered.data.items : null;
  if (!items) {
    return result("failed", { message: "活动列表响应缺少 items（读不懂不能当成没活动）" });
  }
  const picked = items.filter(isDailyCampaign);
  if (picked.length === 0) {
    return result("no-activity", { message: "上游活动列表里没有每日福利" });
  }
  if (picked.every(isConfirmed)) {
    return result("already", { message: "今天的福利上游已确认到账", before: picked });
  }
  if (!picked.some(hasWork)) {
    return result("no-activity", { message: "每日福利当前不可领（前置未满足）", before: picked });
  }

  // 2) claim (skip when upstream already says CLAIMED) + 3) confirm
  if (!writeAllowed(connId, now)) {
    return result("limited", { message: "本地写限流：今日领取次数已用尽或间隔不足 10 分钟", before: picked });
  }
  recordWrite(connId, now);

  for (const item of picked) {
    if (isConfirmed(item)) continue;
    const key = campaignKey(item);
    const idempotentKey = `${connId}::${key}`;
    let storedKey = idempotentKeys.get(idempotentKey);

    if (item.claimable === true && String(item.status || "") !== "CLAIMED") {
      if (!storedKey) {
        storedKey = `claim_${key}_${now}`;
        idempotentKeys.set(idempotentKey, storedKey);
      }
      const claimed = await welfareCall(connection, credential, "POST", CODEARTS_CLAIM_PATH, {
        campaignId: item.campaignId,
        idempotentKey: storedKey,
        channel: "IDE",
      });
      if (claimed.kind === "needs-reauth" || claimed.kind === "limited" || claimed.kind === "failed") {
        return result(claimed.kind, { message: claimed.message, code: claimed.code, before: picked });
      }
      if (claimed.kind === "not-yet") {
        return result("no-activity", { message: claimed.message, code: claimed.code, before: picked });
      }
      // The response must echo the campaign id; confirming a different campaign
      // would book somebody else's delivery as ours.
      const returned = String(asObject(claimed.data)?.campaignId ?? claimed.raw?.campaignId ?? "");
      if (returned && returned !== String(item.campaignId)) {
        return result("failed", { message: `领取响应活动 ID 不匹配（要 ${item.campaignId}，回 ${returned}），未进入确认阶段`, before: picked });
      }
    }

    const confirmed = await welfareCall(connection, credential, "POST", CODEARTS_CONFIRM_PATH, {
      campaignId: item.campaignId,
    });
    if (confirmed.kind === "needs-reauth" || confirmed.kind === "limited" || confirmed.kind === "failed") {
      return result(confirmed.kind, { message: confirmed.message, code: confirmed.code, before: picked });
    }
    if (confirmed.kind === "not-yet") {
      // CLAIMED but not yet confirmable: non-terminal, only confirm next time.
      return result("no-activity", { message: confirmed.message, code: confirmed.code, before: picked });
    }
  }

  // 4) re-read: code:0 is "accepted", only delivery says "landed"
  const verifiedCall = await welfareCall(connection, credential, "GET", CODEARTS_DELIVERY_PATH);
  if (verifiedCall.kind !== "ok") {
    return result("failed", { message: `领取已提交但回读失败：${verifiedCall.message}`, before: picked });
  }
  const verified = Array.isArray(verifiedCall.data?.items) ? verifiedCall.data.items : [];
  const missing = picked.filter((item) => hasWork(item)).filter((item) => {
    const seen = verified.find((row) => campaignKey(row) === campaignKey(item));
    return !seen || !isConfirmed(seen);
  });
  if (missing.length > 0) {
    return result("failed", {
      message: "请求已提交，但官方活动列表尚未确认到账；下次 tick 会只补 confirm",
      before: picked,
      after: verified,
    });
  }

  const confirmedRows = verified.filter((row) => picked.some((item) => campaignKey(item) === campaignKey(row)) && isConfirmed(row));
  const amount = confirmedRows.reduce((sum, row) => sum + (Number(row.benefitAmount) || 0), 0);
  return result("ok", {
    amount,
    before: picked,
    after: verified,
    message: confirmedRows.length ? "官方活动列表已回读确认到账" : "已确认（上游未给金额）",
  });
}

export default {
  id: "codearts",
  providers: ["codearts"],
  settingsKey: "codeartsCheckin",
  cadence: "daily",
  run: claimCodeArtsWelfare,
};
