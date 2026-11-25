import { ATOMCODE_CONFIG } from "open-sse/config/atomcode.js";
import {
  startAtomCodeLogin,
  pollAtomCodeLogin,
  claimAtomCodePlan,
  fetchAtomCodeModels,
} from "open-sse/shared/atomcode/auth.js";

// AtomCode (AtomGit CodingPlan) — platform-broker polling flow, same as the
// official `atomcode login`:
// 1. GET acs.atomgit.com/auth/login?provider=atomgit → { state, login_url }
// 2. user opens login_url (AtomGit OAuth consent)
// 3. poll /auth/check?state → valid:true, then GET /auth/token?state
// After sign-in the free CodingPlan tier is claimed (idempotent) and the
// entitled model list is stored on the connection.
const atomcode = {
  config: ATOMCODE_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async () => {
    const { state, loginUrl } = await startAtomCodeLogin();
    return {
      device_code: state,
      verification_uri: loginUrl,
      user_code: "",
      interval: ATOMCODE_CONFIG.pollInterval / 1000,
      expires_in: ATOMCODE_CONFIG.loginTtlSeconds,
    };
  },
  pollToken: async (_config, state) => {
    try {
      const body = await pollAtomCodeLogin(state);
      if (!body) return { ok: true, data: { error: "authorization_pending" } };
      return {
        ok: true,
        data: {
          access_token: body.access_token,
          refresh_token: body.refresh_token || "",
          token_type: body.token_type || "Bearer",
          expires_in: body.expires_in,
          user: body.user || {},
        },
      };
    } catch (error) {
      return { ok: false, data: { error: error.code || "atomcode_error", error_description: error.message } };
    }
  },
  postExchange: async (tokens) => {
    const plan = await claimAtomCodePlan(tokens.access_token);
    let models = [];
    try {
      models = await fetchAtomCodeModels(tokens.access_token, plan.planType || "Lite");
    } catch {
      models = [];
    }
    return { plan, models };
  },
  mapTokens: (tokens, extra) => {
    const user = tokens.user || {};
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : 7 * 24 * 3600,
      email: user.email || undefined,
      name: user.name || user.username || undefined,
      displayName: user.name || user.username || undefined,
      providerSpecificData: {
        userId: String(user.id || ""),
        username: user.username || "",
        planType: extra?.plan?.planType || null,
        planName: extra?.plan?.planName || null,
        ...(extra?.models?.length ? { models: extra.models } : {}),
      },
    };
  },
};

export default atomcode;
