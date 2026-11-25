// Outbound secret scanner (issue #90 phase 1) — redacts sensitive strings in a
// request body into deterministic placeholders and records the placeholder →
// secret mapping for the inbound restore leg.
//
// Contract mirrors rtk/ (AGENTS.md): mutate the body in-place, fail-open —
// any error returns null/unchanged input and never throws out of here. The
// caller owns the ctx lifetime: one per request attempt, mapping discarded
// with it (secrets never persist to disk or logs).
//
// Cache invariant: placeholders derive from HMAC-SHA256(salt, secret) alone —
// the same secret redacts to the same placeholder across turns, requests and
// restarts (salt is machine-stable), so upstream prompt caches keep hitting.
import crypto from "node:crypto";
import {
  DEFAULT_RULES,
  SECRET_PATTERNS,
  ASSIGNMENT_RE,
  ENTROPY_CANDIDATE_RE,
  IPV4_RE,
  FULL_PLACEHOLDER_RE,
  PLACEHOLDER_PREFIX,
  PLACEHOLDER_SUFFIX,
  HASH_LEN,
  MAX_TYPE_LEN,
  ENTROPY_MIN_LEN,
  ENTROPY_MAX_LEN,
  ENTROPY_THRESHOLD,
  MAX_SCAN_STR_LEN,
  MAX_SCANNED_STRINGS,
  MAX_WALK_DEPTH,
} from "./constants.js";

// ── per-connection opt-in (phase 2 wiring) ─────────────────────────────────

/**
 * Whether privacy redaction is ON for this account attempt. Explicit opt-in
 * only: `credentials.providerSpecificData.privacy` as `true` or
 * `{ enabled: true }` (same plumbing as strictProxy). No provider-class
 * defaults yet — shipping silent redaction on any channel by default would
 * break operators relying on zero behavior change (issue #90 phase 3 adds
 * the dashboard toggle + trust-level defaults).
 * @param {object|null} credentials
 * @returns {boolean}
 */
export function privacyEnabledFor(credentials) {
  const p = credentials?.providerSpecificData?.privacy;
  if (p === true) return true;
  if (p && typeof p === "object" && p.enabled === true) return true;
  return false;
}

// ── salt ────────────────────────────────────────────────────────────────────

/**
 * Machine-stable HMAC salt. Explicit env wins; otherwise the same
 * machine-id identity the credential cipher uses, so the salt survives
 * restarts (and therefore keeps upstream prompt caches warm across them).
 * Last-resort fallback is process-random: redaction still works, only
 * cross-restart cache determinism degrades. Never throws.
 * @returns {Promise<string>}
 */
export async function resolvePrivacySalt() {
  if (process.env.PRIVACY_SALT) return process.env.PRIVACY_SALT;
  try {
    const { getConsistentMachineId } = await import("../shared/machineId.js");
    return await getConsistentMachineId("privacy-redaction");
  } catch {
    return "privacy-redaction-fallback";
  }
}

// ── context ─────────────────────────────────────────────────────────────────

/**
 * Per-request redaction context: rules, the placeholder→secret map the
 * restore leg consumes, and a secret→placeholder index that keeps one
 * canonical placeholder per secret (extra cache fidelity when several rules
 * would match the same string).
 * @param {{ salt: string, rules?: object }} opts
 */
export function createRedactionContext({ salt, rules } = {}) {
  return {
    salt: String(salt ?? ""),
    rules: { ...DEFAULT_RULES, ...(rules || {}) },
    map: new Map(),          // placeholder → original secret
    secretIndex: new Map(),  // secret → canonical placeholder
    stats: { redacted: 0, byType: {} },
  };
}

function placeholderFor(ctx, secret) {
  let ph = ctx.secretIndex.get(secret);
  if (ph) return ph;
  const type = "KEY"; // canonical type label; the hash alone identifies the secret
  const hash = crypto
    .createHmac("sha256", ctx.salt)
    .update(secret, "utf8")
    .digest("hex")
    .slice(0, HASH_LEN);
  ph = `${PLACEHOLDER_PREFIX}${type}_${hash}${PLACEHOLDER_SUFFIX}`;
  ctx.secretIndex.set(secret, ph);
  ctx.map.set(ph, secret);
  return ph;
}

// ── detection ───────────────────────────────────────────────────────────────

