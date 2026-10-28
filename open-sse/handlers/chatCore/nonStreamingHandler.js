import { randomUUID } from "node:crypto";
import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { toOpenAIUsage } from "../../translator/concerns/usage.js";
import { openAICompletionToClaudeMessage } from "../../translator/concerns/claudeMessage.js";
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.js";
import { addBufferToUsage, filterUsageForFormat, usageOrEstimate } from "../../utils/usageTracking.js";
import { createErrorResult } from "../../utils/error.js";
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { parseSSEToOpenAIResponse } from "./sseToJsonHandler.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";
import { restoreToolNames } from "../../utils/opencodeFingerprint.js";
import { restoreGeminiToolName } from "../../translator/concerns/geminiTools.js";
import { ROLE, RESPONSES_ITEM } from "../../translator/schema/index.js";

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

// Gemini's thinking summary is returned as OpenAI-compatible
// `reasoning_content`. Keep it on the JSON path as well as the streaming path;
// otherwise a Gemini model can visibly think through SSE but appear not to
// think when the client requests a non-streaming response. For other models,
// retain the historical Firecrawl compatibility behavior.
function shouldPreserveReasoningContent(model, responseBody, targetFormat) {
  if ([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY, FORMATS.VERTEX].includes(targetFormat)) {
    return true;
  }

  const modelName = [model, responseBody?.model]
    .filter((value) => typeof value === "string")
    .join(" ");
  if (/gemini/i.test(modelName)) return true;
  return false;
}

/**
 * Convert an OpenAI Chat Completions non-streaming response body into the
 * OpenAI Responses API shape. Used when a Responses-format client (e.g. Codex)
 * is routed to a Chat Completions upstream and `stream:false` — the streaming
 * path already emits Responses events, but the JSON path returned a raw
 * `chat.completion` body, so tool_calls were invisible to Responses clients.
 */
function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

// Responses `response` object → Chat Completions. Mirrors the forced-SSE branch in
// sseToJsonHandler (pickAssistantMessageForChatCompletion: the user-visible answer is
// the last non-empty message item; cache counters fold into prompt_tokens).
function responsesCompletionToOpenAICompletion(responseBody) {
  if (!responseBody || typeof responseBody !== "object" || responseBody.object !== "response") return responseBody;
  const output = Array.isArray(responseBody.output) ? responseBody.output : [];
  const messages = output.filter((item) => item?.type === "message");
  let textContent = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = Array.isArray(messages[i].content) ? messages[i].content : [];
    const text = parts.filter((c) => typeof c?.text === "string").map((c) => c.text).join("");
    if (text.length > 0) { textContent = text; break; }
    if (i === 0) textContent = text;
  }
  const funcCallItems = output.filter((item) => item.type === "function_call");
  const toolCalls = funcCallItems.map((item, idx) => ({
    id: item.call_id || `call_${item.name}_${Date.now()}_${idx}`,
    type: "function",
    function: {
      name: item.name,
      arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
    },
  }));
  const hasToolCalls = toolCalls.length > 0;
  const usage = responseBody.usage || {};
  const cacheRead = usage.input_tokens_details?.cached_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const inTokens = (usage.input_tokens || 0) + cacheRead + cacheCreate;
  const outTokens = usage.output_tokens || 0;
  const incomplete = responseBody.status === "incomplete";
  const responseDone = responseBody.status === "completed" || responseBody.status === "done";
  const message = { role: "assistant", content: textContent || (hasToolCalls ? null : "") };
  if (hasToolCalls) message.tool_calls = toolCalls;
  // Responses reports WHY it stopped in incomplete_details.reason; Chat
  // Completions has one slot for it. "max_output_tokens" (the common case)
  // and any unknown reason map to "length", but a safety stop must surface as
  // "content_filter" — as "length" it reads as a small output budget, and
  // clients respond by raising max_tokens or compacting instead of showing
  // the refusal.
  const incompleteReason = responseBody.incomplete_details?.reason;
  const finishReason = hasToolCalls
    ? "tool_calls"
    : incomplete
      ? (incompleteReason === "content_filter" ? "content_filter" : "length")
      : (responseDone ? "stop" : (responseBody.status || "stop"));
  const result = {
    id: responseBody.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: responseBody.created_at || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: { prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: inTokens + outTokens },
  };
  if (cacheRead > 0 || cacheCreate > 0) {
    result.usage.prompt_tokens_details = {
      ...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
      ...(cacheCreate > 0 ? { cache_creation_tokens: cacheCreate } : {}),
    };
  }
  return result;
}

