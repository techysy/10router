import { CROLI_CONFIG } from "../constants/oauth.js";

// Croli（croli.net）— standard authorization_code + PKCE against
// clerk.croli.net（issuer），与桌面端 croli-server.exe 的 desktop_auth.rs
// 同协议（CD 侧 croliAuth.js 同源，2026-11-20 全链实测）：
//   GET  /oauth/authorize?response_type=code&client_id&redirect_uri&scope
//        &state&code_challenge&code_challenge_method=S256
//   POST /oauth/token (form): grant_type=authorization_code, code,
//        client_id, redirect_uri, code_verifier
//   GET  /oauth/userinfo (Bearer) → { sub, email, name, picture }
//
// Clerk 只注册 loopback redirect_uri（127.0.0.1:任意端口/callback 通配）——
// dashboard 发起时 redirect_uri 必须是 loopback 形状（antigravity 的
// paste-callback 模式）：授权完成后浏览器跳转 127.0.0.1 必然打不开，
// 用户复制地址栏完整 URL 粘贴回来，由通用 callback 路由解析 code。
//
// 换票响应的 token_type 是小写 "bearer"（RFC 6749 大小写不敏感）——
// 严格等 "Bearer" 会把成功响应误判为格式无效（2026-11-20 实测踩坑）。
//
// postExchange 领取模型网关 key：POST api.croli.net/relay/api/deepseek/sk
// （幂等，同一账号恒回同一把 csk_），存 providerSpecificData.croliSk +
// apiKey 槽——DefaultExecutor 的 Bearer 描述符优先 apiKey，聊天流量带
// csk_ 走 ds.croli.net/v1，OAuth pair 只是 credits 控制面凭据（签到/
// 余额/refresh）。
const croli = {
  config: CROLI_CONFIG,
  flowType: "authorization_code_pkce",
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: config.scope,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: config.codeChallengeMethod || "S256",
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await res.text().catch(() => "");
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 非 JSON（Cloudflare HTML 等）走下方诊断 */ }
    if (!res.ok) {
      throw new Error(`Croli token exchange failed: ${body.error_description || body.error || `HTTP ${res.status}`}`);
    }
    // RFC 6749：token_type 大小写不敏感（Clerk 返回小写 "bearer"）
    if (typeof body.access_token !== "string" || !body.access_token) {
      const keys = Object.keys(body).join(",");
      throw new Error(`Croli token response missing access_token (HTTP ${res.status}, got: ${keys || raw.slice(0, 120)})`);
    }
    return body;
  },
  postExchange: async (tokens) => {
    // userinfo 拿身份（name/email 用于连接命名）+ 领网关 sk（幂等）
    let identity = {};
    try {
      const res = await fetch(CROLI_CONFIG.userInfoUrl, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) identity = await res.json();
    } catch { /* 身份读失败不阻断连接 */ }

    let croliSk = "";
    let skError = "";
    try {
      const res = await fetch(CROLI_CONFIG.skClaimUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && typeof body.sk === "string" && body.sk) croliSk = body.sk;
      else skError = body.error || body.message || `HTTP ${res.status}`;
    } catch (e) {
      skError = e?.message || "network";
    }

    return { identity, croliSk, skError };
  },
  mapTokens: (tokens, extra) => {
    const identity = extra?.identity || {};
    const sub = (identity.sub || "").trim();
    const rawEmail = (identity.email || "").trim();
    const displayName = (identity.name || "").trim();
    // 稳定归户身份：Clerk sub；无 sub 时回退 email 形状的合成键
    const email = rawEmail || (sub ? `croli-user-${sub}` : null);
    const mapped = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      email,
      displayName: displayName || rawEmail || (sub ? `croli-user-${sub}` : null),
      providerSpecificData: {
        authMethod: "oauth",
        croliSub: sub,
        croliSk: extra?.croliSk || "",
        croliAvatarUrl: identity.picture || "",
        // sk 领取失败（网络抖动等）不阻断连接：签到/余额仍可用，say-hi
        // 与聊天在下次 backgroundTokenRefresh / checkin tick 里重领
        ...(extra?.skError ? { croliSkError: extra.skError } : {}),
      },
    };
    // 网关 key 走 apiKey 槽（DefaultExecutor Bearer 描述符优先），与 meoo 同构
    if (extra?.croliSk) mapped.apiKey = extra.croliSk;
    return mapped;
  },
};

export default croli;
