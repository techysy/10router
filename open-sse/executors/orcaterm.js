import { randomUUID } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { ORCATERM_CONFIG } from "../config/orcaterm.js";
import { ROLE } from "../translator/schema/roles.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { chatChunkSse, sseChunk } from "../utils/sse.js";
import { OrcaTermError, refreshOrcaTermToken } from "../shared/orcaterm/auth.js";
import { buildOrcaTermRequest, OrcaTermReply, orcaStreamError, readOrcaTermEvents } from "../shared/orcaterm/protocol.js";

function errorResponse(error) {
  return Response.json({
    error: { message: error instanceof OrcaTermError ? error.message : "OrcaTerm upstream request failed", type: "upstream_error" },
  }, { status: error instanceof OrcaTermError ? error.status : 502 });
}

export class OrcaTermExecutor extends BaseExecutor {
  constructor() {
    super("orcaterm", PROVIDERS.orcaterm);
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    return refreshOrcaTermToken(credentials.refreshToken || credentials.accessToken, log, proxyOptions);
  }

  async execute({ model, body, stream, credentials, signal, proxyOptions = null }) {
    const abort = new AbortController();
    const fetchSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const url = this.config.baseUrl;
    const headers = this.buildHeaders(credentials, true);
    let payload = body;
    try {
      if (!credentials.accessToken) throw new OrcaTermError("OrcaTerm sign-in is required", 401);
      const context = buildOrcaTermRequest(model, body, credentials);
      payload = context.payload;
      headers["x-seqid"] = payload.input.id;
      const timer = setTimeout(() => abort.abort(), ORCATERM_CONFIG.chatConnectTimeoutMs);
      let upstream;
      try {
        upstream = await proxyAwareFetch(url, {
          method: "POST", headers, body: JSON.stringify(payload), signal: fetchSignal, redirect: "error",
        }, proxyOptions);
      } finally { clearTimeout(timer); }
      const result = (response) => ({ response, url, headers, transformedBody: payload });
      if (!upstream.ok) return result(upstream);
      if (upstream.headers.get("content-type")?.includes("application/json")) {
        const error = await upstream.json().catch(() => null);
        throw orcaStreamError(error?.error?.message || error?.message || "OrcaTerm returned JSON instead of an SSE stream", Number(error?.code));
      }

      const events = readOrcaTermEvents(upstream, fetchSignal);
      const reply = new OrcaTermReply(context);
      const id = `chatcmpl-orcaterm-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      // Surface HTTP-200 auth/rate-limit failures before chatCore commits response headers.
      let first;
      do {
        first = await events.next();
      } while (!first.done && (!first.value || first.value.type === "tool" || (!first.value.content && !first.value.reasoningContent)));
      if (first.done) throw new OrcaTermError("OrcaTerm returned an empty response");

      async function* deltas() {
        yield { role: ROLE.ASSISTANT };
        let next = first;
        try {
          while (!next.done) {
            const event = next.value;
            if (event.type !== "tool") {
              const reasoning = typeof event.reasoningContent === "string" ? event.reasoningContent
                : event.reasoning === true && typeof event.content === "string" ? event.content : "";
              if (reasoning) yield { reasoning_content: reasoning };
              if (event.reasoning !== true && typeof event.content === "string") {
                const delta = reply.feed(event.content);
                if (delta) yield delta;
              }
            }
            next = await events.next();
          }
          const end = reply.finish();
          if (end.delta) yield end.delta;
          yield { finishReason: end.finishReason };
        } finally { await events.return?.(); }
      }
      if (!stream) {
        const message = { role: ROLE.ASSISTANT, content: "" };
        let finishReason = "stop";
        for await (const delta of deltas()) {
          if (delta.content) message.content += delta.content;
          if (delta.reasoning_content) message.reasoning_content = (message.reasoning_content || "") + delta.reasoning_content;
          if (delta.tool_calls) message.tool_calls = delta.tool_calls.map(({ index: _index, ...call }) => call);
          if (delta.finishReason) finishReason = delta.finishReason;
        }
        if (message.tool_calls && !message.content) message.content = null;
        return result(Response.json({
          id, object: "chat.completion", created, model,
          choices: [{ index: 0, message, finish_reason: finishReason }],
        }));
      }
      const encoder = new TextEncoder();
      let cancelled = false;
      const output = new ReadableStream({
        async start(controller) {
          try {
            for await (const delta of deltas()) {
              if (cancelled) break;
              const { finishReason, ...content } = delta;
              controller.enqueue(encoder.encode(chatChunkSse({ id, created, model, delta: content, finishReason })));
            }
          } catch (error) {
            if (!cancelled) controller.enqueue(encoder.encode(sseChunk({
              error: { message: error instanceof OrcaTermError ? error.message : "OrcaTerm stream interrupted", type: "upstream_error" },
            })));
          } finally {
            if (!cancelled) {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }
          }
        },
        cancel() { cancelled = true; abort.abort(); return events.return?.(); },
      });
      return result(new Response(output, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }));
    } catch (error) {
      abort.abort();
      if (signal?.aborted) throw error;
      return { response: errorResponse(error), url, headers, transformedBody: payload };
    }
  }
}
