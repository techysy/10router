import { translate } from "@/i18n/runtime";
import { REALNAME_GATE_RE } from "open-sse/config/errorConfig.js";
import { extractRealnameVerificationUrl } from "./validationUrl.js";

/**
 * Friendly i18n translation for upstream quota-exhausted errors.
 *
 * Covers Google-style HTTP 429 `RESOURCE_EXHAUSTED` payloads (Antigravity /
 * Gemini Code Assist), e.g.:
 *   "Individual quota reached. Please upgrade your subscription to increase
 *    your limits. Resets in 1h27m36s."
 *   with details[].quotaResetDelay ("1h27m36.139434956s") and
 *   details[].quotaResetTimeStamp ("2026-09-15T12:52:06Z").
 *
 * Dynamic values (reset time / countdown) cannot live in the literal
 * dictionary, so templates are looked up then placeholders replaced here.
 */

const RESET_TEMPLATE_KEY = "Individual quota reached. Resets at {time} (in {duration}).";

// Same failure, but scoped to ONE model. Google bills a single account against
// several independent per-model buckets (Antigravity's 5h individual quota is
// per model), while the lock we store is per-model too — yet the account-wide
// wording above reads as "this whole account is dead for 5 hours", which is
// exactly what issue #46 reported: other models on the same connection keep
// serving traffic the entire time. Qualify the sentence when the payload names
// the model; the account-wide template stays for payloads that don't (a genuine
// whole-account exhaustion).
const RESET_PER_MODEL_TEMPLATE_KEY = "Individual quota reached for model {model}. Resets at {time} (in {duration}).";

// Plan/subscription quota (MiMo's weekly allowance and friends) is a DIFFERENT
// failure from Google's per-minute cap: there is no countdown in the payload and
// no upgrade path we can speak to, so it gets its own template. Without this
// branch the raw JSON blob (`[403]: {"error":{"message":"本周用量已满…` renders in
// the row and gets truncated mid-sentence by the max-width span.
const SUBSCRIPTION_TEMPLATE_KEY = "Subscription quota used up. Please wait for the quota reset.";

// MiMo: "code":"subscription_quota_exhausted","biz_code":30011 (HTTP 403).
// Deliberately NARROW: Google's 429 payload also carries a `QUOTA_EXHAUSTED`
// reason, so a looser pattern would steal that case and drop its reset clock.
// The Chinese phrases cover deployments that only send a message.
const SUBSCRIPTION_QUOTA_RE = /subscription_quota_exhausted|本周用量已满|本周额度已用完/i;

// StepFun CN Step Plan 免费套餐的实名闸门（HTTP 403）。与 SUBSCRIPTION_QUOTA_RE
// 同族的「配置状态、无倒计时」类：等多久都不会自己好，所以文案里不给时间、只给
// 出路。原先它落到下面 Google 分支之外的 `direct` 兜底，把整坨英文 JSON 渲染进
// 连接行那条 300px 的红字里，被 max-width 截断成半句。
// 正则与文案的真相源在 open-sse/config/errorConfig.js（客户端提示共用同一份）。
const REALNAME_TEMPLATE_KEY = "This account must complete real-name verification before StepFun will serve it. Complete it at {url}, then retry.";

function fmtUnit(key, n) {
  // Falls back to the raw key ("{n}h" -> "3h") when the dictionary is missing.
  return translate(key).replace("{n}", String(n));
}

/**
 * Parse a Google-style duration string ("1h27m36.139434956s") into {h, m, s}.
 * Returns null when nothing parses.
 */
