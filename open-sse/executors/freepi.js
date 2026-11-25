import crypto from "crypto";
import { DefaultExecutor } from "./default.js";
import { FREEPI_CONFIG } from "../config/freepi.js";

// Latest client version advertised by /client-version; the gateway answers 426
// below its minimum. Cached for an hour, refreshed lazily.
let versionCache = { value: FREEPI_CONFIG.clientVersion, at: 0 };
async function currentClientVersion() {
  if (Date.now() - versionCache.at < 3600_000) return versionCache.value;
  versionCache.at = Date.now();
  try {
    const res = await fetch(FREEPI_CONFIG.clientVersionUrl, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (typeof data?.latest === "string" && /^\d+\.\d+\.\d+/.test(data.latest)) versionCache.value = data.latest;
  } catch {
    // keep the last known version
  }
  return versionCache.value;
}

/**
 * FreePiExecutor — api.freepi.ai/v1/chat/completions (OpenAI-compatible).
 * Needs x-client-version (≥ server minimum) and a stable per-connection
 * x-session-id (the server leases one in-flight request per session).
 */
export class FreePiExecutor extends DefaultExecutor {
  constructor() {
    super("freepi");
  }

  async execute(args) {
    await currentClientVersion();
    return super.execute(args);
  }

  transformRequest(model, body, stream, credentials) {
    const out = super.transformRequest(model, body, stream, credentials);
    if (Array.isArray(out?.messages)) {
      out.messages = out.messages.map((m) => (m?.role === "developer" ? { ...m, role: "system" } : m));
    }
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      if (Number(out?.[key]) > FREEPI_CONFIG.maxTokens) out[key] = FREEPI_CONFIG.maxTokens;
    }
    return out;
  }

  buildHeaders(credentials, stream = true, url, model, transformedBody) {
    const headers = super.buildHeaders(credentials, stream, url, model, transformedBody);
    headers["x-client-version"] = versionCache.value;
    headers["x-session-id"] = credentials?.providerSpecificData?.sessionId
      || crypto.createHash("sha256").update(`freepi:${credentials?.connectionId || "default"}`).digest("hex").slice(0, 32);
    headers["x-ad-context"] = "none";
    return headers;
  }

  async refreshCredentials() {
    return null;
  }
}

export default FreePiExecutor;
