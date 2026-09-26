/**
 * Translator: OpenAI Chat Completions → OpenAI Responses API (response)
 * Converts streaming chunks from Chat Completions to Responses API events
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { buildChunk } from "../concerns/chunk.js";
import { buildUsage } from "../concerns/usage.js";
import { fallbackToolCallId } from "../concerns/toolCall.js";
import { reasoningDelta, extractReasoningText } from "../concerns/reasoning.js";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM, OPENAI_FINISH, MODEL_FALLBACK } from "../schema/index.js";

// 上游 Chat Completions usage → Responses API usage 形状。
// 没有它 /v1/responses 永远不上报 usage：Responses 客户端（Codex CLI）的
// "context used" 会一直停在 0、永不自动 compact，长会话直到撞上游上下文上限
// 才被拒（9router issue #3432）。
//
// 注意写到 state.responsesUsage 而不是 state.usage：state.usage 归流层所有，
// 形状是 normalizeUsage() 的（prompt_tokens/prompt_tokens_details），交给
// finalizeStream() 做统计与计费；被这里覆盖会静默丢 cached/reasoning token。
function toResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const inputTokens = [usage.input_tokens, usage.prompt_tokens].find(Number.isFinite) ?? 0;
  const outputTokens = [usage.output_tokens, usage.completion_tokens].find(Number.isFinite) ?? 0;
  const responseUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : inputTokens + outputTokens
  };
  const cachedTokens = [usage.input_tokens_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens].find(Number.isFinite);
  const reasoningTokens = [usage.output_tokens_details?.reasoning_tokens, usage.completion_tokens_details?.reasoning_tokens].find(Number.isFinite);
  if (Number.isFinite(cachedTokens)) responseUsage.input_tokens_details = { cached_tokens: cachedTokens };
  if (Number.isFinite(reasoningTokens)) responseUsage.output_tokens_details = { reasoning_tokens: reasoningTokens };

  return responseUsage;
}

// #4307：response.completed 必须携带全部已完成 output items —— Responses 客户端
// （Codex 等）从终态事件读 output，而不是回放整条事件流。
function recordCompletedOutputItem(state, index, item) {
  state.completedOutputItems ??= new Map();
  state.completedOutputItems.set(index, item);
}

/**
 * Translate OpenAI chunk to Responses API events
 * @returns {Array} Array of events with { event, data } structure
 */
