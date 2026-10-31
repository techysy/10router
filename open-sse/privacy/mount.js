// Mainline mount for per-attempt outbound redaction (issue #90).
//
// Behavioral contract (pinned by tests/unit/privacy-wiring.test.js):
//   - redactions happened → body is the REDACTED DEEP CLONE and privacyCtx
//     carries the placeholder map + chunkRestorer for the response path;
//   - nothing to redact / feature off / any error → body is the ORIGINAL
//     reference (untouched) and privacyCtx is null.
// The deep copy is load-bearing: chat.js retries the same body on the next
// account attempt, and a trusted channel must never receive placeholders
// minted for a failed untrusted one. Fail-open: scanBody/clone errors skip
// redaction entirely and never throw into the request path.

import {
  privacyEnabledFor,
  resolvePrivacySalt,
  createRedactionContext,
  scanBody,
} from "./secretScanner.js";
import { createChunkRestorer } from "./streamRestorer.js";

/**
 * @param {object} body parsed client request body (never mutated)
 * @param {object|null} credentials provider credentials (opt-in switch lives in providerSpecificData.privacy)
 * @param {(error: unknown) => void|null} onError debug hook — the mount itself never logs
 * @returns {Promise<{body: object, privacyCtx: object|null}>}
 */
export async function mountPrivacyRedaction(body, credentials, onError = null) {
  let privacyCtx = null;
  if (!privacyEnabledFor(credentials)) return { body, privacyCtx };
  try {
    privacyCtx = createRedactionContext({ salt: await resolvePrivacySalt() });
    const clone = structuredClone(body);
    scanBody(clone, privacyCtx);
    if (privacyCtx.stats.redacted > 0) {
      privacyCtx.chunkRestorer = createChunkRestorer(privacyCtx.map);
      return { body: clone, privacyCtx };
    }
    privacyCtx = null;
  } catch (error) {
    onError?.(error);
    privacyCtx = null;
  }
  return { body, privacyCtx };
}
