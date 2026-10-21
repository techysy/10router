/**
 * CodeArts (Huawei Cloud CodeArts Agent) chat executor.
 *
 * The upstream speaks OpenAI Chat Completions, but five things are
 * provider-specific and all of them have bitten us in production:
 *
 *   1. **AK/SK + STS signature** over every outgoing header
 *      (`shared/codearts/signing.js`). `maas_type: benefit` participates in the
 *      signature; a benefit model without it answers `InferHub.002002009.404`.
 *   2. **HTTP 200 with an `error_code` envelope** at the head of the SSE stream
 *      (or in a JSON body). Parsed here, before the pipeline, and re-labelled:
 *      quota -> 403, rate limit -> 429, model missing -> 404, rest -> 502.
 *   3. **Concurrency is 3 per account** and the 4th answers HTTP 400
 *      `TM.00001041`. That is a short-cooldown condition, NOT a 429: the account
 *      is healthy, only this instant is busy. See `config/errorConfig.js`.
 *   4. **50 req/s is a whole-pool ceiling** — the token bucket lives in
 *      `shared/codearts/gates.js`, before account selection.
 *   5. **Two size walls** (≈6 MiB inference / ≈12 MiB gateway, measured by our
 *      Rust provider; community repos have no record of either) and a
 *      **65536 output cap** the catalog lies about.
 *
 * Reference: our Rust `codearts/{chat,session,size_gate,signer,dpop}.rs`;
 * MIT `RobbsLuo/Coding2API` was read for shape, not copied.
 */
import { errorResponse } from "../utils/error.js";
import {
  CODEARTS_CHAT_URL,
  CODEARTS_CONCURRENCY_COOLDOWN_MS,
  CODEARTS_GATEWAY_SIZE_CEILING_BYTES,
  CODEARTS_MAX_OUTPUT_TOKENS,
  isCodeArtsBenefitModel,
  resolveCodeArtsModelId,
} from "../config/codearts.js";
import {
  codeArtsFetch,
  codeArtsIdentity,
  codeArtsSizeRejection,
  classifyCodeArtsEnvelope,
  resolveCodeArtsCredential,
} from "../shared/codearts/client.js";
import {
  acquirePoolDispatchSlot,
  acquireSessionSlot,
  holdSizeGate,
  releaseSlotOnResponseEnd,
  sizeGateFloor,
} from "../shared/codearts/gates.js";

const SSE_PEEK_MAX_BYTES = 64 * 1024;

/** Outgoing payload normalisation: clamp only the key the client actually used. */
export function clampCodeArtsOutputTokens(payload) {
  if (!payload || typeof payload !== "object") return payload;
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    const value = payload[key];
    if (Number.isInteger(value) && value > CODEARTS_MAX_OUTPUT_TOKENS) {
      payload[key] = CODEARTS_MAX_OUTPUT_TOKENS;
    }
  }
  return payload;
}

function syntheticError(status, message, headers = {}) {
  return errorResponse(status, message, headers);
}

/** Stable result shape for chatCore's request logger (never includes signed headers). */
function resultOf(response, payload) {
  return {
    response,
    url: CODEARTS_CHAT_URL,
    headers: { "Content-Type": "application/json" },
    transformedBody: payload,
  };
}

async function readLimited(response, limit = SSE_PEEK_MAX_BYTES) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  while (size < limit) {
    const step = await reader.read();
    if (step.done) break;
    const chunk = Buffer.from(step.value);
    chunks.push(chunk);
    size += chunk.length;
    text += decoder.decode(step.value, { stream: true });
    if (text.includes("\n\n") || text.includes("\r\n\r\n")) break;
  }
  text += decoder.decode();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const step = await reader.read();
      if (step.done) controller.close();
      else controller.enqueue(step.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return { response: new Response(stream, { status: response.status, statusText: response.statusText, headers }), text };
}

/** Pull the first JSON object out of an SSE head; ignores `data: [DONE]`. */
export function firstCodeArtsFrame(text) {
  const raw = String(text || "");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      return JSON.parse(data);
    } catch {
      continue;
    }
  }
  const whole = raw.trim();
  if (whole.startsWith("{")) {
    try {
      return JSON.parse(whole);
    } catch {
      return null;
    }
  }
  return null;
}

export class CodeArtsExecutor {
  constructor() {
    this.provider = "codearts";
    this.config = {};
    this.noAuth = false;
  }

  getFallbackCount() {
    return 1;
  }

  transformRequest(model, body) {
    const payload = body && typeof body === "object" ? JSON.parse(JSON.stringify(body)) : body;
    if (!payload || typeof payload !== "object") return payload;
    payload.model = resolveCodeArtsModelId(payload.model || model);
    clampCodeArtsOutputTokens(payload);
    return payload;
  }

  buildHeaders(credentials) {
    const credential = resolveCodeArtsCredential(credentials);
    if (!credential) return {};
    // Signing needs the exact body; the real path signs inside execute().
    return {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    };
  }