export function parseQuotaDurationParts(str) {
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(String(str || "").trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return {
    h: Math.floor(parseFloat(m[1] || 0)),
    m: Math.floor(parseFloat(m[2] || 0)),
    s: Math.round(parseFloat(m[3] || 0)),
  };
}

/**
 * Format parsed parts into a localized duration like "1小时27分36秒" / "1h 27m 36s".
 *
 * A wait measured in days must NOT collapse to a single unit: "41小时" (and the
 * expiry badge's "1d") both hide how much of the day is left, so >=24h renders as
 * "1d 17h". Below a day the existing h/m/s rendering is kept intact.
 */
export function formatQuotaDuration(parts) {
  if (!parts) return "";
  let { h, m, s } = parts;
  if (s >= 60) { m += Math.floor(s / 60); s %= 60; }
  if (m >= 60) { h += Math.floor(m / 60); m %= 60; }
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const remHours = h % 24;
    // Minutes/seconds are noise once the wait is measured in days.
    return remHours > 0 ? `${fmtUnit("{n}d", d)} ${fmtUnit("{n}h", remHours)}` : fmtUnit("{n}d", d);
  }
  const segments = [];
  if (h > 0) segments.push(fmtUnit("{n}h", h));
  if (m > 0) segments.push(fmtUnit("{n}m", m));
  if (s > 0 || segments.length === 0) segments.push(fmtUnit("{n}s", s));
  return segments.join(" ");
}

/** Extract reset info from a raw error payload (JSON body or plain message). */
export function extractQuotaResetInfo(text) {
  const raw = String(text || "");
  let delay = null;
  let timestamp = null;

  const delayJson = /"quotaResetDelay"\s*:\s*"([^"]+)"/.exec(raw);
  const delayPlain = /\bResets in\s+([0-9hms.]+)/i.exec(raw);
  delay = (delayJson && delayJson[1]) || (delayPlain && delayPlain[1]) || null;

  const tsJson = /"quotaResetTimeStamp"\s*:\s*"([^"]+)"/.exec(raw);
  const tsPlain = /"quotaResetTimeStamp"\s*:\s*(".*?"|\S+)/.exec(raw);
  timestamp = (tsJson && tsJson[1]) || (tsPlain && tsPlain[1]) || null;
  if (timestamp) timestamp = timestamp.replace(/^"|"$/g, "");

  // The same metadata block that carries the reset fields also names the model
  // the bucket belongs to ("model": "gemini-3.8-flash-high"). It was parsed
  // past and dropped, which is how a per-model limit rendered as an
  // account-wide outage (#46).
  const model = /"model"\s*:\s*"([^"]+)"/.exec(raw)?.[1] || null;

  return { delay, timestamp, model };
}

function formatResetTime(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts || "";
  try {
    return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return date.toISOString();
  }
}

/**
 * Translate an upstream error string into a friendly localized message.
 * Unmatched inputs fall back to the plain literal translate() pipeline.
 */
export function translateQuotaError(errorText) {
  if (!errorText || typeof errorText !== "string") return errorText ?? "";

  const direct = translate(errorText);
  if (direct && direct !== errorText) return direct;

  // Plan/subscription quota exhausted (no reset fields in the payload).
  // Must stay NARROWER than the Google pattern below so the two never overlap:
  // Google owns the countdown, this one only owns "wait for the reset".
  if (SUBSCRIPTION_QUOTA_RE.test(errorText)) {
    return translate(SUBSCRIPTION_TEMPLATE_KEY);
  }

  // Real-name (实名) gate: a configuration state with no countdown, so give the
  // action instead of a time. Kept as its own branch because the row has to say
  // WHERE to go — "wait for the reset" would be wrong here, nothing resets.
  if (REALNAME_GATE_RE.test(errorText)) {
    const url = extractRealnameVerificationUrl(errorText);
    let msg = translate(REALNAME_TEMPLATE_KEY);
    msg = msg.replace("{url}", url || translate("the provider's console"));
    return msg;
  }

  // Google-style per-account quota exhausted (HTTP 429 RESOURCE_EXHAUSTED).
  if (/Individual quota reached|QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED/i.test(errorText)) {
    const { delay, timestamp, model } = extractQuotaResetInfo(errorText);
    const durationStr = formatQuotaDuration(parseQuotaDurationParts(delay));
    const timeStr = timestamp ? formatResetTime(timestamp) : "";
    let msg = translate(model ? RESET_PER_MODEL_TEMPLATE_KEY : RESET_TEMPLATE_KEY);
    // Legacy rows were stored truncated to 100 chars, which cut the reset
    // fields off the JSON tail — substitute neutral values so the sentence
    // never renders with empty placeholders ("将于  重置（约  后）").
    msg = msg.replace("{model}", model || "");
    msg = msg.replace("{time}", timeStr || translate("shortly"));
    msg = msg.replace("{duration}", durationStr || translate("a short while"));
    return msg;
  }

  return direct;
}
