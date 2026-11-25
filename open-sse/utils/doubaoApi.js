/**
 * Doubao (Volcengine 联网搜索) API helpers shared by the web-search and
 * web-fetch handlers.
 *
 * Doubao's error model is unusual: failures ride inside the JSON body under
 * `ResponseMetadata.Error` (with `Code` / `CodeN` / `Message`) while the HTTP
 * status is not reliably 4xx/5xx — a caller that only checks `resp.ok` would
 * read a failed response as "0 results" and return it as a successful empty
 * answer. Both handlers must consult `assertDoubaoOk` before touching `Result`.
 *
 * Error codes → gateway HTTP status, chosen so the existing account rotation
 * reacts correctly (markAccountUnavailable: 429 → backoff + next account,
 * 403 → long cooldown + next account, 401 → invalid credential):
 *   700429  QPS throttled              → 429
 *   10406 / 10412  free quota drained  → 403 (search and fetch share the
 *                                        500/month allowance, so draining one
 *                                        drains both → rotate to next account)
 *   700901  invalid API key            → 401
 *   10413   robots/compliance refusal  → 403 (non-retriable for this URL)
 *   10500 / 10501 / 10502  upstream    → 502 (transient, retriable)
 *   anything else                      → 502
 */

const ERROR_STATUS_BY_CODE = {
  700429: 429,
  10406: 403,
  10412: 403,
  700901: 401,
  10413: 403,
  10500: 502,
  10501: 502,
  10502: 502,
};

/** `{ code, codeN, message, status }` when the body carries ResponseMetadata.Error, else null. */
export function doubaoApiError(data) {
  const err = data?.ResponseMetadata?.Error;
  if (!err || typeof err !== "object") return null;
  const code = String(err.Code ?? "");
  const codeN = Number(err.CodeN);
  return {
    code,
    codeN: Number.isFinite(codeN) ? codeN : null,
    message: String(err.Message ?? ""),
    status: ERROR_STATUS_BY_CODE[codeN] ?? (ERROR_STATUS_BY_CODE[code] ?? 502),
  };
}

/** Throw an Error carrying the mapped HTTP status when the body reports an API error. */
export function assertDoubaoOk(data) {
  const err = doubaoApiError(data);
  if (!err) return;
  throw Object.assign(
    new Error(`Doubao API error ${err.code || err.codeN || "unknown"}: ${err.message || "no message"}`),
    { status: err.status, doubaoCode: err.code || err.codeN },
  );
}
