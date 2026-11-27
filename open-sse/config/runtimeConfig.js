// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
  // 直连兜底(代理失败后的裸连/MITM bypass 裸 socket)的建连上限(Issue #76):
  // 走到这条路径说明代理或系统 DNS 已失败过一次,海外受阻端点的裸连会被静默
  // 丢包,不设上限就是数百秒死等(实测 788s),还堵死上层多账号/Combo 顺位接力。
  // 默认与 FETCH_CONNECT_TIMEOUT_MS 同量级,env 可调。
  directFallbackTimeoutMs: envMs("DIRECT_FALLBACK_TIMEOUT_MS", 60 * 1000),
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");

// Inter-chunk stall timeout (once tokens are flowing). Claude Code-class
// clients abandon an idle stream at ~2min and surface their own cryptic
// "empty or malformed response" error — the watchdog must fire BEFORE that so
// our friendly in-band terminal frame wins the race. Providers with genuinely
// slow upstreams override per-registry or via env.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 120 * 1000);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Combo member probe budget (#176). When a combo seat is being tried, the
// connect-timeout for THAT request is shortened to this, so a dead member's
// TCP-accepts-but-never-responds hang doesn't consume the full delivery budget
// before the combo loop hands off to the next member. Direct (non-combo)
// requests are NOT affected — they keep FETCH_CONNECT_TIMEOUT_MS. Env: COMBO_PROBE_TIMEOUT_MS.
export const COMBO_PROBE_TIMEOUT_MS = envMs("COMBO_PROBE_TIMEOUT_MS", 12 * 1000);

// chat→responses 直连路由里,response.completed 为等真实 usage 尾部 chunk 而
// 延迟(见 translator/response/openai-responses.js)。上游 stall(无尾部 chunk、
// 无 [DONE]、连接不断开)时这个等待不能无界:watchdog 超时兜底补发终态事件。
export const PENDING_COMPLETION_FLUSH_MS = envMs("PENDING_COMPLETION_FLUSH_MS", 3 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

// Stop-sequence enforcement: a requested stop longer than this is left to the
// provider, because withholding text while a very long sequence could still be
// completing would stall the stream (see utils/stopSequenceGuard.js).
export const MAX_ENFORCED_STOP_LENGTH = 256;

export const TOKEN_SAVER_HEADER = "x-9router-token-saver";

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];
