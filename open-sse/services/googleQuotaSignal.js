/**
 * Google 429 归因判别（issue #147）
 *
 * Google（Antigravity / Gemini Code Assist）的 429 实测分两类，处理方向相反：
 *
 *  1. 真配额 429 —— 带归因信号：Retry-After 头，或 body 里有 RetryInfo /
 *     QuotaFailure detail、配额类 ErrorInfo reason、配额重置时钟
 *     （quotaResetDelay / "quota will reset" / "exhausted your capacity" /
 *     RESOURCE_EXHAUSTED）。这类是账号本阶段额度用尽 → 正常冷却换号（现有逻辑）。
 *
 *  2. 无法归因的伪 429 —— 不带任何配额细节。这是上游 WAF 的身份识别类拒绝
 *     （60 天日志 + can1357/oh-my-pi#19269 实证）：盲目轮换会让一次请求在
 *     70ms 内打穿全池账号，每个账号都留下被拒记录 → Google 判 abuse →
 *     连带 TOS_VIOLATION 封池。这类必须就地停下：不换号、不重放、
 *     渠道级暂停（channelScope 通道）。
 *
 * 判据方向性说明（拍板 A 方案）：真配额 429 恒带归因信号——现有
 * extractQuotaResetMs 冷却链就是按这些形状在 NAS 生产日志上建起来的；
 * 裸 429 是 WAF 特征。误伤（真配额恰好裸奔）的代价是渠道暂停一个短窗口
 * （可恢复），漏判（WAF 爆发仍轮换）的代价是账号被 TOS 停用（近乎
 * 不可逆），两害相权取前者。
 */

/**
 * 文本兜底信号（非 JSON body / proto-JSON 变体）。刻意不含泛化措辞
 * （"rate limit" / "Too Many Requests"）——那是 HTTP 套话不是配额细节，
 * issue 口径的「真配额」必须有具体归因载荷。ErrorInfo 不在此列：它几乎
 * 恒出现，只有 reason 值才是信号，走下面的结构化判定。
 */
const QUOTA_SIGNAL_TEXT_RE =
  /quotaResetDelay|quotaResetTimeStamp|"retryDelay"|RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|quota will reset|exhausted your capacity/i;

/** 配额类 ErrorInfo.reason（Google RPC 规范值 + 实测变体）。 */
const QUOTA_REASON_RE = /RATE_LIMIT|QUOTA|CAPACITY/i;

/**
 * 该 429 是否「无法归因」（疑似 WAF 身份识别类，禁止轮换/重放）。
 * @param {number} status - HTTP 状态码
 * @param {string|null} retryAfterHeader - Retry-After 响应头值
 * @param {string} bodyText - 响应体原文
 * @returns {boolean}
 */
export function isUnattributedGoogle429(status, retryAfterHeader, bodyText) {
  if (status !== 429) return false;
  if (retryAfterHeader) return false;
  const s = typeof bodyText === "string" ? bodyText : "";
  if (!s) return true; // 空体 429：无任何可归因信息 → 伪

  try {
    const json = JSON.parse(s);
    const details = Array.isArray(json?.error?.details) ? json.error.details : [];
    for (const d of details) {
      const type = String(d?.["@type"] || "");
      // RetryInfo（含 retryDelay）/ QuotaFailure 是配额 429 的规范载荷
      if (/RetryInfo|QuotaFailure/.test(type)) return false;
      if (/ErrorInfo/.test(type) && QUOTA_REASON_RE.test(String(d?.reason || ""))) return false;
    }
    // metadata 里的配额重置时钟（Antigravity 5h/7d 桶形状）
    const meta = details.map((d) => d?.metadata).find(Boolean);
    if (meta && (meta.quotaResetTimeStamp || meta.quotaResetDelay)) return false;
  } catch {
    /* 非 JSON：走文本兜底 */
  }

  return !QUOTA_SIGNAL_TEXT_RE.test(s);
}
