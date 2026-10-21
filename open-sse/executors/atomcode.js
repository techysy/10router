// AtomCode (AtomGit / GitCode CodingPlan) executor — deliberately thin.
//
// The upstream is OpenAI Chat Completions on api-ai.gitcode.com, so the body is
// forwarded almost byte-for-byte. Four things are provider-specific:
//   1. model name: clients pick a display name (`GLM-5.3-Flash`); the gateway
//      only answers to `glm5.3-flash`. Sending the wrong spelling does NOT
//      error — it returns HTTP 200 with `参数错误`.
//   2. `stream_options.include_usage`: the official client always sends it, and
//      only then does the gateway emit the trailing usage frame.
//   3. `sign_v1` headers (HKDF-SHA256 -> five X-AtomCode-* headers). The
//      unsigned api-ai gateway does not need them, but a gateway override may;
//      we attach them whenever the connection carries an AtomGit user id.
//   4. HTTP 200 fake failures: `参数错误` and upstream HTML error pages. They
//      are recognised here for non-SSE bodies (see the streaming TODO below).
//
// User-Agent is functional, not cosmetic: `atomcode/<version>` makes the
// gateway demand the closed-source signature. We identify as this adapter.

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { errorResponse } from "../utils/error.js";
import { resolveAtomcodeModelId } from "../shared/atomcode/catalog.js";
import {
  ATOMCODE_ADAPTER_USER_AGENT,
  ATOMCODE_PARAMETER_ERROR_MESSAGE,
  ATOMCODE_QUOTA_WALL_MARKERS,
  ATOMCODE_SIG_MISSING_CODE,
  ATOMCODE_THIRD_PARTY_FAILURE_MARKER,
} from "../shared/atomcode/constants.js";
import { refreshAtomcodeToken } from "../shared/atomcode/oauth.js";
import { signAtomcodeRequest } from "../shared/atomcode/signing.js";

const MAX_PEEK_BYTES = 64 * 1024;

function tokenOf(credentials) {
  return credentials?.accessToken || credentials?.apiKey || "";
}

function userIdOf(credentials) {
  const psd = credentials?.providerSpecificData || {};
  return psd.userId || psd.user_id || credentials?.userId || "";
}

function signPathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "/v1/chat/completions";
  }
}

/** Read at most `limit` bytes from a cloned response body. */
async function readLimited(response, limit = MAX_PEEK_BYTES) {
  const clone = response.clone();
  if (!clone.body) return await clone.text().catch(() => "");
  const reader = clone.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

function contentOf(payload) {
  if (typeof payload === "string") return payload;
  const choice = payload?.choices?.[0];
  const content =
    choice?.message?.content ??
    choice?.delta?.content ??
    choice?.text ??
    payload?.content ??
    payload?.response;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }
  return "";
}

function messageOf(payload) {
  if (!payload || typeof payload !== "object") return "";
  return (
    payload?.error?.message ||
    payload?.detail?.message ||
    payload?.message ||
    payload?.msg ||
    ""
  );
}

/**
 * Classify a gateway body that arrived with HTTP 200.
 *
 * Exact match for `参数错误` (a model narrating the phrase must not be mistaken
 * for a rejection) and prefix match for `三方请求失败` (the gateway appends the
 * raw upstream error/page). Quota-wall copy is matched by substring because it
 * may be wrapped in prose or a JSON string.
 *
 * @returns {{kind:"parameter"|"third-party"|"quota-wall"|"error-envelope", message:string}|null}
 */
