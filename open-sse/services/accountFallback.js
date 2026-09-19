import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS, CHANNEL_BLOCK_MS, CHANNEL_BLOCK_ESCALATE_WINDOW_MS, MAX_RATE_LIMIT_COOLDOWN_MS } from "../config/errorConfig.js";

// 4xx statuses that DO describe the credential / the account's standing, so they
// keep their cooldown rules. Everything else in 400–499 describes the request
// itself (context overflow, malformed body, unsupported parameter) and must not
// evict a healthy connection — see the short-circuit in checkFallbackError.
// 404 is included: an unavailable model on this account is account-scoped here,
// matching the ERROR_RULES entry that already handled it before this list existed.
const ACCOUNT_SCOPED_4XX = new Set([401, 402, 403, 404, 429]);

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Parse an explicit "wait N seconds" hint out of an upstream error message.
 *
 * Some upstreams state the exact window in the body itself — xiaomi-mimo TPM:
 * `{"message":"用户 每人 触发 TPM 限流（上限 5000000），请约 23 秒后重试"}`.
 * Ignoring it and applying the generic exponential backoff (base 2s) makes us
 * re-hit the same limit: NAS log 2026-09-17 shows upstream asking for 23s
 * while the gateway retried at 2s/4s/8s/16s — four wasted 429s in a row.
 *
 * @param {string} text - upstream error text / message field
 * @returns {number|null} seconds, or null when no explicit hint is present
 */
export function extractRetrySeconds(text) {
  const s = typeof text === "string" ? text : "";
  if (!s) return null;
  // Chinese: "请约 23 秒后重试" / "23 秒后重试" / "23 秒钟后重试"
  let m = s.match(/(\d+)\s*秒(?:钟)?后(?:重试|再试|再尝试)?/);
  if (m) return parseInt(m[1], 10);
  // English: "retry after 23 seconds" / "retry in 23s" / "try again in 23 seconds"
  m = s.match(/(?:retry|try again|come back|wait)\s+(?:after|in)\s+(\d+)\s*(?:s|sec|secs|seconds?)\b/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

/**
 * Cooldown for a `backoff: true` rule — exponential, but never shorter than an
 * explicit wait the upstream just told us about.
 * @param {string} errorText - message to scan for an explicit hint
 * @param {number} backoffLevel - current backoff level
 * @returns {number} cooldown ms (capped by MAX_RATE_LIMIT_COOLDOWN_MS)
 */
function backoffCooldown(errorText, backoffLevel) {
  const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
  const backoffMs = getQuotaCooldown(newLevel);
  const hintSec = extractRetrySeconds(errorText);
  if (hintSec === null) return backoffMs;
  // max(): upstream hint wins when it is longer (it is authoritative), backoff
  // wins when it already escalated past it — either way we never retry too soon.
  return Math.min(Math.max(backoffMs, hintSec * 1000), MAX_RATE_LIMIT_COOLDOWN_MS);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number, channelScope?: boolean }}
 *   `channelScope: true` means the error describes the CHANNEL, not this account —
 *   the caller must NOT walk to sibling accounts (that burst is itself what the
 *   upstream policy reacts to); it should cool the whole provider down instead.
 */
export function checkFallbackError(status, errorText, backoffLevel = 0) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  for (const rule of ERROR_RULES) {
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: backoffCooldown(lowerError, backoffLevel), newBackoffLevel: newLevel, channelScope: !!rule.channelScope };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs, channelScope: !!rule.channelScope };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        // Respect an explicit "请约 N 秒后重试" in the body — plain exponential
        // backoff starting at 2s re-hits an upstream that asked for 23s.
        return { shouldFallback: true, cooldownMs: backoffCooldown(lowerError, backoffLevel), newBackoffLevel: newLevel, channelScope: !!rule.channelScope };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs, channelScope: !!rule.channelScope };
    }
  }

  // Request-scoped client errors that matched no rule above: a 400 caused by the
  // request itself (context overflow, malformed body, unsupported parameter) says
  // nothing about the credential, so cooling the account down only removes a
  // healthy connection from rotation. With a single connection it is worse: every
  // later request in the window fails with a copy of this very error
  // ("all 1 accounts locked for <model> | lastError=[400]: ..."), which hides the
  // real cause from the caller and makes unrelated sessions look like they hit the
  // same limit. Hand the upstream error back for this request instead.
  //
  // Account-scoped statuses keep their rules above (401/402/403/404/429); the text
  // rules above still win for rate-limit / quota / capacity wording, so this only
  // catches bodies that described the request and nothing else.
  if (status >= 400 && status < 500 && !ACCOUNT_SCOPED_4XX.has(status)) {
    return { shouldFallback: false, cooldownMs: 0, channelScope: false };
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS, channelScope: false };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Channel-scope block: a provider-wide pause kept in `settings.channelBlocks`
 * rather than on any single connection, because the failure is a property of
 * the channel (egress fingerprint / request shape), not of one account.
 *
 * Shape: { until: ISO string, lastAt: ISO string, strikes: number }
 */

