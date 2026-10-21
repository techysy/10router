/**
 * LobsterAIExecutor — talks to https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions
 *
 * The upstream speaks OpenAI Chat Completions, but:
 *   1. **SSE only** — `stream:false` answers HTTP 500. This executor always sets
 *      `stream:true`; non-streaming clients are re-aggregated by chatCore's
 *      forced-SSE-to-JSON path (registry `transport.forceStream`).
 *   2. **Two functional `X-LobsterAI-Client-*` headers** — the capabilities head
 *      is the catalog gate (without it `kimi-k3` is missing), the version head
 *      makes the request look like a real desktop build (a missing/blank version
 *      is answered with HTTP 500). The version is resolved asynchronously from
 *      the overmind update API, cached for 1h, with a known-good constant as the
 *      sync fallback — the header is never sent blank.
 *   3. **HTTP 200 can be a failure** — quota exhaustion arrives as an
 *      `event:error` SSE frame at the head of a 200 stream (business code 40201).
 *      We peek the head before handing the stream to the pipeline: a matched
 *      marker is re-labelled 402/401; an unmatched error frame becomes 400
 *      (request-side, so a healthy account is never cooled down).
 *
 * Reference behavior (read, re-implemented): MIT lobsterai2api
 * (`internal/upstream/{client,classify,sse}.go`) and our Rust provider
 * (`lobsterai/{chat,errors,version}.rs`).
 */
import { DefaultExecutor } from "./default.js";
import {
  LOBSTERAI_CLIENT_CAPABILITIES,
  LOBSTERAI_SSE_PEEK_MAX_BYTES,
  LOBSTERAI_USER_AGENT,
} from "../shared/lobsterai/constants.js";
import {
  classifyFailure,
  clientVersionSnapshot,
  messageOf,
  parseSseErrorFrame,
  resolveClientVersion,
  statusForFailure,
} from "../shared/lobsterai/client.js";

/** Upstream rejects OpenAI's newer role with HTTP 502「角色信息不正确」 */
const DEVELOPER_ROLE = "developer";
const DEMOTED_ROLE = "system";

function demoteDeveloperMessages(body) {
  if (!Array.isArray(body?.messages)) return;
  for (const message of body.messages) {
    if (message && typeof message === "object" && message.role === DEVELOPER_ROLE) {
      message.role = DEMOTED_ROLE;
    }
  }
}

function toolChoiceMustGo(value) {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && (!value.trim() || value.trim().toLowerCase() === "none");
}

/** 从非 2xx 正文里取一行可读文案（JSON 优先，退原文） */
function readableError(bodyText) {
  const raw = String(bodyText || "").trim();
  if (!raw) return "上游错误";
  try {
    const parsed = JSON.parse(raw);
    const message = messageOf(parsed);
    if (message) return message;
  } catch {
    // 非 JSON：原文就是文案
  }
  return raw.slice(0, 500);
}

/** 把 200 流内错误帧 / 非 2xx 分类结果拼成客户端可读文案 */
function failureMessage(kind, detail) {
  const suffix = detail ? `：${detail}` : "";
  switch (kind) {
    case "hard-credit":
      return `LobsterAI 积分不足${suffix}`;
    case "session-dead":
      return `LobsterAI 登录态已失效${suffix}，请重新登录`;
    case "rate-limit":
      return `LobsterAI 请求过于频繁${suffix}`;
    default:
      return `LobsterAI 上游错误${suffix}`;
  }
}