export function classifyAtomcodeSilentBody(raw, { model = "" } = {}) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;

  const subject = model ? `模型「${model}」` : "该请求";

  if (text === ATOMCODE_PARAMETER_ERROR_MESSAGE) {
    return {
      kind: "parameter",
      message:
        `AtomCode 网关拒绝了${subject}：返回 HTTP 200 但正文是「${ATOMCODE_PARAMETER_ERROR_MESSAGE}」。` +
        "通常表示该模型不在当前 CodingPlan 内、模型名未被识别，或请求参数不被接受。",
    };
  }
  if (text.startsWith(ATOMCODE_THIRD_PARTY_FAILURE_MARKER) || /^<(!doctype|html|head|body)\b/i.test(text)) {
    return {
      kind: "third-party",
      message:
        `AtomCode 网关返回了上游报错页而不是回答（${subject}）：该模型被列出但后端不可用，` +
        "请换一个模型或稍后重试。",
    };
  }
  const wall = ATOMCODE_QUOTA_WALL_MARKERS.find((marker) => text.includes(marker));
  if (wall) {
    return {
      kind: "quota-wall",
      message: `AtomCode 额度已触顶（${subject}）：${wall}。请等待滚动窗口重置或改用其他账号。`,
    };
  }
  return null;
}

/**
 * Inspect a 2xx upstream response for the two silent failures. SSE bodies are
 * deliberately not peeked here — a first-frame content guard belongs in the
 * stream relay, not in a fetch wrapper.
 */
export async function detectAtomcodeSilentSuccess(response, { model = "" } = {}) {
  if (!response || !response.ok) return null;
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (contentType.includes("text/event-stream")) {
    // TODO(stream guard): the same sentinel can arrive as the first
    // `choices[0].delta.content` of an SSE response. Mount point:
    // open-sse/handlers/chatCore/streamingHandler.js, immediately after
    // buildTransformStream() — wrap the provider body in a TransformStream that
    // buffers the first visible delta, calls classifyAtomcodeSilentBody(), and
    // emits an OpenAI error frame + [DONE] instead of relaying the sentinel.
    // Doing it in the executor would require consuming the response here and
    // re-creating headers/status, which the streaming handler already owns.
    return null;
  }

  const text = await readLimited(response).catch(() => "");
  if (!text.trim()) return null;

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* plain text or HTML */ }

  if (parsed !== null) {
    const content = contentOf(parsed);
    const classified = classifyAtomcodeSilentBody(content, { model });
    if (classified) return classified;

    // A 200 body with an error envelope and no choices is also a rejection.
    const hasChoices = Array.isArray(parsed?.choices) && parsed.choices.length > 0;
    if (!hasChoices) {
      const message = messageOf(parsed);
      if (message) {
        const envelope = classifyAtomcodeSilentBody(message, { model });
        if (envelope) return envelope;
        return {
          kind: "error-envelope",
          message: `AtomCode 网关返回 HTTP 200 但带有错误信息：${String(message).slice(0, 300)}`,
        };
      }
    }
    return null;
  }

  return classifyAtomcodeSilentBody(text, { model });
}

function responseBodyMessage(bodyText) {
  const text = String(bodyText || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    const message =
      parsed?.error?.message ||
      parsed?.detail?.message ||
      parsed?.message ||
      parsed?.msg ||
      parsed?.error;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 500);
  } catch { /* plain text */ }
  if (/^<(!doctype|html|head|body)\b/i.test(text)) {
    const title = text.match(/<title>([^<]+)<\/title>/i)?.[1];
    return title ? title.trim().slice(0, 200) : "upstream returned an HTML error page";
  }
  return text.slice(0, 500);
}

export class AtomcodeExecutor extends BaseExecutor {
  constructor(provider = "atomcode") {
    super(provider, PROVIDERS[provider] || PROVIDERS.atomcode);
  }

  transformRequest(model, body, stream) {
    if (!body || typeof body !== "object") return body;
    const payload = { ...body };
    const requested = typeof model === "string" && model.trim() ? model : payload.model;
    if (typeof requested === "string" && requested.trim()) {
      payload.model = resolveAtomcodeModelId(requested);
    }

    if (stream) {
      if (payload.stream_options == null) {
        payload.stream_options = { include_usage: true };
      }
    } else {
      delete payload.stream_options;
    }
    return payload;
  }

