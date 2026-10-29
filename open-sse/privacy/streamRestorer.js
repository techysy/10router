// Inbound placeholder restore (issue #90 phase 1) — turns placeholders the
// model echoed back into the original secrets before anything reaches the
// client. Consumes the mapping built by secretScanner.js on the outbound leg.
//
// Two shapes:
//  - restoreText/restoreBody: one-shot whole-response restore (non-streaming).
//  - createStreamRestorer: sliding-window per-chunk restore for SSE, where a
//    tokenizer may split one placeholder across any number of chunks. The
//    window holds back a bounded tail (≤ 24 chars, strictly a viable partial
//    prefix of the placeholder grammar) so TTFT stays untouched for ordinary
//    text; everything else is emitted on sight.
//
// Fail-safe direction is leak-safe: a placeholder the restorer cannot match
// (mutated by the model, unknown salt, mapping already discarded) passes
// through as-is — the client sees an inert token, never someone else's secret.
// Same fail-open contract as rtk/: never throws.
import {
  FULL_PLACEHOLDER_RE,
  PARTIAL_PLACEHOLDER_RE,
  MAX_TAIL_HOLD,
  MAX_WALK_DEPTH,
} from "./constants.js";

/**
 * One-shot restore over a whole string. Unknown placeholders pass through.
 * @param {string} text
 * @param {Map<string,string>|null} map placeholder → secret
 */
export function restoreText(text, map) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (!map || map.size === 0) return text;
  try {
    return text.replace(FULL_PLACEHOLDER_RE, (ph) => map.get(ph) ?? ph);
  } catch {
    return text;
  }
}

/**
 * Walk a response body in-place restoring every string value.
 * @param {object} body
 * @param {Map<string,string>|null} map
 * @returns {object} the same body reference, for call-site convenience
 */
export function restoreBody(body, map) {
  if (!body || typeof body !== "object" || !map || map.size === 0) return body;
  try {
    const walk = (node, depth) => {
      if (node == null || depth > MAX_WALK_DEPTH) return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      if (typeof node !== "object") return;
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (typeof value === "string") node[key] = restoreText(value, map);
        else if (value && typeof value === "object") walk(value, depth + 1);
      }
    };
    walk(body, 0);
  } catch {
    return body; // fail-open
  }
  return body;
}

/**
 * Create a per-request streaming restorer.
 * @param {Map<string,string>|null} map placeholder → secret (empty/absent ⇒
 *   pure passthrough with zero buffering)
 * @returns {{ push(chunk: string): string, flush(): string }}
 */
export function createStreamRestorer(map) {
  const active = !!map && map.size > 0;
  let pending = "";

  const emit = (buf) => buf.replace(FULL_PLACEHOLDER_RE, (ph) => map.get(ph) ?? ph);

  return {
    /**
     * Feed one chunk of model output; returns the substring that is safe to
     * send downstream right now.
     * @param {string} chunk
     * @returns {string}
     */
    push(chunk) {
      if (typeof chunk !== "string") return chunk;
      if (!active) return chunk;
      try {
        const buf = pending + chunk;
        pending = "";
        // No underscore anywhere ⇒ cannot start or complete a placeholder.
        if (!buf.includes("_")) return buf;
        const safe = emit(buf);
        // Hold back the longest viable partial suffix (≤ MAX_TAIL_HOLD chars).
        const maxHold = Math.min(MAX_TAIL_HOLD, safe.length);
        for (let len = maxHold; len >= 1; len--) {
          const tail = safe.slice(-len);
          if (PARTIAL_PLACEHOLDER_RE.test(tail)) {
            pending = tail;
            return safe.slice(0, safe.length - len);
          }
        }
        return safe;
      } catch {
        pending = ""; // fail-open: stop buffering, emit what we have
        return chunk;
      }
    },

    /**
     * Stream finished: release whatever the window still held. A viable
     * partial that never completed is just text — emit it as-is.
     * @returns {string}
     */
    flush() {
      const out = pending;
      pending = "";
      return emit(out);
    },
  };
}
