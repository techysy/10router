import { randomUUID } from "node:crypto";
import { ORCATERM_CONFIG, ORCATERM_MODELS } from "../../config/orcaterm.js";
import { ROLE } from "../../translator/schema/roles.js";
import { OPENAI_BLOCK } from "../../translator/schema/blocks.js";
import { OrcaTermError, readOrcaTermClaims } from "./auth.js";

const IMAGE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const pendingTools = new Map();

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n");
}

function imageFiles(messages, model) {
  const files = [];
  let bytes = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== OPENAI_BLOCK.IMAGE_URL) continue;
      if (!model.vision) throw new OrcaTermError("This OrcaTerm model does not support images", 400);
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      const match = typeof url === "string" && /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
      if (!match || !IMAGE_EXTENSIONS[match[1]]) {
        throw new OrcaTermError("OrcaTerm images must be base64 PNG, JPEG, WebP or GIF data URLs", 400);
      }
      const buffer = Buffer.from(match[2], "base64");
      bytes += buffer.length;
      if (
        !buffer.length || buffer.length > ORCATERM_CONFIG.maxImageBytes ||
        bytes > ORCATERM_CONFIG.maxTotalImageBytes || files.length >= ORCATERM_CONFIG.maxImages
      ) {
        throw new OrcaTermError("OrcaTerm image limit exceeded (4 images, 10 MB each, 20 MB total)", 400);
      }
      files.push({
        name: `image-${files.length + 1}.${IMAGE_EXTENSIONS[match[1]]}`,
        mimeType: match[1],
        bytes: buffer.toString("base64"),
        details: { acp: { type: "image", mimeType: match[1] } },
      });
    }
  }
  return files;
}

function toolDefinitions(body) {
  if (body.tool_choice === "none") return [];
  return (Array.isArray(body.tools) ? body.tools : []).map((tool) => tool?.function || tool).filter(
    (tool) => typeof tool?.name === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name),
  );
}

export function buildOrcaTermRequest(modelId, body, credentials) {
  const model = ORCATERM_MODELS.find((entry) => entry.id === modelId);
  if (!model) throw new OrcaTermError("Unknown OrcaTerm model", 400);
  const claims = readOrcaTermClaims(credentials.accessToken);
  const userId = String(claims.userId ?? credentials.providerSpecificData?.userId ?? "");
  if (!userId) throw new OrcaTermError("OrcaTerm account identity is missing; sign in again", 401);
  const account = `${userId}:${credentials.connectionId || credentials.id || ""}`;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) throw new OrcaTermError("messages must not be empty", 400);
  const tools = toolDefinitions(body);
  const system = [];
  const transcript = [];
  for (const message of messages) {
    const text = textOf(message.content);
    if (message.role === ROLE.SYSTEM || message.role === ROLE.DEVELOPER) {
      if (text) system.push(text);
      continue;
    }
    const calls = message.tool_calls?.length ? `\nTool calls: ${JSON.stringify(message.tool_calls)}` : "";
    transcript.push(`${message.role}${message.tool_call_id ? ` (${message.tool_call_id})` : ""}:\n${text}${calls}`);
  }
  if (tools.length) {
    system.push([
      "Only use the following client tools. Never use OrcaTerm's built-in tools.",
      JSON.stringify(tools),
      "To call a tool, return exactly one JSON object, with no Markdown or explanation:",
      JSON.stringify({
        action: "review", ph_1: "--",
        tool: { type: "ui", uiServer: ORCATERM_CONFIG.toolNamespace, name: "<tool name>", description: "<brief purpose>", args: {} },
      }),
      "Call only one listed tool at a time, use its declared argument schema, then stop.",
      "The client executes the tool. After receiving its result, continue the task without repeating the call.",
      "When no tool is needed, answer normally.",
      body.tool_choice === "required" ? "You must call one of these tools in this turn." : "",
      body.tool_choice?.function?.name ? `Use the tool named ${body.tool_choice.function.name} in this turn.` : "",
    ].filter(Boolean).join("\n"));
  } else {
    system.push("Do not call any tools. Return an answer to the user.");
  }
  const conversationId = `cid-${randomUUID()}`;
  const input = {
    id: randomUUID(),
    type: "start",
    input: JSON.stringify({ _format: "acp-prompt", version: 1, prompt: [{ type: OPENAI_BLOCK.TEXT, text: transcript.join("\n\n") }] }),
    emphasisPrompt: system.join("\n\n"),
    files: imageFiles(messages, model),
  };
  const now = Date.now();
  for (const [key, pending] of pendingTools) {
    if (pending.expiresAt <= now) pendingTools.delete(key);
  }
  let resumedConversationId = null;
  const last = messages.at(-1);
  if (last?.role === ROLE.TOOL && last.tool_call_id) {
    const key = `${account}:${last.tool_call_id}`;
    const pending = pendingTools.get(key);
    if (pending?.modelId === modelId) {
      // reportToolResult is not idempotent. Consume once; retries can rebuild from the transcript.
      pendingTools.delete(key);
      resumedConversationId = pending.conversationId;
      Object.assign(input, {
        type: "review", reviewAction: "reportToolResult", toolResult: textOf(last.content),
        tool: pending.tool, files: [],
      });
      delete input.input;
    }
  }
  const maxTokens = Number(body.max_completion_tokens ?? body.max_tokens);
  const payload = {
    conversationId: resumedConversationId || conversationId,
    user: {
      id: userId,
      setting: {
        mcpServers: [], uiServers: [], tools: [], approvedTools: [], approvedMCPTools: [],
        enableAutoSubtaskExecution: false, env: [], model: modelId,
        modelDesc: { kwargs: {
          max_tokens: Number.isFinite(maxTokens) && maxTokens > 0
            ? Math.min(Math.floor(maxTokens), ORCATERM_CONFIG.maxOutputTokens) : ORCATERM_CONFIG.maxOutputTokens,
          reasoning_effort: ["low", "medium", "high"].includes(body.reasoning_effort) ? body.reasoning_effort : "high",
        } },
        extra: {}, selectedMCPTools: {}, selectedUITools: {}, a2a: {},
        hideToolMessage: true, language: "zh", multimodal: true, enableThinking: false,
      },
    },
    input,
    stream: true,
  };
  return {
    payload,
    tools,
    rememberTool(callId, tool) {
      while (pendingTools.size >= ORCATERM_CONFIG.maxPendingTools) pendingTools.delete(pendingTools.keys().next().value);
      pendingTools.set(`${account}:${callId}`, {
        tool, modelId, conversationId: payload.conversationId, expiresAt: Date.now() + ORCATERM_CONFIG.pendingToolTtlMs,
      });
    },
  };
}

