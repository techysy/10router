import crypto from "crypto";
import { DefaultExecutor } from "./default.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { getAppPackageVersion } from "../config/appConstants.js";

// OpenCode Go's free tier ties rate limits to the session header. A per-request
// random session makes every call look like a brand-new user (and repeated
// new sessions read as abuse) — pin one stable session per downstream session.
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeGoSession";
const MAX_SESSION_LENGTH = 256;

// The Go endpoint asks integrators to send typical agent traffic with a dedicated
// user-agent identifier rather than a generic SDK/HTTP-library name. Left alone, the
// runtime default would go out as `user-agent: node`, which reads as a scripted client
// and gives the endpoint no way to attribute the traffic.
const UA_HEADER = "user-agent";
const UA_FALLBACK_PREFIX = "10router";
// Generic runtime/library identifiers — never a client's own agent name. Matched as a
// prefix so versioned forms (`axios/1.7.0`, `python-requests/2.32.0`) are covered.
const GENERIC_UA = /^(node|node-fetch|undici|axios|got|curl|wget|python-requests|python-urllib|httpx|aiohttp|okhttp|java|go-http-client|libwww-perl|powershell|postmanruntime|insomnia|dart|deno|bun)\b/i;

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

// Header lookup by name, case-insensitively — the downstream client (or its proxy) is
// free to send `User-Agent`, `user-agent` or any other casing.
function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized || null;
  }
  return null;
}

function nativeSession(headers) {
  return normalizeSession(headerValue(headers, SESSION_HEADER));
}

let fallbackUserAgent = null;

/**
 * The User-Agent to send upstream.
 *
 * A verified client's own identifier is forwarded verbatim — the endpoint's client table
 * matches on it, and rewriting it would erase the attribution. Only a missing or generic
 * one (an SDK/runtime default) is replaced by our own identifier.
 *
 * @param {object|null} rawHeaders - the downstream client's headers
 * @returns {string}
 */
export function opencodeGoUserAgent(rawHeaders) {
  const downstream = headerValue(rawHeaders, UA_HEADER);
  if (downstream && !GENERIC_UA.test(downstream)) return downstream;
  if (!fallbackUserAgent) fallbackUserAgent = `${UA_FALLBACK_PREFIX}/${getAppPackageVersion()}`;
  return fallbackUserAgent;
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
    } else {
      const fallback = this.prepareRequestCredentials({ credentials });
      headers[SESSION_HEADER] = fallback[SESSION_FIELD];
    }

    // A registry-pinned UA is an explicit product decision and wins; otherwise this is
    // what keeps the runtime default (`user-agent: node`) from reaching the endpoint.
    if (!headers["User-Agent"] && !headers["user-agent"]) {
      headers["User-Agent"] = opencodeGoUserAgent(credentials?.rawHeaders);
    }
    return headers;
  }
}
