import crypto from "crypto";
import { resolveSessionId } from "../utils/sessionManager.js";
import { ROLE } from "../translator/schema/roles.js";

// Shared outbound rules for the two CodeBuddy / WorkBuddy channels
// (codebuddy-cn and codebuddy-intl). Everything here runs at the LAST step
// before the body/headers leave the gateway, so it sees exactly the bytes the
// upstream will receive.
//
// ── Why (community-measured 11128 causes) ────────────────────────────────────
// 11128 "Illegal API invocation from an unapproved channel" is not only a WAF
// fingerprint of the egress: two request-side properties reproduce it on a
// plain, single request (MOONKEY0510/workbuddy_api, MIT):
//   1. messages[].role === "developer" — the upstream Go struct validates the
//      role against a whitelist that predates the OpenAI `developer` alias, so
//      a Codex-style request is rejected no matter which account sends it.
//   2. the bare substring "11128" ANYWHERE in the body trips an anti-probing
//      check that blocks the whole request (neighbouring codes 11148 / 11101 /
//      11115 pass), so even quoting our own error code in a chat message fails.
// Both are fixed here, before the channel-scope breaker (errorConfig.js) is
// ever consulted; that breaker stays as the fallback for 11128s that survive
// sanitizing (a genuine channel-level block).

/** The role OpenAI's newer spec uses for system-level instructions. */
export const CODEBUDDY_DEVELOPER_ROLE = ROLE.DEVELOPER;
/** The only role the upstream role whitelist accepts for system instructions. */
export const CODEBUDDY_SYSTEM_ROLE = ROLE.SYSTEM;

/**
 * The upstream check is a literal `strings.Contains(body, "11128")`, so the
 * replacement must be a REAL literal change (zero-width space does not work:
 * the upstream normalizes it away — measured in our Rust implementation).
 *
 * Why "11-128" and not "***":
 *   - it keeps the digits readable and recognizable as "that same number", so
 *     a user reviewing history still understands the text; "***" erases it;
 *   - it only inserts a hyphen between digits — no word/semantic change for
 *     normal Chinese/English sentences;
 *   - it matches the replacement form already used by our Rust worker, so both
 *     implementations rewrite identically.
 */
export const CODEBUDDY_BARE_11128 = "11128";
export const CODEBUDDY_SAFE_11128 = "11-128";

/**
 * Rewrite every string in the request body that contains the bare 11128.
 *
 * Boundary: this is a plain substring replace (not a digit-token match),
 * because the upstream check is a plain substring check — `x11128`,
 * `111280`, `11128.5` all trip it and must all be rewritten. The cost is that
 * a user conversation quoting 11128 (a ticket id, a price) is rewritten too;
 * that request would otherwise be rejected outright, so rewriting always wins.
 *
 * The same plain-substring rule applies to base64 media payloads (and object
 * keys) by design: a 5-digit sequence can occur by chance inside a data URL,
 * and rewriting it would corrupt that image — but the alternative is the whole
 * request being blocked, so the trade-off is still correct. Base64 data URLs
 * hit the sequence with probability on the order of 1e-9 per position.
 *
 * Only STRINGS are rewritten. A numeric JSON value exactly 11128 (e.g.
 * `max_tokens: 11128`) is left alone: converting it to a string would corrupt
 * the field's type, and the task scoped sanitizing to strings.
 */
function sanitizeString(value) {
  if (typeof value !== "string" || !value.includes(CODEBUDDY_BARE_11128)) return value;
  return value.split(CODEBUDDY_BARE_11128).join(CODEBUDDY_SAFE_11128);
}

// Own-property assignment that stays safe for a literal "__proto__" key coming
// from JSON.parse (plain `out[key] =` would mutate the prototype instead).
function setOwn(object, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
    return;
  }
  object[key] = value;
}

/**
 * Build a NEW tree (deep copy) with every string — values AND keys — passed
 * through sanitizeString. The caller's object is never touched; unchanged
 * subtrees are still copied so the result can be mutated freely afterwards.
 *
 * `seen` only guards against cyclic objects (not valid JSON, but a body could
 * be assembled by hand): a cycle throws, and the caller's try/catch returns the
 * body untouched — a partial clone with a dangling original reference would be
 * worse than the fail-open. Non-plain objects (Date, Buffer, class instances)
 * are returned untouched — they are not JSON bodies and rebuilding them would
 * corrupt them.
 */
function cloneAndSanitize(value, seen) {
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value !== "object") return value;

  const proto = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (!isArray && proto !== Object.prototype && proto !== null) return value;
  if (seen.has(value)) throw new TypeError("cyclic request body");

  seen.add(value);
  let out;
  if (isArray) {
    out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = cloneAndSanitize(value[i], seen);
  } else {
    out = {};
    for (const key of Object.keys(value)) {
      setOwn(out, sanitizeString(key), cloneAndSanitize(value[key], seen));
    }
  }
  seen.delete(value);
  return out;
}

function isDeveloperRole(role) {
  return typeof role === "string" && role.trim().toLowerCase() === CODEBUDDY_DEVELOPER_ROLE;
}

