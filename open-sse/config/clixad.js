// Clixad — terminal coding agent whose gateway (OpenRouter-backed) gives each
// GitHub-signed-in account a free daily allowance on a set of models.
// Sign-in is a GitHub device flow proxied by the gateway; the token it returns
// is Clixad's own bearer (no expiry, no refresh — 401 "invalid token" = re-login).
export const CLIXAD_CONFIG = {
  apiBase: "https://clixad.onrender.com",
  deviceStartUrl: "https://clixad.onrender.com/v1/auth/device/start",
  devicePollUrl: "https://clixad.onrender.com/v1/auth/device/poll",
  chatUrl: "https://clixad.onrender.com/v1/chat/completions",
  walletUrl: "https://clixad.onrender.com/v1/wallet",
  website: "https://clixad.io",
  clientHeader: "cli/0.0.1-beta.54",
  pollInterval: 5000,
  requestTimeoutMs: 20000,
};

// Free daily-allowance models (GET /v1/models, free:true, 2026-11-25).
export const CLIXAD_MODELS = [
  { id: "gpt-5-nano", name: "GPT-5 Nano", contextWindow: 400000 },
  { id: "gpt-6-luna", name: "GPT-6 Luna", contextWindow: 78000 },
  { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", contextWindow: 24000 },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 1048576 },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1048576 },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", contextWindow: 1048576 },
  { id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 262144 },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (free until 2027-01-15)", contextWindow: 1048576 },
];
