import { randomUUID } from "node:crypto";
import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { createErrorResult } from "../../utils/error.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { FORMATS } from "../../translator/formats.js";
import { openAICompletionToClaudeMessage } from "../../translator/concerns/claudeMessage.js";
import { PROVIDERS } from "../../config/providers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { usageOrEstimate } from "../../utils/usageTracking.js";
import { ROLE, RESPONSES_ITEM } from "../../translator/schema/index.js";
import { restoreToolNames } from "../../utils/opencodeFingerprint.js";
import { restoreBody } from "../../privacy/streamRestorer.js";
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.js";

// Responses-API providers (e.g. codex) may emit SSE without content-type + use Responses output shape
const isResponsesProvider = (p) => PROVIDERS[p]?.format === FORMATS.OPENAI_RESPONSES;
import { saveRequestDetail, appendRequestLog } from "@/lib/usageDb.js";

function textFromResponsesMessageItem(item) {
  if (!item?.content || !Array.isArray(item.content)) return "";
  const byType = item.content.find((c) => c.type === "output_text");
  if (typeof byType?.text === "string") return byType.text;
  const anyText = item.content.find((c) => typeof c.text === "string");
  if (typeof anyText?.text === "string") return anyText.text;
  return "";
}

/**
 * Codex / Responses API may emit many alternating reasoning + message items.
 * Early message blocks often have empty output_text; the user-visible answer is usually in the last non-empty message.
 */
function pickAssistantMessageForChatCompletion(output) {
  if (!Array.isArray(output)) return { msgItem: null, textContent: null };
  const messages = output.filter((item) => item?.type === "message");
  if (messages.length === 0) return { msgItem: null, textContent: null };
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textFromResponsesMessageItem(messages[i]);
    if (text.length > 0) return { msgItem: messages[i], textContent: text };
  }
  const last = messages[messages.length - 1];
  return { msgItem: last, textContent: textFromResponsesMessageItem(last) };
}

/**
 * Convert an OpenAI Chat Completions JSON body into the Responses API shape.
 * Inlined here (not imported from nonStreamingHandler.js) to avoid a circular
 * import. Mirrors openAICompletionToResponses in nonStreamingHandler.js.
 */
function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

function shouldPreserveReasoningContent(model, parsed, sourceFormat, targetFormat) {
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) return true;
  if ([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY, FORMATS.VERTEX].includes(targetFormat)) return true;

  const modelName = [model, parsed?.model]
    .filter((value) => typeof value === "string")
    .join(" ");
  if (/gemini/i.test(modelName)) return true;
  return false;
}

function chatCompletionToResponses(responseBody, customToolNames = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  for (const tc of message.tool_calls || []) {
    const fn = tc.function || {};
    const custom = customToolNames?.has(fn.name);
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
      call_id: tc.id || "",
      name: fn.name || "",
      ...(custom
        ? { input: extractCustomToolInput(fn.arguments) }
        : { arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}) }),
    });
  }

  const usage = responseBody.usage || {};
  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status: "completed",
    background: false,
    error: null,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
  };
}

/**
 * Parse OpenAI-style SSE text into a single chat completion JSON.
 * Used when provider forces streaming but client wants non-streaming.
 */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel) {
  const chunks = [];
  let streamError = null;

  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk?.error) streamError = chunk.error;
      else chunks.push(chunk);
    } catch { /* ignore malformed lines */ }
  }

  if (streamError) return { error: streamError };
  if (chunks.length === 0) return null;

  const first = chunks[0];
  const contentParts = [];
  const reasoningParts = [];
  const toolCallMap = new Map(); // index -> { id, type, function: { name, arguments } }
  let finishReason = "stop";
  let usage = null;

  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content.length > 0) contentParts.push(delta.content);
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) reasoningParts.push(delta.reasoning_content);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage;

    // Accumulate tool_calls from streaming deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
        }
        const existing = toolCallMap.get(idx);
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      }
    }
  }

  const message = { role: "assistant", content: contentParts.join("") || (toolCallMap.size > 0 ? null : "") };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  }

  const result = {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }]
  };
  if (usage) result.usage = usage;
  return result;
}

/**
 * Handle case: provider forced streaming but client wants JSON.
 * Supports both Codex/Responses API SSE and standard Chat Completions SSE.
 */
