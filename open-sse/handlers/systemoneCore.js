import crypto from "node:crypto";
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { PROVIDER_MEDIA } from "../providers/index.js";

// ses_<12 hex><14 base62> — the session shape OpenCode's zen lanes accept on
// x-opencode-session (hex prefix derives from time, tail is random base62).
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function generateSessionId() {
  const time = Date.now().toString(16).padStart(12, "0").slice(-12);
  const rand = [...crypto.randomBytes(14)].map((b) => BASE62[b % 62]).join("");
  return `ses_${time}${rand}`;
}

/**
 * Core System One (Jev) handler — native decision payload pass-through.
 * URL/headers come from the registry's systemoneConfig; body and JSON response
 * are forwarded untouched (decision models have no chat translation layer).
 *
 * @returns {Promise<{ success: boolean, response: Response, usage?: object, status?: number, error?: string }>}
 */
export async function handleSystemoneCore({
  body,
  modelInfo,
  credentials,
  log,
  onRequestSuccess,
}) {
  const { provider, model } = modelInfo;
  const cfg = PROVIDER_MEDIA[provider]?.systemoneConfig;
  // 连接级端点覆盖（providerSpecificData.baseUrl）优先于 registry 默认——
  // System One lane 协议统一，自建/网关部署只换地址（上游 v0.5.95, 0a879c5c）。
  const targetUrl = credentials?.providerSpecificData?.baseUrl || cfg?.baseUrl;
  if (!targetUrl) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support System One.`,
    );
  }

  // Validate input at the trust boundary; question-level shape is upstream's job.
  // 输入字段按供应商方言：Drex/Jev 系用 state，Gemini Decision 用 input
  // （string 或 Content[]，issue #110）。两字段其一即可。
  // inputField 判定：registry 未声明时按 authHeader 推导（x-goog-api-key →
  // input）—— gemini-decision registry 曾漏配 inputField 导致 core 按 state
  // 校验、把 body.input 拒成 Missing state（#110 实测，2026-11-13）。
  const inputField = cfg.inputField
    || (cfg.authHeader === "x-goog-api-key" ? "input" : "state");
  const inputValue = body[inputField] ?? body[inputField === "state" ? "input" : "state"];
  if (inputValue === undefined || inputValue === null) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Missing required field: ${inputField}`);
  }
  if (!body.questions || typeof body.questions !== "object" || Array.isArray(body.questions)) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: questions");
  }

  // noAuth free lanes carry accessToken "public" from the credential stub.
  const token = credentials?.apiKey || credentials?.accessToken;
  const sysSession = generateSessionId();
  // 鉴权头按 systemoneConfig.authHeader 方言：bearer（默认，Drex/Jev/Zen）、
  // x-goog-api-key（Gemini Decision，issue #110 — Google 拒绝该端点上的 Bearer）。
  const authHeaders = cfg.authHeader === "x-goog-api-key"
    ? (token ? { "x-goog-api-key": token } : {})
    : (token ? { Authorization: `Bearer ${token}` } : {});
  const headers = {
    "Content-Type": "application/json",
    ...authHeaders,
    ...(cfg.headers || {}),
    // Zen lanes expect the official client session header on every request.
    "x-opencode-session": sysSession,
    "x-opencode-session-id": sysSession,
  };
  // Gemini Decision 的 model 字段在 body 里而非 path；透传时保留调用方的
  // input 字段名原样（上游按方言校验，改名会 400）。
  const requestBody = { ...body, model };

  log?.debug?.("SYSTEMONE", `${provider.toUpperCase()} | ${model}`);

  let providerResponse;
  try {
    providerResponse = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      ...(typeof AbortSignal?.timeout === "function"
        ? { signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS) }
        : {}),
    });
  } catch (error) {
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("SYSTEMONE", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse);
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("SYSTEMONE", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg);
  }

  let responseBody;
  try {
    responseBody = await providerResponse.json();
  } catch {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
  }

  if (onRequestSuccess) await onRequestSuccess();

  // usage 形态按方言归一：Jev 系 input_tokens/output_tokens；Gemini Decision
  // total_input_tokens/total_output_tokens（含 input_tokens_by_modality 分模态
  // 计数 — 视频/PDF 计 image tokens，计费对账要用，issue #110）。
  const usage = responseBody?.usage;
  const promptTokens = usage
    ? (usage.input_tokens ?? usage.total_input_tokens ?? 0)
    : 0;
  const completionTokens = usage
    ? (usage.output_tokens ?? usage.total_output_tokens ?? 0)
    : 0;
  return {
    success: true,
    usage: usage
      ? { prompt_tokens: promptTokens, completion_tokens: completionTokens }
      : null,
    response: new Response(JSON.stringify(responseBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