/**
 * Decide the next channel-block state for a provider that just answered with a
 * channel-scope error. Repeat offences inside CHANNEL_BLOCK_ESCALATE_WINDOW_MS
 * escalate to the long duration; otherwise the short one applies.
 * @param {object|null} prev - previous stored state (or null)
 * @param {number} nowMs - current epoch ms (injectable for tests)
 * @returns {{ until: string, lastAt: string, strikes: number, durationMs: number, escalated: boolean }}
 */
export function buildChannelBlock(prev, nowMs = Date.now()) {
  const prevLast = prev?.lastAt ? new Date(prev.lastAt).getTime() : 0;
  const withinWindow = prevLast > 0 && nowMs - prevLast <= CHANNEL_BLOCK_ESCALATE_WINDOW_MS;
  const escalated = withinWindow;
  const durationMs = escalated ? CHANNEL_BLOCK_MS.long : CHANNEL_BLOCK_MS.short;
  return {
    until: new Date(nowMs + durationMs).toISOString(),
    lastAt: new Date(nowMs).toISOString(),
    strikes: (prev?.strikes || 0) + 1,
    durationMs,
    escalated,
  };
}

/**
 * Remaining ms of an active channel block (0 when none / expired).
 */
export function channelBlockRemainingMs(block, nowMs = Date.now()) {
  if (!block?.until) return 0;
  const until = new Date(block.until).getTime();
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, until - nowMs);
}

/**
 * Friendly hint appended to channel-block responses. Clients (e.g. ZCode) wrap
 * our400 into a bare "Bad Request", and the raw upstream JSON alone does not
 * tell the user what to DO — so both the first-hit response and the
 * window-blocked response carry this explanation. Bilingual because the
 * upstream displayMsg already ships zh translations and our users read both.
 */
export const CHANNEL_SCOPE_HINT =
  "提示：当前请求触发上游渠道级安全风控（非账号问题）。" +
  "出路：1. 开启新对话重试（推荐）；2. 输入 /compact 压缩会话后重试；3. 稍等窗口结束后自动恢复。" +
  "（注意：切到其它渠道前请确认该渠道也有同名模型，否则会报 11102 模型不存在。）";

/** Append CHANNEL_SCOPE_HINT to a channel-block error message. */
export function withChannelScopeHint(message) {
  return `${message}\n\n${CHANNEL_SCOPE_HINT}`;
}

// ─── friendly 429 (rate-limit) translation ──────────────────────────────────
// Upstreams answer 429 with a raw JSON blob (xiaomi-mimo:
// {"error":{"code":"429","message":"Too Many Requests","param":"Request rate
// limited"}}) and10Router passes it through verbatim, so Claude-protocol
// clients render a wall of escaped JSON instead of a sentence.
//
// NOTE: the cooldown itself is NOT new — ERROR_RULES already carries
// { status: 429, backoff: true } (exponential backoff; NAS logs show 32s →
// 64s and the per-model lock). This helper only translates the TEXT and leaves
// the timing to the retry info the callers already append.
// `_` matters: xiaomi-mimo's TPM shape ships `type:"rate_limit_error"` /
// `code:"rate_limited"` (underscores, never a bare space) and carries no
// `"429"` — only the `[429]:` prefix formatProviderError adds. See both shapes
// in tests/unit/rate-limit-hint.test.js.
const RATE_LIMIT_RE = /too many requests|rate[_\s-]*limit|频率限制|quota.*exceeded|"429"|\[\s*429\s*\]/i;

// Where a 429 means "free/trial tier throttling" instead of an account fault.
// Worth spelling out: users blame the account (or the gateway) when the
// request budget is simply exhausted for this minute. Two shapes are seen on
// xiaomi-mimo: "Too Many Requests / Request rate limited" (per-request) and
// "用户 每人 触发 TPM 限流（上限 5000000）" (tokens-per-minute).
const RATE_LIMIT_PROVIDER_NOTE = {
  "xiaomi-mimo": "小米 MiMo 为体验/免费通道，每分钟请求数与 Token 数（TPM）均有硬限制，超出即拒绝。",
};

/** True when the message describes an upstream rate limit (429). */
export function isRateLimitText(message) {
  return RATE_LIMIT_RE.test(String(message || ""));
}

/**
 * Append a friendly rate-limit explanation to a message that IS a rate limit.
 * Non-rate-limit messages pass through untouched, so callers can apply it
 * unconditionally. The wording stays shape-agnostic — the upstream body we
 * append to already carries its own specifics (per-request vs TPM, wait time).
 * @param {string} message - upstream/client-facing message
 * @param {string} [provider] - adds a channel-specific note when known
 */
export function withRateLimitHint(message, provider) {
  if (!isRateLimitText(message)) return message;
  const note = RATE_LIMIT_PROVIDER_NOTE[provider] ? ` ${RATE_LIMIT_PROVIDER_NOTE[provider]}` : "";
  return (
    `${message}\n\n` +
    `提示：上游触发了限流（HTTP 429），非账号异常，已按上游提示自动冷却并稍后自动恢复；` +
    `期间可切换其他模型或渠道，或稍候重试。${note}`
  );
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}