function shannonEntropy(str) {
  const freq = new Map();
  for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function isPlausiblySecret(str) {
  if (shannonEntropy(str) < ENTROPY_THRESHOLD) return false;
  return /[a-z]/.test(str) && /[A-Z0-9]/.test(str); // mixed classes, not one alphabet
}

function isAlreadyPlaceholder(s) {
  return s.length >= 20 && s.startsWith(PLACEHOLDER_PREFIX) && s.endsWith(PLACEHOLDER_SUFFIX);
}

/**
 * Collect non-overlapping secret spans in a single string. Overlap policy:
 * earliest start wins, longest breaks ties — so a PEM block absorbs anything
 * inside it and an assignment value absorbs an embedded key prefix.
 */
function collectCandidates(text, ctx) {
  const out = [];
  const push = (start, end, secret, type) => {
    if (end > start && secret && !isAlreadyPlaceholder(secret)) out.push({ start, end, secret, type });
  };

  for (const pack of SECRET_PATTERNS) {
    if (!ctx.rules[pack.id]) continue;
    pack.re.lastIndex = 0;
    let m;
    while ((m = pack.re.exec(text)) !== null) {
      if (m[0].length === 0) { pack.re.lastIndex++; continue; }
      push(m.index, m.index + m[0].length, m[0], pack.type);
    }
  }

  if (ctx.rules.credentialAssignments) {
    ASSIGNMENT_RE.lastIndex = 0;
    let m;
    while ((m = ASSIGNMENT_RE.exec(text)) !== null) {
      if (m[0].length === 0) { ASSIGNMENT_RE.lastIndex++; continue; }
      const valueStart = m.index + m[0].indexOf(m[2], m[1].length);
      push(valueStart, valueStart + m[2].length, m[2], "KEY");
    }
  }

  if (ctx.rules.entropyDetection) {
    ENTROPY_CANDIDATE_RE.lastIndex = 0;
    let m;
    while ((m = ENTROPY_CANDIDATE_RE.exec(text)) !== null) {
      const s = m[1];
      if (s.length < ENTROPY_MIN_LEN || s.length > ENTROPY_MAX_LEN) continue;
      if (isAlreadyPlaceholder(s) || !isPlausiblySecret(s)) continue;
      push(m.index + 1, m.index + 1 + s.length, s, "ENT");
    }
  }

  if (ctx.rules.ipv4) {
    IPV4_RE.lastIndex = 0;
    let m;
    while ((m = IPV4_RE.exec(text)) !== null) {
      push(m.index, m.index + m[0].length, m[0], "IPS");
    }
  }

  const keywords = ctx.rules.customKeywords;
  if (Array.isArray(keywords)) {
    for (const kw of keywords) {
      if (typeof kw !== "string" || kw.length < 3) continue; // noise guard
      let from = 0;
      for (;;) {
        const at = text.indexOf(kw, from);
        if (at === -1) break;
        push(at, at + kw.length, kw, "CUST");
        from = at + kw.length;
      }
    }
  }

  // Resolve overlaps: earliest start, then longest span; drop the rest.
  out.sort((a, b) => (a.start - b.start) || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  let lastEnd = -1;
  for (const c of out) {
    if (c.start < lastEnd) continue;
    kept.push(c);
    lastEnd = c.end;
  }
  return kept;
}

// ── redaction ───────────────────────────────────────────────────────────────

/**
 * Redact one string against the context. Non-strings pass through unchanged
 * (callers hand back whatever the walk found); oversize strings are skipped
 * (fail-open resource guard).
 * @param {string} text
 * @param {object} ctx createRedactionContext() result
 * @returns {string} redacted text, or the original on any failure
 */
export function scanText(text, ctx) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (text.length > MAX_SCAN_STR_LEN) return text;
  try {
    const candidates = collectCandidates(text, ctx);
    if (candidates.length === 0) return text;

    let out = "";
    let pos = 0;
    for (const c of candidates) {
      out += text.slice(pos, c.start);
      out += placeholderFor(ctx, c.secret);
      pos = c.end;
      ctx.stats.redacted++;
      ctx.stats.byType[c.type] = (ctx.stats.byType[c.type] || 0) + 1;
    }
    out += text.slice(pos);
    return out;
  } catch {
    return text; // fail-open: never let the scanner break a request
  }
}

/**
 * Walk a request body in-place and redact every string value. Shape-agnostic:
 * OpenAI messages/input, Claude blocks, Gemini contents, tools, system — the
 * generic walk covers them all, which is the point of mounting before
 * translateRequest. base64 data URIs (images/audio) are skipped entirely:
 * they are not text and entropy-style rules would only burn CPU on them.
 * @param {object} body
 * @param {object} ctx createRedactionContext() result
 * @returns {{ redacted: number, byType: object }|null} stats, or null when
 *   there is nothing to scan / the scan failed (fail-open)
 */
export function scanBody(body, ctx) {
  if (!body || typeof body !== "object" || !ctx || !ctx.map) return null;
  let scanned = 0;
  try {
    const walk = (node, depth) => {
      if (node == null || scanned >= MAX_SCANNED_STRINGS) return;
      if (depth > MAX_WALK_DEPTH) return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      if (typeof node !== "object") return;
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (typeof value === "string") {
          scanned++;
          if (value.length > MAX_SCAN_STR_LEN) continue;
          // Skip base64 data URIs wholesale (images/audio payloads).
          if (value.startsWith("data:") && /;base64,/.test(value.slice(0, 128))) continue;
          node[key] = scanText(value, ctx);
        } else if (value && typeof value === "object") {
          walk(value, depth + 1);
        }
      }
    };
    walk(body, 0);
  } catch {
    return null; // fail-open: keep whatever was redacted so far, report failure
  }
  return ctx.stats;
}
