// Format identifiers
//
// Which of these can actually appear as a `targetFormat` matters — the values
// reach translator dispatch, thinking handling and usage accounting, and a
// format nobody produces is a branch that never runs. Verified 2026-10-10 over
// every `targetFormat:` in the provider registry, every `responseFormat:`
// returned by an executor and every provider config `format`:
//
//   produced  openai · openai-responses · claude · (config.format, which is
//             never "codex" nor "openai-response")
//   never     CODEX · OPENAI_RESPONSE (the singular — note it is NOT the same
//             as OPENAI_RESPONSES)
//
// Those two survive only as defensive `case` arms and pivot-table entries. They
// are not a supported target: do not add code that assumes one can arrive.
export const FORMATS = {
  OPENAI: "openai",
  OPENAI_RESPONSES: "openai-responses",
  OPENAI_RESPONSE: "openai-response",
  CLAUDE: "claude",
  GEMINI: "gemini",
  GEMINI_CLI: "gemini-cli",
  VERTEX: "vertex",
  CODEX: "codex",
  ANTIGRAVITY: "antigravity",
  KIRO: "kiro",
  CURSOR: "cursor",
  OLLAMA: "ollama",
  COMMANDCODE: "commandcode"
};

/**
 * Detect source format from request URL pathname + body.
 * Returns null to fall back to body-based detection.
 */
export function detectFormatByEndpoint(pathname, body) {
  // /v1/responses is always openai-responses
  if (pathname.includes("/v1/responses")) return FORMATS.OPENAI_RESPONSES;

  // /v1/messages is always Claude
  if (pathname.includes("/v1/messages")) return FORMATS.CLAUDE;

  // /v1/chat/completions + input[] → treat as openai (Cursor CLI sends Responses body via chat endpoint)
  if (pathname.includes("/v1/chat/completions") && Array.isArray(body?.input)) {
    return FORMATS.OPENAI;
  }

  return null;
}

