// OfficeAce check-in = one-shot subscription reward claim.
//
// `POST {gateway}/v1/subscription/bonus/claim` (body `{}`, V11-signed) grants
// every currently claimable reward for the day (daily bonus + newcomer gift in
// one action). It is NOT a daily sign-in click: upstream allows one claim per
// activity per day and repeats are idempotent (same list back, no error).
//
// A 2xx is NOT proof. The only proof is the ledger delta: read
// `/v1/subscription` before and after and compare each activity's consumed
// `current_value` (equivalently the decrease of `points - current_value`).
// gain > 0 → ok; otherwise the truth is either "already" (activities exist and
// are exhausted) or "no-activity" (no reward activities). A claim that returns
// 2xx while an unclaimed activity is still sitting there is a *failure*, not a
// quiet success.
//
// Credentials: the control plane needs the temporary AK/SK/STS + project id
// (V11 signing), which OAuth provides. Basic-only connections cannot claim.
import {
  OFFICEACE_BONUS_CLAIM_PATH,
  OFFICEACE_SUBSCRIPTION_PATH,
  OFFICEACE_SUBSCRIPTION_TYPE,
} from "open-sse/config/officeace.js";
import {
  hasOfficeaceSigningMaterial,
  officeaceBonusesOf,
  officeaceControlCredential,
  officeaceControlRequest,
  officeaceGainedBetween,
} from "open-sse/shared/officeace/subscription.js";

const UNIT = "积分";

function subscriptionHeaders() {
  return { [OFFICEACE_SUBSCRIPTION_TYPE.name]: OFFICEACE_SUBSCRIPTION_TYPE.value };
}

/**
 * Decide the outcome from two `/v1/subscription` snapshots.
 * `beforePayload === null` means the pre-claim read failed — the delta is then
 * unknown and must never be reported as 0.
 */
export function officeaceClaimOutcome(beforePayload, afterPayload) {
  const bonuses = officeaceBonusesOf(afterPayload);
  const gained = officeaceGainedBetween(beforePayload, afterPayload);

  if (gained === null) {
    if (bonuses.length > 0 && bonuses.every((bonus) => bonus.remaining <= 0)) {
      return { status: "already", amount: 0, message: "奖励看起来已领完（领前读数缺失，无法核对增量）" };
    }
    return { status: "failed", amount: 0, message: "无法核对领取结果：领前或领后的订阅读数缺失" };
  }
  if (gained > 0) {
    return { status: "ok", amount: gained, message: `已领取 ${gained} 积分` };
  }
  if (bonuses.length === 0) {
    return { status: "no-activity", amount: 0, message: "当前没有可领取的奖励活动" };
  }
  if (bonuses.every((bonus) => bonus.remaining <= 0)) {
    return { status: "already", amount: 0, message: "奖励已领取过（领取前后额度无增量）" };
  }
  return { status: "failed", amount: 0, message: "领取请求已发出，但奖励额度没有增加" };
}

function failureOf(error, { before = null, after = null, message = "" } = {}) {
  const status = error?.kind === "auth"
    ? "needs-reauth"
    : error?.kind === "limited"
      ? "limited"
      : "failed";
  return {
    status,
    amount: 0,
    unit: UNIT,
    before,
    after,
    code: error?.status ?? null,
    message: message || error?.message || "请求失败",
  };
}

/**
 * Claim today's reward for one connection.
 * `ctx.fetch` and `ctx.now` are test seams; the scheduler only passes
 * `{ settings, dryRun, today }`.
 */
export async function claimOfficeaceBonus(conn, ctx = {}) {
  const { credential, baseUrl, region } = officeaceControlCredential(conn);
  if (!hasOfficeaceSigningMaterial(credential)) {
    return {
      status: "needs-reauth",
      amount: 0,
      unit: UNIT,
      before: null,
      after: null,
      message: "连接缺少 OfficeAce 控制面凭据（AK/SK/STS），只有网关 Basic 对无法领取；请完成 OAuth 或补全字段",
    };
  }
  if (!baseUrl) {
    return {
      status: "needs-reauth",
      amount: 0,
      unit: UNIT,
      before: null,
      after: null,
      message: "连接缺少 OfficeAce 网关地址（providerSpecificData.baseUrl）",
    };
  }

  const fetchImpl = typeof ctx.fetch === "function" ? ctx.fetch : globalThis.fetch;
  const common = { credential, baseUrl, region, timeoutMs: 20_000 };

  // ① Snapshot before. A failure here is recorded but does not abort: the claim
  //    is server-side and may still land (Rust keeps going for the same reason).
  const beforeRead = await officeaceControlRequest(fetchImpl, {
    ...common,
    method: "GET",
    path: OFFICEACE_SUBSCRIPTION_PATH,
    headers: subscriptionHeaders(),
  });
  if (beforeRead.kind === "auth" || beforeRead.kind === "limited") {
    return failureOf(beforeRead);
  }
  const before = beforeRead.kind === "ok" ? beforeRead.payload : null;
  const notes = [];
  if (beforeRead.kind !== "ok") notes.push(`领前读数失败：${beforeRead.message}`);

  if (ctx.dryRun === true) {
    return {
      status: before ? "no-activity" : "failed",
      amount: 0,
      unit: UNIT,
      before: null,
      after: null,
      message: before
        ? "dry-run：未触发领取（真实领取前无法判断是否有活动）"
        : "dry-run：领前读数失败，未触发领取",
    };
  }

  // ② Claim. 2xx only means "accepted"; the delta below decides.
  const claim = await officeaceControlRequest(fetchImpl, {
    ...common,
    method: "POST",
    path: OFFICEACE_BONUS_CLAIM_PATH,
    body: "{}",
    headers: subscriptionHeaders(),
  });
  if (claim.kind === "auth" || claim.kind === "limited") {
    return failureOf(claim, { before });
  }
  if (claim.kind !== "ok") notes.push(`领取请求异常：${claim.message}`);

  // ③ Snapshot after — the authoritative answer.
  const afterRead = await officeaceControlRequest(fetchImpl, {
    ...common,
    method: "GET",
    path: OFFICEACE_SUBSCRIPTION_PATH,
    headers: subscriptionHeaders(),
  });
  if (afterRead.kind === "auth" || afterRead.kind === "limited") {
    return failureOf(afterRead, { before });
  }
  const after = afterRead.kind === "ok" ? afterRead.payload : null;
  if (!after) {
    return failureOf(afterRead, {
      before,
      message: `领取后读数失败，无法核对增量：${afterRead.message}`,
    });
  }

  const outcome = officeaceClaimOutcome(before, after);
  let message = outcome.message;
  if (notes.length) message += `；${notes.join("；")}`;
  return {
    status: outcome.status,
    amount: outcome.amount,
    unit: UNIT,
    before: before ? sumRemaining(before) : null,
    after: sumRemaining(after),
    message,
  };
}

/** Total reward points currently left, for the ledger's before/after columns. */
function sumRemaining(payload) {
  return officeaceBonusesOf(payload).reduce((total, bonus) => total + bonus.remaining, 0);
}

export default {
  id: "officeace",
  providers: ["officeace"],
  settingsKey: "officeaceCheckin",
  // One claim per activity per day; upstream is idempotent on repeats.
  cadence: "claim",
  run(conn, ctx = {}) {
    return claimOfficeaceBonus(conn, ctx);
  },
};
