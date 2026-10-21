// AtomCode "check-in": claim a free CodingPlan (not daily points).
//
// A plan is claimed once, then renews on expiry; the scheduler probes it as a
// `claim`-cadence adapter. Flow (our Rust provider checkin.rs / models.rs):
//   1. GET  {codingplan}/coding-plan/status-v2
//      `codingplan_free` with a non-empty expires_at (or remaining_days > 0)
//      means the plan is active -> already, no claim request.
//   2. POST {coding-plan}/claim-v2 with {"plan_type":"<tier>"}
//      Max -> Pro -> Lite, stop at the first tier that is `duplicate` (held) or
//      `success` (granted). A refusal falls through to the next tier.
//   3. On a grant, re-read status to report the delivered days.
//
// `duplicate:true` is success semantics: continuing past it would re-report or
// downgrade the account. Transport/HTTP failures abort the whole cascade —
// changing tiers cannot repair a broken connection.
//
// Returns {status, amount?, unit?, code, message}:
//   already     plan active / duplicate / same-day memo
//   no-activity every tier refused because the window is not open yet
//   ok          granted (amount = plan days when the verification read agrees)
//   needs-reauth 401/403
//   limited     429 or a concurrent run for the same account
//   failed      transport, 5xx, malformed body, or a non-timing refusal

import {
  ATOMCODE_ADAPTER_USER_AGENT,
  ATOMCODE_CODINGPLAN_CLAIM_PATH,
  ATOMCODE_CODINGPLAN_STATUS_PATH,
  ATOMCODE_PLAN_CASCADE,
  atomcodeCodingPlanBase,
} from "open-sse/shared/atomcode/constants.js";

const RUNNING = new Set();
// accountKey|day -> terminal outcome, so a manual second run is a no-op.
const DAY_MEMO = new Map();
const MEMO_LIMIT = 500;

const str = (source, key) => {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
};

const int = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

function localDayKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function accountKeyOf(conn) {
  return String(
    conn?.providerSpecificData?.userId ||
    conn?.id ||
    conn?.email ||
    conn?.name ||
    "unknown"
  );
}

function tokenOf(conn) {
  return conn?.accessToken || conn?.apiKey || "";
}

/** Test seam: clear the in-process lock/idempotency memo. */
export function __resetAtomcodeCheckinState() {
  RUNNING.clear();
  DAY_MEMO.clear();
}

/** `codingplan_free` -> active plan info. Empty expires_at means "pending activation". */
export function planFromStatus(payload) {
  const plan = payload?.codingplan_free;
  if (!plan || typeof plan !== "object") {
    return { active: false, planName: "", planType: "", expiresAt: "", remainingDays: 0, totalDays: 0 };
  }
  const planName = str(plan, "plan_name");
  const expiresAt = str(plan, "expires_at");
  const remainingDays = int(plan.remaining_days);
  const totalDays = int(plan.total_days);
  return {
    active: Boolean(expiresAt) || remainingDays > 0,
    planName,
    planType: str(plan, "plan_type") || str(payload, "plan_type"),
    expiresAt,
    remainingDays,
    totalDays,
  };
}

/**
 * One `claim-v2` body. `duplicate` is checked before `success` on purpose:
 * `duplicate:true` means the tier (or a higher one) is already held and must
 * stop the cascade instead of downgrading the account.
 */
export function classifyTierResponse(payload) {
  const message = str(payload, "message") || str(payload, "msg");
  const planName = str(payload, "plan_name") || str(payload, "planName");
  if (payload?.duplicate === true) {
    return { kind: "already", message, planName };
  }
  if (payload?.success === true) {
    return { kind: "granted", message, planName };
  }
  return { kind: "refused", message, planName };
}

/** Refusal copy that means "not yet", not "broken". */
export function isNotYetClaimable(message) {
  return /未到(领取|续领)时间|请稍后重试|活动.*(未开始|已结束|未开放)|不在.*活动|暂不可领取|不可领取/.test(
    String(message || "")
  );
}

/**
 * Walk Max -> Pro -> Lite with an injected `claimTier` (network-free testable).
 * `claimTier(tier)` resolves `{ ok, status, payload }`; throwing means transport.
 */
