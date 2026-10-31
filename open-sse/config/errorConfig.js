// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  // "model_not_found" here is the OpenAI-compatible code clients key off, and
  // changing it would be a breaking API change; only the human-readable default
  // text below is corrected. See the note there.
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  // 404 is deliberately NOT "Model not found": on the local CreditDaddy gateway
  // lines (zcode-free / trae-free) a 404 means the endpoint path
  // is wrong or the gateway does not serve it — the brand segment moved from
  // /gateway/v1/messages to /gateway/<brand>/v1/messages — and saying "model
  // not found" points the user at their model list instead of at the path they
  // configured (issue #47). Upstream 404s that really are a missing model still
  // carry their own message and are unaffected: buildErrorBody only falls back
  // to this text when the caller supplies none.
  404: "Not found (wrong endpoint path, or the model does not exist)",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// 402 Payment Required: 余额/免费活动包耗尽不会在秒级自愈（每日积分也要等次日
// 登录刷新）。COOLDOWN.long 的 2 分钟只够"错误呈现"，到期后又对同一欠费渠道
// 发起必败请求（issue #91 方案 B 的实测缺口）。30 分钟避让 + 到期单次重探：
// 若已充值/活动恢复则成功并清锁，仍欠费则再锁 30 分钟——代价是每 30 分钟一次
// 探测请求，换来期间每一次请求都零耗时直落下一个健康渠道。
export const BILLING_COOLDOWN_MS = 30 * 60 * 1000;

// Google-style quota windows (Antigravity 429 RESOURCE_EXHAUSTED with
// quotaResetDelay) are the account's REAL reset clock — hours by design.
// Honoring them needs a bigger ceiling than the generic 30min hint cap.
export const MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

// Channel-level (provider-wide) block durations (ms).
// Some upstreams reject a *request shape* or an *egress fingerprint* rather than
// an account — CodeBuddy's 11128 "unapproved channel" answers identically for
// every account of the provider within the same second. Locking accounts one by
// one triples the burst, which is itself the signal the WAF looks for, so the
// right response is to stop the whole channel for a while instead.
export const CHANNEL_BLOCK_MS = {
  // First offence: short pause. Long enough that the in-flight request gives up
  // and the client retries into a different provider/model, short enough that a
  // blip does not blackhole the channel.
  short: 60 * 1000,
  // Repeat offence within CHANNEL_BLOCK_ESCALATE_WINDOW_MS: the fingerprint is
  // clearly sticky, back off properly.
  long: 10 * 60 * 1000,
};

