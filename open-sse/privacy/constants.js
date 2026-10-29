// Privacy redaction pipeline (issue #90) — shared grammar, limits and defaults.
// Pure constants only: no I/O, no state. Consumed by secretScanner.js (outbound)
// and streamRestorer.js (inbound).

// Placeholder grammar: __SEC_<TYPE>_<hash>__
// hash = HMAC-SHA256(salt, secret) truncated to 12 hex chars. The RFC proposed
// 8 (32-bit): two distinct secrets in one session would collide with p≈n²/2³²
// and restore the WRONG secret for one of them. 12 chars (48-bit) keeps the
// same fixed-length shape and makes collisions negligible at session scale
// (n=1000 → p≈2e-9). Same (secret, salt) → same placeholder across turns and
// restarts, which is what keeps upstream prompt-cache hits intact.
export const PLACEHOLDER_PREFIX = "__SEC_";
export const PLACEHOLDER_SUFFIX = "__";
export const HASH_LEN = 12;
export const MAX_TYPE_LEN = 4; // PEM, JWT, KEY, PWD, ENT, IPS, CUST
export const MAX_PLACEHOLDER_LEN =
  PLACEHOLDER_PREFIX.length + MAX_TYPE_LEN + 1 + HASH_LEN + PLACEHOLDER_SUFFIX.length; // 25

// Any complete placeholder (mapping membership decides whether it restores).
export const FULL_PLACEHOLDER_RE = /__SEC_[A-Z]{1,4}_[0-9a-f]{12}__/g;

// Streaming restorer: a tail that future chunks could still complete into a
// full placeholder. Anchored both ends; strictly a proper prefix of the full
// grammar (12 hex max, plus at most ONE underscore of the closing "__" pair —
// a tokenizer may split between the two). Anything longer or malformed can
// never become a placeholder and is emitted immediately — this bound is what
// keeps TTFT impact to a sub-25-char hold.
export const PARTIAL_PLACEHOLDER_RE =
  /^_(?:_(?:S(?:E(?:C(?:_(?:[A-Z]{0,4}(?:_(?:[0-9a-f]{0,12})_?)?)?)?)?)?)?)?$/;
export const MAX_TAIL_HOLD = MAX_PLACEHOLDER_LEN - 1;

// Rule defaults. Conservative by design: every rule that adds false positives
// in coding-agent traffic (entropy, IP literals) is opt-in, because a wrong
// redaction is lossless on the way back but still burns upstream prompt cache
// and can confuse the model.
export const DEFAULT_RULES = {
  apiKeyPatterns: true,        // sk- / ghp_ / github_pat_ / AKIA / AIza / xox / glpat
  privateKeys: true,           // PEM blocks
  jwtTokens: true,             // eyJ… JWT triples
  credentialAssignments: true, // token: "…" / password = … / Authorization: Bearer …
  entropyDetection: false,     // opt-in
  ipv4: false,                 // opt-in
  customKeywords: [],          // exact-match literals (codenames, internal domains)
};

// Entropy detection thresholds (only runs when explicitly enabled): candidate
// must be a quoted 20–80 char token, pass 4.3 bits/char Shannon entropy and
// mix character classes — pure hex words or base64 data URIs never qualify.
export const ENTROPY_MIN_LEN = 20;
export const ENTROPY_MAX_LEN = 80;
export const ENTROPY_THRESHOLD = 4.3;

// Fail-open resource guards: scanning must never blow up a request on
// pathological payloads. Beyond these caps the string/scan is skipped.
export const MAX_SCAN_STR_LEN = 2_000_000;
export const MAX_SCANNED_STRINGS = 5000;
export const MAX_WALK_DEPTH = 24;

// Outbound detection packs. Order matters only for overlap resolution, which
// prefers the earliest-start / longest match (PEM swallows assignments, an
// assignment value swallows an embedded sk- key — never the reverse).
export const SECRET_PATTERNS = [
  {
    id: "privateKeys",
    type: "PEM",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "jwtTokens",
    type: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: "apiKeyPatterns",
    type: "KEY",
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,})/g,
  },
];

// key[:=] value assignment shapes; capture group 2 is the secret value.
// The optional bearer/basic prefix keeps "Authorization: Bearer eyJ…" capturing
// the token rather than the scheme word.
export const ASSIGNMENT_RE = /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|authorization|credential)["']?\s*[:=]\s*(?:["']|(?:bearer|basic)\s)?["']?([A-Za-z0-9_\-+/=]{16,128})/gi;

// Quoted high-entropy candidate for the opt-in entropy rule (group 1).
export const ENTROPY_CANDIDATE_RE = /["']([A-Za-z0-9_/+=-]{20,80})["']/g;

// Opt-in IPv4 literal (collides with four-part version strings; off default).
export const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
