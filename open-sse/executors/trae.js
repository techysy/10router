import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { PROVIDERS } from "../config/providers.js";
import {
  buildTraeToolPrompt,
  serializeTraeToolHistory,
  parseTraeToolCalls,
  TraeToolCallStreamRecover,
} from "./traeToolProtocol.js";

// Trae executor — SOLO remote agent API.
//
// Flow:
//   1. POST {base}/chat_sessions          → { code:0, data:{ chat_session_id, message_id } }
//   2. GET  {base}/chat_sessions/{id}/events?reply_to_message_id={message_id}
//        → text/event-stream. Assistant text streams in `plan_item` events under
//          the `thought` field (cumulative per plan-item id). `token_usage` carries
//          usage; `done` ends the turn; `error` carries upstream errors.
//
// Auth: header `Authorization: Cloud-IDE-JWT <jwt>` (RS256, ~14-day lifetime).
// Identity fields for common_params live in credentials.providerSpecificData.

const STREAM_TIMEOUT_MS = parseInt(process.env.TRAE_STREAM_TIMEOUT_MS || "300000", 10);
const TRAE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// 国际站 core host 候选链（#99 情报二）：老账号在 core-normal.trae.ai 上仍可用，
// 新一代账号面已迁 traeapi.us / 区域生成域名（coresg-/coreva-）。createSession
// 失败按序换站重试，不写死任何单一域名。
const INTL_CORE_CANDIDATES = [
  "https://core-normal.trae.ai/api/remote/v1",
  "https://core-normal.traeapi.us/api/remote/v1",
  "https://coresg-normal.trae.ai/api/remote/v1",
  "https://coreva-normal.trae.ai/api/remote/v1",
];
const CN_CORE_CANDIDATES = ["https://trae-api-cn.mchost.guru/api/remote/v1"];

// 设备指纹按账号派生（#99 落地要点 4）：共享硬编码 device_id 是 4017 风控的
// 主要触发面（trae2api-hub v1.4.3 同款修法）。uid 取 psd.userId，缺了退邮箱/
// token 前缀——同一连接永远得到同一组稳定指纹。
function traeDeviceIdentity(psd = {}, accessToken = "") {
  const uidSource = String(psd.userId || psd.email || `tok:${String(accessToken).slice(0, 64)}` || "anonymous");
  const digest = crypto.createHash("sha256").update(`10router-trae:${uidSource}`).digest("hex");
  const deviceId = digest.slice(0, 16).replace(/\D/g, "").padEnd(16, "7");
  const machineId = [
    digest.slice(16, 24), digest.slice(24, 28), `4${digest.slice(28, 31)}`,
    [["8", "9", "a", "b"][parseInt(digest.slice(31, 32), 16) % 4], digest.slice(32, 35)].join(""),
    digest.slice(35, 47),
  ].join("-");
  return { deviceId, machineId };
}

// 工具协议块已迁往 traeToolProtocol.js（#108：marker 协议 + 结构化 tool_calls
// 出口恢复，参照 trae2api-hub 三层方案）。flattenQuery 通过 buildTraeToolPrompt /
// serializeTraeToolHistory 取注入块与多轮历史。

function flattenQuery(messages, tools = null) {
  const parts = [];
  // #108：工具协议三段之①③——格式声明注入 + 多轮历史透传。tool_calls 历史的
  // marker 形态与 ② 出口解析同源（traeToolProtocol.js）。
  const toolProtocol = buildTraeToolPrompt(tools);
  if (toolProtocol.prompt) parts.push(toolProtocol.prompt);
  for (const block of serializeTraeToolHistory(messages)) parts.push(block);
  for (const m of messages) {
    let content = "";
    if (typeof m.content === "string") content = m.content;
    else if (Array.isArray(m.content)) {
      content = m.content
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object") return String(p.text ?? "");
          return "";
        })
        .join("");
    }
    if (m.role === "system") parts.push(`[System]\n${content}`);
    else if (m.role === "assistant") parts.push(`[Assistant]\n${content}`);
    else parts.push(content);
  }
  // Trae expects query as a JSON-encoded string of typed content blocks.
  return JSON.stringify([{ type: "text", data: { content: parts.join("\n\n") } }]);
}