export function openaiToOpenAIResponsesResponse(chunk, state) {
  if (!chunk) {
    return flushEvents(state);
  }

  // 在 choices 守卫之前先捕获 usage：最后一个 OpenAI chunk 可能同时携带 usage
  // 和空的 choices 数组（OpenAI 正是这么发尾部 chunk 的），不能丢。
  if (chunk.usage) {
    state.responsesUsage = toResponsesUsage(chunk.usage);
  }

  if (!chunk.choices?.length) return [];
  
  const events = [];
  const nextSeq = () => ++state.seq;
  
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  const choice = chunk.choices[0];
  const idx = choice.index || 0;
  const delta = choice.delta || {};

  // Emit initial events
  if (!state.started) {
    state.started = true;
    state.responseId = chunk.id ? `resp_${chunk.id}` : state.responseId;
    
    emit("response.created", {
      type: "response.created",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress",
        background: false,
        error: null,
        output: []
      }
    });

    emit("response.in_progress", {
      type: "response.in_progress",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress"
      }
    });
  }

  // Handle reasoning across vendor shapes (reasoning_content / reasoning / reasoning_details)
  const reasoningText = extractReasoningText(delta);
  if (reasoningText) {
    startReasoning(state, emit, idx);
    emitReasoningDelta(state, emit, reasoningText);
  }

  // Handle text content
  if (delta.content) {
    let content = delta.content;

    if (content.includes("<think>")) {
      state.inThinking = true;
      content = content.replace("<think>", "");
      startReasoning(state, emit, idx);
    }

    if (content.includes("</think>")) {
      const parts = content.split("</think>");
      const thinkPart = parts[0];
      const textPart = parts.slice(1).join("</think>");
      if (thinkPart) emitReasoningDelta(state, emit, thinkPart);
      closeReasoning(state, emit);
      state.inThinking = false;
      content = textPart;
    }

    if (state.inThinking && content) {
      emitReasoningDelta(state, emit, content);
      return events;
    }

    if (content) {
      emitTextContent(state, emit, idx, content);
    }
  }

  // Handle tool_calls (empty array is truthy; require a real call)
  if (delta.tool_calls && delta.tool_calls.length) {
    closeMessage(state, emit, idx);
    for (const tc of delta.tool_calls) {
      emitToolCall(state, emit, tc);
    }
  }

  // Handle finish_reason
  if (choice.finish_reason) {
    for (const i in state.msgItemAdded) closeMessage(state, emit, i);
    closeReasoning(state, emit);
    for (const i in state.funcCallIds) closeToolCall(state, emit, i);
    // 上游可能在 finish chunk 之后的尾部 chunk（choices 为空）才报 usage。在
    // usage 未知时提前发 response.completed 会把载荷冻结在旧值，所以要延迟到
    // flushEvents()（上游流结束后必跑一次，届时所有 chunk 都已见过）。
    // 该延迟只在直连 openai:openai-responses 路由上成立；作为 pivot 第二跳
    // （Claude/Gemini/Kiro 上游）时 translateResponse() 在终态 null chunk 前
    // 就返回了——flushEvents 不会被调用，延迟会吞掉终态事件，保持原行为。
    const flushReachesUs = state.targetFormat === FORMATS.OPENAI;
    if (state.responsesUsage || !flushReachesUs) sendCompleted(state, emit);
  }

  return events;
}

// Helper functions
function startReasoning(state, emit, idx) {
  if (!state.reasoningId) {
    state.reasoningId = `rs_${state.responseId}_${idx}`;
    state.reasoningIndex = idx;
    
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: idx,
      item: { id: state.reasoningId, type: RESPONSES_ITEM.REASONING, summary: [] }
    });

    emit("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: state.reasoningId,
      output_index: idx,
      summary_index: 0,
      part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: "" }
    });
    state.reasoningPartAdded = true;
  }
}

function emitReasoningDelta(state, emit, text) {
  if (!text) return;
  state.reasoningBuf += text;
  emit("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    summary_index: 0,
    delta: text
  });
}

function closeReasoning(state, emit) {
  if (state.reasoningId && !state.reasoningDone) {
    state.reasoningDone = true;
    
    emit("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      text: state.reasoningBuf
    });

    emit("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: state.reasoningBuf }
    });

    const reasoningItem = {
      id: state.reasoningId,
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: state.reasoningBuf }]
    };
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.reasoningIndex,
      item: reasoningItem
    });
    recordCompletedOutputItem(state, state.reasoningIndex, reasoningItem);
  }
}

function emitTextContent(state, emit, idx, content) {
  if (!state.msgItemAdded[idx]) {
    state.msgItemAdded[idx] = true;
    const msgId = `msg_${state.responseId}_${idx}`;
    
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: idx,
      item: { id: msgId, type: RESPONSES_ITEM.MESSAGE, content: [], role: ROLE.ASSISTANT }
    });
  }

  if (!state.msgContentAdded[idx]) {
    state.msgContentAdded[idx] = true;
    
    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: `msg_${state.responseId}_${idx}`,
      output_index: idx,
      content_index: 0,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: "" }
    });
  }

  emit("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: `msg_${state.responseId}_${idx}`,
    output_index: idx,
    content_index: 0,
    delta: content,
    logprobs: []
  });

  if (!state.msgTextBuf[idx]) state.msgTextBuf[idx] = "";
  state.msgTextBuf[idx] += content;
}

