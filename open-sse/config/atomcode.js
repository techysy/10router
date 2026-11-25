// AtomCode (AtomGit CodingPlan) — free coding plan from AtomGit (CSDN / OpenAtom).
// Login goes through AtomGit's platform broker (same flow as the official
// `atomcode login`): GET /auth/login → open login_url → poll /auth/check →
// GET /auth/token. Inference is OpenAI-compatible at llm-api.atomgit.com but
// every request must be signed (see shared/atomcode/sign.js).
export const ATOMCODE_CONFIG = {
  platformUrl: "https://acs.atomgit.com",
  loginUrl: "https://acs.atomgit.com/auth/login",
  checkUrl: "https://acs.atomgit.com/auth/check",
  tokenUrl: "https://acs.atomgit.com/auth/token",
  refreshUrl: "https://acs.atomgit.com/oauth/refresh",
  codingPlanApi: "https://api.gitcode.com/api/v5/coding-plan",
  llmBaseUrl: "https://llm-api.atomgit.com/v1",
  chatPath: "/v1/chat/completions",
  website: "https://ai.atomgit.com/serverless-api",
  // Official client version the signing scheme was recovered from. The gateway
  // checks X-AtomCode-Ver; bump together with sign.js if AtomGit rotates keys.
  clientVersion: "5.2.8",
  userAgent: "atomcode/5.2.8",
  pollInterval: 3000,
  loginTtlSeconds: 600,
  requestTimeoutMs: 20000,
  // Plan tiers tried at sign-in, highest first; the server grants the best one
  // the account is eligible for and answers duplicate:true when already held.
  claimPlans: ["Pro", "Lite"],
};

// Lite tier catalogue as returned by /coding-plan/models-v3 on 2026-11-25 (both
// verified live). The live list is also stored on the connection at sign-in.
export const ATOMCODE_MODELS = [
  { id: "qwen3.8-27b", name: "Qwen3.8 27B", vision: true, contextWindow: 262144, maxOutput: 32000 },
  { id: "glm5.3-flash", name: "GLM 5.3 Flash", vision: true, contextWindow: 512000, maxOutput: 16000 },
];
