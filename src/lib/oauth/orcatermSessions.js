import { randomUUID } from "node:crypto";
import { ORCATERM_CONFIG } from "open-sse/config/orcaterm.js";
import { OrcaTermError, createOrcaTermPkceLogin, exchangeOrcaTermSession } from "open-sse/shared/orcaterm/auth.js";
import { getClientIp } from "../auth/loginLimiter.js";
import { smsRateLimit } from "../auth/smsRateLimiter.js";

const sessions = new Map();
const MAX_SESSIONS = 32;

function prune() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

/**
 * Start a desktop (PKCE) sign-in. The OrcaTerm session id and the code verifier
 * stay on the server; the dashboard only receives the authorize page to open.
 */
export async function createOrcaTermLoginSession(request) {
  prune();
  if (sessions.size >= MAX_SESSIONS) {
    throw new OrcaTermError("Too many pending OrcaTerm sign-ins; try again later", 429);
  }
  const rate = smsRateLimit(
    `orcaterm-authorize:${getClientIp(request)}`,
    ORCATERM_CONFIG.maxAuthorizeRequests,
    ORCATERM_CONFIG.authorizeWindowMs,
  );
  if (!rate.ok) {
    throw new OrcaTermError("Too many OrcaTerm sign-in attempts; try again later", 429, "RATE_LIMITED");
  }
  const { orcaSessionId, codeVerifier, authorizeUrl } = createOrcaTermPkceLogin();
  const sessionId = randomUUID();
  const expiresAt = Date.now() + ORCATERM_CONFIG.loginTtlMs;
  sessions.set(sessionId, { orcaSessionId, codeVerifier, authorizeUrl, expiresAt, exchanging: false });
  return { sessionId, authorizeUrl, expiresAt };
}

export function cancelOrcaTermLoginSession(sessionId) {
  sessions.delete(sessionId);
}

export async function completeOrcaTermLoginSession({ sessionId }) {
  prune();
  const session = sessions.get(sessionId);
  if (!session) {
    throw new OrcaTermError("OrcaTerm sign-in expired; start again", 400);
  }
  if (session.exchanging) {
    throw new OrcaTermError("OrcaTerm sign-in is already being completed", 409);
  }
  // OAuthExchangeToken is single-use: hold the session against concurrent redemption,
  // and drop it once OrcaTerm has answered either way.
  session.exchanging = true;
  try {
    return await exchangeOrcaTermSession(session.orcaSessionId, session.codeVerifier);
  } finally {
    sessions.delete(sessionId);
  }
}