// Trae 标准模型名称映射（服务端的 chat_v3 / ConfigName 严格区分大小写，传错报 4001 config empty）
const CANONICAL_TRAE_MODELS = {
  "doubao-seed-code": "Doubao-Seed-Code",
  "doubao-seed-2.1-turbo": "Doubao-Seed-2.1-Turbo",
  "doubao-seed-2.1-pro": "Doubao-Seed-2.1-Pro",
  "doubao-seed-2.0-code": "Doubao-Seed-2.0-Code",
  "doubao-seed-evolving": "Doubao-Seed-Evolving",
  "deepseek-v4.1-flash": "DeepSeek-V4-Flash",
  "deepseek-v4-flash": "DeepSeek-V4-Flash",
  "deepseek-v4-pro": "DeepSeek-V4-Pro",
  "deepseek-v4-pro-official": "DeepSeek-V4-Pro-Official",
  "glm-5.3": "GLM-5.3",
  "glm-5.3-flash": "GLM-5.3-Flash",
  "glm-5.3-flashx": "GLM-5.3-FlashX",
  "kimi-k3.1-pro": "Kimi-K3.1-Pro",
  "kimi-k3": "Kimi-K3",
  "minimax-m3.1-flash": "MiniMax-M3.1-Flash",
  "minimax-m3": "MiniMax-M3",
  "step-5-preview": "Step-5-Preview",
  "qwen3.8-flash": "qwen3.8-flash",
  "qwen3.8-max": "qwen3.8-max",
  "mimo-v2.6-flash": "mimo-v2.6-flash",
  "mimo-v2.6-pro": "mimo-v2.6-pro",
};

export function canonicalTraeModel(model) {
  if (!model) return "";
  const key = String(model).trim().toLowerCase();
  return CANONICAL_TRAE_MODELS[key] || model;
}

// 4001 config-empty 降级链（#109）：上游 chat_v3 的 ConfigName 目录是社区人工
// 校对的静态表（issue #99 备注），新模型可能还没进表（实测 GLM-5.3-FlashX 4001）。
// 机械截段不行 —— tier 名是完整段（FlashX ≠ Flash + X），降级目标需显式声明：
//   FlashX → Flash → 基型；Pro-Official → Pro；2.1-Turbo → 2.1-Pro（同族降档）
// 表里没有的模型名返回 null（外层放弃降级，报原文错误）。命中即返回规范
// ConfigName，重试同一 base；降级在日志标注（回复可能不是请求指定的模型）。
const TRAE_CONFIG_DEGRADE = {
  "GLM-5.3-FlashX": "GLM-5.3-Flash",
  "DeepSeek-V4-Pro-Official": "DeepSeek-V4-Pro",
  "Doubao-Seed-2.1-Turbo": "Doubao-Seed-2.1-Pro",
};
export function degradeTraeConfigName(configName) {
  const m = String(configName || "").trim();
  if (!m || m === "auto") return null;
  const next = TRAE_CONFIG_DEGRADE[m] || null;
  // 降级目标必须是目录已知名（或可继续降级的中间态）—— 防止降进未知名再 4001。
  const knownValues = new Set(Object.values(CANONICAL_TRAE_MODELS));
  return next && (knownValues.has(next) || TRAE_CONFIG_DEGRADE[next]) ? next : null;
}

