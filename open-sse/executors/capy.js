/**
 * CapyExecutor — runs OpenAI-format chat requests on Capy's agent platform.
 *
 * Capy has no chat-completions endpoint: a request becomes a projectless jam
 * bound to the connection's enrolled device ({deviceId, workspace.worktree}),
 * and the agent's user-visible reply arrives over the jam's NDJSON event
 * stream as `message_user` tool calls (state:"final" closes the turn). This
 * executor performs the whole lifecycle and wraps the result in a synthetic
 * Response whose body is ordinary OpenAI SSE (or JSON when stream=false), so
 * the rest of the pipeline sees a normal upstream answer.
 *
 * Credentials: refreshToken = Clerk client JWT (rotating_token — rotated on
 * every FAPI call; persist via onCredentialsRefreshed like grok-cli).
 * accessToken = 60s session JWT; a fresh one is minted per request.
 */

import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import {
  mintCapySessionJwt,
  capyJams,
  capyCreateJam,
  capyPostMessage,
  capyJamEvents,
  CapyApiError,
} from "../shared/capy/client.js";
import { CapyTunnelRegistry } from "../shared/capy/tunnel.js";
import {
  CAPY_EVENT_ASSISTANT,
  CAPY_EVENT_ERROR,
  CAPY_EVENT_MESSAGE,
  CAPY_TOOL_MESSAGE_USER,
  CAPY_MESSAGE_STATE_FINAL,
} from "../shared/capy/constants.js";

const CAPY_STREAM_TIMEOUT_MS = 10 * 60 * 1000;
const ROLE_LABELS = { system: "System", user: "User", assistant: "Assistant", tool: "Tool" };

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (part?.type === "image_url") return "[image omitted]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const CAPY_EFFORTS = new Set(["none", "instant", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Flatten an OpenAI messages array into one jam instruction string. */
function flattenMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const turns = messages
    .map((m) => {
      const role = ROLE_LABELS[m?.role] ?? m?.role;
      let text = contentToText(m?.content);
      if (m?.role === "assistant" && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
        const calls = m.tool_calls.map((c) => {
          let args = c?.function?.arguments;
          try { args = typeof args === "string" ? JSON.parse(args || "{}") : (args || {}); } catch { /* keep string */ }
          return `<tool_call>${JSON.stringify({ id: c?.id, name: c?.function?.name, arguments: args })}</tool_call>`;
        }).join("\n");
        text = text ? `${text}\n${calls}` : calls;
      }
      if (m?.role === "tool") {
        return `Tool result (${m?.name || ""}${m?.tool_call_id ? ` id=${m.tool_call_id}` : ""}):\n${text || "(empty)"}`;
      }
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean);
  return turns.join("\n\n");
}

/** OpenAI tools → prompt preamble. Capy has no function-calling API, so the
 * model is told to answer with <tool_call> JSON blocks we parse back out. */
function toolPreamble(tools, toolChoice) {
  const fns = (Array.isArray(tools) ? tools : [])
    .map((t) => (t?.type === "function" || t?.function) ? t.function : null)
    .filter((f) => f?.name);
  if (!fns.length || toolChoice === "none") return "";
  const spec = fns.map((f) => JSON.stringify({ name: f.name, description: f.description || "", parameters: f.parameters || { type: "object" } })).join("\n");
  let force = "";
  if (toolChoice === "required") force = "You MUST call at least one tool in this reply.\n";
  else if (toolChoice?.function?.name) force = `You MUST call the tool "${toolChoice.function.name}" in this reply.\n`;
  return [
    "# Client tools",
    "You are acting as the model behind an API client. The client (not you) executes these tools and returns results in later turns.",
    "Do NOT use your own sandbox/terminal/file tools for this request; only use message_user to reply.",
    "To call client tools, your message_user text must contain ONLY one or more blocks, each exactly:",
    '<tool_call>{"name":"<tool name>","arguments":{...json args...}}</tool_call>',
    "with no other text. Otherwise answer normally in plain text.",
    force + "Available tools (JSON Schema):",
    spec,
    "# Conversation",
    "",
  ].join("\n");
}

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
function parseToolCalls(text) {
  if (typeof text !== "string" || !text.includes("<tool_call>")) return null;
  const calls = [];
  for (const m of text.matchAll(TOOL_CALL_RE)) {
    let raw = m[1].trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    try {
      const obj = JSON.parse(raw);
      if (!obj?.name) continue;
      const args = typeof obj.arguments === "string" ? obj.arguments : JSON.stringify(obj.arguments ?? obj.parameters ?? {});
      calls.push({ id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "function", function: { name: obj.name, arguments: args } });
    } catch { /* skip malformed */ }
  }
  if (!calls.length) return null;
  const rest = text.replace(TOOL_CALL_RE, "").trim();
  return { calls, rest };
}

