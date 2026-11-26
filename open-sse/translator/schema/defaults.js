// Shared translator default values (magic strings used across multiple translators).

// Fallback model id when upstream chunk omits one.
export const MODEL_FALLBACK = "unknown";

// Default image mime when source omits it (base64 blobs without a declared type).
export const DEFAULT_IMAGE_MIME = "image/png";

// image_url.detail values Chat Completions accepts. The Responses API also allows
// "original", but Chat-only upstreams (e.g. DuMate) 400 on it (#178) — anything
// outside this set is normalized to the default when crossing into Chat format.
export const CHAT_IMAGE_DETAILS = ["auto", "low", "high"];
export const DEFAULT_IMAGE_DETAIL = "auto";
