import { DefaultExecutor } from "./default.js";
import { refreshAutoclawToken } from "../services/tokenRefresh/providers.js";
import {
  autoclawRegionFor,
  autoclawRegionConfig,
  autoclawSignHeaders,
  autoclawIdentityHeaders,
  autoclawRouteModel,
  bareToken,
  sanitizeAutoclawBody,
} from "../shared/autoclaw/client.js";

// AutoClaw（智谱澳龙）executor — one class for both registry entries
// (`autoclaw` intl OAuth, `autoclaw-cn` SMS). The chat endpoint speaks
// OpenAI chat/completions, so DefaultExecutor does the streaming; the deltas
// (all from AutoClaw2api lanes.BuildRequest, live-verified there):
//
//   - URL by REGION, not by entry: the access/refresh JWT's source_id decides
//     (agent* = CN managed gateway without /v1, else intl …/autoclaw/v1/…).
//     Tokens never cross domains (wrong host = 401), so a CN token imported
//     under the intl card still lands on the CN gateway. Provider id is only
//     the fallback when the JWT is undecodable.
//   - Headers: Bearer token in Authorization + X-Authorization, the
//     X-Auth-* md5 signature (recomputed per attempt — it carries a
//     timestamp), client identity headers incl. an explicit User-Agent (WAF
//     405s a missing/library UA), X-Request-Model = FULL route id (zai_auto),
//     fresh X-Request-Id, X-Agent-Id on CN. Never X-Harness-Type (2.x → 406).
//   - Body: max_tokens family stripped (406 with an empty body), unsupported
//     OpenAI fields dropped, model prefix stripped (zai_auto → auto), the 2.x
//     identity banner injected and foreign harness identities neutralized,
//     reasoning_effort clamped to the upstream's low/high/max.
//   - Refresh: refreshAutoclawToken (host order by source_id, /refresh →
//     /agent-refresh on 400002, rotated refresh token returned for the
//     caller to persist).
export class AutoclawExecutor extends DefaultExecutor {
  constructor(provider = "autoclaw") {
    super(provider);
  }

  region(credentials) {
    return autoclawRegionFor(this.provider, credentials || {});
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return autoclawRegionConfig(this.region(credentials)).chatUrl;
  }

  buildHeaders(credentials, stream = true, url, model, body) {
    const region = this.region(credentials);
    const cfg = autoclawRegionConfig(region);
    const token = bareToken(credentials?.accessToken || credentials?.apiKey || "");
    const requestId = crypto.randomUUID().replace(/-/g, "");
    const headers = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      Authorization: `Bearer ${token}`,
      "X-Authorization": `Bearer ${token}`,
      "X-Request-Model": autoclawRouteModel(model || body?.model),
      "X-Request-Id": requestId,
      "X-Trace-Id": requestId,
      ...autoclawSignHeaders(),
      ...autoclawIdentityHeaders(region),
    };
    if (cfg.agentId) headers["X-Agent-Id"] = cfg.agentId;
    return headers;
  }

  transformRequest(model, body) {
    const transformed = super.transformRequest(model, body);
    return sanitizeAutoclawBody(transformed, model || transformed?.model);
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    try {
      const result = await refreshAutoclawToken(credentials.refreshToken, {
        region: this.region(credentials),
        proxyOptions,
        log,
      });
      if (result?.accessToken) log?.info?.("TOKEN", `${this.provider} refreshed`);
      return result;
    } catch (error) {
      log?.error?.("TOKEN", `${this.provider} refresh error: ${error.message}`);
      return null;
    }
  }
}

export default AutoclawExecutor;