function partialString(source, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(source);
  if (!match) return "";
  let text = "";
  for (let i = match.index + match[0].length; i < source.length; i++) {
    const character = source[i];
    if (character === '"') break;
    if (character !== "\\") { text += character; continue; }
    if (++i >= source.length) break;
    if (source[i] === "u") {
      const digits = source.slice(i + 1, i + 5);
      if (!/^[a-fA-F0-9]{4}$/.test(digits)) break;
      text += String.fromCharCode(parseInt(digits, 16));
      i += 4;
    } else {
      const escapes = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (!(source[i] in escapes)) throw new OrcaTermError("Malformed OrcaTerm answer");
      text += escapes[source[i]];
    }
  }
  // Do not encode a split UTF-16 surrogate as a replacement character in SSE.
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}

export class OrcaTermReply {
  constructor(context) {
    this.context = context;
    this.raw = "";
    this.emitted = "";
    this.plain = false;
  }

  feed(piece) {
    this.raw += piece;
    if (this.raw.length > ORCATERM_CONFIG.maxResponseChars) throw new OrcaTermError("OrcaTerm response is too large");
    const start = this.raw.trimStart();
    if (start && start[0] !== "{" && start[0] !== "`") this.plain = true;
    let text = this.plain ? this.raw : "";
    const action = /^\s*(?:```(?:json)?\s*)?\{\s*"action"\s*:\s*"(completion|ask)"/.exec(this.raw);
    if (action) {
      text = partialString(this.raw, action[1] === "ask" ? "question" : "taskCompletion");
    }
    const delta = text.slice(this.emitted.length);
    this.emitted = text;
    return delta ? { content: delta } : null;
  }

  finish() {
    const raw = this.raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    let envelope;
    try { envelope = JSON.parse(raw); } catch {
      if (/^\{\s*"action"\s*:/.test(raw)) throw new OrcaTermError("Incomplete OrcaTerm response envelope");
    }
    if (envelope?.action === "review") {
      const tool = envelope.tool;
      const definition = this.context.tools.find((entry) => entry.name === tool?.name);
      if (!definition || tool.type !== "ui" || tool.uiServer !== ORCATERM_CONFIG.toolNamespace) {
        throw new OrcaTermError("OrcaTerm requested an undeclared tool");
      }
      const args = tool.args ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new OrcaTermError("Invalid OrcaTerm tool arguments");
      const id = `call_${randomUUID().replaceAll("-", "")}`;
      this.context.rememberTool(id, tool);
      return {
        delta: { tool_calls: [{ index: 0, id, type: OPENAI_BLOCK.FUNCTION, function: { name: tool.name, arguments: JSON.stringify(args) } }] },
        finishReason: "tool_calls",
      };
    }
    const text = envelope?.action === "completion" && typeof envelope.taskCompletion === "string"
      ? envelope.taskCompletion
      : envelope?.action === "ask" && typeof envelope.question === "string" ? envelope.question : this.raw;
    const tail = text.slice(this.emitted.length);
    return { delta: tail ? { content: tail } : null, finishReason: "stop" };
  }
}

export function orcaStreamError(message, code) {
  const status = code === 429 || /rate.?limit|chat-rpm|too many requests/i.test(message) ? 429
    : code === 401 || code === 403 || /invalid.?token|unauthor|token.*expired|NEED_UIN_AND_SKEY/i.test(message) ? 401
      : /context_length_exceeded|too many tokens|prompt is too long/i.test(message) ? 413 : 502;
  return new OrcaTermError(String(message).slice(0, 500), status);
}

export async function* readOrcaTermEvents(response, signal) {
  if (!response.body) throw new OrcaTermError("OrcaTerm returned no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  let buffer = "";
  function parse(block) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return null;
    if (data.trim() === "[DONE]") return { done: true };
    if (/^\[ERROR\]/i.test(data)) throw orcaStreamError(data);
    let value;
    try { value = JSON.parse(data); } catch { throw new OrcaTermError("Malformed OrcaTerm SSE event"); }
    const event = value?.data && typeof value.data === "object" ? { ...value.data, ...value } : value;
    if (event?.code != null && String(event.code) !== "0") {
      throw orcaStreamError(event.message || "OrcaTerm rejected the request", Number(event.code));
    }
    if (event?.error || event?.type === "error") {
      throw orcaStreamError(event.error?.message || event.message || "OrcaTerm stream failed");
    }
    return event;
  }
  try {
    if (signal?.aborted) throw signal.reason;
    while (true) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > ORCATERM_CONFIG.maxResponseChars) throw new OrcaTermError("OrcaTerm SSE event is too large");
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop();
      if (done && buffer) { blocks.push(buffer); buffer = ""; }
      for (const block of blocks) {
        const event = parse(block);
        if (event?.done) return;
        if (event) yield event;
      }
      if (done) return;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
