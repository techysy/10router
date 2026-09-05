import crypto from "crypto";
import { DefaultExecutor } from "./default.js";
import { resolveSessionId } from "../utils/sessionManager.js";

// OpenCode Go's free tier ties rate limits to the session header. A per-request
// random session makes every call look like a brand-new user (and repeated
// new sessions read as abuse) — pin one stable session per downstream session.
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeGoSession";
const MAX_SESSION_LENGTH = 256;

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) return normalizeSession(value);
  }
  return null;
}

// Deterministic per (connection session, client tool): the same downstream
// conversation always maps to the same upstream session, while different
// client tools never share one.
function translatedSession(sessionId, clientTool) {
  const digest = crypto
    .createHash("sha256")
    .update(`opencode-go\0${clientTool || "generic"}\0${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return `ses_${digest}`;
}

export class OpenCodeGoExecutor extends DefaultExecutor {
  constructor() {
    super("opencode-go");
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const native = nativeSession(sourceCredentials.rawHeaders);
    const resolved = normalizeSession(providerSessionId) || resolveSessionId({
      headers: sourceCredentials.rawHeaders,
      body,
      connectionId: sourceCredentials.connectionId,
      scope: "opencode-go",
    });

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: native || translatedSession(resolved, clientTool),
    };
  }

  async execute(args) {
    const credentials = this.prepareRequestCredentials(args);
    return super.execute({ ...args, credentials });
  }

  buildHeaders(credentials, stream = true, url, model) {
    const headers = super.buildHeaders(credentials || {}, stream, url, model);
    const prepared = credentials?.[SESSION_FIELD];
    if (prepared) {
      headers[SESSION_HEADER] = prepared;
      return headers;
    }

    const fallback = this.prepareRequestCredentials({ credentials });
    headers[SESSION_HEADER] = fallback[SESSION_FIELD];
    return headers;
  }
}