function closeMessage(state, emit, idx) {
  if (state.msgItemAdded[idx] && !state.msgItemDone[idx]) {
    state.msgItemDone[idx] = true;
    const fullText = state.msgTextBuf[idx] || "";
    const msgId = `msg_${state.responseId}_${idx}`;

    emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: msgId,
      output_index: parseInt(idx),
      content_index: 0,
      text: fullText,
      logprobs: []
    });

    emit("response.content_part.done", {
      type: "response.content_part.done",
      item_id: msgId,
      output_index: parseInt(idx),
      content_index: 0,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: fullText }
    });

    const msgItem = {
      id: msgId,
      type: RESPONSES_ITEM.MESSAGE,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: fullText }],
      role: ROLE.ASSISTANT
    };
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: parseInt(idx),
      item: msgItem
    });
    recordCompletedOutputItem(state, parseInt(idx), msgItem);
  }
}

function isCustomTool(state, name) {
  return !!name && state.customToolNames?.has(name);
}

function extractCustomToolInput(argumentsText) {
  if (typeof argumentsText !== "string") return "";
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* incomplete or raw freeform input */ }
  return argumentsText;
}

function emitToolCall(state, emit, tc) {
  const tcIdx = tc.index ?? 0;
  const newCallId = tc.id;
  const funcName = tc.function?.name;

  if (funcName) state.funcNames[tcIdx] = funcName;
  if (newCallId) state.funcCallIds[tcIdx] = newCallId;

  // Some compatible providers split the call id and function name across
  // chunks. Wait for both before deciding whether this is a custom tool;
  // otherwise an `exec` call can be irreversibly announced as function_call.
  const callId = state.funcCallIds[tcIdx];
  if (!state.funcItemAdded[tcIdx] && callId && state.funcNames[tcIdx]) {
    state.funcItemAdded[tcIdx] = true;
    const custom = isCustomTool(state, state.funcNames[tcIdx]);

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: tcIdx,
      item: {
        id: `${custom ? "ctc" : "fc"}_${callId}`,
        type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
        ...(custom ? { input: "" } : { arguments: "" }),
        call_id: callId,
        name: state.funcNames[tcIdx] || ""
      }
    });
  }

  if (!state.funcArgsBuf[tcIdx]) state.funcArgsBuf[tcIdx] = "";

  if (tc.function?.arguments) {
    const refCallId = state.funcCallIds[tcIdx] || newCallId;
    if (state.funcItemAdded[tcIdx] && refCallId && !isCustomTool(state, state.funcNames[tcIdx])) {
      emit("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: `fc_${refCallId}`,
        output_index: tcIdx,
        delta: tc.function.arguments
      });
    }
    // Custom input is emitted once at close, after the Chat JSON wrapper can be
    // parsed and unwrapped. Streaming the raw JSON fragments would expose
    // {"input":"..."} instead of the freeform program Codex expects.
    state.funcArgsBuf[tcIdx] += tc.function.arguments;
  }
}

function closeToolCall(state, emit, idx) {
  const callId = state.funcCallIds[idx];
  if (callId && !state.funcItemDone[idx]) {
    const args = state.funcArgsBuf[idx] || "{}";
    const custom = isCustomTool(state, state.funcNames[idx]);

    if (custom) {
      const input = extractCustomToolInput(args);
      emit("response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta",
        item_id: `ctc_${callId}`,
        output_index: parseInt(idx),
        delta: input
      });
      emit("response.custom_tool_call_input.done", {
        type: "response.custom_tool_call_input.done",
        item_id: `ctc_${callId}`,
        output_index: parseInt(idx),
        input
      });
    } else {
      emit("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: `fc_${callId}`,
        output_index: parseInt(idx),
        arguments: args
      });
    }

    const funcItem = {
      id: `${custom ? "ctc" : "fc"}_${callId}`,
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      ...(custom ? { input: extractCustomToolInput(args) } : { arguments: args }),
      call_id: callId,
      name: state.funcNames[idx] || ""
    };
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: parseInt(idx),
      item: funcItem
    });
    recordCompletedOutputItem(state, parseInt(idx), funcItem);

    state.funcItemDone[idx] = true;
    state.funcArgsDone[idx] = true;
  }
}

