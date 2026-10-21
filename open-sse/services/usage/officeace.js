// OfficeAce usage — `/v1/subscription` on the control plane (V11-HMAC signed).
//
// The payload has two wallets:
//   • plan  — `skus[].quotas[]`, `sku_attr_code` = `officeace_points` (points,
//     what inference burns) plus `online_search_count`;
//   • bonus — `bonus_skus[]` (reward activities: newcomer gift, daily bonus),
//     total in `points`, consumed in `current_value`, expiry in `expired_time`.
//
// All numbers arrive as STRINGS (`"sku_value":"500"`) — `Number()` on them,
// never arithmetic on the raw object. An unparsable payload must say "I did not
// understand this" instead of "you have 0 left".
//
// This endpoint needs the temporary AK/SK/STS that only OAuth (or a full manual
// import) provides. A Basic-only gateway connection carries no signing
// material, and this handler says exactly that.
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  OFFICEACE_OUTPUT_LIMITS,
  OFFICEACE_SUBSCRIPTION_PATH,
  OFFICEACE_SUBSCRIPTION_TYPE,
} from "../../config/officeace.js";
import {
  hasOfficeaceSigningMaterial,
  officeaceBonusesOf,
  officeaceControlCredential,
  officeaceControlRequest,
} from "../../shared/officeace/subscription.js";

const TIMEOUT_MS = 20_000;

/** `bonus_skus[]` re-export for callers that only need the activity list. */
export { officeaceBonusesOf };

const num = (value) => {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : 0;
};
const trimStr = (value) => (typeof value === "string" ? value.trim() : "");

function expiredAtMs(value) {
  if (typeof value === "number") return value;
  const text = trimStr(value);
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Map `/v1/subscription` to the `{ quotas }` dashboard shape.
 * Returns `{ message }` when the payload carried no recognisable wallet.
 */
export function shapeOfficeAceUsage(payload) {
  const now = Date.now();
  const quotas = {};
  let planTotal = 0;
  let planUsed = 0;
  let planName = "";
  let searchTotal = 0;
  let searchUsed = 0;
  let sawPlan = false;

  for (const sku of Array.isArray(payload?.skus) ? payload.skus : []) {
    for (const quota of Array.isArray(sku?.quotas) ? sku.quotas : []) {
      const expired = expiredAtMs(quota?.expired_time);
      if (expired > 0 && expired <= now) continue;
      const code = trimStr(quota?.sku_attr_code);
      if (code === "officeace_points") {
        sawPlan = true;
        planTotal += num(quota.sku_value);
        planUsed += num(quota.current_value);
        const skuName = trimStr(sku.sku_name);
        if (!planName && skuName) planName = skuName;
      } else if (code === "online_search_count") {
        searchTotal += num(quota.sku_value);
        searchUsed += num(quota.current_value);
      }
    }
  }

  if (sawPlan) {
    const total = Math.max(0, planTotal);
    const used = Math.max(0, planUsed);
    const remaining = Math.max(0, total - used);
    const name = planName || "套餐积分";
    quotas[name] = {
      name,
      used,
      total,
      remaining,
      remainingPercentage: total > 0 ? (remaining / total) * 100 : 0,
      unit: "积分",
    };
  }
  if (searchTotal > 0) {
    const remaining = Math.max(0, searchTotal - searchUsed);
    quotas["联网搜索次数"] = {
      name: "联网搜索次数",
      used: Math.max(0, searchUsed),
      total: searchTotal,
      remaining,
      remainingPercentage: (remaining / searchTotal) * 100,
      unit: "次",
    };
  }

  for (const bonus of officeaceBonusesOf(payload)) {
    if (bonus.expiresAt > 0 && bonus.expiresAt <= now) continue;
    const name = `奖励积分 · ${bonus.name}`;
    let unique = name;
    let index = 2;
    while (quotas[unique]) unique = `${name} #${index++}`;
    quotas[unique] = {
      name: unique,
      used: bonus.used,
      total: bonus.total,
      remaining: bonus.remaining,
      remainingPercentage: bonus.total > 0 ? (bonus.remaining / bonus.total) * 100 : 0,
      unit: "积分",
      ...(bonus.expiresAt > 0 ? { resetAt: new Date(bonus.expiresAt).toISOString() } : {}),
    };
  }

  if (Object.keys(quotas).length === 0) {
    return { message: "OfficeAce 订阅接口没有返回可识别的套餐或奖励额度。" };
  }

  return {
    ...(planName ? { plan: planName } : {}),
    quotas,
    // Informational: per-family completion ceilings enforced by the executor.
    modelOutputLimits: OFFICEACE_OUTPUT_LIMITS.map((entry) => ({
      family: entry.family,
      maxOutputTokens: entry.maxOutputTokens,
      combined: entry.combined,
    })),
  };
}

export async function getOfficeAceUsage(apiKey, providerSpecificData, proxyOptions = null) {
  const { credential, baseUrl, region } = officeaceControlCredential({ apiKey, providerSpecificData });
  if (!hasOfficeaceSigningMaterial(credential)) {
    return {
      message:
        "OfficeAce 额度接口需要控制面凭据（accessKeyId/secretAccessKey/securityToken/projectId），" +
        "当前连接只有网关 Basic 对。OAuth 登录落地前，请在连接的高级设置里补全这些字段。",
    };
  }
  if (!baseUrl) {
    return { message: "OfficeAce 连接缺少网关地址（providerSpecificData.baseUrl）。" };
  }

  const result = await officeaceControlRequest(proxyAwareFetch, {
    method: "GET",
    path: OFFICEACE_SUBSCRIPTION_PATH,
    credential,
    baseUrl,
    region,
    headers: { [OFFICEACE_SUBSCRIPTION_TYPE.name]: OFFICEACE_SUBSCRIPTION_TYPE.value },
    timeoutMs: TIMEOUT_MS,
    proxyOptions,
  });

  if (result.kind === "auth") {
    return { message: "OfficeAce 控制面凭据已失效（401/403），请重新登录或补全 AK/SK/STS。" };
  }
  if (result.kind === "limited") {
    return { message: "OfficeAce 额度接口被限流（429），稍后再试。" };
  }
  if (result.kind !== "ok") {
    return { message: `OfficeAce 额度请求失败：${result.message || "未知错误"}` };
  }
  if (!result.payload || typeof result.payload !== "object") {
    return { message: "OfficeAce 额度接口返回的不是 JSON。" };
  }
  return shapeOfficeAceUsage(result.payload);
}
