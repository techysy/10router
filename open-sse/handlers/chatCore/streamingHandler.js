import { randomUUID } from "node:crypto";
import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS, HTTP_STATUS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildStreamErrorBytes } from "../../utils/streamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, pxpipe, reqTag, log, finalizedRef = { current: false } }) {
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" and crashes the chat router. Read the body,
  // pull a short human-readable message from the <title>, sanitize it, and
  // return a clean JSON error instead. The message is stripped of HTML tags
  // and clamped so untrusted upstream text never reaches the client verbatim
  // (the UI may render error.message as HTML).
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    const bodyText = await providerResponse.text().catch(() => '');
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const shortMsg = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, '').trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    const status = providerResponse.status || 502;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return {
      success: false,
      response: new Response(JSON.stringify({ error: { message: `[${status}]: ${shortMsg}` } }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey });

  // Terminal bytes when the stream aborts after HTTP 200 was already sent, so the
  // client sees a real error instead of a silently truncated stream. Responses
  // passthrough keeps its own response.failed shape; every other client format
  // gets the OpenAI error frame + [DONE], or `event: error` for Claude.
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  // Friendly abort copy (用户实测：客户端在 ~140s 自行放弃并报
  // "empty or malformed response (HTTP 200)"——看门狗必须先行，且文案要给出路).
  const friendlyAbort = (message) =>
    message === "stream stall timeout"
      ? "上游连接在响应中途失联（120 秒无任何数据）——通常是上游过载、网络抖动或渠道临时故障；本轮已自动终止以免客户端长时间挂起。请直接重试，或切换其他渠道/模型。"
      : "上游连接中断——通常是上游过载或网络抖动；本轮已自动终止。请直接重试，或切换其他渠道/模型。";
  // Placeholder row, upserted later by onStreamComplete. It is deliberately NOT
  // marked "success": at this point the stream has produced nothing yet, and if
  // the upstream dies mid-flight nothing comes back to correct it — an aborted
  // request used to sit in the Details tab as a green 0-in / 0-out row forever,
  // reading as a completed call that happened to be free (issue #48).
  //
  // Written BEFORE the pipe is built so every early-exit path below can update
  // the same row by id. Idempotent: on an upstream error the wrapped controller
  // hook AND the terminal builder both reach for it.
  let abortRecorded = false;
  const recordAbort = (message) => {
    if (finalizedRef.current) return message;
    if (abortRecorded) return message;
    abortRecorded = true;
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: "[Streaming aborted before completion]",
      response: { content: "[Streaming aborted]", error: message || "upstream connection lost", thinking: null, type: "streaming" },
      pxpipe,
      status: "error"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to record aborted stream:", err.message);
    });
    return message;
  };
  const abortTerminal = isResponsesPassthrough
    ? (message) => { finalizedRef.current = true; return buildAbortedResponsesTerminalBytes(recordAbort(message)); }
    : (message) => { finalizedRef.current = true; return buildStreamErrorBytes(HTTP_STATUS.GATEWAY_TIMEOUT, friendlyAbort(recordAbort(message)), sourceFormat); };

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    status: "streaming"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  // The terminal builder above only fires from pull(), so it covers upstream
  // errors and stall timeouts — but NOT a client cancelling mid-flight: the
  // stream's cancel() hook calls handleDisconnect and no further pull() runs,
  // which used to leave the placeholder row "streaming" forever. Wrapping the
  // controller's two termination hooks makes every early-exit path finalize the
  // row; the once-guard in recordAbort dedupes against the terminal builder on
  // paths where both fire (upstream error → handleError AND emitTerminal).
  // The row is finalized by whichever fires first — the terminal bytes below or
  // onStreamComplete. A client that disconnects mid-flight reaches neither, so
  // without this the placeholder above would sit "streaming" forever; the latch
  // lets the wrapped controller reports claim the row, and (once onStreamComplete
  // has written the real result) stops a later disconnect from overwriting a
  // completed answer with an "aborted" error row — issue #48.
  const abortAwareController = {
    ...streamController,
    handleError: (e) => {
      recordAbort(e?.message || "upstream error");
      streamController.handleError(e);
    },
    handleDisconnect: (r) => {
      if (!finalizedRef.current) recordAbort(typeof r === "string" ? r : "cancelled");
      streamController.handleDisconnect(r);
    },
  };
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, abortAwareController, abortTerminal, stallTimeoutMs);
  return {
    success: true,
    response: new Response(transformedBody, { headers: { ...SSE_HEADERS, ...upstreamResponseHeaders(providerResponse.headers) } })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log, finalizedRef = { current: false } }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    // A terminal abort already wrote this row; the success write would overwrite
    // the real failure reason with a partial "success".
    if (finalizedRef.current) return;
    finalizedRef.current = true;

    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      pxpipe,
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    // Persist stream usage to DB (no console line; the "📊 done" line below is authoritative)
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, latency, usageKey: randomUUID(), label: "STREAM USAGE", silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency }));
  };

  return { onStreamComplete, streamDetailId };
}