function sendCompleted(state, emit) {
  if (!state.completedSent) {
    state.completedSent = true;
    const output = [];
    if (state.completedOutputItems?.size) {
      const maxIdx = Math.max(...state.completedOutputItems.keys());
      for (let i = 0; i <= maxIdx; i++) {
        const item = state.completedOutputItems.get(i);
        if (item) output.push(item);
      }
    }
    emit("response.completed", {
      type: "response.completed",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "completed",
        background: false,
        error: null,
        output,
        ...(state.responsesUsage ? { usage: state.responsesUsage } : {})
      }
    });
  }
}

function flushEvents(state) {
  if (state.completedSent) return [];
  
  const events = [];
  const nextSeq = () => ++state.seq;
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  for (const i in state.msgItemAdded) closeMessage(state, emit, i);
  closeReasoning(state, emit);
  for (const i in state.funcCallIds) closeToolCall(state, emit, i);
  sendCompleted(state, emit);
  
  return events;
}

// currentToolCallId is intentionally sticky for the current turn so flush/completion
  // can still finalize as tool_calls even if the tool call was emitted before stream end.
function computeFinishReason(state) {
   return state.toolCallIndex > 0 || state.currentToolCallId
    ? OPENAI_FINISH.TOOL_CALLS
    : OPENAI_FINISH.STOP;
}

/**
 * Translate OpenAI Responses API chunk to OpenAI Chat Completions format
 * This is for when Codex returns data and we need to send it to an OpenAI-compatible client
 */
