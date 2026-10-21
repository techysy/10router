/**
 * Huawei Cloud CodeArts (CodeArts Agent / Snap) constants.
 *
 * Every value below is owned by our Rust provider
 * (`agent2api …/providers/codearts/{chat,signer,session,welfare,models}.rs`).
 * Nothing here is guessed from the community forks — where the two disagree,
 * the Rust measurement wins and the comment says so.
 */

/** Chat Completions endpoint (Rust `chat.rs` / `signer_vectors.json`). */
export const CODEARTS_BASE_URL = "https://snap-access.cn-north-4.myhuaweicloud.com";
export const CODEARTS_CHAT_URL = `${CODEARTS_BASE_URL}/api/v2/chat/completions`;

/** Benefit (daily free pool) is booked on a second gateway (Rust balance.rs). */
export const CODEARTS_BENEFIT_GATEWAY_URL = "https://opengw.developer.huaweicloud.com";
export const CODEARTS_STATISTICS_PATH = "/snap-manager/v1/statistics/plugin";
export const CODEARTS_BENEFIT_BALANCE_PATH = "/api/v1/user/tokens/balance";
export const CODEARTS_BENEFIT_CLAIM_PATH = "/api/v1/benefit/claim";

/** Welfare campaign endpoints (Rust welfare.rs). */
export const CODEARTS_DELIVERY_PATH = "/v1/ops/delivery?channel=IDE";
export const CODEARTS_CLAIM_PATH = "/v1/ops/claim";
export const CODEARTS_CONFIRM_PATH = "/v1/ops/confirm";

/** OAuth / STS (Rust oauth.rs); PKCE verifier + DPoP key are part of the credential. */
export const CODEARTS_TOKEN_URL = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
export const CODEARTS_IDENTITY_URL = "https://sts.cn-north-4.myhuaweicloud.com/v5/caller-identity";
export const CODEARTS_WEB_LOGIN_BASE = "https://codearts.huaweicloud.com";
export const CODEARTS_OAUTH_CLIENT_ID = "vscode-codebot";

/** Fingerprint headers sent by the official extension (all of them are signed). */
export const CODEARTS_CLIENT_HEADERS = {
  "X-Language": "en-us",
  "plugin-name": "snap_vscode",
  "plugin-version": "1.0.0",
  "User-Agent": "snap_vscode",
};

/**
 * Platform hard cap on `max_tokens` / `max_completion_tokens`: 65536 passes,
 * 65537+ is rejected wholesale (`InferHub.001001005.400`). Measured by our
 * Rust provider on both benefit and non-benefit models; the catalog's declared
 * 131072/393216 values lie, so do NOT use them as a clamp.
 */
export const CODEARTS_MAX_OUTPUT_TOKENS = 65_536;

/**
 * Request-body walls. **Our measurement, not documented by the community**
 * (all 10 reference repos are silent): inference backend ≈6 MiB answers
 * `InferHub.001001005.400`, API gateway ≈12 MiB answers HTTP 413 `APIG.0201`.
 * Rust: 5,310,247 B passed, 6,372,244 B rejected. Re-verify before trusting
 * the exact byte; the gate below only remembers the measured floor.
 */
export const CODEARTS_SIZE_CEILING_KNOWN_BYTES = 6 * 1024 * 1024;
export const CODEARTS_GATEWAY_SIZE_CEILING_BYTES = 12 * 1024 * 1024;

/** Per-account concurrent chat sessions. Upstream hard limit is 3 (4th -> TM.00001041). */
export const CODEARTS_DEFAULT_SESSION_LIMIT = 3;
export const CODEARTS_MAX_SESSION_LIMIT = 64;

/**
 * Pool-wide dispatch rate. 50 req/s is the **aggregate** ceiling — it is NOT
 * per account, so the bucket lives at module scope, before account selection.
 */
export const CODEARTS_POOL_RATE_PER_SECOND = 50;

