import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { PENDING_COMPLETION_FLUSH_MS } from "../config/runtimeConfig.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    customToolNames = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null
  } = options;

  let buffer = "";
  let usage = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, customToolNames: new Set(customToolNames || []), model,
        // 本流的upstream格式。响应翻译器可能被直接命中（target === 注册源），
        // 也可能作为 pivot 的第二跳——终态 null chunk 时 pivot 会丢弃第一跳的
        // 返回，需要延迟收尾事件的翻译器知道自己在哪种情形里。缺省=未知，不延迟。
        targetFormat }
    : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let streamCompleted = false;
  // Set when flush() has to manufacture a terminator the upstream never sent.
  // The client still needs the sentinel — OpenClaw hangs until timeout without
  // one — but this is what an upstream proxy cutting the connection mid-answer
  // looks like, and it must not be recorded as a clean `status: "success"` with
  // estimated (not real) usage. The stall watchdog only fires on byte gaps, not
  // on an early clean FIN, so flush() is the only place that can tell.
  let endedWithoutTerminal = false;
  // A `data:` line that looked like payload but would not parse is dropped by
  // the loops below. That is deliberate for HTML error pages injected mid
  // stream, but the same swallow hides genuine corruption: the client gets a
  // shorter answer than the model produced and the request still books as a
  // clean success. Counting them makes the loss visible without changing the
  // success semantics — one bad line is not proof the stream was cut.
  let parseFailures = 0;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush

  // chat→responses 直连路由:finish_reason 后等 usage 尾部 chunk 而延迟的
  // response.completed(见 state.completionPending),由 watchdog 兜底补发。
  let completionFlushTimer = null;

  const clearCompletionFlushTimer = () => {
    if (completionFlushTimer) {
      clearTimeout(completionFlushTimer);
      completionFlushTimer = null;
    }
  };

  // chat→responses 直连路由(openai:openai-responses)的完成延迟只在
  // target=OPENAI / source=OPENAI_RESPONSES 时成立。
  const defersResponsesCompletion = () =>
    mode === STREAM_MODE.TRANSLATE &&
    targetFormat === FORMATS.OPENAI &&
    sourceFormat === FORMATS.OPENAI_RESPONSES &&
    state?.completionPending === true;

  // 立即补发被延迟的 response.completed 系列事件 —— 在 [DONE] 到达、或
  // watchdog 放弃等待 usage 尾部 chunk 时调用。sendCompleted 按 completedSent
  // 去重,先到的路径赢、另一条变为空转,不会双发。
  const flushDeferredCompletion = (controller) => {
    clearCompletionFlushTimer();
    if (!defersResponsesCompletion()) return;
    const flushed = translateResponse(targetFormat, sourceFormat, null, state);
    for (const item of flushed || []) {
      if (item === null || item === undefined) continue;
      const output = formatSSE(item, sourceFormat);
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
      sseEmittedCount++;
    }
  };

  // 完成行(buildRequestDetail 落 status:"success" 的那一次)只允许发一次:
  // 早发路径(见下)与 flush() 谁先到谁赢,后到的变空转。两条路径都可能在
  // 同一轮里跑到——[DONE] 之后客户端立刻断开,cancel() 不会让 flush() 执行,
  // 所以 [DONE] 处必须自己收尾。
  const finishStream = () => {
    if (streamCompleted) return;
    streamCompleted = true;

    // Translate 模式下 usage 记在 state 上,且尾部 usage chunk 已经把它补全
    // (实现刻意保留原始值供日志)。注意用 provider 而非 state.provider:后者
    // 可能是 translator 的中间格式名,落库该记真实上游。
    const finalUsage = mode === STREAM_MODE.PASSTHROUGH ? usage : state?.usage;
    if (!hasValidUsage(finalUsage) && totalContentLength > 0) {
      const estimated = estimateUsage(body, totalContentLength, mode === STREAM_MODE.PASSTHROUGH ? FORMATS.OPENAI : sourceFormat);
      if (mode === STREAM_MODE.PASSTHROUGH) usage = estimated;
      else state.usage = estimated;
    }

    const settledUsage = mode === STREAM_MODE.PASSTHROUGH ? usage : state?.usage;
    if (hasValidUsage(settledUsage)) {
      logUsage(provider || targetFormat, settledUsage, model, connectionId, apiKey);
    } else {
      appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
    }

    if (onStreamComplete) {
      onStreamComplete({
        content: accumulatedContent,
        thinking: accumulatedThinking,
        // Additive: consumers that ignore these behave as before. `streaming`
        // rows carry them so a truncated stream is not booked as a clean
        // success, and so dropped content is not invisible.
        incomplete: endedWithoutTerminal,
        parseFailures,
      }, settledUsage, ttftAt);
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          let output;
          let injectedUsage = false;

          if (trimmed === "data: [DONE]" || trimmed === "data:[DONE]") {
            output = "data: [DONE]\n\n";
            streamDoneSent = true;
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            finishStream();
            continue;
          }

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              const parsed = JSON.parse(trimmed.slice(5).trim());

              const idFixed = fixInvalidId(parsed);

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
              // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
              // every streaming delta. @ai-sdk/openai-compatible checks
              // `delta.tool_calls != null` — an empty array passes this check,
              // causing premature `reasoning-end` on every chunk.
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
                    delete choice.delta.tool_calls;
                    fieldsInjected = true;
                  }
                  // Normalize tool_calls with an empty function.name. Some
                  // upstreams (e.g. CodeBuddy CN) stream the tool name on the
                  // first chunk and then repeat `function:{name:"",arguments}`
                  // on every subsequent chunk for the SAME tool index. A client
                  // that blindly overwrites the accumulated name (rather than
                  // skipping empty ones) ends up with `unknown tool ""`.
                  // Dropping the empty `name` makes the stream match the OpenAI
                  // spec (name only on the first chunk; later chunks carry just
                  // arguments), so the client keeps the already-accumulated name.
                  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls)) {
                    for (const tc of choice.delta.tool_calls) {
                      if (tc?.function && tc.function.name === "" && Object.keys(tc.function).length > 1) {
                        delete tc.function.name;
                        fieldsInjected = true;
                      }
                    }
                  }
                }
              }

              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content;
              const reasoning = delta?.reasoning_content;
              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = mergeUsage(usage, extracted);
              }

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch {
              // Skip non-JSON data lines — don't forward garbage to clients.
              // Upstream providers sometimes return plain-text errors (HTML,
              // rate-limit messages) in the SSE stream that would break
              // downstream JSON decoders. But do count them: the same swallow
              // hides mid-stream corruption of real content, and the client
              // then gets a shorter answer with no signal at all.
              parseFailures++;
              continue;
            }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) {
          // `null` also covers plain non-`data:` lines (comments, event names),
          // which are legitimately ignorable. Only a `data:` line that would
          // not parse is a lost chunk — see the note on `parseFailures`.
          if (trimmed.startsWith("data:")) parseFailures++;
          continue;
        }

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // chat→responses 直连:[DONE] 到达时不再等尾部 usage chunk,
          // 立即补发被延迟的 response.completed 并取消 watchdog。
          flushDeferredCompletion(controller);

          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
          }

          if (keepsOpenAIResponsesFormat && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }
          streamDoneSent = true;
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          // [DONE] 之后客户端(OpenAI SDK / Hermes / 各类 card sidecar)会立刻
          // 关闭连接,cancel() 不会触发 flush()——不在这里收尾,这一轮就永远
          // 停在占位行上,再被 cancel 的 abort 路径改写成 status:"error"、
          // 0/0 token,尽管答复已完整送达(issue #48)。收尾必须由 [DONE] 自己完成。
          finishStream();
          continue;
        }

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = mergeUsage(state.usage, extracted); // Keep original usage for logging

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            if (item === null || item === undefined) continue;
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            sseEmittedCount++;
          }
        }
      }

      // 兜底 watchdog:上游可能在 finish_reason 后 stall(无尾部 usage chunk、
      // 无 [DONE]、连接不断开),被延迟的 response.completed 会无限挂起。
      if (completionFlushTimer && !defersResponsesCompletion()) {
        // 正常路径(带 usage 的 finish/尾部 usage chunk)已即时补发,取消 watchdog。
        clearCompletionFlushTimer();
      } else if (!completionFlushTimer && defersResponsesCompletion()) {
        completionFlushTimer = setTimeout(() => {
          completionFlushTimer = null;
          if (!defersResponsesCompletion()) return;
          try {
            flushDeferredCompletion(controller);
          } catch {
            // 控制器可能已被关闭/取消(客户端断开),补发失败无需处理。
          }
        }, PENDING_COMPLETION_FLUSH_MS);
        // 兜底定时器不该拖住 Node 进程退出。
        completionFlushTimer.unref?.();
      }
    },

    flush(controller) {
      clearCompletionFlushTimer();
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            let output = buffer;
            if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }

          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          // Gemini-family clients (Antigravity, Vertex, Gemini) reject this sentinel with 400 syntax errors.
          const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";
          if (!streamDoneSent && !isGeminiFamily) {
            // We are the ones inventing the terminator, so the upstream never
            // finished. Say so — see the note on `endedWithoutTerminal`. Gemini
            // family is exempt: it has no [DONE] sentinel, so `!streamDoneSent`
            // is always true there and would flag every healthy stream.
            endedWithoutTerminal = true;
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }

          finishStream();
          return;
        }

        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim());
          if (parsed && !parsed.done) {
            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                if (item === null || item === undefined) continue;
                const output = formatSSE(item, sourceFormat);
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
              }
            }
          }
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          // Same situation as the passthrough case above: we are the ones
          // inventing the terminal. The client is told `response.failed`, so
          // booking this as `status: "success"` made the two disagree.
          endedWithoutTerminal = true;
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        if (keepsOpenAIResponsesFormat && !openAIResponsesDoneSent && !streamDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
          openAIResponsesDoneSent = true;
          streamDoneSent = true;
        }

        finishStream();
      } catch (error) {
        // Never swallow a flush failure: if we bail before finishStream the
        // request-detail row is left at status "streaming" forever, or later
        // rewritten as an error even though bytes were delivered. Finalize what
        // we accumulated and mark it incomplete instead.
        endedWithoutTerminal = true;
        try {
          finishStream();
        } catch {
          /* second failure is not recoverable; leave the row as it is */
        }
        console.log("Error in flush:", error);
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, customToolNames = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    customToolNames,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}
