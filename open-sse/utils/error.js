import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";
import { withRealnameHint } from "../services/accountFallback.js";

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    type: "error",
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, extraHeaders = null) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number}>}
 */

// Google surfaces (Gemini Code Assist / Antigravity cloudcode-pa) answer a flagged
// account with 403 VALIDATION_REQUIRED and bury the only actionable part — a one-click
// "Verify your account" URL — inside the error JSON (BaseExecutor.parseError passes the
// raw body through verbatim). Surface the URL instead of the JSON wall.
const VALIDATION_REASON_MARKER = "VALIDATION_REQUIRED";
const VALIDATION_URL_RE = /"validation_url"\s*:\s*"([^"]+)"/;

export function buildAccountValidationMessage(bodyText) {
  if (!bodyText || !bodyText.includes(VALIDATION_REASON_MARKER)) return null;
  const match = VALIDATION_URL_RE.exec(bodyText);
  if (!match) return null;
  let url = match[1];
  try {
    url = JSON.parse(`"${url}"`); // unescape \/ and friends from the JSON encoding
  } catch { /* keep the raw capture — still a usable URL */ }
  return (
    "Google requires account verification (VALIDATION_REQUIRED). "
    + "Most often this means the account's 18+ age verification is missing — "
    + "complete it at https://myaccount.google.com/age-verification (check the birthdate at "
    + "https://myaccount.google.com/birthday first). "
    + `Otherwise open this URL in a browser signed in to the affected account, complete "Verify your account", then retry: ${url}`
  );
}

export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  const validationMessage = buildAccountValidationMessage(bodyText);

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const msg = validationMessage
          || parsed.message
          || DEFAULT_ERROR_MESSAGES[response.status]
          || `Upstream error: ${response.status}`;
        return { statusCode: parsed.status || response.status, message: msg, resetsAtMs: parsed.resetsAtMs };
      }
    } catch { /* fall through to default parsing */ }
  }

  if (validationMessage) {
    return { statusCode: response.status, message: validationMessage };
  }

  let message = "";
  try {
    const json = JSON.parse(bodyText);
    message = json.error?.message || json.message || json.error || bodyText;
  } catch {
    message = bodyText;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  return { statusCode: response.status, message: finalMessage };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, extraHeaders = null) {
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    response: errorResponse(statusCode, message, extraHeaders)
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman, extraHeaders = null) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: statusCode >= 500 ? "api_error" : "invalid_request_error",
        message: msg,
      },
    }),
    {
      status: statusCode,
      headers: {
        ...extraHeaders,
        "Content-Type": "application/json",
        // Intentionally mis-cased to prevent duplicate headers: the gateway's
        // own cooldown must win over any forwarded upstream retry-after.
        "retry-after": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  const base = `[${code}]: ${message}${causeStr}`;
  // An upstream real-name (实名) gate is a CONFIGURATION state, not a quota or a
  // fault: the raw English JSON names no action the user can take, and 403's
  // OpenAI-compatible type ("insufficient_quota") actively misleads them into
  // topping up. Appending the go-and-do-this explanation here covers every core
  // (chat / embeddings / image / video / systemone) at once — they all build
  // their client-facing string through this function. Non-matching messages
  // pass through byte-for-byte.
  return withRealnameHint(base, provider);
}