// Re-offending inside this window escalates short → long.
export const CHANNEL_BLOCK_ESCALATE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff?, channelScope?, provider? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 *   - channelScope: true = the failure is a property of the CHANNEL (egress
 *     fingerprint / request shape), not of the account, so the caller must stop
 *     retrying sibling accounts and cool the whole provider down instead.
 *   - provider: 限定规则只对该 provider（解析后的 id）生效——同一句错误文案
 *     在别的渠道可能是请求自身的问题，不该把账号拉进长冷却。
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  // codex：[1m] 长上下文请求打到没勾选该变体的账号时，后端 400 回复这句——
  // 是账号级能力问题（换号可解），但它以 400 出现会撞进下方「请求自身 4xx
  // 不冷却」的兜底分支，所以必须显式置顶并按长冷却换下一个账号（上游 9f41ee75）。
  { provider: "codex", text: "model is not supported when using codex with a chatgpt account", cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS },
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  // CodeBuddy 11128 "Illegal API invocation from an unapproved channel" —
  // upstream security policy. Verified on a 4-account pool: all four answer 11128
  // with the SAME model within the same second (323–654ms), while a direct
  // single request with the identical shape returns 200. So the block is on the
  // channel, and walking the account list is what makes it worse.
  { text: "unapproved channel",       channelScope: true, cooldownMs: CHANNEL_BLOCK_MS.short },
  { text: "illegal api invocation",   channelScope: true, cooldownMs: CHANNEL_BLOCK_MS.short },
  // CodeBuddy INTL 会话头闸门（2026-10-15 起官方网关强制 X-Conversation-* 头族，
  // 11128 "conversation id missing" / "request illegal"，无头 100% 拒）：同 CN
  // unapproved channel 的渠道级语义——所有连接同秒同答，逐号重试只会放大。
  // 11128 是过载码（还承载 "first message is not system prompt" 这类 body 形状
  // 问题），所以按 provider + 文案限定，不按码分类。executor 已默认带上头族，
  // 这两条是头族回退时的防线。
  { provider: "codebuddy-intl", text: "conversation id missing", channelScope: true, cooldownMs: CHANNEL_BLOCK_MS.short },
  { provider: "codebuddy-intl", text: "request illegal", channelScope: true, cooldownMs: CHANNEL_BLOCK_MS.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  // Missing MiMo Desktop session is a CONFIGURATION state (executors/xiaomi-mimo.js),
  // not a transient fault: cooldown 0 = account never locked, combo falls through
  // immediately with zero wait, and the client sees the friendly message without
  // a misleading "(reset after 30s)".
  { text: "mimo desktop account",     cooldownMs: 0 },
  // CodeBuddy 11133（模型无法处理此请求 / 参数被模型方拒绝）：是特定模型的内容不兼容或模型拒识，
  // 官方建议 SWITCH_MODEL。在组合中应当立刻降级尝试下一个模型，而不锁账号。
  { text: "11133",                    cooldownMs: 0 },
  { text: "rejected by the model provider", cooldownMs: 0 },
  // CodeBuddy CN 极端载荷本地拦截：该渠道 WAF 对超大包风控，本地拦截以 400 返回。
  // 在组合降级场景中，后续候选渠道可能无此体积限制，故允许立即降级（cooldownMs: 0，不锁账号）。
  { text: "请求体积已达极端量级",     cooldownMs: 0 },
  { text: "extreme-size backstop",    cooldownMs: 0 },
  // StepFun CN Step Plan 免费套餐的 403：账号未完成实名（人脸）核验，上游在放行调用
  // 之前先拒。同样是**配置状态**而非故障、也非额度问题——cooldown 0 让账号永不锁定、
  // combo 立即穿透，与上面的 missing-MiMo-Desktop-session 同族。少了这条它会落到下方
  // 通用 `{ status: 403 }`，把模型锁 2 分钟、给客户端回一个 "(reset after 2m)"，
  // 而用户无论等多久都不会自己好——出路是去实名，不是等重置。
  { text: "real-name verification",   cooldownMs: 0 },
  { text: "realname verification",    cooldownMs: 0 },
  // ModelScope 未绑定阿里云账号提示（配置状态，cooldown 0 立即穿透与提示）
  { text: "bind your alibaba cloud account", cooldownMs: 0 },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: BILLING_COOLDOWN_MS },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// ─── StepFun CN 实名（real-name）闸门 ──────────────────────────────────────
// StepFun CN 的 Step Plan 免费套餐在放行调用之前先要求账号完成实名（人脸）核验，
// 未完成时上游对每个请求都回 403：
//   {"error":{"message":"real-name verification is required for your free step plan
//    before calling this API. please complete face verification at
//    https://account.stepfun.com/security?action=realname","type":...}}
// 这是**账号配置状态**，不是额度、不是故障、也不是限流：等多久都不会自己好，
// 反复重试只会反复拿到同一句话。原先 10Router 原样透传这坨英文 JSON，用户看不出
// 该做什么（还容易误以为额度用完而去充值）。
//
// 正则与文案放在本模块（叶子，无 import）而不是某个 handler 里，是因为两个消费方
// 都要用：ERROR_RULES 用它把 403 从「额度/故障」重分类为「配置状态、不冷却」，
// utils/error.js 用它给客户端补可执行的出路说明。两份真相源会漂。
export const REALNAME_GATE_RE = /real-name verification|realname|\bface verification\b|实名认证|bind your alibaba cloud account/i;

// 注意 provider 键用注册表 id：调用方传入的是 resolveProviderId 之后的值。
export const REALNAME_HINT = {
  "stepfun-plan-cn":
    "StepFun CN 的 Step Plan 免费套餐要求账号先完成实名（人脸）核验，未完成时上游一律拒绝，" +
    "与本机额度、与 10Router 都无关。出路：1. 打开 " +
    "https://account.stepfun.com/security?action=realname 完成人脸核验后重试（推荐）；" +
    "2. 或改用按量计费的 stepfun-cn 渠道（扣现金/代金券，无实名要求）。" +
    "该账号不会被锁定，但在实名完成前每次调用都会得到这条提示。",
  modelscope:
    "ModelScope 魔搭要求账号先绑定阿里云账号（实名认证）才能使用免费推理 API。出路：打开 " +
    "https://modelscope.cn/my/account 完成第三方账号「阿里云」绑定后重试。",
};

export const REALNAME_HINT_GENERIC =
  "上游要求该账号先完成实名认证（real-name verification），未完成前所有调用都会被拒绝；" +
  "请按上游提示的地址完成核验后重试。";

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
