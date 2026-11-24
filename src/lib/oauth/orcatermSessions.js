import { randomUUID } from "node:crypto";
import { ORCATERM_CONFIG } from "open-sse/config/orcaterm.js";
import { OrcaTermError, startOrcaTermLogin, exchangeOrcaTermCode } from "open-sse/shared/orcaterm/auth.js";
import { getClientIp } from "../auth/loginLimiter.js";
import { smsRateLimit } from "../auth/smsRateLimiter.js";

const sessions = new Map();
const MAX_SESSIONS = 32;
let inFlightLoginRequests = 0;

function prune() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

export async function createOrcaTermLoginSession(request) {
  prune();
  if (
    sessions.size + inFlightLoginRequests >= MAX_SESSIONS ||
    inFlightLoginRequests >= ORCATERM_CONFIG.maxInFlightLoginRequests
  ) {
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
  inFlightLoginRequests++;
  try {
    const login = await startOrcaTermLogin();
    prune();
    if (sessions.size >= MAX_SESSIONS) {
      throw new OrcaTermError("Too many pending OrcaTerm sign-ins; try again later", 429);
    }
    const sessionId = randomUUID();
    const session = { ...login, expiresAt: Date.now() + ORCATERM_CONFIG.loginTtlMs };
    sessions.set(sessionId, session);
    return { sessionId, ...session };
  } finally {
    inFlightLoginRequests--;
  }
}

export function cancelOrcaTermLoginSession(sessionId) {
  sessions.delete(sessionId);
}

export async function completeOrcaTermLoginSession({ sessionId, code, state }) {
  prune();
  const session = sessions.get(sessionId);
  if (!session || state !== session.state) {
    throw new OrcaTermError("OrcaTerm sign-in expired or state did not match; start again", 400);
  }
  if (typeof code !== "string" || !code.trim() || code.length > 2048) {
    throw new OrcaTermError("Missing or invalid WeChat authorization code", 400);
  }
  // Consume before awaiting the single-use upstream exchange, including concurrent replays.
  sessions.delete(sessionId);
  return exchangeOrcaTermCode(code, session.state);
}