export function openaiResponsesToOpenAIResponse(chunk, state) {
  if (!chunk) {
    // Flush: send final chunk with finish_reason
    if (state.finishReasonSent || !state.started) return null;

    const finishReason = computeFinishReason(state);

    state.finishReasonSent = true;
    state.finishReason = finishReason;

    const finalChunk = buildChunk(
      { id: state.chatId || `chatcmpl-${Date.now()}`, created: state.created || Math.floor(Date.now() / 1000), model: state.model || MODEL_FALLBACK },
      {},
      finishReason
    );

    if (state.usage && typeof state.usage === "object") {
      finalChunk.usage = state.usage;
    }

    return finalChunk;
  }

  // Handle different event types from Responses API
  const eventType = chunk.type || chunk.event;
  const data = chunk.data || chunk;

  // Initialize state
  if (!state.started) {
    state.started = true;
    state.chatId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.toolCallIndex = 0;
    state.currentToolCallId = null;
    // item_id → chat tool_calls index. Deltas carry item_id; keying on it (not
    // stream position) keeps parallel calls separate when upstream emits all
    // output_item.added events before any done/delta. Lazily created so callers
    // that build their own state object (stream.js) need no changes.
    state.respToolChatIndex ??= new Map();
    // Indices that already received argument deltas (guards done-with-args).
    state.respToolArgsEmitted ??= new Set();
  }

  // Text content delta
  if (eventType === "response.output_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { content: delta }
    );
  }

  // Text content done (ignore, we handle via delta)
  if (eventType === "response.output_text.done") {
    return null;
  }

  // Function call started (standard function_call or custom_tool_call).
  // Index is assigned here (not on done): attributing deltas by stream position
  // merges parallel calls into index 0 whenever upstream emits all addeds
  // before dones — the client then concatenates N JSON payloads into one
  // tool input and fails validation. The server item id is the correlator.
  if (eventType === "response.output_item.added" && (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL || data.item?.type === "custom_tool_call")) {
    const item = data.item;
    state.currentToolCallId = item.call_id || fallbackToolCallId();
    state.respToolChatIndex ??= new Map();
    const key = item.id || data.item_id || state.currentToolCallId;
    let idx;
    if (key && state.respToolChatIndex.has(key)) {
      idx = state.respToolChatIndex.get(key); // duplicate added (retry) — reuse
    } else {
      idx = state.toolCallIndex++;
      if (key) state.respToolChatIndex.set(key, idx);
    }

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      {
        tool_calls: [{
          index: idx,
          id: state.currentToolCallId,
          type: OPENAI_BLOCK.FUNCTION,
          function: { name: item.name || "", arguments: "" }
        }]
      }
    );
  }

  // Function call arguments delta (standard or custom_tool_call variant).
  // Routed by item_id so interleaved parallel fragments stay on their own call.
  if (eventType === "response.function_call_arguments.delta" || eventType === "response.custom_tool_call_input.delta") {
    const argsDelta = data.delta || "";
    if (!argsDelta) return null;

    const known = data.item_id ? state.respToolChatIndex?.get(data.item_id) : undefined;
    const idx = known ?? Math.max(0, (state.toolCallIndex || 1) - 1);
    state.respToolArgsEmitted ??= new Set();
    state.respToolArgsEmitted.add(idx);
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { tool_calls: [{ index: idx, function: { arguments: argsDelta } }] }
    );
  }

  // Function call done (standard or custom_tool_call variant).
  // Index was assigned at added-time; nothing to advance. Some upstreams send
  // complete arguments only here (no deltas) — emit them once in that case.
  if (eventType === "response.output_item.done" && (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL || data.item?.type === "custom_tool_call")) {
    const key = data.item?.id || data.item_id;
    const idx = (key && state.respToolChatIndex?.get(key)) ?? Math.max(0, (state.toolCallIndex || 1) - 1);
    const fullArgs = data.item?.arguments;
    if (typeof fullArgs === "string" && fullArgs) {
      state.respToolArgsEmitted ??= new Set();
      if (!state.respToolArgsEmitted.has(idx)) {
        state.respToolArgsEmitted.add(idx);
        return buildChunk(
          { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
          { tool_calls: [{ index: idx, function: { arguments: fullArgs } }] }
        );
      }
    }
    return null;
  }

  // Response completed
  if (eventType === "response.completed" || eventType === "response.done") {
    // Extract usage from response.completed event
    const responseUsage = data.response?.usage;
    if (responseUsage && typeof responseUsage === "object") {
      const inputTokens = responseUsage.input_tokens || responseUsage.prompt_tokens || 0;
      const outputTokens = responseUsage.output_tokens || responseUsage.completion_tokens || 0;
      // OpenAI Responses API: input_tokens already includes cached_tokens
      // Cache info is in input_tokens_details.cached_tokens
      const cacheReadTokens = responseUsage.input_tokens_details?.cached_tokens || responseUsage.cache_read_input_tokens || 0;
      
      state.usage = buildUsage({ promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens, cachedTokens: cacheReadTokens });
    }
    
    if (!state.finishReasonSent) {
      const finishReason = computeFinishReason(state);

      state.finishReasonSent = true;
      state.finishReason = finishReason; // Mark for usage injection in stream.js
      
      const finalChunk = buildChunk(
        { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
        {},
        finishReason
      );

      // Include usage in final chunk if available
      if (state.usage && typeof state.usage === "object") {
        finalChunk.usage = state.usage;
      }
      
      return finalChunk;
    }
    return null;
  }

  // Error events from Responses API (e.g. model_not_found)
  if (eventType === "error" || eventType === "response.failed") {
    // Avoid emitting duplicate errors (error + response.failed arrive back-to-back)
    if (state.finishReasonSent) return null;

    const error = data.error || data.response?.error;
    if (error) {
      state.error = error;
      state.finishReasonSent = true;

      // Surface the error as an OpenAI-compatible error chunk
      return buildChunk(
        { id: state.chatId || `chatcmpl-${Date.now()}`, created: state.created || Math.floor(Date.now() / 1000), model: state.model || MODEL_FALLBACK },
        { content: `[Error] ${error.message || JSON.stringify(error)}` },
        OPENAI_FINISH.STOP
      );
    }
    return null;
  }

  // Reasoning summary delta → emit as reasoning_content for client thinking display
  if (eventType === "response.reasoning_summary_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      reasoningDelta(delta)
    );
  }

  // Ignore other events
  return null;
}

// Register both directions
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, null, openaiToOpenAIResponsesResponse);
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, null, openaiResponsesToOpenAIResponse);
