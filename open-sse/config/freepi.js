// FreePi — ad-supported free coding agent (free-pi-cli). GitHub device flow
// brokered by api.freepi.ai; the result is a JWT (~90 days, no refresh).
// Signing in accepts freepi.ai/terms (consent_version) on the user's behalf.
export const FREEPI_CONFIG = {
  apiBase: "https://api.freepi.ai",
  deviceUrl: "https://api.freepi.ai/auth/github/device",
  consentUrl: "https://api.freepi.ai/auth/consent",
  tokenUrl: "https://api.freepi.ai/auth/token",
  chatUrl: "https://api.freepi.ai/v1/chat/completions",
  clientVersionUrl: "https://api.freepi.ai/client-version",
  sessionResetUrl: "https://api.freepi.ai/session/reset",
  meUrl: "https://api.freepi.ai/me",
  website: "https://freepi.ai",
  consentVersion: "4",
  // Server enforces a minimum (426 below it); refreshed from /client-version.
  clientVersion: "0.6.28",
  maxTokens: 32768,
  pollInterval: 5000,
  requestTimeoutMs: 20000,
  tokenLifetimeSeconds: 90 * 24 * 3600,
};

export const FREEPI_MODELS = [
  { id: "particle", name: "Particle-1 (free)" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (free)" },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash (free)" },
];
