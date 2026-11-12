import { MEOO_CONFIG } from "../constants/oauth.js";

// Meoo （秒悟） — standard authorization_code + PKCE against meoo.com,
// mirroring the official CLI (@aliyun-meoo/cli dist/lib/oauth.js):
//   GET  /oauth/authorize?client_id&redirect_uri&response_type=code
//        &scope=cli.compat&state&code_challenge&code_challenge_method=S256
//   POST /oauth/token (form): grant_type=authorization_code, client_id,
//        code, redirect_uri, code_verifier
// The redirect URI is whatever the dashboard hands the generic OAuth route
// (the gateway's own callback), NOT the CLI's 127.0.0.1 loopback — whether
// Meoo's authorize endpoint accepts a non-loopback redirect for this
// public client is a known unknown (see the provider notes); the CLI
// client_id is reused because it is the only public client Meoo issues.
//
// The gateway never sees the OAuth token: postExchange resolves the
// project service AK and mapTokens stores it as the connection's apiKey,
// which DefaultExecutor prefers over accessToken when building the
// Authorization header.
const meoo = {
  config: MEOO_CONFIG,
  flowType: "authorization_code_pkce",
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: config.scope,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: config.codeChallengeMethod || "S256",
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    const { MeooService } = await import("@/lib/oauth/services/meoo");
    const tokens = await new MeooService().exchangeAuthorizationCode({
      code,
      redirectUri,
      codeVerifier,
    });
    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
      scope: tokens.scope,
      openid: tokens.openid,
      tenant_id: tokens.tenantId,
    };
  },
  postExchange: async (tokens) => {
    const { MeooService } = await import("@/lib/oauth/services/meoo");
    return new MeooService().resolveLoginExtra(tokens.access_token);
  },
  mapTokens: (tokens, extra) => {
    const identity = extra?.identity || {};
    const username = (identity.username || "").trim();
    const rawEmail = (identity.email || "").trim();
    const openid = tokens.openid || "";
    // Same fallback shape as qoder-cn: a stable synthetic identity when
    // the account exposes neither email nor username, so repeat logins
    // dedupe onto one connection row.
    const email = rawEmail || username || (openid ? `meoo-user-${openid}` : null);
    const mapped = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      email,
      displayName: username || rawEmail || (openid ? `meoo-user-${openid}` : null),
      providerSpecificData: {
        authMethod: "oauth",
        openid,
        tenantId: tokens.tenant_id || identity.tenantId || "",
        username,
        projectUrlId: extra?.projectUrlId || "",
        projectName: extra?.projectName || "",
        projectApiKey: extra?.projectApiKey || "",
        akStatus: extra?.akStatus || "pending",
        ...(extra?.akError ? { akError: extra.akError } : {}),
        ...(extra?.projectApiKey ? { akResolvedAt: new Date().toISOString() } : {}),
      },
    };
    // The project service AK rides in the connection's apiKey slot: the
    // credential assembler passes it through and DefaultExecutor's Bearer
    // descriptor prefers apiKey over accessToken, so chat traffic carries
    // the AK while the OAuth pair stays purely a control-plane credential.
    if (extra?.projectApiKey) mapped.apiKey = extra.projectApiKey;
    return mapped;
  },
};

export default meoo;
