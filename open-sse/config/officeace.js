// OfficeAce (华为云果办 / OfficeClaw) constants.
//
// Two very different surfaces live behind one account:
//   • model gateway  — `POST {gateway}/v2/chat/completions`, OpenAI protocol,
//     authenticated with a *non-expiring* Basic pair (`model_app_key:secret`).
//   • control plane  — `/v1/subscription` + `/v1/subscription/bonus/claim`,
//     authenticated with Huawei V11-HMAC (temporary AK/SK/STS + project id).
// The gateway host is per-account (`modelgw-00NN.<region>.huaweicloud-agentarts.com`),
// so the constant below is only the default used when a connection carries none.

export const OFFICEACE_DEFAULT_REGION = "cn-southwest-2";
// CredentialScope's service segment is fixed by APIG.
export const OFFICEACE_SCOPE_SERVICE = "apic";

export const OFFICEACE_DEFAULT_GATEWAY_BASE =
  "https://modelgw-0004.officeace.cn-southwest-2.huaweicloud-agentarts.com";

export const OFFICEACE_CHAT_PATH = "/chat/completions";
export const OFFICEACE_SUBSCRIPTION_PATH = "/v1/subscription";
export const OFFICEACE_BONUS_CLAIM_PATH = "/v1/subscription/bonus/claim";
// Required by both `/v1/subscription` and the bonus claim on the v2 control plane.
export const OFFICEACE_SUBSCRIPTION_TYPE = { name: "x-subscription-type", value: "v2" };

// ── limits ──────────────────────────────────────────────────────────────
// `messages` array length. Verified wall: the upstream rejects exactly 5000
// with `81113 ... messages max size is: 5000` — this is a COUNT limit, not a
// token limit, so shortening each message does not help.
export const OFFICEACE_MESSAGES_LIMIT = 5000;

// The gateway treats `max_tokens` as the budget for reasoning + visible text.
// A small value therefore returns HTTP 200 with an empty body and
// `finish_reason=length` (reasoning ate the whole budget). We *append* an
// allowance (never `max()` — that would rewrite an intentional 1-token ask).
export const OFFICEACE_REASONING_ALLOWANCE = 1024;
export const OFFICEACE_TINY_MAX_TOKENS = 16;

// Markers of the "request too large" family (officeace2api's `classifyUpstream`
// + APIG/MaaS wording). They must be classified BEFORE HTTP 429: the upstream
// sends 81113 with status 429, and treating it as rate limiting would cool a
// healthy account and tell the client to retry a request that can never pass.
export const OFFICEACE_TOO_LARGE_MARKERS = [
  "81113",
  "exceeds the maximum size",
  "requestentitytoolarge",
  "payload too large",
  "request body is too large",
  "request body is too long",
];

// Per-family output ceilings. `combined: true` means the number is the
// input+output total (qwen3), not a pure completion budget.
export const OFFICEACE_OUTPUT_LIMITS = [
  { family: "glm-5.*", pattern: /^glm-5(?:\.|$)/i, maxOutputTokens: 131072, combined: false },
  { family: "deepseek-v4.1-flash", pattern: /^deepseek-v4\.1-flash$/i, maxOutputTokens: 393216, combined: false },
  { family: "qwen3*", pattern: /^qwen3/i, maxOutputTokens: 65536, combined: true },
];

/**
 * Output ceiling for a model id, or `null` when the family is unknown.
 * `null` means "do not clamp" — inventing a ceiling for an unmeasured family
 * is worse than forwarding the client's value.
 */
export function officeaceOutputLimitFor(model) {
  const id = typeof model === "string" ? model.trim() : "";
  if (!id) return null;
  for (const entry of OFFICEACE_OUTPUT_LIMITS) {
    if (entry.pattern.test(id)) {
      return { maxOutputTokens: entry.maxOutputTokens, combined: entry.combined };
    }
  }
  return null;
}

// ── static model seed ───────────────────────────────────────────────────
// The authoritative catalog is `GET {gateway}/v1/models` and is per-account
// (34 names listed, ~11 actually usable — the rest answer 81004/81009). This
// seed only exists so the provider is usable before a catalog refresh lands;
// unknown ids are forwarded rather than rejected.
export const OFFICEACE_MODELS = [
  { id: "glm-5.3", name: "GLM 5.3" },
  { id: "glm-5.2", name: "GLM 5.2" },
  { id: "glm-5.1", name: "GLM 5.1" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash (0731)" },
  { id: "kimi-k2.6", name: "Kimi K2.6" },
];

/** `https://host`, `https://host/`, `https://host/v2` → `https://host/v2`. */
export function normalizeOfficeaceGatewayBase(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v2") ? trimmed : `${trimmed}/v2`;
}

/** Chat endpoint for a gateway base (adds `/v2` when missing). */
export function officeaceChatEndpoint(baseUrl) {
  const base = normalizeOfficeaceGatewayBase(baseUrl);
  return base ? `${base}${OFFICEACE_CHAT_PATH}` : "";
}

/** Control-plane base (subscription endpoints live at the gateway root). */
export function officeaceControlPlaneBase(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v2$/, "");
}