export async function handleForcedSSEToJson({ providerResponse, sourceFormat, targetFormat, provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, customToolNames, toolNameMap, translateToClientFormat, trackDone, appendLog, reqTag, log, privacyCtx }) {
  const contentType = providerResponse.headers.get("content-type") || "";
  const isSSE = contentType.includes("text/event-stream") || (contentType === "" && isResponsesProvider(provider));
  if (!isSSE) return null; // not handled here

  trackDone();

  // Privacy restore (issue #90): reverse placeholders before the aggregated
  // JSON reaches the client. Unknown placeholders pass through inertly.
  const restorePrivacy = (obj) => (privacyCtx?.map?.size ? restoreBody(obj, privacyCtx.map) : obj);

  const ctx = {
    provider, model, connectionId,
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null
  };

  // Codex/Responses API SSE path
  // Branch on the UPSTREAM format (targetFormat = format we spoke to the provider in),
  // not the client format: a Responses-API client behind a chat-native forced-streaming
  // provider still receives chat SSE chunks, which must go through the standard path.
  const isCodexResponsesApi = isResponsesProvider(provider) || targetFormat === FORMATS.OPENAI_RESPONSES;
  if (isCodexResponsesApi) {
    try {
      const jsonResponse = await convertResponsesStreamToJson(providerResponse.body);
      if (onRequestSuccess) await onRequestSuccess();

      // `jsonResponse` is handed to the client verbatim just below, so the
      // estimated value stays in a separate variable — never written back.
      // `upstreamUsage` is the only figure allowed onto the wire below.
      const upstreamUsage = jsonResponse.usage || {};
      const usage = usageOrEstimate(upstreamUsage, body, jsonResponse);
      appendLog({ tokens: usage, status: "200 OK" });
      const totalLatency = Date.now() - requestStartTime;
      saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, latency: { ttft: totalLatency, total: totalLatency }, usageKey: randomUUID(), silent: true });
      if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: totalLatency } }));

      // Same cache-inclusive total for the recorded detail, so the DB and the
      // client-facing usage can never disagree. Read BOTH usage spellings:
      // a real Responses payload uses input_tokens/output_tokens, but when the
      // upstream reported nothing, usageOrEstimate substituted an OpenAI-shaped
      // estimate (prompt_tokens/completion_tokens) — reading only the Responses
      // fields here recorded 0/0 into the Details row while the Overview got
      // the estimate, re-creating issue #48 on this path.
      const inTokensForLog = (usage.prompt_tokens ?? usage.input_tokens ?? 0)
        + (usage.cache_read_input_tokens || usage.cached_tokens || 0)
        + (usage.cache_creation_input_tokens || 0);
      const outTokensForLog = usage.completion_tokens ?? usage.output_tokens ?? 0;
      const { msgItem, textContent } = pickAssistantMessageForChatCompletion(jsonResponse.output);

      saveRequestDetail(buildRequestDetail({
        ...ctx,
        latency: { ttft: totalLatency, total: totalLatency },
        tokens: { prompt_tokens: inTokensForLog, completion_tokens: outTokensForLog },
        response: { content: textContent, thinking: null, finish_reason: jsonResponse.status || "unknown" },
        status: "success"
      }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});

      // Client is Responses API → return as-is
      if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
        return { success: true, response: new Response(JSON.stringify(restoreToolNames(restorePrivacy(jsonResponse), toolNameMap)), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
      }

      // Build client-format response.
      // input_tokens EXCLUDES cached tokens on cache-capable upstreams, so summing
      // only input+output under-reports prompt_tokens — measured: 2012 reported
      // where the real prompt was ~5344 with 5332 served from cache. Fold the cache
      // counters in, and keep them visible in prompt_tokens_details so a client can
      // tell a cache hit from a small prompt.
      //
      // The reported usage must stay exactly what the provider said: the fold
      // above is a fidelity correction, and mixing the ESTIMATED `usage` in here
      // would present a guess to the client as a real spend. `usage` is DB-only.
      const cacheRead = upstreamUsage.cache_read_input_tokens || upstreamUsage.cached_tokens || 0;
      const cacheCreate = upstreamUsage.cache_creation_input_tokens || 0;
      const inTokens = (upstreamUsage.input_tokens || 0) + cacheRead + cacheCreate;
      const outTokens = upstreamUsage.output_tokens || 0;
      const cacheDetails = (cacheRead > 0 || cacheCreate > 0)
        ? { prompt_tokens_details: {
              ...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
              ...(cacheCreate > 0 ? { cache_creation_tokens: cacheCreate } : {}) } }
        : {};
      let finalResp;

      // Extract tool calls from Responses API output (function_call items)
      const funcCallItems = (jsonResponse.output || []).filter(item => item.type === "function_call");
      const toolCalls = funcCallItems.map((item, idx) => ({
        id: item.call_id || `call_${item.name}_${Date.now()}_${idx}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        }
      }));
      const hasToolCalls = toolCalls.length > 0;

      if (sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) {
        finalResp = {
          response: {
            candidates: [{ content: { role: "model", parts: [{ text: textContent || "" }] }, finishReason: "STOP", index: 0 }],
            usageMetadata: { promptTokenCount: inTokens, candidatesTokenCount: outTokens, totalTokenCount: inTokens + outTokens },
            modelVersion: model,
            responseId: jsonResponse.id || `resp_${Date.now()}`
          }
        };
      } else {
        const message = { role: "assistant", content: textContent || (hasToolCalls ? null : "") };
        if (hasToolCalls) message.tool_calls = toolCalls;
        const responseDone = jsonResponse.status === "completed" || jsonResponse.status === "done";
        const finishReason = hasToolCalls ? "tool_calls" : (responseDone ? "stop" : (jsonResponse.status || "stop"));
        finalResp = {
          id: jsonResponse.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
          model: jsonResponse.model || model,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: { prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: inTokens + outTokens, ...cacheDetails }
        };
      }

      if (sourceFormat === FORMATS.CLAUDE) {
        finalResp = openAICompletionToClaudeMessage(finalResp);
      }

      return { success: true, response: new Response(JSON.stringify(restoreToolNames(restorePrivacy(finalResp), toolNameMap)), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
    } catch (err) {
      console.error("[ChatCore] Responses API SSE→JSON failed:", err);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON");
    }
  }

  // Standard Chat Completions SSE path
  try {
    const sseText = await providerResponse.text();
    const parsed = parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
    if (parsed.error) {
      return createErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        parsed.error.message || "Upstream SSE stream failed"
      );
    }

    if (onRequestSuccess) await onRequestSuccess();

    // Two values on purpose. `upstreamUsage` is what the provider actually
    // reported and is the only thing allowed onto the wire below — an estimate
    // must never be presented to a client as a real spend. `usage` is what we
    // record, falling back to an estimate so the DB rows are not left at 0 / 0.
    const upstreamUsage = parsed.usage || {};
    const usage = usageOrEstimate(upstreamUsage, body, parsed);
    appendLog({ tokens: usage, status: "200 OK" });
    const totalLatency = Date.now() - requestStartTime;
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, latency: { ttft: totalLatency, total: totalLatency }, usageKey: randomUUID(), silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: totalLatency } }));

    saveRequestDetail(buildRequestDetail({
      ...ctx,
      latency: { ttft: totalLatency, total: totalLatency },
      tokens: usage,
      response: {
        content: parsed.choices?.[0]?.message?.content || null,
        thinking: parsed.choices?.[0]?.message?.reasoning_content || null,
        finish_reason: parsed.choices?.[0]?.finish_reason || "unknown"
      },
      status: "success"
    }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});

    // Re-attach usage explicitly. `upstreamUsage` is what the provider actually
    // reported — and for a cached Claude request the same figure the DB row
    // carries reads cache_read_input_tokens: 11022 — yet the client was observed
    // receiving no usage field at all (verified 2026-08-04 with a fingerprinted
    // payload matched on both sides). Whatever drops it between assembly and
    // serialisation, the client must not be left unable to account for its own
    // token spend: a caller cannot tell a 90%-cached request from a cheap one
    // without this. An estimate is deliberately NOT attached here.
    if (upstreamUsage && Object.keys(upstreamUsage).length > 0) parsed.usage = upstreamUsage;

    // Keep Gemini thought summaries on the forced-SSE-to-JSON path, matching
    // the normal non-streaming path. A Claude client is left alone for the same
    // reason: the shared translation below turns reasoning_content into a
    // thinking block, exactly as the normal non-streaming path does.
    if (sourceFormat !== FORMATS.CLAUDE && !shouldPreserveReasoningContent(model, parsed, sourceFormat, targetFormat) && parsed?.choices) {
      for (const choice of parsed.choices) {
        if (choice?.message?.reasoning_content && choice.message.content) {
          delete choice.message.reasoning_content;
        }
      }
    }

    // A Responses-format client (e.g. Codex) forced this provider to stream,
    // but wants JSON back. parseSSEToOpenAIResponse yields a Chat Completions
    // body; convert it to the Responses `output` shape so tool_calls are not
    // lost on the non-streaming return path. Inlined (not imported from
    // nonStreamingHandler.js) to avoid a circular import: nonStreamingHandler
    // already imports parseSSEToOpenAIResponse from this module.
    //
    // Every other client dialect goes through the shared non-streaming
    // translation, injected by chatCore. Without it a Claude client routed to a
    // force-stream provider (CodeBuddy CN rejects non-stream requests) received
    // the raw OpenAI body it cannot read — `content` undefined — which fails the
    // same agent turns the stop-sequence guard exists to repair (issue #18).
    const finalBody = sourceFormat === FORMATS.OPENAI_RESPONSES
      ? chatCompletionToResponses(parsed, customToolNames)
      : (typeof translateToClientFormat === "function" ? translateToClientFormat(parsed) : parsed);

    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...upstreamResponseHeaders(providerResponse.headers)
    };
    if (sourceFormat === FORMATS.CLAUDE) {
      if (!headers["request-id"] || !headers["request-id"].startsWith("req_")) {
        headers["request-id"] = `req_${Date.now()}`;
      }
    }

    return { success: true, response: new Response(JSON.stringify(restoreToolNames(restorePrivacy(finalBody), toolNameMap)), { headers }) };
  } catch (err) {
    console.error("[ChatCore] Chat Completions SSE→JSON failed:", err);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON");
  }
}