function requestEffort(body) {
  const e = body?.reasoning_effort ?? body?.reasoning?.effort ?? null;
  if (typeof e === "string" && CAPY_EFFORTS.has(e)) return e;
  return undefined;
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function openaiChunk(model, id, delta, finishReason = null, usage = null) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return sseChunk(chunk);
}

export class CapyExecutor extends BaseExecutor {
  #tunnels = null;

  constructor(provider = "capy", config = {}) {
    super(provider, config);
  }

  needsRefresh(credentials) {
    // The session JWT is 60s; treat it as always needing a mint.
    return true;
  }

  /** 401-path refresh: mint a fresh session JWT and return rotated clientJwt. */
  async refreshCredentials(credentials, log) {
    const sessionId = credentials?.providerSpecificData?.sessionId;
    const clientJwt = credentials?.refreshToken || credentials?.accessToken;
    if (!sessionId || !clientJwt) return null;
    const { jwt, rotatedClientJwt } = await mintCapySessionJwt({ clientJwt, sessionId }, { fetchImpl: this.config?.fetchImpl });
    // Stamp expiresAt on the live credentials object too: chatCore merges the
    // returned fields without recomputing expiry, and #sessionJwt would
    // otherwise mint a second JWT on the retry pass.
    credentials.expiresAt = new Date(Date.now() + 55_000).toISOString();
    return {
      accessToken: jwt,
      refreshToken: rotatedClientJwt ?? credentials.refreshToken,
      expiresIn: 55,
    };
  }

