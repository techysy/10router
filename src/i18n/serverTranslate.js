// Server-side counterpart to the client runtime translate(): reads a literal
// dictionary straight off disk (same files public/i18n/literals/*.json the
// browser loads) and translates exact strings, falling back to English.
//
// Needed because some refusals reach the user as API error bodies (gateway
// 429s) — the client-side runtime never sees them, so the message has to be
// localized where it is produced. Dictionaries are flat English-keyed JSON,
// identical in shape to what translate() consumes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Candidate roots, tried in order: the running server's cwd (dev + standalone
// both keep public/ at the app root) and this module's repo-relative home
// (vitest runs with cwd=tests/, where the cwd candidate misses). The self-dir
// probe is wrapped: a bundler that leaves import.meta.url unusable must not
// take down every /v1 handler (this module is imported by auth.js).
const SELF_DIR = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
})();
const LITERALS_ROOTS = [
  path.join(process.cwd(), "public", "i18n", "literals"),
  ...(SELF_DIR ? [path.join(SELF_DIR, "..", "..", "public", "i18n", "literals")] : []),
];

// Canonical file names for the region-carrying locales; everything else ships
// as a bare lowercase base (de.json, ja.json, …).
const REGION_TAGS = {
  "zh-cn": "zh-CN", "zh-hans": "zh-CN",
  "zh-tw": "zh-TW", "zh-hant": "zh-TW",
  "pt-br": "pt-BR", "pt-pt": "pt-PT",
};

// Parsed dictionaries by canonical locale; null = a locale we tried and failed
// to read (never re-hit the disk for it). `en` needs no dictionary at all —
// the keys ARE English.
const dicts = new Map([["en", null]]);

function loadDict(locale) {
  if (dicts.has(locale)) return dicts.get(locale);
  let dict = null;
  for (const root of LITERALS_ROOTS) {
    try {
      dict = JSON.parse(fs.readFileSync(path.join(root, `${locale}.json`), "utf8"));
      break;
    } catch {
      // try the next root; missing/corrupt everywhere → English fallback
    }
  }
  dicts.set(locale, dict);
  return dict;
}

// Map a locale tag (Accept-Language entry or cookie value) onto a shipped
// dictionary: region-aware exact match first, then the bare base language
// (zh → zh-CN, pt → pt-BR). Unknown/absent → "en".
function canonicalizeTag(tag) {
  const lower = tag.toLowerCase();
  if (REGION_TAGS[lower]) return REGION_TAGS[lower];
  const base = lower.split("-")[0];
  if (base === "zh") return "zh-CN";
  if (base === "pt") return "pt-BR";
  // Generic fallthrough feeds a filename (`${locale}.json`) — the tag comes
  // from a caller-controlled cookie / Accept-Language header, so only a bare
  // alpha base language may pass; anything shaped like a path reads as "en".
  if (lower === "en") return "en";
  return /^[a-z]{2,3}$/.test(base) ? base : "en";
}

/**
 * Pick the best shipped locale for an Accept-Language header (or a single
 * tag). Candidates are tried in header order; the first whose dictionary file
 * exists wins. Falls back to "en".
 */
export function resolveLocale(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return "en";
  const candidates = headerValue
    .split(",")
    .map((part) => part.split(";")[0].trim())
    .filter((t) => t && t !== "*");
  for (const raw of candidates) {
    const locale = canonicalizeTag(raw);
    if (locale === "en") return "en";
    if (loadDict(locale)) return locale;
  }
  return "en";
}

/**
 * Best-effort locale for an incoming fetch Request: the dashboard's `locale`
 * cookie when the caller shares the origin (browsers send it automatically),
 * else the Accept-Language header, else "en". Cookie wins because it is the
 * language the user explicitly picked in the UI, while Accept-Language is the
 * OS/browser default which may not match the dashboard they are looking at.
 */
export function resolveRequestLocale(request) {
  if (!request?.headers) return "en";
  try {
    const cookie = request.headers.get("cookie") || "";
    const match = /(?:^|;\s*)locale=([^;]+)/.exec(cookie);
    if (match) {
      const fromCookie = canonicalizeTag(decodeURIComponent(match[1]).trim());
      if (fromCookie === "en" || loadDict(fromCookie)) return fromCookie;
    }
  } catch { /* malformed cookie → fall through to header */ }
  return resolveLocale(request.headers.get("accept-language"));
}

/**
 * Translate one exact string against a locale's dictionary. Falls back to the
 * input (English) on any miss — same contract as the client translate().
 */

// Some error text that reaches the user is upstream free prose wrapped in
// pipeline prefixes (`[503]: … (reset after 30s)`), so an exact dictionary
// key can never match it. UPSTREAM_PATTERNS rewrite the matched upstream
// sentence in place — surrounding prefixes and retry suffixes survive the
// replace, and reworded upstream text falls back to passthrough. Server-side
// only: these strings arrive inside dashboard test results, never through
// the client runtime translate(), so the table lives here rather than in the
// literals files the client also consumes.
const UPSTREAM_PATTERNS = [
  {
    // Oxion gateway-wide 503 during a maintenance window (2026-10-24, live):
    // "Our service is being upgraded right now and will be back to normal
    // within a few minutes. Please retry shortly — your plan and balance
    // are not affected."
    re: /Our service is being upgraded[\s\S]*?not affected\./i,
    "zh-CN": "上游正在升级维护，通常几分钟内恢复，稍后自动重试即可；套餐与余额不受影响。",
    "zh-TW": "上游正在升級維護，通常幾分鐘內恢復，稍後自動重試即可；方案與餘額不受影響。",
  },
  {
    // DEFAULT_ERROR_MESSAGES 503/502/504 — the bare defaults surface verbatim
    // whenever the upstream body carries no message of its own.
    re: /Service temporarily unavailable/gi,
    "zh-CN": "服务暂时不可用（上游维护或过载，稍后重试）",
    "zh-TW": "服務暫時不可用（上游維護或過載，稍後重試）",
  },
  {
    re: /Bad gateway - upstream provider error/gi,
    "zh-CN": "网关错误——上游供应商故障",
    "zh-TW": "閘道錯誤——上游供應商故障",
  },
  {
    re: /Gateway timeout/gi,
    "zh-CN": "网关超时",
    "zh-TW": "閘道逾時",
  },
];

export function serverTranslate(locale, text) {
  if (!text || typeof text !== "string") return text;
  const dict = loadDict(locale);
  const exact = dict && dict[text.trim()];
  if (exact) return exact;
  if (locale === "en") return text;
  for (const pattern of UPSTREAM_PATTERNS) {
    const replacement = pattern[locale];
    if (replacement && pattern.re.test(text)) {
      pattern.re.lastIndex = 0; // /g flags are stateful across .test() calls
      return text.replace(pattern.re, replacement);
    }
  }
  return text;
}
