import { extractApiKey, isValidApiKey, checkApiKeyDailyLimit, getProviderCredentials, markAccountUnavailable } from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { handleChat } from "./chat.js";
import * as log from "../utils/logger.js";

/**
 * POST /v1/audio/music — music-generation endpoint (media kind "music").
 *
 * Body: { model, prompt, caption?, lyrics?, instrumental?, response_format? } —
 * the shape MEDIA_PROVIDER_KINDS.music and the media example card ship with.
 * Dispatch by the provider's musicConfig.mode:
 *   - "stepfun-async" (StepFun 原生 /v1/audio/music：submit + query 轮询异步任务)
 *   - default "chat"  (acemusic：OpenAI chat completions 的 audio 方言，message.audio[]
 *     整曲 base64 data URI；内部走完整 chat 管线——combo 回退/用量统计全复用)
 *
 * Both paths return the same contract: { data: [{ url, format }], content, model } —
 * url is a data:audio/* URI the example card plays inline and offers for download.
 */

// StepFun async task poll cadence/budget (official docs: poll every 5s; a full
// song takes tens of seconds to minutes — autoregressive long task).
const STEP_POLL_INTERVAL_MS = 5000;
const STEP_POLL_BUDGET_MS = 8 * 60 * 1000;

const MIME_BY_FORMAT = { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/opus", pcm: "audio/pcm" };

// Pure: reshape a chat-completions JSON body into the music response.
export function extractMusicResponse(chatJson) {
  const choice = chatJson?.choices?.[0];
  const message = choice?.message || {};
  const audio = Array.isArray(message.audio) ? message.audio : [];

  const data = audio
    .map((a) => a?.audio_url?.url)
    .filter((url) => typeof url === "string" && url.startsWith("data:audio/"))
    .map((url) => {
      const mime = url.slice(5, url.indexOf(";")) || "audio/mpeg";
      const container = mime.includes("mp4") ? "mp4" : mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : "mp3";
      return { url, format: container };
    });

  if (data.length === 0) {
    return { error: "Upstream returned no audio for this prompt" };
  }

  return {
    data,
    content: typeof message.content === "string" && message.content ? message.content : null,
    usage: chatJson?.usage || null,
  };
}

// Pure: map the gateway music contract onto StepFun's submit fields. A prompt
// pasted as lyrics (multi-line / structure tags) drives `lyrics` so the model
// sings it as-is; a one-line description stays `caption` (server auto-writes
// lyrics). Both overridable explicitly.
export function buildStepfunSubmitBody(body, musicConfig) {
  const prompt = String(body.prompt || "").trim();
  const isLyricShaped = /\n/.test(prompt) || /^\[(intro|verse|chorus|bridge|hook|outro|instrumental)/im.test(prompt);
  const submit = {
    task: "text_to_music",
    model_id: musicConfig.modelIdUpstream,
    caption: String(body.caption || "").trim() || (isLyricShaped ? prompt.split("\n")[0].trim() : prompt),
    response_format: body.response_format || musicConfig.defaultResponseFormat || "mp3",
  };
  const lyrics = String(body.lyrics || "").trim() || (isLyricShaped ? prompt : "");
  if (lyrics) submit.lyrics = lyrics;
  if (body.instrumental === true) submit.instrumental = true;
  return submit;
}

// Pure: reshape a StepFun SUCCESS query payload into the music response.
export function extractStepfunMusicResponse(queryJson, musicConfig) {
  if (queryJson?.status === "FAILED") {
    const err = queryJson.error || {};
    return { error: `Upstream task failed (${err.stage || "unknown"}): ${err.message || "no detail"}` };
  }
  if (queryJson?.status !== "SUCCESS" || typeof queryJson.audio !== "string" || queryJson.audio === "") {
    return { error: "Upstream returned no audio for this prompt" };
  }
  const format = queryJson.response_format || musicConfig.defaultResponseFormat || "mp3";
  const mime = MIME_BY_FORMAT[format] || "audio/mpeg";
  return {
    data: [{ url: `data:${mime};base64,${queryJson.audio}`, format }],
    content: queryJson.rewritten_lyrics || queryJson.lyrics || null,
    model: musicConfig.modelIdUpstream,
  };
}

function musicConfigFor(provider) {
  const entry = REGISTRY.find((p) => p.id === provider);
  const cfg = entry?.musicConfig;
  return cfg && cfg.mode ? cfg : null;
}

export async function handleMusic(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  log.request("POST", `${url.pathname} | ${body.model || "?"}`);

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }
  const limitResponse = await checkApiKeyDailyLimit(apiKey, { request, model: body.model });
  if (limitResponse) return limitResponse;

  if (!body.model) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");

  const modelInfo = await getModelInfo(body.model);
  if (!modelInfo?.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown model: ${body.model}`);
  const musicConfig = musicConfigFor(modelInfo.provider);

  if (musicConfig?.mode === "stepfun-async") {
    return handleNativeAsyncMusic(body, modelInfo, musicConfig, url);
  }

  // Chat-native path (acemusic): ride the chat pipeline with the caller's
  // credentials. The original URL is kept so usage rows log the music endpoint.
  const chatBody = {
    model: body.model,
    stream: false,
    messages: [{ role: "user", content: body.prompt }],
  };
  const chatRequest = new Request(url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(chatBody),
  });

  const chatResponse = await handleChat(chatRequest);
  if (!chatResponse.ok) {
    const errText = await chatResponse.text().catch(() => "");
    let message = errText;
    try {
      message = JSON.parse(errText)?.error?.message || errText;
    } catch { /* raw text */ }
    return errorResponse(chatResponse.status, message || "Music generation failed");
  }

  const chatJson = await chatResponse.json().catch(() => null);
  const extracted = extractMusicResponse(chatJson);
  if (extracted.error) {
    return errorResponse(HTTP_STATUS.BAD_GATEWAY, extracted.error);
  }

  return Response.json(
    { data: extracted.data, content: extracted.content, model: chatJson?.model || body.model },
    { headers: { "Access-Control-Allow-Origin": "*" } }
  );
}

// StepFun native async: credential loop → submit → bounded 5s poll → reshape.
async function handleNativeAsyncMusic(body, modelInfo, musicConfig, url) {
  const { provider, model } = modelInfo;
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const msg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return errorResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const result = await runStepfunTask(body, credentials, musicConfig);
    if (result.success) {
      return Response.json(result.body, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }
    return errorResponse(result.status, result.error);
  }
}

async function runStepfunTask(body, credentials, musicConfig) {
  const proxyConfig = await resolveConnectionProxyConfig(credentials.providerSpecificData).catch(() => ({}));
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    strictProxy: false,
  };
  const headers = {
    Authorization: `Bearer ${credentials.accessToken || credentials.apiKey}`,
    "Content-Type": "application/json; charset=utf-8",
  };

  // 1. Submit
  const submitBody = buildStepfunSubmitBody(body, musicConfig);
  let taskId;
  try {
    const submitRes = await proxyAwareFetch(
      musicConfig.submitUrl,
      { method: "POST", headers, body: JSON.stringify(submitBody) },
      proxyOptions,
    );
    const submitJson = await submitRes.json().catch(() => null);
    if (!submitRes.ok || !submitJson?.task_id) {
      const msg = submitJson?.error?.message || `HTTP ${submitRes.status}`;
      return { success: false, status: submitRes.status, error: `Music submit failed: ${msg}` };
    }
    taskId = submitJson.task_id;
  } catch (e) {
    return { success: false, status: HTTP_STATUS.BAD_GATEWAY, error: `Music submit failed: ${e.message}` };
  }

  // 2. Poll (FAILED is a 200 business terminal — judge on status, not HTTP)
  const deadline = Date.now() + STEP_POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, STEP_POLL_INTERVAL_MS));
    let queryJson;
    try {
      const queryRes = await proxyAwareFetch(
        musicConfig.queryUrl,
        { method: "POST", headers, body: JSON.stringify({ task_id: taskId }) },
        proxyOptions,
      );
      queryJson = await queryRes.json().catch(() => null);
      if (!queryRes.ok) {
        return { success: false, status: queryRes.status, error: `Music query failed: ${queryJson?.error?.message || `HTTP ${queryRes.status}`}` };
      }
    } catch (e) {
      return { success: false, status: HTTP_STATUS.BAD_GATEWAY, error: `Music query failed: ${e.message}` };
    }

    if (queryJson.status === "PENDING" || queryJson.status === "RUNNING") continue;

    const extracted = extractStepfunMusicResponse(queryJson, musicConfig);
    if (extracted.error) return { success: false, status: HTTP_STATUS.BAD_GATEWAY, error: extracted.error };
    return { success: true, body: { data: extracted.data, content: extracted.content, model: extracted.model } };
  }

  return { success: false, status: HTTP_STATUS.GATEWAY_TIMEOUT, error: `Music task timed out after ${Math.round(STEP_POLL_BUDGET_MS / 60000)} min (task_id ${taskId})` };
}
