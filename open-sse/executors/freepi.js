import crypto from "crypto";
import { DefaultExecutor } from "./default.js";
import { FREEPI_CONFIG } from "../config/freepi.js";

// Latest client version advertised by /client-version; the gateway answers 426
// below its minimum. Cached for an hour, refreshed lazily; a failed lookup is
// retried after a minute, and a 426 forces a refresh plus one retry.
const VERSION_TTL_MS = 3600_000;
const VERSION_RETRY_MS = 60_000;
const VERSION_RE = /^\d+\.\d+\.\d+/;
let versionCache = { value: FREEPI_CONFIG.clientVersion, at: 0, ttl: VERSION_TTL_MS };

function semverGt(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function bumpVersion(v) {
  if (typeof v === "string" && VERSION_RE.test(v) && semverGt(v, versionCache.value)) versionCache.value = v;
}

async function currentClientVersion(force = false) {
  if (!force && Date.now() - versionCache.at < versionCache.ttl) return versionCache.value;
  versionCache.at = Date.now();
  versionCache.ttl = VERSION_RETRY_MS;
  try {
    const res = await fetch(FREEPI_CONFIG.clientVersionUrl, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (typeof data?.latest === "string" && VERSION_RE.test(data.latest)) {
      bumpVersion(data.latest); // never step back below a minimum a 426 taught us
      bumpVersion(data.min);
      versionCache.ttl = VERSION_TTL_MS;
    }
  } catch {
    // keep the last known version; retry after VERSION_RETRY_MS
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
    const result = await super.execute(args);
    if (result?.response?.status !== 426) return result;
    // Client version below the gateway minimum: learn the new one and retry once.
    const before = versionCache.value;
    try {
      const text = await result.response.clone().text();
      bumpVersion(text.match(/required minimum \((\d+\.\d+\.\d+)/)?.[1]);
    } catch {
      // body unreadable; rely on /client-version
    }
    await currentClientVersion(true);
    if (versionCache.value === before) return result;
    args?.log?.info?.("FREEPI", `426: client version ${before} -> ${versionCache.value}, retrying`);
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
