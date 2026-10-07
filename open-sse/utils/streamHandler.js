// Stream handler with disconnect detection - shared for all providers
import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({ onDisconnect, onError, log, provider, model, reqTag = "" } = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  // Only abnormal terminations are logged; normal completion is covered by "📊 done".
  // isError uses errorLine (always shown, ignores LOG_LEVEL) so failures survive quiet levels.
  const logStream = (symbol, status, isError = false) => {
    const duration = Date.now() - startTime;
    const emit = isError ? log?.errorLine : log?.line;
    if (emit) emit(reqTag, symbol, `${status} · ${provider}/${model} · ${duration}ms`);
    else console.log(`[${getTimeString()}] ${symbol} ${provider}/${model} · ${status} · ${duration}ms`);
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;

      logStream("⚡", `DISCONNECT: ${reason}`);
      dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`);

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally (no line here — "📊 done" is authoritative)
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("⚡", "ABORTED");
        return;
      }

      logStream("✗", `ERROR: ${error.message}${error.stack ? `\n    ${error.stack}` : ""}`, true);
      onError?.(error);
    },

    abort: () => abortController.abort()
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 */
export function createDisconnectAwareStream(transformStream, streamController, onAbortTerminal = null) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable.getWriter();
  let terminalEmitted = false;
  // 每当上游送出一个 [DONE] 哨兵就记一个。客户端读到 [DONE] 会立刻关闭连接,
  // 于是这里的 cancel() 紧跟其后触发——但这不是"上游断流",而是**正常收尾**。
  // 见 cancel():只有在上游 [DONE] 之前被取消才算真断连。
  let sawUpstreamDone = false;

  // TTFT keep-alive: large-context upstreams (codebuddy DeepSeek/GLM on 100K+ token
  // prompts) can take 20-30s before the first byte. During that silence the client
  // (gateway/card sidecar) sees an idle connection and times out → ResponseAborted
  // loop. SSE comment lines (`: keep-alive`) are spec-legal and ignored by every
  // OpenAI/Claude/Gemini client parser, so emit them while waiting for first byte.
  const KEEPALIVE_INTERVAL_MS = 5000;
  let firstByteSeen = false;
  let keepAliveTimer = null;
  let pendingKeepAlives = 0;
  const stopKeepAlive = () => {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  };
  const startKeepAlive = (controller) => {
    keepAliveTimer = setInterval(() => {
      if (!streamController.isConnected() || firstByteSeen) { stopKeepAlive(); return; }
      try {
        controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
        pendingKeepAlives++;
      } catch { /* downstream gone */ }
    }, KEEPALIVE_INTERVAL_MS);
  };

  // Emit a synthesized terminal payload (e.g. Responses response.failed + [DONE]) once
  const emitTerminal = (controller) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    try {
      const bytes = onAbortTerminal();
      if (bytes) controller.enqueue(bytes);
    } catch { /* best-effort terminal */ }
  };

  return new ReadableStream({
    async pull(controller) {
      if (!streamController.isConnected()) {
        stopKeepAlive();
        emitTerminal(controller);
        controller.close();
        return;
      }

      try {
        // While waiting for the first upstream byte, emit keep-alive comments so
        // the downstream connection stays active during long TTFT windows.
        if (!firstByteSeen && !keepAliveTimer) startKeepAlive(controller);
        const { done, value } = await reader.read();
        if (!firstByteSeen && value) {
          firstByteSeen = true;
          stopKeepAlive();
        }
        // 上游的 [DONE] 从这里路过(是普通 chunk,不是 done 状态),留个记号给 cancel()。
        // 字节级、刻意不做文本解析:分片边界、CRLF/双换行、`data: [DONE]` 前缀
        // 都不影响这个标记的正确性,它只要求"别漏看"。
        if (value && /\[DONE\]/.test(typeof value === "string" ? value : new TextDecoder().decode(value))) {
          sawUpstreamDone = true;
        }

        if (done) {
          stopKeepAlive();
          streamController.handleComplete();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        stopKeepAlive();
        const wasConnected = streamController.isConnected();
        // Controller already closed = downstream ended; not an upstream error, skip noisy log.
        const msg0 = error?.message || "";
        const isControllerClosed = msg0.includes("already closed") || msg0.includes("Invalid state");
        // Observed upstream error/disconnect state (production log, not dbg-only) to tell
        // whether the break happened during the TTFT window (no first byte yet) vs mid-stream.
        console.log(`[${getTimeString()}] 🔍 STREAM-ERR name=${error?.name} | msg=${msg0} | firstByteSeen=${firstByteSeen} | keepalivesSent=${pendingKeepAlives} | wasConnected=${wasConnected} | sinceStart=${Date.now() - streamController.startTime}ms`);
        if (!isControllerClosed) streamController.handleError(error);
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});

        // Treat network resets / socket hang up / abort as graceful close
        const msg = error?.message || "";
        const code = error?.code || error?.cause?.code || "";
        const isNetworkClose =
          error.name === "AbortError" ||
          msg.includes("aborted") ||
          msg.includes("socket hang up") ||
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("EPIPE") ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          code === "EPIPE" ||
          code === "UND_ERR_SOCKET";

        // Graceful close on network/abort, or when a structured terminal is available
        // (Responses passthrough prefers response.failed + [DONE] over a raw transport error)
        try {
          if (!wasConnected || isNetworkClose || onAbortTerminal) {
            emitTerminal(controller);
            controller.close();
          } else {
            controller.error(error);
          }
        } catch (e) { /* already closed or cancelled */ }
      }
    },

    cancel(reason) {
      stopKeepAlive();
      const disconnectState = `cancel reason=${reason} | firstByteSeen=${firstByteSeen} | keepalivesSent=${pendingKeepAlives} | sawUpstreamDone=${sawUpstreamDone} | sinceStart=${Date.now() - streamController.startTime}ms`;
      console.log(`[${getTimeString()}] 🔍 STREAM-CANCEL ${disconnectState}`);
      if (!sawUpstreamDone) {
        streamController.handleDisconnect(reason || "cancelled");
      }
      // 上游已经送过 [DONE]:这是**正常收尾**——客户端读到哨兵后关连接,不是断流。
      // 走 handleComplete 而不走 handleDisconnect:后者会触发 chatCore 记一条
      // status:"error"、0/0 token 的"中止"行,把一次完整答复写成失败(issue #48)。
      // 客户端那一刻读到的东西也无法区分:本函数在 cancel 语义里只能记完成,
      // 更诚实的 "completed-then-cancelled" 状态得动 DB schema。
      // 注:上游 EOF 场景在 pull() 里已经 handleComplete 过,再调一次是幂等的。
      else {
        console.log(`[${getTimeString()}] ✅ STREAM-CANCEL after upstream [DONE] — treating as normal completion (client closed post-sentinel)`);
        streamController.handleComplete();
      }
      reader.cancel();
      writer.abort();
    }
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal = null, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS) {
  let stallTimer = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  // Why the stream ended early, so the terminal frame can say something truer
  // than "stream ended". Set by whichever path aborts first.
  let abortMessage = "upstream connection lost";
  const t0 = Date.now();
  const tag = "STREAM";
  const clearStall = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      abortMessage = "stream stall timeout";
      dbg(tag, `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`);
      streamController.handleError?.(new Error("stream stall timeout"));
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  // Wrap controller so every termination path clears the stall timer.
  // Without this, abort/cancel/downstream-error paths leave the timer armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: () => { dbg(tag, `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleComplete(); },
    handleError: (e) => { dbg(tag, `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleError(e); },
    handleDisconnect: (r) => { dbg(tag, `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleDisconnect(r); },
    abort: () => { clearStall(); streamController.abort(); }
  };

  armStall();
  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms`);

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
        dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
      }
      armStall();
      controller.enqueue(chunk);
    },
    flush() { dbg(tag, `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); }
  });

  const transformedBody = providerResponse.body
    .pipeThrough(upstreamTap)
    .pipeThrough(transformStream);

  return createDisconnectAwareStream(
    { readable: transformedBody, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
    wrappedController,
    // Bind the abort reason here: it lives in this scope, and the downstream
    // helper only knows the zero-argument callback contract. Wrapping (rather
    // than threading a second parameter down) keeps that contract intact — the
    // Responses passthrough passes its own zero-arg builder straight in.
    onAbortTerminal ? () => onAbortTerminal(abortMessage) : null
  );
}