  /**
   * Non-2xx classification. 00001041 must stay HTTP 400 (short cooldown) and
   * never become 429 — a 429 would cool the account for minutes over a
   * one-second scheduling collision.
   */
  parseError(response, bodyText) {
    const text = String(bodyText || "");
    if (codeArtsSizeRejection(response.status, text, 0) || text.includes("PARSE_REQUEST_DATA_EXCEPTION")) {
      return { status: 413, message: `CodeArts 请求体超过上游体积墙：${text.slice(0, 300)}` };
    }
    if (text.includes("00001041")) {
      return { status: 400, message: `CodeArts 上游并发超限（TM.00001041）：${text.slice(0, 200)}` };
    }
    if (text.toLowerCase().includes("benefit not found") || text.includes("4004.200")) {
      return {
        status: 403,
        message: "CodeArts 账号还没有福利档案（InferHub.4004.200），先领取一次福利或运行官方客户端完成注册",
      };
    }
    return { status: response.status, message: text || `HTTP ${response.status}` };
  }

  async execute({ model, body, stream = false, credentials, signal, log, proxyOptions = null }) {
    const credential = resolveCodeArtsCredential(credentials);
    if (!credential) {
      return {
        response: syntheticError(
          400,
          "CodeArts 凭据不完整：需要 accessKeyId / secretAccessKey（OAuth 登录或手动 AK/SK 导入）"
        ),
      };
    }

    const payload = this.transformRequest(model, body);
    payload.model = resolveCodeArtsModelId(payload.model || model);
    const bodyText = JSON.stringify(payload);
    const wireBytes = Buffer.byteLength(bodyText, "utf8");
    const benefit = isCodeArtsBenefitModel(payload.model);

    // ── size walls (local) ────────────────────────────────────────────
    if (wireBytes >= CODEARTS_GATEWAY_SIZE_CEILING_BYTES) {
      return resultOf(
        syntheticError(
          413,
          `CodeArts 请求体 ${wireBytes} 字节，超过 API 网关 ≈12 MiB 墙（我们实测，社区无记录）`
        ),
        payload
      );
    }
    const floor = sizeGateFloor();
    if (floor !== null && wireBytes >= floor) {
      return resultOf(
        syntheticError(
          503,
          `CodeArts 本次请求 ${wireBytes} 字节，已超过近期实测的 ${floor} 字节上界，本轮绕开该渠道`
        ),
        payload
      );
    }

    // ── 3 sessions per account ────────────────────────────────────────
    let session;
    try {
      session = acquireSessionSlot(codeArtsIdentity(credential), credentials?.maxConcurrent);
    } catch (error) {
      log?.warn?.("CODEARTS", error.message);
      return resultOf(
        syntheticError(400, error.message, { "Retry-After": String(CODEARTS_CONCURRENCY_COOLDOWN_MS / 1000) }),
        payload
      );
    }

    // ── whole-pool 50 req/s ───────────────────────────────────────────
    await acquirePoolDispatchSlot();

    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      // Functional header: also part of the signature. Missing on a benefit
      // model -> 404 InferHub.002002009.404.
      ...(benefit ? { maas_type: "benefit" } : {}),
    };

    let response;
    try {
      response = await codeArtsFetch(CODEARTS_CHAT_URL, {
        method: "POST",
        body: bodyText,
        headers,
        credential,
        proxyOptions,
        signal,
      });
    } catch (error) {
      session.release();
      throw error;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (codeArtsSizeRejection(response.status, text, wireBytes)) {
        holdSizeGate(wireBytes);
        log?.warn?.("CODEARTS", `体积墙命中：${wireBytes} 字节；记入门内 2 分钟`);
      }
      session.release();
      return resultOf(new Response(text, { status: response.status, headers: response.headers }), payload);
    }

    // ── HTTP 200 can still be a failure ───────────────────────────────
    const contentType = (response.headers?.get?.("content-type") || "").toLowerCase();
    let guarded = response;
    let head = "";
    if (contentType.includes("text/event-stream")) {
      const peeked = await readLimited(response);
      guarded = peeked.response;
      head = peeked.text;
    } else if (contentType.includes("application/json")) {
      const text = await response.text();
      const headersOut = new Headers(response.headers);
      headersOut.delete("content-length");
      guarded = new Response(text, { status: 200, statusText: response.statusText, headers: headersOut });
      head = text;
    } else {
      // HTML / unknown: let chatCore's non-SSE guard report it.
      return resultOf(releaseSlotOnResponseEnd(response, session.release), payload);
    }

    const frame = firstCodeArtsFrame(head);
    const envelope = classifyCodeArtsEnvelope(frame);
    if (envelope) {
      session.release();
      if (codeArtsSizeRejection(envelope.status, JSON.stringify(frame), wireBytes)) {
        holdSizeGate(wireBytes);
      }
      return resultOf(syntheticError(envelope.status, envelope.message), payload);
    }

    return resultOf(releaseSlotOnResponseEnd(guarded, session.release), payload);
  }

  /**
   * 401/403 retry hook. Refresh tokens are one-time-use, so this goes through
   * the single-flight helper; chatCore persists the returned bundle before the
   * retry (persist-first, then sync).
   */
  async refreshCredentials(credentials, log, proxyOptions = null) {
    const { refreshCodeArtsCredential } = await import("../shared/codearts/oauth.js");
    try {
      return await refreshCodeArtsCredential(credentials, { proxyOptions });
    } catch (error) {
      log?.warn?.("TOKEN", `CodeArts refresh failed: ${error?.message || error}`);
      return null;
    }
  }
}

export default CodeArtsExecutor;
