// OfficeAce control-plane helpers shared by the usage handler and the check-in
// adapter: credential extraction, `bonus_skus` parsing, the before/after delta
// that decides whether a claim actually landed, and a signed request helper.
//
// All numbers arrive as STRINGS (`"points":"4000"`, `"current_value":"0.66"`),
// so they go through `Number()`. Reward rows may lack `activity_id` (only
// `activity_name` / `cbc_resource_id`), and dropping those rows would read as
// "no activity" — the key falls back in that order.
import { OFFICEACE_DEFAULT_REGION } from "../../config/officeace.js";
import { signOfficeAceRequest } from "./signer.js";

const trimStr = (value) => (typeof value === "string" ? value.trim() : "");
const num = (value) => {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : 0;
};

/** Signing material from providerSpecificData (Basic-only connections lack it). */
export function officeaceControlCredential(source) {
  const psd = source?.providerSpecificData || source || {};
  const credential = {
    accessKeyId: trimStr(psd.accessKeyId || psd.access_key_id || psd.ak),
    secretAccessKey: trimStr(psd.secretAccessKey || psd.secret_access_key || psd.sk),
    securityToken: trimStr(psd.securityToken || psd.security_token || psd.stsToken),
    projectId: trimStr(psd.projectId || psd.project_id),
  };
  const baseUrl = trimStr(psd.baseUrl || psd.apiBase || psd.api_base);
  const region = trimStr(psd.region) || OFFICEACE_DEFAULT_REGION;
  return { credential, baseUrl, region };
}

export function hasOfficeaceSigningMaterial(credential) {
  return Boolean(credential?.accessKeyId && credential?.secretAccessKey);
}

function expiredAtMs(value) {
  if (typeof value === "number") return value;
  const text = trimStr(value);
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `bonus_skus[]` → `{activityId, name, total, used, remaining, expiresAt}`. */
export function officeaceBonusesOf(payload) {
  const items = Array.isArray(payload?.bonus_skus) ? payload.bonus_skus : [];
  const bonuses = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const activityId =
      trimStr(item.activity_id) || trimStr(item.cbc_resource_id) || trimStr(item.activity_name);
    if (!activityId) continue;
    const total = num(item.points);
    const used = num(item.current_value);
    bonuses.push({
      activityId,
      name: trimStr(item.activity_name) || activityId,
      total,
      used,
      remaining: Math.max(0, total - used),
      expiresAt: expiredAtMs(item.expired_time),
    });
  }
  return bonuses;
}

/**
 * Points actually gained between two `/v1/subscription` reads.
 * Per activity: increase of `total - current_value` (clamped at 0); a newly
 * appearing activity counts with its whole remaining amount. `before === null`
 * (unreadable snapshot) returns `null` — the caller must NOT call that "0".
 */
export function officeaceGainedBetween(before, after) {
  if (!before || !after) return null;
  const previous = new Map(officeaceBonusesOf(before).map((bonus) => [bonus.activityId, bonus.remaining]));
  let gained = 0;
  for (const bonus of officeaceBonusesOf(after)) {
    const prev = previous.get(bonus.activityId);
    gained += prev === undefined ? bonus.remaining : Math.max(0, bonus.remaining - prev);
  }
  return gained;
}

/** signed control-plane call; returns `{kind, status, payload, message}` */
export async function officeaceControlRequest(
  fetchImpl,
  { method = "GET", path, body = "", credential, baseUrl, region, headers = {}, timeoutMs = 20_000, proxyOptions = null }
) {
  const url = `${String(baseUrl || "").replace(/\/+$/, "").replace(/\/v2$/, "")}${path}`;
  let signed;
  try {
    signed = signOfficeAceRequest({
      algorithm: "V11",
      method,
      url,
      headers: {
        ...headers,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body,
      credential,
      region: region || OFFICEACE_DEFAULT_REGION,
    });
  } catch (error) {
    return { kind: "sign", status: 0, message: error?.message || String(error) };
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: signed.headers,
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    }, proxyOptions);
  } catch (error) {
    return { kind: "network", status: 0, message: error?.message || String(error) };
  }

  const status = Number(response?.status) || 0;
  let text = "";
  try {
    text = typeof response?.text === "function" ? await response.text() : "";
  } catch {
    text = "";
  }
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (status === 401 || status === 403) {
    return { kind: "auth", status, payload, message: `控制面凭据失效（HTTP ${status}）` };
  }
  if (status === 429) {
    return { kind: "limited", status, payload, message: "上游限流（429）" };
  }
  if (response?.ok === false || status >= 400) {
    return { kind: "http", status, payload, message: `上游返回 HTTP ${status}` };
  }
  return { kind: "ok", status, payload, message: "" };
}
