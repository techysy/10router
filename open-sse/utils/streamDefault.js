/**
 * Streaming-default resolution for /v1/chat/completions.
 *
 * OpenAI spec: an omitted `stream` field means NON-streaming (JSON response).
 * The upstream engine historically defaulted to streaming
 * (`body.stream !== false` — `undefined !== false` is true), which breaks
 * strict JSON parsers (official SDKs, curl) with a malformed
 * `text/event-stream` body; see issue #4.
 *
 * Flipping the default unconditionally would silently change behavior for
 * legacy clients that omit `stream` and expect SSE, so it ships behind the
 * experimental `strictStreamDefault` toggle (default off = legacy behavior).
 */

/**
 * Resolve the effective streaming decision from the request's `stream` field.
 * @param {object} p
 * @param {boolean|undefined} p.bodyStream - the raw `body.stream` value (may be undefined)
 * @param {boolean} p.providerRequiresStreaming - provider registry `forceStream` flag
 * @param {boolean} p.strictStreamDefault - experimental spec-compliant toggle
 * @returns {boolean} true = stream (SSE), false = non-streaming (JSON)
 */
export function resolveStreamDefault({ bodyStream, providerRequiresStreaming, strictStreamDefault }) {
  if (providerRequiresStreaming) return true;
  return strictStreamDefault === true ? bodyStream === true : bodyStream !== false;
}
