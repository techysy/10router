// Normalize image_url.detail when crossing Responses → Chat Completions (#178).
// The Responses API accepts detail:"original" (Codex sends it), but Chat-only
// upstreams validate auto/low/high and 400 before the model runs (DuMate).
// Keep valid values; map missing/unknown ones to the Chat default. If an upstream
// genuinely supports "original", preserve it via an explicit provider quirk at
// that provider's layer — never by passing unknown values through here.
import { CHAT_IMAGE_DETAILS, DEFAULT_IMAGE_DETAIL } from "../schema/index.js";

export function normalizeChatImageDetail(detail) {
  return CHAT_IMAGE_DETAILS.includes(detail) ? detail : DEFAULT_IMAGE_DETAIL;
}