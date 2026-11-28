import { handleChat } from "@/sse/handlers/chat.js";
import { extractApiKey } from "@/sse/services/auth.js";
import { getResponseSnapshot, saveResponseSnapshot } from "@/lib/db/repos/responsesStoreRepo.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;
const JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
// Bounds the SSE tee that looks for response.completed. A stream larger than
// this is still delivered to the client in full; it simply is not stored.
const MAX_CAPTURED_SSE_BYTES = 8 * 1024 * 1024;
const NON_STORED_TERMINAL_EVENTS = new Set(["response.failed", "response.incomplete", "response.cancelled", "error"]);

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

function cloneItems(items) {
  return Array.isArray(items) ? structuredClone(items) : [];
}

// Replay detection compares what an item MEANS, not its bytes.
//
// The items we store come from `response.output` and carry server-generated
// fields (`id: "fc_…"`, `status`, `sequence_number`, indexes, reasoning
// `encrypted_content`) that a replaying client either drops or spells
// differently. A byte-for-byte compare would therefore miss the replay and
// re-send the whole stored history in front of it — doubling the prompt on every
// turn of a long agent session, which is worse than the bug this fixes.
//
// Whitelist (not blacklist): identity is kind + role + which tool call it is +
// the text/arguments themselves. Anything else is decoration.
function itemText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const ref = part?.image_url?.url || (typeof part?.image_url === "string" ? part.image_url : "") || part?.file_id || "";
        return `${part?.type || ""}:${part?.text ?? ""}${ref ? `[${ref}]` : ""}`;
      })
      .join("|");
  }
  return content == null ? "" : JSON.stringify(content);
}

function itemSignature(item) {
  if (typeof item === "string") return `str|${item}`;
  if (!item || typeof item !== "object") return `raw|${JSON.stringify(item) ?? "undefined"}`;
  const type = item.type || (item.role ? "message" : "unknown");
  // Freeform tool input, then a tool call's arguments, then a tool result, then
  // message content; a reasoning item has none of those and carries its text in
  // summary[], so it is consulted last.
  const payload = [item.input, item.arguments, item.output, item.content, item.summary]
    .find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
  // An item carrying no text at all (Codex's `additional_tools` declaration
  // block) is distinguished by what it declares — otherwise two different tool
  // sets compare equal and a fresh turn gets mistaken for a replay.
  const text = payload === undefined ? JSON.stringify(item.tools ?? null) : itemText(payload);
  return [type, item.role || "", item.call_id || "", item.name || "", text].join("|");
}

function isPrefixOf(short, long) {
  if (short.length > long.length) return false;
  const shortSigs = short.map(itemSignature);
  const longSigs = long.map(itemSignature);
  return shortSigs.every((sig, index) => sig === longSigs[index]);
}

// Responses input is also allowed to be a bare string.
function toInputItems(input) {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input.trim() === "" ? "..." : input }] }];
  }
  return cloneItems(input);
}

function mergeUniqueTools(...groups) {
  const byName = new Map();
  for (const group of groups) {
    for (const tool of Array.isArray(group) ? group : []) {
      const name = tool?.name || tool?.function?.name;
      if (typeof name === "string" && name) byName.set(name, structuredClone(tool));
    }
  }
  return [...byName.values()];
}

/**
 * Splice stored history into a continuation request without ever duplicating it.
 *
 * Clients differ here: the spec says only the NEW items accompany
 * previous_response_id, but plenty of clients replay the whole transcript anyway.
 * Prefixing stored history onto a replay would double every turn, so the test is
 * whether the stored history is exactly the leading items of what the client sent:
 *   - yes → the client replayed (with or without new items); its own array wins
 *   - no  → the client sent only the new turn → history first, then the new items
 *
 * There is deliberately no "client input is a prefix of history" branch: a new
 * turn can legitimately repeat an earlier message, and matching it against the
 * start of the history would drop that turn.
 *
 * The result is the exact conversation handed upstream, which is also exactly what
 * gets stored once this turn completes — one array, no reconciliation afterwards.
 */
function resolveContinuationInput(bodyInput, snapshot) {
  const sent = toInputItems(bodyInput);
  const prior = cloneItems(snapshot?.history);
  if (!prior.length) return sent;
  return isPrefixOf(prior, sent) ? sent : [...prior, ...sent];
}

function buildContinuationBody(body, snapshot) {
  return {
    ...body,
    input: resolveContinuationInput(body.input, snapshot),
    tools: mergeUniqueTools(snapshot.tools, body.tools),
    ...(typeof body.instructions === "string" && body.instructions
      ? {}
      : typeof snapshot.instructions === "string" && snapshot.instructions
        ? { instructions: snapshot.instructions }
        : {}),
    ...(body.prompt_cache_key ? {} : snapshot.prompt_cache_key ? { prompt_cache_key: snapshot.prompt_cache_key } : {}),
  };
}

function responseError(status, message, type, code) {
  return Response.json({ type: "error", error: { message, type, code } }, { status, headers: JSON_HEADERS });
}

/**
 * Rebuild the inbound request with a rewritten body.
 *
 * The copied headers must NOT carry the client's `content-length`: a continuation
 * body is larger than what was sent, and a stale length truncates the upstream
 * request to the original byte count — the turn would then look like a malformed
 * or empty prompt. `transfer-encoding` goes for the same reason. Everything else
 * (auth, user-agent, accept) is preserved so downstream client detection, quota
 * and account routing see exactly what the client sent.
 */
