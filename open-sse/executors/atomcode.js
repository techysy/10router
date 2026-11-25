import crypto from "crypto";
import { DefaultExecutor } from "./default.js";
import { ATOMCODE_CONFIG } from "../config/atomcode.js";
import { signAtomCode } from "../shared/atomcode/sign.js";
import { refreshAtomCodeToken } from "../shared/atomcode/auth.js";
import { resolveSessionId } from "../utils/sessionManager.js";

/**
 * AtomCodeExecutor — AtomGit CodingPlan gateway (llm-api.atomgit.com/v1).
 *
 * OpenAI-compatible, but the gateway rejects unsigned requests
 * (403 ATOMCODE_SIG_MISSING). Each request is signed over the exact body bytes
 * BaseExecutor.execute sends (JSON.stringify(transformedBody)), so signing
 * happens in buildHeaders, which receives that same object right before
 * serialization. Models other than qwen also expect x-atomcode-session-id
 * (glm answers "access disabled by request policy" without it).
 */
export class AtomCodeExecutor extends DefaultExecutor {
  constructor() {
    super("atomcode");
  }

  buildHeaders(credentials, stream = true, url, model, transformedBody) {
    const headers = super.buildHeaders(credentials, stream, url, model, transformedBody);
    const token = credentials?.accessToken || "";
    const userId = credentials?.providerSpecificData?.userId || "";
    headers["User-Agent"] = ATOMCODE_CONFIG.userAgent;

    let sessionId;
    try {
      sessionId = resolveSessionId({
        headers: credentials?.rawHeaders,
        body: transformedBody,
        connectionId: credentials?.connectionId,
        scope: "atomcode",
      });
    } catch {
      sessionId = null;
    }
    headers["x-atomcode-session-id"] = sessionId
      ? crypto.createHash("sha256").update(`atomcode:${sessionId}`).digest("hex").slice(0, 32)
      : crypto.randomUUID();

    if (token && userId) {
      Object.assign(headers, signAtomCode({
        path: ATOMCODE_CONFIG.chatPath,
        body: JSON.stringify(transformedBody),
        token,
        userId,
        version: ATOMCODE_CONFIG.clientVersion,
      }));
    }
    return headers;
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    const result = await refreshAtomCodeToken(credentials.refreshToken, log, proxyOptions);
    return result && !result.error ? result : null;
  }
}

export default AtomCodeExecutor;
