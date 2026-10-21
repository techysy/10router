// Raccoon / 小浣熊 (xiaohuanxiong.com) — Bearer-JWT API-key provider.
//
// The model gateway is a plain OpenAI-compatible Chat Completions endpoint, so
// no executor is needed. What DOES need local enforcement is the model id:
// the upstream silently falls back to its default model and answers 200 for an
// unknown id, which is the most convincing kind of failure. `strictModels`
// turns that into a local 400 before any account is selected (the gate lives
// in open-sse/services/model.js `isModelAllowedForProvider`).
//
// Auth: a JWT obtained from the official web/desktop login, pasted as the API
// key. The same token is used for /points and /office reads. If the connection
// also carries `refreshToken`, open-sse/services/tokenRefresh.js refreshes it
// via POST /api/web/auth/v1/refresh (rotating refresh token).
//
// Catalog: the five entries below are the Rust provider's static fallback
// (raccoon/models.rs `fallback_models`) — the desktop client's
// default-llm-config.json presets plus the limits observed on /model_catalog.
// They are the offline floor, not a live mirror: the remote catalog can add
// models, but 10router only accepts ids it knows locally (see strictModels).
import { RACCOON_CHAT_COMPLETIONS_URL } from "../../config/raccoon.js";

export default {
  id: "raccoon",
  priority: 70,
  alias: "raccoon",
  display: {
    name: "Raccoon 小浣熊",
    icon: "pets",
    color: "#F59E0B",
    textIcon: "RC",
    website: "https://xiaohuanxiong.com",
  },
  category: "oauth",
  authType: "apikey",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: RACCOON_CHAT_COMPLETIONS_URL,
    format: "openai",
    // Rust sends Accept: */* because the gateway may answer either JSON or SSE.
    headers: { Accept: "*/*" },
  },
  models: [
    {
      id: "raccoon-8c4485",
      name: "Raccoon-Work",
      contextWindow: 1_000_000,
      maxOutput: 100_000,
      vision: true,
      reasoning: false,
    },
    {
      id: "raccoon-19b265",
      name: "Raccoon-Work-260817-A",
      contextWindow: 1_000_000,
      maxOutput: 100_000,
      vision: false,
      reasoning: false,
    },
    {
      id: "raccoon-405a1c",
      name: "Raccoon-Work-260817-B",
      contextWindow: 1_000_000,
      maxOutput: 100_000,
      vision: false,
      reasoning: false,
    },
    {
      id: "raccoon-chat-ml-5-5",
      name: "Raccoon Chat (默认)",
      contextWindow: 180_000,
      maxOutput: 80_000,
      vision: false,
      reasoning: true,
    },
    {
      id: "sn-sensenova-6-8-flash-lite",
      name: "SenseNova 6.8 Flash Lite",
      contextWindow: 256_000,
      maxOutput: 63_999,
      vision: false,
      reasoning: true,
    },
  ],
  // Do NOT set passthroughModels: it is the UI/routing "accept any id" switch,
  // and this upstream's fallback-on-unknown behaviour makes that unsafe.
  strictModels: true,
  features: {
    usage: true,
    usageApikey: true,
  },
};
