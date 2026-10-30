// Privacy redaction & restore pipeline (issue #90) — public surface.
//
// Outbound: secretScanner redacts sensitive strings in the request body into
// deterministic placeholders (cache-friendly), recording the mapping on a
// per-request context. Inbound: streamRestorer reverses placeholders on the
// way back — both one-shot (non-streaming JSON) and per-chunk with a sliding
// window (SSE tokenizers split placeholders across chunks).
//
// Phase 1 = pure modules + tests; the mainline mount points (chatCore outbound
// per-attempt, stream.js/nonStreamingHandler inbound) are phase 2, tracked in
// issue #90. Conventions identical to rtk/: fail-open, in-place mutation,
// never throw into the request path.
export {
  privacyEnabledFor,
  resolvePrivacySalt,
  createRedactionContext,
  scanText,
  scanBody,
} from "./secretScanner.js";
export {
  restoreText,
  restoreBody,
  createStreamRestorer,
  createChunkRestorer,
} from "./streamRestorer.js";