export async function cascadeClaim({ claimTier, tiers = ATOMCODE_PLAN_CASCADE } = {}) {
  const attempts = [];
  let lastMessage = "";

  for (const tier of tiers) {
    let result;
    try {
      result = await claimTier(tier);
    } catch (error) {
      return {
        outcome: "failed",
        code: "network",
        message: `AtomCode claim failed at ${tier}: ${error?.message || error}`,
        tier,
        attempts,
      };
    }

    if (!result?.ok) {
      const status = int(result?.status);
      attempts.push({ tier, outcome: "http-error", status });
      if (status === 401 || status === 403) {
        return {
          outcome: "needs-reauth",
          code: "auth",
          message: "AtomCode access token expired or rejected (HTTP 401/403). Sign in again.",
          tier,
          attempts,
        };
      }
      if (status === 429) {
        return {
          outcome: "limited",
          code: "rate-limited",
          message: "AtomCode claim is rate limited (HTTP 429). Retry later.",
          tier,
          attempts,
        };
      }
      return {
        outcome: "failed",
        code: status ? `http-${status}` : "network",
        message: `AtomCode claim returned HTTP ${status || "error"} at ${tier}.`,
        tier,
        attempts,
      };
    }

    const verdict = classifyTierResponse(result.payload);
    attempts.push({ tier, outcome: verdict.kind, message: verdict.message, planName: verdict.planName });

    if (verdict.kind === "already") {
      return {
        outcome: "already",
        code: "already-held",
        message: verdict.message || `已持有 ${tier} 档套餐，无需重复领取`,
        tier,
        planName: verdict.planName,
        attempts,
      };
    }
    if (verdict.kind === "granted") {
      return {
        outcome: "ok",
        code: "claimed",
        message: verdict.message || `已领取 ${tier} 档免费套餐`,
        tier,
        planName: verdict.planName,
        attempts,
      };
    }
    if (verdict.message) lastMessage = verdict.message;
  }

  if (isNotYetClaimable(lastMessage)) {
    return {
      outcome: "no-activity",
      code: "not-yet",
      message: lastMessage || "三档免费套餐暂不可领取（未到领取时间）",
      attempts,
    };
  }
  return {
    outcome: "failed",
    code: "refused",
    message: lastMessage || "三档免费套餐都未能领取（上游未说明原因）",
    attempts,
  };
}

async function requestJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  let payload = null;
  let text = "";
  try {
    if (typeof response.json === "function") {
      payload = await response.json();
      text = payload == null ? "" : JSON.stringify(payload);
    } else if (typeof response.text === "function") {
      text = await response.text();
      payload = text ? JSON.parse(text) : null;
    }
  } catch {
    payload = null;
  }
  return {
    ok: response.ok === true || (int(response.status) >= 200 && int(response.status) < 300),
    status: int(response.status),
    payload,
    text,
  };
}

function planMessage(plan) {
  let message = "套餐有效中，无需领取";
  if (plan.planName) message += `（${plan.planName}）`;
  if (plan.remainingDays > 0) message += `，剩余 ${plan.remainingDays} 天`;
  else if (plan.expiresAt) message += `，到期 ${plan.expiresAt}`;
  return message;
}

/**
 * Full network flow for one connection. No lock/memo here — `run` adds those.
 */
