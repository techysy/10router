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

// ── structured-chunk restore (stream.js mount, phase 2) ─────────────────────

// Only model-generated text payload fields ride the sliding window. Whitelist
// matters: pushing id/model/finish_reason strings would hold back innocent
// trailing underscores and delay whole frames. `delta` is the Responses-API
// output_text delta field (string), distinct from OpenAI's delta *object*.
const RESTORE_FIELDS = new Set(["content", "reasoning_content", "thinking", "text", "arguments", "delta"]);
const MAX_CHUNK_DEPTH = 12;

/**
 * Multi-window restorer for structured SSE chunks. Each text-payload field
 * is its own continuous stream (content ≠ thinking ≠ each tool_call's
 * arguments), so windows are keyed by the field's path inside the chunk and
 * state persists across chunks of the same stream.
 *
 * Mutates the chunk in place. Call restoreChunk() before serializing each
 * translated chunk; call flushLost() when the stream ends to account for a
 * partial placeholder the model left unterminated (truncation scenario —
 * those chars were held but never completed; see stream.js flush).
 *
 * @param {Map<string,string>|null} map placeholder → secret
 * @returns {{ restoreChunk(item: object): boolean, flushLost(): string }}
 */
export function createChunkRestorer(map) {
  const windows = new Map(); // path → single-window restorer

  const windowFor = (path) => {
    let w = windows.get(path);
    if (!w) {
      w = createStreamRestorer(map);
      windows.set(path, w);
    }
    return w;
  };

  return {
    /**
     * Restore every whitelisted text field of one structured chunk.
     * @param {object} item client-format chunk (mutated in place)
     * @returns {boolean} true when any text changed (callers that forward the
     *   original serialized line instead of re-serializing must re-serialize)
     */
    restoreChunk(item) {
      if (!item || typeof item !== "object" || !map || map.size === 0) return false;
      let replaced = false;
      try {
        const walk = (node, path, depth) => {
          if (node == null || typeof node !== "object" || depth > MAX_CHUNK_DEPTH) return;
          if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
              const el = node[i];
              // OpenAI streaming tool_calls arrive as one single-element delta
              // per chunk; parallel calls are distinguished only by the `index`
              // field inside. Key the window by that index (position is always
              // 0) or parallel calls share one window and a held partial tail
              // corrupts the next call's arguments.
              const idx =
                path.endsWith(".tool_calls") && el && typeof el === "object" && Number.isInteger(el.index)
                  ? el.index
                  : i;
              walk(el, `${path}[${idx}]`, depth + 1);
            }
            return;
          }
          for (const key of Object.keys(node)) {
            const value = node[key];
            const fieldPath = `${path}.${key}`;
            if (typeof value === "string") {
              if (RESTORE_FIELDS.has(key) && value.length > 0) {
                const safe = windowFor(fieldPath).push(value);
                if (safe !== value) {
                  node[key] = safe;
                  replaced = true;
                }
              }
            } else if (value && typeof value === "object") {
              walk(value, fieldPath, depth + 1);
            }
          }
        };
        walk(item, "", 0);
      } catch {
        return replaced; // fail-open: keep whatever was restored
      }
      return replaced;
    },

    /**
     * Stream ended: emit the fragments each window still held (a partial
     * placeholder the model never finished — truncation only). Returned text
     * is inert (placeholders here never matched a full secret), so it can be
     * surfaced or dropped by the caller; either way nothing leaks.
     * @returns {string}
     */
    flushLost() {
      let lost = "";
      for (const w of windows.values()) {
        const tail = w.flush();
        if (tail) lost += tail;
      }
      return lost;
    },
  };
}