// 判定是否为显式要求的 SOLO 沙箱模式
export function isSoloAgentMode(model = "") {
  const m = String(model).trim().toLowerCase();
  // 豆包系（doubao-*）：上游 chat 通道对豆包系也回落云端沙箱执行（#109 实测
  // 日志：agent_type:chat 下 Doubao-Seed-Code 返回 TRAE 沙箱环境自述）。与其
  // 走错通道拿错形态的回复，不如显式归位 SOLO 沙箱（As-Designed，#58 归档），
  // 卡面/文档即可如实标注「云端沙箱执行」。
  return m.includes("solo") || m.includes("work") || m.startsWith("agent-") || m.startsWith("doubao-");
}

// #99 拆线：同一执行器服务两条 registry 条目——
//   trae     → 国际站（默认 intl）
//   trae-cn  → 国内站（默认 cn）
// 连接落库的 psd.site 仍是最终权威（老连接 / 粘贴探测纠偏过的站点优先），
// 条目缺省只兜 psd 缺 site 的场景。
export default class TraeExecutor extends BaseExecutor {
  constructor(providerId = "trae") {
    super(providerId, PROVIDERS[providerId] || PROVIDERS.trae);
    this.defaultSite = providerId === "trae-cn" ? "cn" : "intl";
  }

  siteOf(psd = {}) {
    const declared = String(psd.site || "").toLowerCase();
    return declared === "cn" || declared === "intl" ? declared : this.defaultSite;
  }

  // SOLO 网关按站点分叉：国内站 (trae.cn) 与国际站 (trae.ai) 的 token 不能互用，
  // 网关也不互通。cn 侧数据面走国内 web remote 网关 trae-api-cn.mchost.guru
  // （core-normal.trae.cn 不解析；api.trae.com.cn 只承接 CloudIDE/OAuth/pay，#99 情报二）；
  // 若上游改域，改这里一处即可。
  base(psd = {}) {
    return this.baseCandidates(psd)[0];
  }

  // 候选链有序：registry/env 配置优先（显式指定 = 信任），其后补社区实测域名。
  baseCandidates(psd = {}) {
    const site = this.siteOf(psd);
    const configured = site === "cn"
      ? (this.config.soloBaseUrlCn || process.env.TRAE_SOLO_BASE_URL_CN)
      : (this.config.soloBaseUrl || this.config.baseUrl || process.env.TRAE_SOLO_BASE_URL);
    const tail = site === "cn" ? CN_CORE_CANDIDATES : INTL_CORE_CANDIDATES;
    return [configured, ...tail].filter(Boolean)
      .map((u) => String(u).replace(/\/$/, ""))
      .filter((u, i, arr) => arr.indexOf(u) === i);
  }

  buildHeaders(credentials, stream = true) {
    const token = credentials?.accessToken || "";
    const psd = credentials?.providerSpecificData || {};
    const isCn = this.siteOf(psd) === "cn";
    // 设备指纹按账号派生并随请求上送（社区在同款 web remote 端点的实测头组合）：
    // 共享硬编码设备号是 4017 风控的主要触发面。
    const { deviceId, machineId } = traeDeviceIdentity(psd, token);
    return {
      Authorization: `Cloud-IDE-JWT ${token}`,
      "Content-Type": "application/json",
      "X-Trae-Client-Type": "web",
      "X-Preferenced-Language": psd.appLanguage || (isCn ? "zh" : "en"),
      "x-user-region": psd.userRegion || (isCn ? "CN" : "US"),
      "x-uid": psd.userId || "",
      "x-device-id": deviceId,
      "x-machine-id": machineId,
      "x-request-id": crypto.randomUUID(),
      Referer: isCn ? "https://www.trae.cn/" : "https://solo.trae.ai/",
      "User-Agent": TRAE_UA,
      Accept: stream ? "text/event-stream" : "application/json",
    };
  }

  // SOLO session modes: "code" (model picker) vs "work" (fast auto lane).
  resolveMode(model) {
    const m = (model || "").trim().toLowerCase();
    if (m === "work" || m === "auto-work" || m === "solo-work") {
      return { mode: "work", strategy: "auto", modelName: "" };
    }
    const auto = !m || m === "auto";
    const mapped = canonicalTraeModel(model);
    return { mode: "code", strategy: auto ? "auto" : "manual", modelName: auto ? "" : mapped };
  }

