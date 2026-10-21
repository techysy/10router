/**
 * Shared CodeArts transport helpers: credential resolution, signed fetch and
 * upstream error-envelope classification. Used by the chat executor, the usage
 * handler and the welfare check-in adapter so all three sign identically.
 */
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  CODEARTS_BENEFIT_ABSENT_CODE,
  CODEARTS_CLIENT_HEADERS,
  CODEARTS_MODEL_NOT_REGISTERED_CODE,
  CODEARTS_PARAM_INVALID_CODE,
  CODEARTS_QUOTA_CODE,
  CODEARTS_SESSION_LIMIT_CODE,
} from "../../config/codearts.js";
import { signCodeArtsRequest, sdkDateNow } from "./signing.js";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * Resolve AK/SK/STS/domain from a 10router connection.
 *
 * Accepted shapes (first hit wins):
 *   · `credentials.accessKeyId` + `secretAccessKey` (+ `securityToken`, `domainId`)
 *   · `credentials.providerSpecificData.{accessKeyId,secretAccessKey,…}`
 *   · `apiKey` holding a JSON object with those keys (manual import path)
 *
 * The OAuth login (PKCE + DPoP + STS) is supposed to write exactly these four
 * fields; until that flow lands, manual AK/SK import is the supported path.
 */
export function resolveCodeArtsCredential(credentials) {
  const psd = asObject(credentials?.providerSpecificData) || {};
  const nested = asObject(psd.codearts) || {};
  let fromKey = null;
  const apiKey = typeof credentials?.apiKey === "string" ? credentials.apiKey.trim() : "";
  if (apiKey.startsWith("{")) {
    try {
      fromKey = asObject(JSON.parse(apiKey));
    } catch {
      fromKey = null;
    }
  }
  const pick = (name) =>
    credentials?.[name] ?? nested[name] ?? psd[name] ?? fromKey?.[name] ?? "";
  const credential = {
    accessKeyId: String(pick("accessKeyId") || pick("access_key_id") || "").trim(),
    secretAccessKey: String(pick("secretAccessKey") || pick("secret_access_key") || "").trim(),
    securityToken: String(pick("securityToken") || pick("security_token") || "").trim(),
    domainId: String(pick("domainId") || pick("domain_id") || "").trim(),
  };
  if (!credential.accessKeyId || !credential.secretAccessKey) return null;
  return credential;
}

/** Stable, non-secret identity used as the per-account gate key. */
export function codeArtsIdentity(credential) {
  // AK rotates on every STS renewal (Rust deliberately keys on the account id,
  // not the AK). `domainId` is the stable half; fall back to AK when absent.
  return credential?.domainId || credential?.accessKeyId || "anonymous";
}

/**
 * Sign and send one request. The body is serialised once and that exact string
 * is both signed and sent — re-serialising after signing is a classic 401.
 */
export async function codeArtsFetch(url, {
  method = "GET",
  body = "",
  headers = {},
  credential,
  includeHost = false,
  proxyOptions = null,
  timeoutMs = 60_000,
  signal = null,
} = {}) {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body ?? "");
  const merged = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Sdk-Date": sdkDateNow(),
    ...CODEARTS_CLIENT_HEADERS,
    ...headers,
  };
  const signed = signCodeArtsRequest({
    method,
    url,
    headers: merged,
    body: bodyText,
    credential,
    includeHost,
  });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const mergedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return proxyAwareFetch(url, {
    method,
    headers: signed.headers,
    body: method === "GET" || method === "DELETE" ? undefined : bodyText,
    signal: mergedSignal,
  }, proxyOptions);
}

/** Does this frame carry actual assistant output? Error frames have none. */
export function frameHasAnswer(frame) {
  if (!frame || typeof frame !== "object") return false;
  const delta = frame.delta && typeof frame.delta === "object" ? frame.delta : null;
  if (delta && (typeof delta.content === "string" && delta.content.length > 0 || Array.isArray(delta.content) && delta.content.length > 0)) {
    return true;
  }
  if (Array.isArray(frame.choices)) {
    for (const choice of frame.choices) {
      const part = choice?.delta || choice?.message || {};
      if (typeof part.content === "string" && part.content.length > 0) return true;
      if (Array.isArray(part.content) && part.content.length > 0) return true;
      if (Array.isArray(part.tool_calls) && part.tool_calls.length > 0) return true;
    }
  }
  const text = typeof frame.text === "string" ? frame.text.trim() : "";
  return Boolean(text && text !== "[DONE]");
}

/**
 * Classify an HTTP-200 error envelope.
 *
 * Huawei answers business failures with `{error_code, error_msg, details}` on an
 * HTTP 200 SSE stream. Without this gate the client sees a 200 with zero
 * content — the "200 fake success" shape. The returned status is what the
 * orchestrator uses to decide "switch account" (quota/limit) vs "fail fast".
 *
 * @returns {{code:string, message:string, status:number}|null}
 */
export function classifyCodeArtsEnvelope(frame) {
  if (!frame || typeof frame !== "object") return null;
  const code = typeof frame.error_code === "string" ? frame.error_code : "";
  if (!code) return null;
  if (frameHasAnswer(frame)) return null; // partial content wins; let the stream run
  const detail = [
    typeof frame.error_msg === "string" ? frame.error_msg.trim() : "",
    ...(Array.isArray(frame.details)
      ? frame.details.map((item) => String(item?.error_msg || item?.error_code || "").trim())
      : []),
  ].filter(Boolean);
  let message = `上游报告 ${code}`;
  if (detail[0]) message += `：${detail[0]}`;
  const lowered = message.toLowerCase();

  let status = 502;
  if (code === CODEARTS_SESSION_LIMIT_CODE || code.includes("00001041")) status = 400;
  else if (code.includes(CODEARTS_BENEFIT_ABSENT_CODE) || lowered.includes("benefit not found")) status = 502;
  else if (code.includes(CODEARTS_MODEL_NOT_REGISTERED_CODE) || lowered.includes("model is not registered")) status = 404;
  else if (lowered.includes("insufficient quota") || code.includes(CODEARTS_QUOTA_CODE)) status = 403;
  else if (code.includes("429") || lowered.includes("rate limit") || lowered.includes("too many")) status = 429;
  else if (code.includes(CODEARTS_PARAM_INVALID_CODE)) status = 502;

  return { code, message, status };
}

/**
 * Size-wall detector. `InferHub.001001005.400` is ALSO the generic "request
 * param invalid" code, so it only counts as a size verdict when the body we
 * actually sent already crossed the measured inference wall. `APIG.0201` is an
 * overload code reused across 400/413/414/494/502/504/500 — only the
 * "entity too large" wording makes it a size verdict.
 */
export function codeArtsSizeRejection(status, text, wireBytes) {
  const raw = String(text || "");
  const lowered = raw.toLowerCase();
  if (lowered.includes("apig.0201") && lowered.includes("entity too large")) return true;
  if (lowered.includes("parsedata") || lowered.includes("parse_request_data_exception")) return true;
  if (
    lowered.includes("inferhub.001001005.400") &&
    wireBytes >= 6 * 1024 * 1024 &&
    (status === 400 || status === 413 || status === 502)
  ) {
    return true;
  }
  return false;
}

/** True when the code is the "benefit profile missing" state (self-healing). */
export function isBenefitAbsent(text) {
  const lowered = String(text || "").toLowerCase();
  return lowered.includes("benefit not found") || lowered.includes("inferhub.4004.200");
}
