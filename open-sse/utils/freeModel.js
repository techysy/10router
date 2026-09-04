/**
 * Free-tier model detection + friendly rate-limit copy.
 *
 * Used to give "limited-time free" models (OpenCode contributor-free,
 * oc/*-free, tokenrouter/z-ai/*-free, APInex free/*, etc.) a friendlier
 * 429 / rate-limit response instead of surfacing the upstream English message.
 * Paid models and multi-account providers keep their normal fallback path.
 */

/**
 * True when a model id looks like a free/limited-time-free tier. Such ids carry
 * a "free" marker in the model slug (`contributor-free`, `-free`, `free/`).
 * Conservative: only matches clearly-free tokens, never a bare "free" inside a
 * normal word.
 */
export function isFreeModel(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  return /(?:^|\/|-|_)(free|freemium)(?:$|\/|-|_|\.)/i.test(modelId) ||
    /(?:^|\/)(free)\//i.test(modelId);
}

/**
 * Build a friendly, human-readable message for a free-model rate limit.
 * @param {string} providerId
 * @param {string} modelId
 * @param {number|null} [retryAfterMs] - when known, ms until the limit is
 *   expected to reset. Optional.
 */
export function formatFreeRateLimitMessage(providerId, modelId, retryAfterMs = null) {
  const model = `${providerId}/${modelId}`;
  let waitHint = "";
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    const sec = Math.ceil(retryAfterMs / 1000);
    if (sec >= 3600) {
      waitHint = `约 ${(sec / 3600).toFixed(1)} 小时后可再试`;
    } else if (sec >= 60) {
      waitHint = `约 ${Math.ceil(sec / 60)} 分钟后可再试`;
    } else {
      waitHint = `约 ${sec} 秒后可再试`;
    }
  } else {
    waitHint = "建议稍后再试（免费额度通常按小时/天窗口重置）";
  }
  return `免费模型 ${model} 触发限流（rate limit），${waitHint}，或切换其它可用模型 / 改用付费档。`;
}