  // common_params is a JSON-encoded string embedded inside initial_message.
  commonParams(psd, mode, sessionId) {
    const cp = {
      language: "en-us",
      app_language: psd.appLanguage || "en",
      quality: "stable",
      app_version: psd.appVersion || "1.0.0.1229",
      web_id: psd.webId || "",
      user_identity: psd.userIdentity || "Free",
      is_freshman: "0",
      biz_user_id: psd.bizUserId || "",
      user_unique_id: psd.userUniqueId || "",
      scope: psd.scope || "marscode-us",
      tenant: psd.tenant || "marscode",
      region: psd.region || "US-East",
      aiRegion: psd.aiRegion || psd.region || "US-East",
      is_privacy_mode: 0,
      privacy_mode: "off",
      solo_chat_mode: mode,
    };
    if (sessionId) cp.biz_session_id = sessionId;
    return JSON.stringify(cp);
  }

  // POST /chat_sessions — creates a session and submits the first turn on ONE base.
  // 区分直连非沙箱通道（agent_type: "chat", env: "local"）与 SOLO 沙箱通道（solo_agent_remote）：
  // 普通模型调用默认走轻量非沙箱通道，避免在远端分配容器沙箱及并发上限；
  // 只有明确指定 solo/work 任务模式时才启用云端沙箱。
  async createSessionOnBase(base, headers, query, model, psd, signal, configNameOverride = null) {
    const { mode, strategy, modelName: resolvedName } = this.resolveMode(model);
    // 4001 降级链的 ConfigName 覆盖优先于 resolveMode 的映射结果。
    const modelName = configNameOverride ?? resolvedName;
    const useSoloSandbox = isSoloAgentMode(model);
    const body = {
      mode,
      environment_id: "default",
      initial_message: {
        chat_session_id: "",
        content: [],
        query,
        model_name: modelName,
        agent_type: useSoloSandbox ? "solo_agent_remote" : "chat",
        model_selection_strategy: strategy,
        common_params: this.commonParams(psd, mode),
      },
      env: useSoloSandbox ? "remote" : "local",
      auto_create_project: false,
      origin: "web",
    };
    const res = await proxyAwareFetch(`${base}/chat_sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    }, null);
    const text = await res.text();
    if (!res.ok) throw new Error(`[${res.status}] ${text}`);
    const json = JSON.parse(text);
    if (json?.code !== 0) throw new Error(`Trae create_session: ${JSON.stringify(json)}`);
    return { sessionId: json.data.chat_session_id, messageId: json.data.message_id };
  }

  // createSession 按候选链换站重试（#99 落地要点 3）：国际账号面域名已按区域
  // 生成，写死单一域名是直连线不可用的根因之一。首个 code:0 的 host 胜出。
  // 4001 降级重试（#109）：上游 ConfigName 目录是社区人工校对的静态表，新模型
  // （如 GLM-5.3-FlashX）可能未进表。命中 4001 时按 degradeTraeConfigName 降级
  // ConfigName 重试同一 base，逐级直到 auto；降级在日志标注（回复可能不是
  // 请求指定的那个模型）。
  async createSession(headers, query, model, psd, signal) {
    let lastErr = new Error("no core host candidates");
    for (const base of this.baseCandidates(psd)) {
      let configName = this.resolveMode(model).modelName;
      for (;;) {
        try {
          const session = await this.createSessionOnBase(base, headers, query, model, psd, signal, configName);
          session.base = base;
          session.modelName = configName || "auto";
          return session;
        } catch (err) {
          if (signal?.aborted) throw err;
          const is4001 = err?.message?.includes("4001") || err?.message?.includes("config item is empty");
          const next = is4001 ? degradeTraeConfigName(configName) : null;
          if (!next || next === configName) { lastErr = err; break; }
          lastErr = err;
          configName = next;
        }
      }
    }
    throw lastErr;
  }

  // GET /events SSE → invoke onEvent(eventType, dataObj) per frame.
  // Resolves when `done`/`error` arrives, the stream ends, or timeout fires.
  async streamEvents(base, headers, sessionId, replyTo, onEvent, signal) {
    const url = `${base}/chat_sessions/${sessionId}/events?reply_to_message_id=${encodeURIComponent(replyTo)}`;
    const ctrl = new AbortController();
    if (signal?.aborted) ctrl.abort();
    const timer = setTimeout(() => ctrl.abort(new Error("trae stream timeout")), STREAM_TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await proxyAwareFetch(url, { method: "GET", headers, signal: ctrl.signal }, null);
      if (!res.ok || !res.body) throw new Error(`[${res.status}] events stream failed`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let ev = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            let data;
            try { data = JSON.parse(payload); } catch { data = { _raw: payload }; }
            if (onEvent(ev, data)) {
              await reader.cancel().catch(() => {});
              return;
            }
          } else if (line === "") ev = null;
        }
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  async execute({ model, body, stream, credentials, signal }) {
    const headers = this.buildHeaders(credentials, stream !== false);
    const psd = credentials?.providerSpecificData || {};
    // 站点固定的 SOLO 网关。按请求取局部值——执行器是全局单例，存实例字段
    // 会让并发的国内站 / 国际站请求互相覆盖，token 打到错的一端。
    // base 只作展示兜底；实际 host 由 createSession 换站重试的胜出者决定。
    const base = this.base(psd);
    const query = flattenQuery(body?.messages || [], body?.tools || null);
    // #108 工具协议三段之②：出口恢复器——把模型输出里的 marker 块转成标准
    // tool_calls（流式 = delta；非流式 = message.tool_calls）。无 tools 的请求
    // allowedNames 为空集，守卫直接 fail-open（原文透传，零开销）。
    const toolRecover = new TraeToolCallStreamRecover(body?.tools ? buildTraeToolPrompt(body.tools).allowedNames : new Set());
    const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
    const responseId = `chatcmpl-trae-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const errResponse = (status, message) => new Response(
      JSON.stringify({ error: { message, type: "api_error", code: "" } }),
      { status, headers: { "Content-Type": "application/json" } }
    );

    let session;
    try {
      session = await this.createSession(headers, query, model, psd, signal);
    } catch (err) {
      return { response: errResponse(502, err?.message ? String(err.message) : String(err)), url: base, headers, transformedBody: body };
    }
    const usedBase = session.base || base;

    // Shared per-turn state: plan_item thoughts / content (cumulative, longest wins).
    const order = [];
    const thoughts = {};
    let sent = 0;
    let usage = null;
    let errorEvent = null;
    const renderNewText = (data) => {
      const pid = data.id || data.message_id || "default";
      if (!(pid in thoughts)) order.push(pid);
      // 提取回复文本：兼顾 SOLO 沙箱的 plan_item.thought 与直连 chat 的 content / delta / text
      const t = data.thought || data.content || data.delta?.content || data.text || "";
      if (t.length >= (thoughts[pid] || "").length) thoughts[pid] = t;
      const full = order.map((i) => thoughts[i]).join("");
      const piece = full.slice(sent);
      sent = full.length;
      return piece;
    };

    if (stream !== false) {
      const enc = new TextEncoder();
      const sse = new ReadableStream({
        start: async (controller) => {
          const emit = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
          emit({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          });
          try {
            await this.streamEvents(usedBase, headers, session.sessionId, session.messageId, (ev, data) => {
              if (ev === "error") { errorEvent = data; return true; }
              if (ev === "token_usage" || ev === "notify_usage") usage = data;
              if (ev === "plan_item" || ev === "delta" || ev === "message" || ev === "content") {
                let piece = renderNewText(data);
                if (piece && hasTools) {
                  // #108 ②：文本 delta 过恢复器——正文原样透传，marker 块转
                  // tool_calls delta（OpenAI 流形态，SDK 客户端直接可用）。
                  const chunks = [...toolRecover.feed(piece), ...toolRecover.flush()];
                  for (const ch of chunks) {
                    if (ch.tool_calls) {
                      emit({
                        id: responseId,
                        object: "chat.completion.chunk",
                        created,
                        model,
                        choices: [{ index: 0, delta: { tool_calls: ch.tool_calls }, finish_reason: null }],
                      });
                    } else if (ch.content) {
                      emit({
                        id: responseId,
                        object: "chat.completion.chunk",
                        created,
                        model,
                        choices: [{ index: 0, delta: { content: ch.content }, finish_reason: null }],
                      });
                    }
                  }
                  piece = "";
                }
                if (piece) {
                  emit({
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
                  });
                }
              }
              return ev === "done";
            }, signal);
            if (errorEvent) {
              emit({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [],
                error: { message: `trae ${errorEvent.code || ""}: ${errorEvent.message || ""}`, type: "api_error" },
              });
            } else {
              // #108 ②收尾：恢复器缓冲里可能还剩正文尾巴（无 marker 的正常尾段）
              if (hasTools) {
                for (const ch of toolRecover.flush()) {
                  if (ch.content) {
                    emit({
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [{ index: 0, delta: { content: ch.content }, finish_reason: null }],
                    });
                  }
                }
              }
              const finish = hasTools && toolRecover.emitted > 0 ? "tool_calls" : "stop";
              emit({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: finish }],
              });
              if (usage) {
                emit({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [],
                  usage: {
                    prompt_tokens: usage.prompt_tokens || 0,
                    completion_tokens: usage.completion_tokens || 0,
                    total_tokens: usage.total_tokens || 0,
                  },
                });
              }
            }
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      });
      return {
        response: new Response(sse, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        }),
        url: base,
        headers,
        transformedBody: body,
      };
    }

    // Non-streaming: drive to completion, return chat.completion JSON.
    try {
      await this.streamEvents(usedBase, headers, session.sessionId, session.messageId, (ev, data) => {
        if (ev === "error") { errorEvent = data; return true; }
        if (ev === "token_usage" || ev === "notify_usage") usage = data;
        if (ev === "plan_item" || ev === "delta" || ev === "message" || ev === "content") renderNewText(data);
        return ev === "done";
      }, signal);
    } catch (err) {
      return { response: errResponse(502, err?.message ? String(err.message) : String(err)), url: base, headers, transformedBody: body };
    }
    if (errorEvent) {
      return { response: errResponse(502, `trae ${errorEvent.code || ""}: ${errorEvent.message || ""}`), url: base, headers, transformedBody: body };
    }
    const content = order.map((i) => thoughts[i]).join("");
    // #108 ②：非流式同样过恢复器——marker 块转 message.tool_calls
    let toolCalls = null;
    let cleanContent = content;
    if (hasTools) {
      const parsed = parseTraeToolCalls(content, toolRecover.allowed);
      cleanContent = parsed.content;
      if (parsed.calls.length) toolCalls = parsed.calls;
    }
    const message = { role: "assistant", content: cleanContent };
    if (toolCalls) message.tool_calls = toolCalls;
    const out = {
      id: responseId,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" }],
    };
    if (usage) {
      out.usage = {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
      };
    }
    return {
      response: new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } }),
      url: base,
      headers,
      transformedBody: body,
    };
  }

  // Refresh hook placeholder — Cloud-IDE-JWT is long-lived (~14d); refresh via
  // ExchangeToken (refresh→access) is wired in services/tokenRefresh/providers.js.
  async refreshCredentials() {
    return null;
  }
}
