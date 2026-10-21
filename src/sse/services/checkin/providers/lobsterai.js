// LobsterAI（网易有道龙虾）daily check-in adapter.
//
// Three steps, all against https://lobsterai-server.youdao.com:
//   1. GET  /api/client-activities/slot?placement=desktop_sidebar&clientVersion=…
//   2. GET  /api/client-activities/{code}/context?configRevision=…
//   3. POST /api/client-activities/{code}/actions/check_in
//         body { configRevision, idempotencyKey:<uuid4>, payload:{} }
//
// Idempotency is the CLIENT's job — the upstream has no "already claimed" reply
// shape strong enough to rely on. Both pre-checks are required:
// `state.claimedToday` AND `check_in` present in `actions[]`. Hitting only one
// misses "activity exists but cannot be signed today" (Rust checkin.rs). When a
// pre-check says done/already, we do NOT call the action endpoint — a
// non-idempotent upstream would grant the day twice.
//
// "已签到" and "无活动" are neutral outcomes (already / no-activity), never a
// failure: the scheduler memoizes them for the day instead of retrying.
//
// Amount comes from a before/after `/api/user/profile-summary` read (the
// authoritative credit balance, not `/api/user/quota`'s fixed 300). If the
// balance read is unavailable we fall back to the declared reward fields
// (creditsGranted → rewardCredits → credits).
import {
  LOBSTERAI_API_BASE,
  LOBSTERAI_CHECK_IN_ACTION,
  LOBSTERAI_PATHS,
  LOBSTERAI_PROFILE_SUMMARY_URL,
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  LOBSTERAI_SLOT,
  LOBSTERAI_USER_AGENT,
} from "open-sse/shared/lobsterai/constants.js";
import {
  isAlreadyCheckedInText,
  isSessionDeadCode,
  isSessionDeadText,
  parseCredits,
  readNumber,
  resolveClientVersion,
  roundCredits,
  unwrapEnvelope,
  uuidV4,
} from "open-sse/shared/lobsterai/client.js";

const UNIT = "积分";

function tokenOf(conn) {
  const token = typeof conn?.accessToken === "string" ? conn.accessToken.trim() : "";
  return token;
}

function failure(status, message) {
  return { status, message };
}

async function requestJson(method, url, token, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": LOBSTERAI_USER_AGENT,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, status: "failed", message: `LobsterAI 请求失败：${error?.message || error}` };
  }

  const text = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: "needs-reauth", message: `LobsterAI 凭据已失效（HTTP ${response.status}），请重新登录` };
  }
  if (response.status === 429) {
    return { ok: false, status: "limited", message: "LobsterAI 限流（HTTP 429）" };
  }
  if (!response.ok) {
    return { ok: false, status: "failed", message: `LobsterAI 返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ""}` };
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, status: "failed", message: "LobsterAI 响应不是 JSON" };
  }
  return { ok: true, payload };
}

function envelopeFailure(unwrapped) {
  if (!unwrapped.ok) {
    if (unwrapped.status === 401) return { status: "needs-reauth", message: unwrapped.message };
    if (isSessionDeadCode(unwrapped.code) || isSessionDeadText(unwrapped.message)) {
      return { status: "needs-reauth", message: unwrapped.message };
    }
    return { status: "failed", message: unwrapped.message };
  }
  return null;
}

async function readBalance(token) {
  const result = await requestJson("GET", LOBSTERAI_PROFILE_SUMMARY_URL, token);
  if (!result.ok) return { available: null, error: result };
  const unwrapped = unwrapEnvelope(result.payload, "积分查询");
  const failureInfo = envelopeFailure(unwrapped);
  if (failureInfo) return { available: null, error: failureInfo };
  return { available: parseCredits(unwrapped.data).available, error: null };
}

function slotUrl(clientVersion) {
  const params = new URLSearchParams({
    placement: LOBSTERAI_SLOT.placement,
    clientVersion,
    containerApiVersion: LOBSTERAI_SLOT.containerApiVersion,
    platform: LOBSTERAI_SLOT.platform,
  });
  return `${LOBSTERAI_API_BASE}${LOBSTERAI_PATHS.activitySlot}?${params.toString()}`;
}

function contextUrl(code, revision) {
  const encodedCode = encodeURIComponent(code);
  const encodedRevision = encodeURIComponent(revision);
  return `${LOBSTERAI_API_BASE}${LOBSTERAI_PATHS.activityContext}/${encodedCode}/context?configRevision=${encodedRevision}`;
}

function checkinUrl(code) {
  return `${LOBSTERAI_API_BASE}${LOBSTERAI_PATHS.activityContext}/${encodeURIComponent(code)}/actions/${LOBSTERAI_CHECK_IN_ACTION}`;
}

/** 活动位 `data` 里我们关心的三个字段 */
export function parseSlot(data) {
  const activity = data?.activity && typeof data.activity === "object" ? data.activity : {};
  return {
    slotState: typeof data?.slotState === "string" ? data.slotState.trim() : "",
    activityCode: typeof activity.activityCode === "string" ? activity.activityCode.trim() : "",
    configRevision: activity.configRevision,
  };
}

/** `configRevision` 渲染成 query 里的数（整数不带小数尾巴；读不出给 "0"） */
export function revisionString(value) {
  const number = readNumber(value);
  return number === undefined ? "0" : String(number);
}

