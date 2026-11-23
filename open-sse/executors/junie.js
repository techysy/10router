import { DefaultExecutor } from "./default.js";
import { JUNIE_FREE_HEADERS, resolveJunieUpstreamModel } from "../shared/junie/constants.js";
import { refreshJunieToken } from "../services/tokenRefresh/providers.js";

// Junie (JetBrains) free-lane executor. The lane is a standard OpenAI
// chat/completions endpoint, so DefaultExecutor does the heavy lifting;
// the Junie-specific deltas are:
//
//   - Auth: Bearer is the connection's id_token (stored in the
//     accessToken slot by the OAuth mapTokens — the access_token itself
//     gets 403 NO_LICENSE). DefaultExecutor's BEARER descriptor already
//     sends apiKey || accessToken, so no header work is needed there.
//   - The three Free-license headers ride in buildHeaders (the CLI
//     sends exactly these for a Free license; X-Forced-License-Free is
//     the decisive one).
//   - Model mapping: the single user-facing key (junie-lite) maps to
//     the current Lite backend string in transformRequest — one place
//     to change when JetBrains swaps the backend.
//   - Streaming requests must carry stream_options.include_usage=true
//     or the lane answers 400; transformRequest backfills it.
//   - Refresh: the reactive 401 path must use refreshJunieToken (the
//     returned id_token replaces the credential; the rotated
//     refresh_token is persisted by the caller).
export class JunieExecutor extends DefaultExecutor {
  constructor(provider = "junie") {
    super(provider);
  }

  buildHeaders(credentials, stream = true, url, model, body) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    Object.assign(headers, JUNIE_FREE_HEADERS);
    return headers;
  }

  transformRequest(model, body) {
    const transformed = super.transformRequest(model, body);
    if (transformed && typeof transformed === "object") {
      transformed.model = resolveJunieUpstreamModel(model);
      if (transformed.stream === true) {
        transformed.stream_options = {
          ...(transformed.stream_options || {}),
          include_usage: true,
        };
      }
    }
    return transformed;
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    try {
      const result = await refreshJunieToken(credentials.refreshToken, log, proxyOptions);
      if (result) log?.info?.("TOKEN", "junie refreshed");
      return result;
    } catch (error) {
      log?.error?.("TOKEN", `junie refresh error: ${error.message}`);
      return null;
    }
  }
}

export default JunieExecutor;