// Top-level `messages[].role` normalization. Deliberately does NOT merge,
// reorder or drop anything else: multiple system messages are not something we
// have measured upstream, so introducing a merge would add a new variable.
function normalizeDeveloperRoles(body) {
  if (!Array.isArray(body?.messages)) return;
  for (const message of body.messages) {
    if (!message || typeof message !== "object") continue;
    if (isDeveloperRole(message.role)) message.role = CODEBUDDY_SYSTEM_ROLE;
  }
}

/**
 * Sanitize a request body that is about to be sent to CodeBuddy CN / intl.
 *
 * Always returns a fresh deep copy; the input object is never mutated (the
 * caller may reuse it for retries or for another provider). Fail-open: any
 * internal error returns the input unchanged instead of failing the request —
 * a body that cannot be sanitized is still better than a request we never send.
 *
 * Runs at the END of the executor's transformRequest, i.e. after translation
 * and the provider-specific rewrites, so it covers the exact outbound shape
 * (including messages rebuilt by the intl profile).
 *
 * @param {object} body
 * @returns {object} sanitized body (deep copy), or the input on failure
 */
export function sanitizeCodeBuddyOutbound(body) {
  if (!body || typeof body !== "object") return body;
  try {
    const next = cloneAndSanitize(body, new WeakSet());
    normalizeDeveloperRoles(next);
    return next;
  } catch {
    return body;
  }
}

// Downstream headers whose value identifies one logical request. Prefer the
// most specific one; the first non-empty wins.
const REQUEST_ID_HEADER_KEYS = ["x-conversation-request-id", "x-request-id", "x-client-request-id"];
const HEX_32_RE = /^[a-f0-9]{32}$/i;

function headerValue(headers, keys) {
  if (!headers || typeof headers !== "object") return null;
  const pick = (raw) => {
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  for (const key of keys) {
    const value = pick(headers[key]);
    if (value) return value;
  }
  // Be tolerant of non-lowercase maps (tests, custom callers).
  for (const [name, raw] of Object.entries(headers)) {
    if (!keys.includes(name.toLowerCase())) continue;
    const value = pick(raw);
    if (value) return value;
  }
  return null;
}

function sha256Short(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// Deterministic serialization for the body hash. JSON.stringify preserves
// insertion order, and the translated body is rebuilt in the same order on
// every retry / account switch, so the digest is stable for one logical
// request. The fallback keeps it deterministic even for exotic bodies.
function stableBodySeed(body) {
  try {
    return JSON.stringify(body ?? null);
  } catch {
    const model = typeof body?.model === "string" ? body.model : "";
    const count = Array.isArray(body?.messages) ? body.messages.length : 0;
    return `model:${model}|messages:${count}`;
  }
}

/**
 * Resolve the 32-hex request id reused across retries and account switches.
 *
 * Priority:
 *   1. a request-id header supplied by the downstream client — the same
 *      logical request retried by the client keeps its own identity;
 *   2. a stable hash of the outbound body (messages + model included) — the
 *      gateway retries/account fallback re-send the same body, so they reuse
 *      the same id instead of presenting each attempt as a new burst.
 *
 * Never random (except if hashing itself throws — practically impossible):
 * a fresh id per attempt is exactly the fingerprint upstream reacts to.
 *
 * @param {object} headers - downstream raw headers (credentials.rawHeaders)
 * @param {object} body - the outbound (transformed) body
 * @returns {string} 32 lowercase hex chars
 */
export function resolveCodeBuddyRequestId(headers, body) {
  const incoming = headerValue(headers, REQUEST_ID_HEADER_KEYS);
  if (incoming) {
    // Already the expected shape: pass through byte-for-byte. Anything else
    // (UUID with dashes, arbitrary client id) is hashed so the header keeps
    // the 32-hex shape the upstream expects while staying deterministic.
    return HEX_32_RE.test(incoming) ? incoming.toLowerCase() : sha256Short(`client:${incoming}`);
  }
  return sha256Short(stableBodySeed(body));
}

/**
 * Build the X-Conversation-* / X-Request-ID header family for one attempt.
 *
 * X-Conversation-ID keeps the existing session-derived logic (stable per
 * downstream session / connection). The request/message ids are now derived
 * once per LOGICAL request (see resolveCodeBuddyRequestId) and reused by every
 * retry and account fallback, instead of a fresh random value per attempt.
 */
export function buildCodeBuddyConversationHeaders(credentials, transformedBody, scope) {
  const headers = {};
  try {
    const sessionId = resolveSessionId({
      headers: credentials?.rawHeaders,
      body: transformedBody,
      connectionId: credentials?.connectionId,
      scope,
    });
    headers["X-Conversation-ID"] = crypto
      .createHash("md5")
      .update(sessionId || `${scope}-default`)
      .digest("hex");
  } catch {
    headers["X-Conversation-ID"] = crypto.randomBytes(16).toString("hex");
  }

  let requestId;
  try {
    requestId = resolveCodeBuddyRequestId(credentials?.rawHeaders, transformedBody);
  } catch {
    requestId = crypto.randomBytes(16).toString("hex");
  }
  headers["X-Conversation-Request-ID"] = requestId;
  headers["X-Conversation-Message-ID"] = requestId;
  headers["X-Request-ID"] = requestId;
  headers["X-Agent-Intent"] = "craft";
  headers["X-Agent-Type"] = "main";
  return headers;
}
