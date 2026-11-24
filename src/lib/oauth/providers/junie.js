import { JUNIE_CONFIG } from "../constants/oauth.js";
import { decodeJwtPayload, extractEmailFromAccessToken } from "../providerHelpers.js";

// Junie (JetBrains) — JBA OAuth 2.0 authorization-code + PKCE, wire-
// compatible with the official Junie CLI's sign-in (reverse-engineered
// by seanf/junie-bridge and live-verified 2026-11-23):
//   GET  https://junie.jetbrains.com/cli-auth?client_id=junie-cli
//        &scope=offline_access+openid+jb-authn-service&state
//        &code_challenge&redirect_uri=http://localhost:62345
//        (the CLI sends exactly these params — no response_type, no
//        code_challenge_method; S256 is implied by the challenge)
//   POST https://oauth.account.jetbrains.com/oauth2/token (form):
//        grant_type=authorization_code, code, code_verifier,
//        client_id, redirect_uri
//
// The registered redirect http://localhost:62345 is served by the CLI's
// own loopback listener; from the dashboard nothing listens there, so
// the user pastes the full redirect URL back (paste-callback, croli
// shape) and the generic exchange route parses the code out of it.
//
// CRITICAL mapping: the inference credential on the free lane is the
// **id_token**, not the access_token (live-verified — access_token
// answers 403 NO_LICENSE). mapTokens therefore stores the id_token in
// BOTH the accessToken slot (what the executor sends as Bearer) and the
// idToken slot, and stamps expiresAt from the id_token's own exp claim
// when present — that is the expiry the refresh lead must respect.
function idTokenExpiry(tokens) {
  const payload = tokens?.id_token ? decodeJwtPayload(tokens.id_token) : null;
  if (payload?.exp) return new Date(payload.exp * 1000).toISOString();
  return tokens?.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;
}

const junie = {
  config: JUNIE_CONFIG,
  flowType: "authorization_code_pkce",
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = new URLSearchParams({
      client_id: config.clientId,
      scope: config.scope,
      state: state,
      code_challenge: codeChallenge,
      // JetBrains registered exactly one redirect for this client (the
      // CLI's loopback listener); any other value is rejected, so the
      // config value wins over whatever the caller passed.
      redirect_uri: config.redirectUri || redirectUri,
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: config.clientId,
        redirect_uri: config.redirectUri || redirectUri,
      }),
      signal: AbortSignal.timeout(15000),
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      /* non-JSON error body */
    }
    if (!response.ok || !data?.id_token) {
      const detail = data?.error_description || data?.error || `HTTP ${response.status}`;
      throw new Error(`Junie token exchange failed: ${detail}`);
    }
    return data;
  },
  mapTokens: (tokens) => {
    const payload = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
    const email = extractEmailFromAccessToken(tokens.id_token) || null;
    const displayName = payload?.name || null;
    return {
      // The id_token IS the inference credential on the free lane.
      accessToken: tokens.id_token,
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token || null,
      expiresIn: tokens.expires_in,
      expiresAt: idTokenExpiry(tokens),
      scope: tokens.scope,
      email: email || undefined,
      displayName: displayName || undefined,
      providerSpecificData: {
        authMethod: "pkce",
        email: email || null,
      },
    };
  },
};

export default junie;