/** Local size-gate lifetime (Rust size_gate.rs): never persisted, TTL only. */
export const CODEARTS_SIZE_GATE_TTL_MS = 120_000;

/** Short cooldown for a locally observed session/upstream concurrency rejection. */
export const CODEARTS_CONCURRENCY_COOLDOWN_MS = 5_000;

export const CODEARTS_SESSION_LIMIT_CODE = "00001041";
export const CODEARTS_MODEL_NOT_REGISTERED_CODE = "InferHub.002002009.404";
export const CODEARTS_BENEFIT_ABSENT_CODE = "InferHub.4004.200";
export const CODEARTS_PARAM_INVALID_CODE = "InferHub.001001005.400";
export const CODEARTS_QUOTA_CODE = "InferHub.4291.200";
export const CODEARTS_WELFARE_NOT_YET_CODE = "40001";

/** Static catalog: agent + builtin + benefit, merged agent-first (Rust models.rs). */
export const CODEARTS_MODELS = [
  // ── agent source (also in builtin; agent row wins on id collision) ──
  { id: "GLM-5.2", name: "GLM-5.2", contextWindow: 202_752, maxOutput: 65_536, vision: false, reasoning: true },
  { id: "glm-5.2-sft-harmony", name: "GLM-5.2-ArkTS-SPARK", contextWindow: 202_752, maxOutput: 65_536, vision: false, reasoning: false },
  { id: "openpangu-2.0-pro", name: "OpenPangu-2.0-Pro", contextWindow: 524_288, maxOutput: 65_536, vision: false, reasoning: true },
  { id: "openpangu-2.0-flash", name: "OpenPangu-2.0-Flash", contextWindow: 524_288, maxOutput: 65_536, vision: false, reasoning: true },
  // ── builtin-only (multimodal models appear ONLY here) ──────────────
  { id: "Qwen3-VL-235B", name: "Qwen3-VL-235B", contextWindow: 200_000, maxOutput: 65_536, vision: true, reasoning: false },
  { id: "kimi-k2.6-vl", name: "Kimi-K2.6-VL", contextWindow: 200_000, maxOutput: 65_536, vision: true, reasoning: false },
  // ── benefit gateway (needs `maas_type: benefit`; without it 404) ───
  { id: "deepseek-v4-flash-0731", name: "DeepSeek-V4-Flash", contextWindow: 1_048_576, maxOutput: 65_536, vision: false, reasoning: true, benefit: true },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", contextWindow: 1_048_576, maxOutput: 65_536, vision: false, reasoning: true, benefit: true },
  { id: "deepseek-v4-pro-0813", name: "DeepSeek-V4-Pro", contextWindow: 1_000_000, maxOutput: 65_536, vision: false, reasoning: true, benefit: true },
  { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 1_000_000, maxOutput: 65_536, vision: false, reasoning: true, benefit: true },
];

export const CODEARTS_BENEFIT_MODEL_IDS = new Set(
  CODEARTS_MODELS.filter((model) => model.benefit).map((model) => model.id)
);

/** Model ids are case-sensitive upstream; clients habitually lower-case them. */
export function resolveCodeArtsModelId(requested) {
  const raw = String(requested || "").trim();
  if (!raw) return raw;
  const exact = CODEARTS_MODELS.find((model) => model.id === raw);
  if (exact) return exact.id;
  const folded = CODEARTS_MODELS.find((model) => model.id.toLowerCase() === raw.toLowerCase());
  return folded ? folded.id : raw;
}

export function isCodeArtsBenefitModel(model) {
  const resolved = resolveCodeArtsModelId(model);
  if (CODEARTS_BENEFIT_MODEL_IDS.has(resolved)) return true;
  // Unknown ids are forwarded as-is. The benefit pool is never the default
  // route: guessing `benefit` here would leak a header the model may reject,
  // and guessing `false` only surfaces the upstream's honest 404.
  return false;
}