function requestWithBody(request, bodyJson) {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  // The abort signal is forwarded as-is, so a client that disconnects mid-turn
  // still stops the upstream stream instead of paying for a response nobody reads.
  return new Request(request.url, {
    method: request.method,
    headers,
    body: bodyJson,
    signal: request.signal,
  });
}

function extractCompleted(response) {
  if (response?.status !== "completed" || typeof response?.id !== "string") return null;
  return { id: response.id, output: cloneItems(response.output) };
}

function readEventBlock(block) {
  let event = null;
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    const value = JSON.parse(data.join("\n"));
    return { event: event || value.type, value };
  } catch {
    // A frame we cannot parse is not a terminal frame; ignore it and keep piping.
    return null;
  }
}

/**
 * Tee the SSE stream to learn the response id + output, forwarding bytes to the
 * client untouched and unbuffered. Storage happens only after a
 * response.completed actually arrived; a failed/incomplete/cancelled turn, a
 * stream that dies early, or one over the capture cap stores nothing.
 */
function captureCompletedSse(response, onCompleted) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  let capturedBytes = 0;
  let capturing = true;

  const inspect = (block) => {
    if (!capturing || !block.trim()) return;
    capturedBytes += block.length;
    if (capturedBytes > MAX_CAPTURED_SSE_BYTES) {
      capturing = false;
      completed = null;
      return;
    }
    const parsed = readEventBlock(block);
    if (!parsed) return;
    if (parsed.event === "response.completed") completed = extractCompleted(parsed.value.response);
    else if (NON_STORED_TERMINAL_EVENTS.has(parsed.event)) {
      capturing = false;
      completed = null;
    }
  };

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer) inspect(buffer);
          // Persist BEFORE reporting the stream complete: a caller that turns
          // around and sends the next turn must find the row it just earned.
          if (completed) await onCompleted(completed);
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) inspect(block);
        controller.enqueue(value);
      } catch (error) {
        capturing = false;
        completed = null;
        controller.error(error);
        try { await reader.cancel(error); } catch { /* already errored */ }
      }
    },
    async cancel(reason) {
      capturing = false;
      completed = null;
      await reader.cancel(reason);
    },
  });

  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function readCompletedJson(response) {
  try {
    return extractCompleted(await response.clone().json());
  } catch {
    return null;
  }
}

/** POST /v1/responses — Chat gateway with caller-scoped Responses continuation. */
export async function POST(request) {
  await ensureInitialized();
  let body;
  try {
    body = await request.json();
  } catch {
    return responseError(400, "Invalid JSON body", "invalid_request_error", "invalid_json");
  }

  const apiKey = extractApiKey(request);
  // store:false means "do not persist THIS response" — it does not invalidate a
  // previous_response_id, so resolution stays independent of the save decision.
  const saveEnabled = body.store !== false;
  let snapshot = null;

  if (body.previous_response_id != null) {
    if (typeof body.previous_response_id !== "string" || !body.previous_response_id) {
      return responseError(400, "previous_response_id must be a non-empty string", "invalid_request_error", "invalid_previous_response_id");
    }
    try {
      snapshot = await getResponseSnapshot(body.previous_response_id, apiKey);
    } catch (error) {
      console.error("[Responses store] Failed to load previous response:", error?.message || error);
      return responseError(500, "Unable to load previous response", "server_error", "response_store_error");
    }
    if (!snapshot) {
      // Refuse rather than start a fresh conversation: an agent loop that silently
      // loses its history answers as if it had never been asked, which reads to the
      // user as the tool turn being interrupted (#184).
      return responseError(400, "Response not found or access denied", "invalid_request_error", "response_not_found");
    }
    body = buildContinuationBody(body, snapshot);
    // Consumed. The history now rides in `input`; forwarding our own id would
    // hand a native Responses upstream an id it never issued (OpenAI answers
    // that with 404), which is how a continuation would break for providers we
    // proxy in their own format.
    delete body.previous_response_id;
  }

  // Always rebuilt: `request.json()` above consumed the body, so handing the
  // original Request to handleChat would make its own read throw
  // "Body is unusable: Body has already been read".
  const upstream = await handleChat(requestWithBody(request, JSON.stringify(body)));
  if (!saveEnabled || !upstream?.ok) return upstream;

  // The conversation as handed upstream, plus this turn's output, is the snapshot.
  const conversation = toInputItems(body.input);
  const tools = cloneItems(body.tools);
  const instructions = typeof body.instructions === "string" ? body.instructions : "";
  const promptCacheKey = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : "";
  const persist = async ({ id, output }) => {
    // No input items means this was not a well-formed Responses call (a Chat-style
    // body posted here). Storing an output with no conversation would hand a later
    // continuation a history it cannot reason over.
    if (!id || !conversation.length) return;
    try {
      await saveResponseSnapshot(id, apiKey, { history: [...conversation, ...output], tools, instructions, prompt_cache_key: promptCacheKey });
    } catch (error) {
      // Persistence is an optimization: losing it must not change the response.
      console.warn("[Responses store] Failed to save response snapshot:", error?.message || error);
    }
  };

  if ((upstream.headers.get("content-type") || "").includes("text/event-stream")) {
    return captureCompletedSse(upstream, persist);
  }
  const completed = await readCompletedJson(upstream);
  // Awaited for the same reason as the SSE path: the row has to exist before
  // this response is handed back, or the caller's very next turn misses it.
  if (completed) await persist(completed);
  return upstream;
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