function openAICompletionToResponses(responseBody, customToolNames = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  // Reasoning → a reasoning item (summary text), mirroring the streaming path.
  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  // Assistant text → a message item with output_text content.
  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  // tool_calls → function_call/custom_tool_call items (Responses-native tool shape).
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
  const status = choice.finish_reason === "tool_calls" ? "completed" : (choice.finish_reason === "stop" ? "completed" : (choice.finish_reason || "completed"));

  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status,
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
 * Translate non-streaming response body from provider format → OpenAI format.
 */
export function translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames = null, toolNameMap = null) {
  if (targetFormat === sourceFormat) return responseBody;
  // Provider responded in OpenAI Chat Completions shape but the client speaks
  // Responses API — convert so tool_calls/text surface as Responses `output`.
  if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES) {
    return openAICompletionToResponses(responseBody, customToolNames);
  }
  // Mirror case: provider spoke the Responses API (openai-responses target —
  // opencode-go's responses-only ids, grok-4.x / gpt-*-luna) but the client is a
  // Chat Completions speaker. Without this the raw Responses body fell through
  // and was served as-is: no `choices`, empty content, no usage.
  if (targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI) {
    return responsesCompletionToOpenAICompletion(responseBody);
  }
  if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.CLAUDE) {
    return openAICompletionToClaudeMessage(responseBody);
  }
  if (targetFormat === FORMATS.OPENAI) return responseBody;

  // Antigravity / Gemini / Vertex
  if (targetFormat === FORMATS.GEMINI || targetFormat === FORMATS.ANTIGRAVITY || targetFormat === FORMATS.GEMINI_CLI || targetFormat === FORMATS.VERTEX) {
    if (sourceFormat === FORMATS.CLAUDE) {
      // Direct pipeline or convert intermediate OpenAI format to Claude message
      const openaiComp = translateNonStreamingResponse(responseBody, targetFormat, FORMATS.OPENAI, customToolNames, toolNameMap);
      return openAICompletionToClaudeMessage(openaiComp);
    }
    const response = responseBody.response || responseBody;
    if (!response?.candidates?.[0]) return responseBody;

    const candidate = response.candidates[0];
    const content = candidate.content;
    const usage = response.usageMetadata || responseBody.usageMetadata;
    let textContent = "", reasoningContent = "";
    const toolCalls = [];

    if (content?.parts) {
      for (const part of content.parts) {
        if (part.thought === true && part.text) reasoningContent += part.text;
        else if (part.text !== undefined) textContent += part.text;
        if (part.functionCall) {
          // Map a sanitized declaration name back to the one the client sent
          const name = restoreGeminiToolName(part.functionCall.name, toolNameMap);
          toolCalls.push({
            id: `call_${name}_${Date.now()}_${toolCalls.length}`,
            type: "function",
            function: { name, arguments: JSON.stringify(part.functionCall.args || {}) }
          });
        }
        // Handle inline image data (from image generation models)
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData?.data) {
          const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
          textContent += `\n![image](data:${mimeType};base64,${inlineData.data})\n`;
        }
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = (candidate.finishReason || "stop").toLowerCase();
    if (finishReason === "stop" && toolCalls.length > 0) finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${response.responseId || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(new Date(response.createTime || Date.now()).getTime() / 1000),
      model: response.modelVersion || "gemini",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (usage) {
      result.usage = {
        prompt_tokens: (usage.promptTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0
      };
      if (usage.thoughtsTokenCount > 0) {
        result.usage.completion_tokens_details = { reasoning_tokens: usage.thoughtsTokenCount };
      }
    }
    return result;
  }

  // Claude
  if (targetFormat === FORMATS.CLAUDE) {
    // Always translate a Claude-format body to OpenAI, even if `content` is
    // missing/null (e.g. M3 with max_tokens:1 spends the budget on thinking
    // and returns `content: null`). Returning the raw body would leave the
    // OpenAI client without a `choices` array and surface as a UI test error.
    // Early return if the response is already in OpenAI format (has choices array)
    // or if it has content as a non-array value (likely a different non-Claude format).
    // Some providers (e.g. xiaomi-tokenplan) return OpenAI-format responses even when
    // the request was translated to Claude format — the targetFormat is Claude but the
    // actual response is OpenAI-native and needs no further translation.
    if (responseBody.choices || (responseBody.content && !Array.isArray(responseBody.content))) return responseBody;

    let textContent = "", thinkingContent = "";
    const toolCalls = [];

    for (const block of (responseBody.content || [])) {
      if (block.type === "text") {
        // Strip markdown code block markers (e.g. kimi wraps JSON in ```json...```)
        const raw = block.text ?? "";
        const text = raw.replace(/^\s*```\s*json\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "");
        textContent += text;
      } else if (block.type === "thinking") thinkingContent += block.thinking || "";
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (thinkingContent) message.reasoning_content = thinkingContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = responseBody.stop_reason || "stop";
    if (finishReason === "end_turn") finishReason = "stop";
    if (finishReason === "tool_use") finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${responseBody.id || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseBody.model || "claude",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (responseBody.usage) {
      result.usage = toOpenAIUsage(responseBody.usage, "claude") || {
        prompt_tokens: responseBody.usage.input_tokens || 0,
        completion_tokens: responseBody.usage.output_tokens || 0,
        total_tokens: (responseBody.usage.input_tokens || 0) + (responseBody.usage.output_tokens || 0)
      };
    }
    return result;
  }

  // Ollama
  if (targetFormat === FORMATS.OLLAMA) {
    return ollamaBodyToOpenAI(responseBody);
  }

  return responseBody;
}

/**
 * Handle non-streaming response from provider.
 */
export async function handleNonStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, trackDone, appendLog, pxpipe, reqTag, log }) {
  trackDone();
  const contentType = providerResponse.headers.get("content-type") || "";
  let responseBody;

  if (contentType.includes("text/event-stream")) {
    const sseText = await providerResponse.text();
    const parsed = parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
    }
    if (parsed.error) {
      const upstreamStatus = Number(parsed.error.status);
      const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599
        ? upstreamStatus
        : HTTP_STATUS.BAD_GATEWAY;
      appendLog({ status: `FAILED ${status}` });
      return createErrorResult(status, parsed.error.message || "Upstream SSE stream failed", null, upstreamResponseHeaders(providerResponse.headers));
    }
    responseBody = parsed;
  } else {
    try {
      responseBody = await providerResponse.json();
    } catch (err) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      console.error(`[ChatCore] Failed to parse JSON from ${provider}:`, err.message);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
    }
  }

  reqLogger.logProviderResponse(providerResponse.status, providerResponse.statusText, providerResponse.headers, responseBody);
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // Decloak tool_use names once on raw Claude body, before any translation (INPUT side)
  responseBody = decloakToolNames(responseBody, toolNameMap);

  const usage = extractUsageFromResponse(responseBody);
  // Providers that answer a non-streaming request without a usage block used to
  // leave BOTH writers with zeros: saveUsageStats drops all-zero rows outright
  // (so the Overview tab, which reads usageDaily/usageHistory, showed nothing),
  // while saveRequestDetail still wrote the row (so the Details tab listed a
  // request with 0 in / 0 out). usageOrEstimate is the shared fallback — the
  // SSE-to-JSON path and the plain SSE path use it too, so all three agree.
  //
  // This `usage` only feeds the log line and the DB rows — the client-facing
  // usage is translatedResponse.usage below — so estimating cannot change the
  // API response.
  const recordedUsage = usageOrEstimate(usage, body, responseBody);
  appendLog({ tokens: recordedUsage, status: "200 OK" });
  const usageLatency = { total: Date.now() - requestStartTime };
  saveUsageStats({ provider, model, tokens: recordedUsage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, latency: usageLatency, usageKey: randomUUID(), silent: true });
  if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage: recordedUsage, latency: usageLatency }));

  const translatedResponse = needsTranslation(targetFormat, sourceFormat)
    ? translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames, toolNameMap)
    : responseBody;
  const isClaudeMessageResponse = sourceFormat === FORMATS.CLAUDE && translatedResponse?.type === "message";
  // Responses-format translation produces a `object:"response"` body with no
  // `choices`; skip the Chat-Completions-specific post-processing below for it.
  const isResponsesResponse = sourceFormat === FORMATS.OPENAI_RESPONSES && translatedResponse?.object === "response";

  // Fix finish_reason for tool_calls: some providers return non-standard values (e.g. "other")
  if (translatedResponse?.choices?.[0]) {
    const choice = translatedResponse.choices[0];
    const msg = choice.message;
    const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
    if (hasToolCalls && choice.finish_reason !== "tool_calls") {
      choice.finish_reason = "tool_calls";
    }
  }

  // Ensure OpenAI-required fields
  if (!isClaudeMessageResponse && !isResponsesResponse) {
    if (!translatedResponse.object) translatedResponse.object = "chat.completion";
    if (!translatedResponse.created) translatedResponse.created = Math.floor(Date.now() / 1000);
  }

  // Strip Azure-specific fields
  if (!isClaudeMessageResponse && !isResponsesResponse) {
    delete translatedResponse.prompt_filter_results;
    if (translatedResponse?.choices) {
      for (const choice of translatedResponse.choices) delete choice.content_filter_results;
    }
  }

  if (translatedResponse?.usage) {
    translatedResponse.usage = filterUsageForFormat(addBufferToUsage(translatedResponse.usage), sourceFormat);
  }

  // Firecrawl and similar clients historically required reasoning_content to
  // be omitted from ordinary JSON responses. Gemini is the exception: its
  // thought summaries are a first-class part of the user-visible response and
  // must match the streaming path (and CPA's behavior).
  if (!isClaudeMessageResponse && !isResponsesResponse
      && !shouldPreserveReasoningContent(model, translatedResponse, targetFormat)
      && translatedResponse?.choices) {
    for (const choice of translatedResponse.choices) {
      if (choice?.message?.reasoning_content && choice.message.content) {
        delete choice.message.reasoning_content;
      }
    }
  }

  reqLogger.logConvertedResponse(translatedResponse);

  const totalLatency = Date.now() - requestStartTime;
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: totalLatency, total: totalLatency },
    tokens: recordedUsage || { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: responseBody || null,
    response: {
      content: translatedResponse?.choices?.[0]?.message?.content || translatedResponse?.content || null,
      thinking: translatedResponse?.choices?.[0]?.message?.reasoning_content || translatedResponse?.reasoning_content || null,
      finish_reason: translatedResponse?.choices?.[0]?.finish_reason || "unknown"
    },
    pxpipe,
    status: "success"
  }, { endpoint: clientRawRequest?.endpoint || null })).catch(err => {
    console.error("[RequestDetail] Failed to save:", err.message);
  });

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

  return {
    success: true,
    response: new Response(JSON.stringify(restoreToolNames(translatedResponse, toolNameMap)), {
      headers
    })
  };
}