  buildHeaders(credentials, stream = true, url, model, body) {
    const headers = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": ATOMCODE_ADAPTER_USER_AGENT,
    };

    const token = tokenOf(credentials);
    if (token) headers.Authorization = `Bearer ${token}`;

    const userId = userIdOf(credentials);
    if (token && userId) {
      try {
        const signature = signAtomcodeRequest({
          method: "POST",
          path: signPathOf(url),
          body: JSON.stringify(body ?? {}),
          accessToken: token,
          userId,
          clientVersion: credentials?.providerSpecificData?.atomcodeClientVersion,
          masterKeyHex: credentials?.providerSpecificData?.atomcodeSignMasterKey,
        });
        Object.assign(headers, signature);
      } catch {
        // Signing is optional on the unsigned gateway. A 403 below still
        // produces an actionable message (signature required / re-login).
      }
    }

    return headers;
  }

  async execute(options) {
    const result = await super.execute(options);
    const silent = await detectAtomcodeSilentSuccess(result.response, { model: options?.model });
    if (!silent) return result;

    // Present it as a real failure so chatCore/account-fallback treat it as a
    // failed generation instead of forwarding the sentinel as an answer.
    const status = silent.kind === "quota-wall" ? 429 : 502;
    return {
      ...result,
      response: errorResponse(status, silent.message),
    };
  }

  parseError(response, bodyText) {
    const status = response?.status || 502;
    const text = String(bodyText || "");

    if (text.includes(ATOMCODE_SIG_MISSING_CODE)) {
      return {
        status: 502,
        message:
          `AtomCode 网关要求官方版请求签名（${ATOMCODE_SIG_MISSING_CODE}）：` +
          "请求打到了需要签名的官方主机（通常是 llm-api.atomgit.com）。请把网关改回 " +
          "https://api-ai.gitcode.com/v1，或确认连接里带有 AtomGit user id 以便签名。",
      };
    }

    const message = responseBodyMessage(text);

    if ((status === 401 || status === 403) && /codingplan/i.test(`${message} ${text.slice(0, 400)}`)) {
      return {
        status: 403,
        message:
          "该 AtomGit 账号还没有可用的 CodingPlan：请先在 AtomCode 客户端领取套餐，或在本渠道开启 AtomCode 签到/领取。",
      };
    }

    if (status === 403) {
      return {
        status,
        message: message
          ? `AtomCode 拒绝访问（HTTP 403）：${message}`
          : "AtomCode 拒绝访问（HTTP 403，响应无文案）。",
      };
    }

    return {
      status,
      message: message || `AtomCode 上游返回 HTTP ${status}`,
    };
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    try {
      const bundle = await refreshAtomcodeToken(credentials.refreshToken, proxyOptions);
      if (!bundle?.accessToken) return null;
      const psd = credentials.providerSpecificData || {};
      return {
        accessToken: bundle.accessToken,
        refreshToken: bundle.refreshToken || credentials.refreshToken,
        expiresIn: bundle.expiresIn || undefined,
        providerSpecificData: {
          ...(bundle.userId ? { userId: bundle.userId } : {}),
          ...(bundle.username ? { username: bundle.username } : {}),
          ...(bundle.name ? { name: bundle.name } : {}),
          ...(bundle.avatarUrl ? { avatarUrl: bundle.avatarUrl } : {}),
          ...(psd.atomcodeClientVersion ? { atomcodeClientVersion: psd.atomcodeClientVersion } : {}),
        },
      };
    } catch (error) {
      log?.warn?.("TOKEN", `atomcode refresh failed: ${error?.message || error}`);
      return error?.code === "invalid_grant" ? { error: "invalid_grant" } : null;
    }
  }
}

// Keep the signing primitive reachable from tests/consumers without importing
// the whole executor graph twice.
export { signAtomcodeRequest };

export default AtomcodeExecutor;