  /**
   * Return a live session JWT for this request. chatCore refreshes credentials
   * proactively via tokenRefresh (capyRefreshHandler → mintCapySessionJwt), so
   * an accessToken with a fresh expiresAt is reused as-is; minting here is the
   * fallback for callers that skip the credential-manager path. A rotated
   * clientJwt rides back through onCredentialsRefreshed for persistence.
   */
  async #sessionJwt(credentials, log, onCredentialsRefreshed) {
    const expiresAt = Date.parse(credentials?.expiresAt || "") || 0;
    if (credentials?.accessToken && expiresAt - Date.now() > 10_000) {
      return credentials.accessToken;
    }
    const refreshed = await this.refreshCredentials(credentials, log);
    if (!refreshed?.accessToken) {
      throw new CapyApiError("Capy 会话凭证缺失，请重新登录", { code: "missing_credential" });
    }
    credentials.accessToken = refreshed.accessToken;
    if (refreshed.expiresAt) credentials.expiresAt = refreshed.expiresAt;
    if (refreshed.refreshToken && refreshed.refreshToken !== credentials.refreshToken) {
      credentials.refreshToken = refreshed.refreshToken;
    }
    if (onCredentialsRefreshed) await onCredentialsRefreshed(refreshed);
    return refreshed.accessToken;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions, onCredentialsRefreshed }) {
    const orgId = credentials?.providerSpecificData?.orgId;
    if (!orgId) throw new CapyApiError("Capy 连接缺少组织信息，请重新登录", { code: "no_org" });

    const upstreamModel = model || body?.model;
    const convo = flattenMessages(body?.messages);
    if (!convo) throw new CapyApiError("Empty request", { code: "empty_request" });
    const prompt = toolPreamble(body?.tools, body?.tool_choice) + convo;

    let jwt, jamId, messageId;
    try {
      jwt = await this.#sessionJwt(credentials, log, onCredentialsRefreshed);

      // Reuse the persisted jam; create one only if missing.
      jamId = credentials?.providerSpecificData?.jamId;
      if (!jamId) {
        jamId = await this.#ensureJam(jwt, orgId, credentials, log, onCredentialsRefreshed);
      }

      const messageReq = {
        text: prompt,
        modelId: upstreamModel,
        clientKey: `10router-${Date.now()}`,
      };
      let post;
      try {
        post = await capyPostMessage(jwt, orgId, jamId, messageReq, { fetchImpl: this.config?.fetchImpl });
      } catch (e1) {
        // A stale/deleted jam → find or create a fresh one and retry once.
        if (e1 instanceof CapyApiError && (e1.status === 404 || e1.status === 400)) {
          log?.warn?.("CAPY", `jam ${jamId} no longer usable (${e1.status}); acquiring fresh jam`);
          jamId = await this.#ensureJam(jwt, orgId, credentials, log, onCredentialsRefreshed, true);
          post = await capyPostMessage(jwt, orgId, jamId, messageReq, { fetchImpl: this.config?.fetchImpl });
        } else {
          throw e1;
        }
      }
      messageId = post?.id ?? null;
    } catch (e) {
      // Auth failures become a synthetic upstream response so chatCore runs the
      // standard refresh-and-retry path instead of reporting a 502.
      if (e instanceof CapyApiError && (e.status === 401 || e.status === 403)) {
        return {
          response: new Response(JSON.stringify({ error: { message: e.message, type: "authentication_error" } }), {
            status: e.status,
            headers: { "content-type": "application/json" },
          }),
          url: `https://api.capy.ai/app/orgs/${orgId}/jams/${jamId ?? ""}/message`,
          headers: {},
          transformedBody: body,
        };
      }
      throw e;
    }
    log?.debug?.("CAPY", `message ${messageId} sent on jam ${jamId} model ${upstreamModel}`);

    const completionId = `chatcmpl-capy-${jamId.replace(/^jam_/, "")}`;

    const getJwt = () => this.#sessionJwt(credentials, log, onCredentialsRefreshed);
    const withTools = !!toolPreamble(body?.tools, body?.tool_choice);
    const response = stream
      ? this.#streamResponse({ getJwt, orgId, jamId, model: upstreamModel, completionId, signal, log, withTools, startCursor: messageId })
      : await this.#jsonResponse({ getJwt, orgId, jamId, model: upstreamModel, completionId, signal, log, withTools, startCursor: messageId });

    return {
      response,
      url: `https://api.capy.ai/app/orgs/${orgId}/jams/${jamId}/message`,
      headers: {},
      transformedBody: body,
    };
  }

  /**
   * Find an existing idle jam, or create one. The jam is the only Capy
   * execution unit — there is no stateless inference endpoint. Creation may
   * need a connected device on first enrolment; once a jam exists it keeps
   * running even when the device goes offline, so we persist jamId on the
   * connection and reuse it. `forceNew` skips reuse when the current jam is
   * stale.
   */
  async #ensureJam(jwt, orgId, credentials, log, onCredentialsRefreshed, forceNew = false) {
    if (!forceNew && credentials?.providerSpecificData?.jamId) {
      return credentials.providerSpecificData.jamId;
    }

    // Try to reuse an existing idle jam from the org.
    try {
      const jams = await capyJams(jwt, orgId, { fetchImpl: this.config?.fetchImpl });
      const list = Array.isArray(jams) ? jams : jams?.items ?? [];
      const idle = list.find((j) => j?.id && j?.status === "idle" && !j?.archived);
      if (idle?.id) {
        credentials.providerSpecificData.jamId = idle.id;
        log?.debug?.("CAPY", `reusing jam ${idle.id}`);
        return idle.id;
      }
    } catch (e) {
      log?.debug?.("CAPY", `jam list failed: ${e.message}; will try create`);
    }

    // No usable jam → create one. Creation is refused unless the device is
    // actually connected, so bring it online first: with a paired `capyd_`
    // token the executor dials Capy's own device tunnel and serves the machine
    // RPC the agent needs, instead of requiring the desktop app to be running.
    const deviceId = credentials?.providerSpecificData?.deviceId;
    await this.#bringDeviceOnline(jwt, orgId, credentials, log);
    const jamId = `jam_${crypto.randomUUID()}`;
    try {
      const jam = await capyCreateJam(jwt, orgId, {
        jamId,
        requestId: crypto.randomUUID(),
        title: "10router",
        message: "Ready.",
        personal: true,
        ...(deviceId ? { deviceId } : {}),
      }, { fetchImpl: this.config?.fetchImpl });
      const createdId = jam?.id ?? jamId;
      credentials.providerSpecificData.jamId = createdId;
      log?.debug?.("CAPY", `created jam ${createdId}`);
      return createdId;
    } catch (e) {
      throw new CapyApiError(
        `Capy 需要一台已登记设备来创建线程（首次接入请在 Capy 桌面端登录并在线一次），${e.message}`,
        { code: "jam_create_failed", status: e.status ?? 0, upstream: e.upstream },
      );
    }
  }

  /**
   * Make sure this connection's device is registered as connected.
   *
   * A device is only `connected` while something holds its tunnel open, and a
   * jam cannot be created against an offline device. When the connection
   * carries a `capyd_` token we dial the tunnel ourselves and keep it for the
   * lifetime of the connection; without a token there is nothing to dial, so
   * the caller sees Capy's own "device is offline" error.
   *
   * Failures are non-fatal here: the jam create below reports the real reason,
   * and a tunnel hiccup should not mask that.
   */
  async #bringDeviceOnline(jwt, orgId, credentials, log) {
    const deviceId = credentials?.providerSpecificData?.deviceId;
    const token = credentials?.providerSpecificData?.deviceToken;
    if (!deviceId || !token) return;

    const registry = this.#tunnelRegistry();
    const existing = registry.get(orgId, deviceId);
    if (existing?.connected) return;

    const listDevices = () => capyDevices(jwt, orgId, { fetchImpl: this.config?.fetchImpl });
    try {
      await registry.ensure({
        orgId,
        deviceId,
        token,
        hostname: credentials.providerSpecificData.deviceName || "10router-headless",
        listDevices,
      });
      log?.debug?.("CAPY", `device ${deviceId} online`);
    } catch (e) {
      log?.warn?.("CAPY", `device ${deviceId} could not be brought online: ${e?.message || e}`);
    }
  }

  /** Lazily create the process-wide tunnel registry. */
  #tunnelRegistry() {
    if (!this.#tunnels) {
      this.#tunnels = new CapyTunnelRegistry({
        worktreeBase: this.config?.worktreeBase,
        WebSocketImpl: this.config?.WebSocketImpl,
        logger: this.config?.logger,
      });
    }
    return this.#tunnels;
  }

  /**
   * Poll the jam's event pages until the agent's turn ends.
   *
   * GET /jams/:id/events/stream is NOT a live feed: it dumps one page
   * (`page`, `event`*, `end{cursor}`) and closes — the desktop follows a jam
   * by re-listing with `after=<cursor>` on reactivity pings. So we page with
   * after=cursor until a terminal signal: message_user state:"final",
   * a task/thread completion, a failed message, an error event, or idle/timeout.
   * Yields { type: "text"|"raw"|"error"|"usage", ... } records.
   */
  async *#pollJam({ getJwt, orgId, jamId, signal, log, startCursor }) {
    const deadline = Date.now() + CAPY_STREAM_TIMEOUT_MS;
    const seen = new Set();
    let cursor = startCursor;
    let sawText = false;
    let lastNew = Date.now();
    let delay = 700;
    while (Date.now() < deadline) {
      if (signal?.aborted) return;
      const jwt = await getJwt();
      const qs = new URLSearchParams({ limit: "100", ...(cursor ? { after: cursor } : {}) });
      const page = await capyJamEvents(jwt, orgId, `${jamId}`, {
        fetchImpl: this.config?.fetchImpl, pathSuffix: `?${qs}`,
      });
      const items = Array.isArray(page?.items) ? page.items : [];
      if (page?.cursor) cursor = page.cursor;
      let fresh = 0;
      for (const item of items) {
        if (!item?.id || seen.has(item.id)) continue;
        seen.add(item.id); fresh++;
        const kind = item.kind;
        if (kind === CAPY_EVENT_ERROR) { yield { type: "error", text: item.payload?.message || "Capy agent error" }; return; }
        if (kind === CAPY_EVENT_MESSAGE && item.state === "failed") { yield { type: "error", text: "Capy message failed" }; return; }
        if (kind === "task_completion" || kind === "thread_completion") { if (sawText) return; continue; }
        if (kind !== CAPY_EVENT_ASSISTANT) continue;
        if (item.payload?.usage) yield { type: "usage", usage: this.#mapUsage(item.payload.usage) };
        let rawHere = false;
        for (const block of item.payload?.blocks ?? []) {
          if (block?.type === "tool_use" && block.toolName === CAPY_TOOL_MESSAGE_USER) {
            const text = block.args?.text;
            if (typeof text === "string" && text !== "") { sawText = true; yield { type: "text", text }; }
            if (block.args?.state === CAPY_MESSAGE_STATE_FINAL) return;
          } else if (block?.type === "text" && typeof block.text === "string" && block.text) {
            rawHere = true;
            yield { type: "raw", text: block.text };
          }
        }
        // The agent's turn ended without a tool call: nothing more is coming.
        if (item.payload?.stopReason === "end_turn" && (sawText || rawHere)) return;
      }
      if (fresh > 0) { lastNew = Date.now(); delay = 700; } else { delay = Math.min(delay * 1.5, 3000); }
      // Agent delivered text and went quiet: treat as end of turn.
      if (sawText && Date.now() - lastNew > 45_000) return;
      await new Promise((r) => setTimeout(r, delay));
    }
    log?.warn?.("CAPY", `jam ${jamId} timed out waiting for the agent`);
  }

  #streamResponse({ getJwt, orgId, jamId, model, completionId, signal, log, withTools, startCursor }) {
    const encoder = new TextEncoder();
    const out = new ReadableStream({
      start: async (controller) => {
        const write = (chunk) => controller.enqueue(encoder.encode(chunk));
        let usage = null;
        let sawText = false;
        const rawBuf = [];
        const textBuf = [];
        let finish = "stop";
        const keepAlive = setInterval(() => { try { write(": keep-alive\n\n"); } catch { /* closed */ } }, 15_000);
        try {
          write(openaiChunk(model, completionId, { role: "assistant" }));
          for await (const ev of this.#pollJam({ getJwt, orgId, jamId, signal, log, startCursor })) {
            if (ev.type === "usage") usage = ev.usage;
            else if (ev.type === "text") {
              sawText = true;
              if (withTools) textBuf.push(ev.text);
              else write(openaiChunk(model, completionId, { content: ev.text }));
            }
            else if (ev.type === "raw") rawBuf.push(ev.text);
            else if (ev.type === "error") write(openaiChunk(model, completionId, { content: `[capy error] ${ev.text}` }));
          }
          if (withTools) {
            const full = textBuf.join("\n") || rawBuf.join("\n");
            const parsed = parseToolCalls(full);
            if (parsed) {
              if (parsed.rest) write(openaiChunk(model, completionId, { content: parsed.rest }));
              write(openaiChunk(model, completionId, {
                tool_calls: parsed.calls.map((c, index) => ({ index, ...c })),
              }));
              finish = "tool_calls";
            } else if (full) write(openaiChunk(model, completionId, { content: full }));
          } else if (!sawText && rawBuf.length) write(openaiChunk(model, completionId, { content: rawBuf.join("\n") }));
        } catch (e) {
          write(openaiChunk(model, completionId, { content: `[capy error] ${e?.message || e}` }));
        } finally {
          clearInterval(keepAlive);
          try {
            write(openaiChunk(model, completionId, {}, finish, usage));
            write("data: [DONE]\n\n");
            controller.close();
          } catch { /* client gone */ }
          // Jam is reused across requests; no per-request cleanup.
        }
      },
    });
    return new Response(out, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  /** Non-streaming: poll the jam to completion and return one completion JSON. */
  async #jsonResponse({ getJwt, orgId, jamId, model, completionId, signal, log, withTools, startCursor }) {
    const encoder = new TextEncoder();
    const parts = [];
    const raw = [];
    let usage = null;
    let errorText = null;
    try {
      for await (const ev of this.#pollJam({ getJwt, orgId, jamId, signal, log, startCursor })) {
        if (ev.type === "usage") usage = ev.usage;
        else if (ev.type === "text") parts.push(ev.text);
        else if (ev.type === "raw") raw.push(ev.text);
        else if (ev.type === "error") errorText = ev.text;
      }
    } finally {
      // Jam is reused across requests; no per-request cleanup.
    }
    let text = parts.join("\n") || raw.join("\n");
    if (!text && errorText) text = `[capy error] ${errorText}`;
    const completion = {
      id: completionId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [(() => {
        const parsed = withTools ? parseToolCalls(text) : null;
        return parsed
          ? { index: 0, message: { role: "assistant", content: parsed.rest || null, tool_calls: parsed.calls }, finish_reason: "tool_calls" }
          : { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" };
      })()],
      ...(usage ? { usage } : {}),
    };
    return new Response(encoder.encode(JSON.stringify(completion)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  #mapUsage(u) {
    const prompt = (u.inputTokens ?? 0);
    const completion = (u.outputTokens ?? 0);
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      ...(u.cacheReadTokens ? { prompt_tokens_details: { cached_tokens: u.cacheReadTokens } } : {}),
    };
  }

  /** Best-effort jam cleanup so one-shot threads don't pile up in the UI. */
  #cleanupJam(getJwt, orgId, jamId, log) {
    Promise.resolve(typeof getJwt === "function" ? getJwt() : getJwt)
      .then((jwt) => capyDeleteJams(jwt, orgId, [jamId], { fetchImpl: this.config?.fetchImpl }))
      .catch((e) => log?.debug?.("CAPY", `jam ${jamId} cleanup failed: ${e?.message || e}`));
  }
}