function syntheticErrorResponse(kind, detail, code) {
  const status = statusForFailure(kind);
  const body = {
    error: {
      message: failureMessage(kind, detail),
      type: status >= 500 ? "api_error" : "invalid_request_error",
      ...(code !== undefined ? { code } : {}),
    },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 读取 SSE 流首块并原样回放。
 *
 * 参考实现（Go）用 `bufio.Reader.Peek` 做到「窥探不消费」；Web Streams 没有
 * peek，所以这里先读若干 chunk、拼出流首文本，再把已读字节和剩余流拼回一个
 * 新的 ReadableStream —— 下游仍从第一个字节开始读。
 */
export async function peekSseHead(response, maxBytes = LOBSTERAI_SSE_PEEK_MAX_BYTES) {
  if (!response?.body) return { response, text: "" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let text = "";
  let done = false;

  while (!done && text.length < maxBytes) {
    const step = await reader.read();
    if (step.done) {
      done = true;
      break;
    }
    if (step.value) {
      chunks.push(step.value);
      text += decoder.decode(step.value, { stream: true });
    }
    // 一个完整 SSE event 以空行结束；错误帧总在流首，拿到首帧即可判定。
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
  return {
    response: new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    text,
  };
}

/** 200 JSON 响应也要判假成功（上游偶发忽略 stream 选项时走这里） */
async function peekJsonBody(response) {
  const text = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return {
    response: new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    text,
  };
}

/**
 * 200 假成功闸门：返回替换后的 response（命中错误帧）或可安全回放的 response。
 */
export async function guardFakeSuccess(result) {
  const response = result?.response;
  if (!response || response.status !== 200) return result;

  const contentType = (response.headers?.get?.("content-type") || "").toLowerCase();
  let peeked;
  if (contentType.includes("text/event-stream")) {
    peeked = await peekSseHead(response);
  } else if (contentType.includes("application/json")) {
    peeked = await peekJsonBody(response);
  } else {
    return result;
  }

  const failure = parseSseErrorFrame(peeked.text);
  if (!failure) return { ...result, response: peeked.response };

  return {
    ...result,
    response: syntheticErrorResponse(failure.kind, failure.message, failure.code),
  };
}

export class LobsterAiExecutor extends DefaultExecutor {
  constructor() {
    super("lobsterai");
  }

  /**
   * 四项上游强制的改写（每一处都实测过，见模块头）：
   *   developer → system、tool_choice 的空/none 形态删除、
   *   绝不下发 prompt_cache_key、`stream` 恒 true。
   */
  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    if (!transformed || typeof transformed !== "object") return transformed;

    demoteDeveloperMessages(transformed);
    if (toolChoiceMustGo(transformed.tool_choice)) delete transformed.tool_choice;
    delete transformed.prompt_cache_key;
    // 上游只收 SSE：无论客户端要不要流式，出站一律 stream:true。
    transformed.stream = true;
    return transformed;
  }

  buildHeaders(credentials, stream = true, url, model, transformedBody) {
    const headers = super.buildHeaders(credentials, stream, url, model, transformedBody);
    headers["Content-Type"] = "application/json";
    headers.Accept = "text/event-stream, application/json";
    headers["User-Agent"] = LOBSTERAI_USER_AGENT;
    headers["X-LobsterAI-Client-Capabilities"] = LOBSTERAI_CLIENT_CAPABILITIES;
    // 同步快照：解析过就用真版本，否则用已知可用的兜底常量 —— 绝不发空头。
    headers["X-LobsterAI-Client-Version"] = clientVersionSnapshot();
    return headers;
  }

  async execute(args) {
    // 异步预热版本（不阻塞首个请求：快照已有兜底常量）。
    resolveClientVersion().catch(() => {});
    const result = await super.execute(args);
    return guardFakeSuccess(result);
  }

  /** 401 后的刷新：续期会轮换 refresh token，调用方负责落库（chatCore 的 onCredentialsRefreshed）。 */
  async refreshCredentials(credentials, log, proxyOptions = null) {
    const { refreshLobsterAiToken } = await import("../services/tokenRefresh/providers.js");
    try {
      return await refreshLobsterAiToken(credentials, log, proxyOptions);
    } catch (error) {
      log?.warn?.("TOKEN", `LobsterAI refresh failed: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * 非 2xx 分类：402 / 中文「积分不足」→ 402；40100 / 40101 → 401；其余交给
   * 默认解析。状态覆盖会让账号池按正确语义换号 / 判死会话。
   */
  parseError(response, bodyText) {
    const kind = classifyFailure(response.status, bodyText);
    if (kind === "hard-credit" || kind === "session-dead") {
      return {
        status: statusForFailure(kind),
        message: failureMessage(kind, readableError(bodyText)),
      };
    }
    return super.parseError(response, bodyText);
  }
}

export default LobsterAiExecutor;

/** 单测入口（稳定导出；生产代码只用 executor 本身） */
export const __test__ = {
  demoteDeveloperMessages,
  toolChoiceMustGo,
  guardFakeSuccess,
  peekSseHead,
  syntheticErrorResponse,
};