/** `configRevision` 作为 JSON 数字放进签到体 */
export function revisionJson(value) {
  const number = readNumber(value);
  return number === undefined ? 0 : number;
}

/** 发放额三段回退：creditsGranted → rewardCredits → credits */
export function declaredCredit(result) {
  if (!result || typeof result !== "object") return undefined;
  for (const key of ["creditsGranted", "rewardCredits", "credits"]) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const value = readNumber(result[key]);
      if (value !== undefined) return roundCredits(value);
    }
  }
  return undefined;
}

function neutral(status, message, extra = {}) {
  return { status, message, unit: UNIT, ...extra };
}

export default {
  id: "lobsterai",
  providers: ["lobsterai"],
  settingsKey: "lobsteraiCheckin",
  cadence: "daily",

  async run(conn, ctx = {}) {
    const token = tokenOf(conn);
    if (!token) return failure("needs-reauth", "LobsterAI 连接缺少 accessToken，请重新登录");

    // 活动位按 clientVersion 决定活动可见性：旧版本号会拿到 slotState=empty。
    // 版本接口不可用时用兜底常量，仍可能拿不到活动 —— 如实回 no-activity。
    const clientVersion = await resolveClientVersion();

    // 领前余额：读不到不阻断签到，只是失去「到账量」的权威读数。
    const beforeRead = await readBalance(token);
    if (beforeRead.error?.status === "needs-reauth") return beforeRead.error;
    const before = beforeRead.available;

    // ── 第一步：活动位 ─────────────────────────────────────────
    const slotResult = await requestJson("GET", slotUrl(clientVersion), token);
    if (!slotResult.ok) return slotResult;
    const slotUnwrapped = unwrapEnvelope(slotResult.payload, "活动槽位查询");
    const slotFailure = envelopeFailure(slotUnwrapped);
    if (slotFailure) return slotFailure;
    const slot = parseSlot(slotUnwrapped.data);
    if (slot.slotState !== "available" || !slot.activityCode) {
      return neutral("no-activity", `今天没有可签到的活动（slotState=${slot.slotState || "empty"}）`, {
        before,
        code: slot.activityCode || undefined,
      });
    }

    // ── 第二步：两道预检（幂等靠客户端，缺一不可）───────────────
    const revision = revisionString(slot.configRevision);
    const contextResult = await requestJson("GET", contextUrl(slot.activityCode, revision), token);
    if (!contextResult.ok) return contextResult;
    const contextUnwrapped = unwrapEnvelope(contextResult.payload, "活动上下文查询");
    const contextFailure = envelopeFailure(contextUnwrapped);
    if (contextFailure) return contextFailure;
    const contextData = contextUnwrapped.data;
    const claimedToday = contextData?.state?.claimedToday === true;
    const actions = Array.isArray(contextData?.actions) ? contextData.actions : [];
    const hasCheckIn = actions.some(
      (action) => typeof action === "string" && action.trim() === LOBSTERAI_CHECK_IN_ACTION,
    );

    if (claimedToday) {
      return neutral("already", "今天已签到", {
        before,
        after: before,
        amount: 0,
        code: slot.activityCode,
      });
    }
    if (!hasCheckIn) {
      return neutral("no-activity", "当前不可签到（活动未开放 check_in）", {
        before,
        code: slot.activityCode,
      });
    }

    // 手动 dry-run 只走到预检，不提交签到。
    if (ctx.dryRun) {
      return neutral("ok", "dry-run：今日可签到（未提交）", {
        before,
        amount: 0,
        code: slot.activityCode,
      });
    }

    // ── 第三步：真签（幂等键每次新生成）────────────────────────
    const body = {
      configRevision: revisionJson(slot.configRevision),
      idempotencyKey: uuidV4(),
      payload: {},
    };
    const actionResult = await requestJson("POST", checkinUrl(slot.activityCode), token, body);
    if (!actionResult.ok) return actionResult;

    const actionUnwrapped = unwrapEnvelope(actionResult.payload, "签到");
    if (!actionUnwrapped.ok) {
      // 上游可能用业务错误表达「今天已签」：中性结果，不算失败。
      if (isAlreadyCheckedInText(actionUnwrapped.message)) {
        return neutral("already", "今天已签到", {
          before,
          after: before,
          amount: 0,
          code: slot.activityCode,
        });
      }
      return envelopeFailure(actionUnwrapped) || failure("failed", actionUnwrapped.message);
    }

    const result = actionUnwrapped.data?.result ?? actionUnwrapped.data ?? {};
    const declared = declaredCredit(result);
    const afterRead = await readBalance(token);
    const after = afterRead.available;

    // 余额差是权威读数；读不到或差值为 0（发放延迟）时用声明的奖励兜底。
    const diff = before !== null && after !== null ? roundCredits(after - before) : undefined;
    const amount = diff !== undefined && diff > 0 ? diff : declared;
    const message = amount !== undefined && amount > 0
      ? `签到成功，获得 ${amount} 积分`
      : "签到成功";

    return neutral("ok", message, {
      before,
      after,
      amount: amount ?? 0,
      code: slot.activityCode,
    });
  },
};

/** 单测入口 */
export const __test__ = {
  parseSlot,
  revisionString,
  revisionJson,
  declaredCredit,
  slotUrl,
  contextUrl,
  checkinUrl,
  requestJson,
};