export async function runAtomcodeCheckin(conn, ctx = {}) {
  const token = tokenOf(conn);
  if (!token) {
    return { status: "needs-reauth", code: "no-credentials", message: "AtomCode account has no access token or API key." };
  }

  const fetchImpl = ctx.fetch || fetch;
  const base = atomcodeCodingPlanBase();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": ATOMCODE_ADAPTER_USER_AGENT,
  };
  const timeout = () => (AbortSignal.timeout ? AbortSignal.timeout(20_000) : undefined);

  let statusResult;
  try {
    statusResult = await requestJson(fetchImpl, `${base}${ATOMCODE_CODINGPLAN_STATUS_PATH}`, {
      method: "GET",
      headers,
      signal: timeout(),
    });
  } catch (error) {
    return { status: "failed", code: "network", message: `AtomCode status request failed: ${error?.message || error}` };
  }

  if (statusResult.status === 401 || statusResult.status === 403) {
    return { status: "needs-reauth", code: "auth", message: "AtomCode access token expired or rejected (HTTP 401/403)." };
  }
  if (statusResult.status === 429) {
    return { status: "limited", code: "rate-limited", message: "AtomCode status is rate limited (HTTP 429)." };
  }
  if (!statusResult.ok) {
    return {
      status: "failed",
      code: `http-${statusResult.status || "error"}`,
      message: `AtomCode status returned HTTP ${statusResult.status || "error"}.`,
    };
  }
  if (!statusResult.payload || typeof statusResult.payload !== "object") {
    return { status: "failed", code: "bad-response", message: "AtomCode status response was not JSON." };
  }

  const plan = planFromStatus(statusResult.payload);
  if (plan.active) {
    return {
      status: "already",
      code: "plan-active",
      message: planMessage(plan),
      ...(plan.planName ? { planName: plan.planName } : {}),
    };
  }

  const cascade = await cascadeClaim({
    claimTier: async (tier) => {
      try {
        return await requestJson(fetchImpl, `${base}${ATOMCODE_CODINGPLAN_CLAIM_PATH}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ plan_type: tier }),
          signal: timeout(),
        });
      } catch (error) {
        const wrapped = new Error(error?.message || String(error));
        wrapped.transport = true;
        throw wrapped;
      }
    },
  });

  if (cascade.outcome === "ok") {
    // Verify before claiming success: "success" from claim-v2 is the upstream's
    // word, and an empty expires_at is how the status API says "not active".
    let verifiedPlan = null;
    try {
      const verify = await requestJson(fetchImpl, `${base}${ATOMCODE_CODINGPLAN_STATUS_PATH}`, {
        method: "GET",
        headers,
        signal: timeout(),
      });
      if (verify.ok && verify.payload && typeof verify.payload === "object") {
        const candidate = planFromStatus(verify.payload);
        if (candidate.active) verifiedPlan = candidate;
      }
    } catch {
      // Keep the grant; report it as unverified below.
    }

    const days = verifiedPlan
      ? (verifiedPlan.totalDays || verifiedPlan.remainingDays || 0)
      : 0;
    return {
      status: "ok",
      ...(days > 0 ? { amount: days, unit: "天" } : {}),
      code: verifiedPlan ? "claimed" : "claimed-unverified",
      message: verifiedPlan
        ? `${cascade.message}（${planMessage(verifiedPlan)}）`
        : `${cascade.message}（上游已受理，暂未能二次确认到账）`,
      tier: cascade.tier,
      ...(cascade.planName ? { planName: cascade.planName } : {}),
      attempts: cascade.attempts,
    };
  }

  return {
    status: cascade.outcome,
    code: cascade.code,
    message: cascade.message,
    ...(cascade.tier ? { tier: cascade.tier } : {}),
    ...(cascade.planName ? { planName: cascade.planName } : {}),
    attempts: cascade.attempts,
  };
}

/** Terminal outcomes worth memoizing for the rest of the day. */
const MEMO_STATUSES = new Set(["ok", "already", "no-activity"]);

export default {
  id: "atomcode",
  providers: ["atomcode"],
  settingsKey: "atomcodeCheckin",
  cadence: "claim",

  async run(conn, ctx = {}) {
    const key = accountKeyOf(conn);
    const day = ctx.today || localDayKey();
    const memoKey = `${key}|${day}`;

    if (RUNNING.has(key)) {
      return { status: "limited", code: "in-progress", message: "AtomCode claim already running for this account." };
    }

    const memo = DAY_MEMO.get(memoKey);
    if (memo) {
      return {
        ...memo,
        status: memo.status === "ok" ? "already" : memo.status,
        code: "idempotent-memo",
        message: `已在本日完成（幂等键 ${memoKey}）：${memo.message}`,
      };
    }

    RUNNING.add(key);
    try {
      const outcome = await runAtomcodeCheckin(conn, ctx);
      if (MEMO_STATUSES.has(outcome.status)) {
        if (DAY_MEMO.size >= MEMO_LIMIT) {
          const first = DAY_MEMO.keys().next().value;
          if (first !== undefined) DAY_MEMO.delete(first);
        }
        DAY_MEMO.set(memoKey, outcome);
      }
      return outcome;
    } finally {
      RUNNING.delete(key);
    }
  },
};
