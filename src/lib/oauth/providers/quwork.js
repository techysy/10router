import { QUWORK_CONFIG } from "../constants/oauth.js";
import {
  quworkSendLoginCode,
  quworkLoginByCode,
  quworkProbeInference,
  quworkRefreshAccess,
  quworkSelfInfo,
  quworkPointsFromSelf,
  quworkConnectionName,
  quworkIdentity,
  quworkDeviceIdentifier,
  QUWORK_PHONE_RE,
} from "open-sse/shared/quwork/client.js";

// QuWork（quwork.cn）— 手机号短信直登（与 Loomy 短信直登同构的 sms_code 流程）：
//   1) dashboard 打开 /api/oauth/quwork/captcha 完成阿里云滑块 → captchaVerifyParam
//   2) POST /api/sendVerifyCode?aliyun_captcha=<token>  form {phone,type:login}
//   3) POST /api/user/client/login  json {phone,verification_code,platform:qurvis,device_identifier,device_uuid:""}
//      → { llm_token, token, expire, user }
// 另支持粘贴 llm_token（+ 可选账号 token）。协议源自 quwork-auth@0.1.0（MIT）。
//
// 纯函数无 DB 依赖：路由层负责把 mapTokens 结果落成 providerConnection。
// 不内置代理：请求走全局 fetch（10Router 全局出站代理 / 环境变量代理生效）。
export { QUWORK_PHONE_RE };

const quwork = {
  config: QUWORK_CONFIG,
  flowType: "sms_code",

  /** Step 1: send the SMS code (captchaToken = Aliyun captchaVerifyParam). */
  sendCode: async (config, phone, captchaToken) => quworkSendLoginCode(phone, captchaToken),

  /** Step 2: SMS code → token pair, in OAuth token-response shape. */
  exchangeToken: async (config, code, phone) => {
    // 记下登录用的 device_identifier：/api/user/activate 要求同一个设备标识。
    const deviceId = quworkDeviceIdentifier();
    const cred = await quworkLoginByCode(phone, code, { deviceId });
    return {
      access_token: cred.accessToken,
      refresh_token: cred.accessToken,
      llm_token: cred.llmToken,
      expires_in: Math.max(60, Math.floor((cred.accessExpiresAt - Date.now()) / 1000)),
      _quworkUser: { uid: cred.uid, nickname: cred.nickname, phone: cred.phone },
      _quworkDeviceId: deviceId,
    };
  },

  /**
   * Pasted tokens: llm_token is required (validated against /v1/models, no
   * points spent); the account token is optional and, when given, renewed
   * once so we learn its expiry and the account identity.
   */
  importToken: async (config, { llmToken, accessToken }) => {
    const llm = String(llmToken || "").trim();
    if (!llm) throw new Error("请粘贴 llm_token");
    // 405 = QuWork 网关的阿里云 WAF 拒绝了本机出口（非中国大陆 IP）：token 无法在此
    // 校验，但仍保存——用户随后给该连接配置连接级代理（或全局出站代理）即可用。
    let probe;
    try { probe = await quworkProbeInference(llm); } catch (e) { probe = { ok: false, status: 0, error: e?.message || String(e) }; }
    const unreachable = !probe.ok && (probe.status === 405 || probe.status === 0);
    if (!probe.ok && !unreachable) throw new Error(`llm_token 校验失败：${probe.error}`);
    const tokens = { llm_token: llm, access_token: "", refresh_token: "", expires_in: undefined, _quworkUser: {}, _warning: "" };
    const acc = String(accessToken || "").trim();
    if (unreachable) {
      tokens._warning = `本机无法直连 QuWork 网关（${probe.status === 405 ? "HTTP 405，非中国大陆 IP" : probe.error}），token 未校验即保存；请为该连接配置国内代理后点“测试”。`;
      if (acc) { tokens.access_token = acc; tokens.refresh_token = acc; }
      return tokens;
    }
    if (acc) {
      try {
        const next = await quworkRefreshAccess(acc);
        tokens.access_token = next.accessToken;
        tokens.refresh_token = next.accessToken;
        tokens.expires_in = Math.max(60, Math.floor((next.accessExpiresAt - Date.now()) / 1000));
        try {
          const self = await quworkSelfInfo(next.accessToken);
          tokens._quworkUser = {
            uid: self?.id === undefined || self?.id === null ? "" : String(self.id),
            nickname: quworkPointsFromSelf(self).nickname,
            phone: self?.phone ? String(self.phone) : "",
          };
        } catch { /* identity optional */ }
      } catch (e) {
        tokens._warning = `access token 无效（${e.message}），已仅保存 llm_token（积分/签到不可用）`;
      }
    }
    return tokens;
  },

  mapTokens: (tokens, extra = {}) => {
    const user = tokens._quworkUser || {};
    const llmToken = String(tokens.llm_token || "").trim();
    const account = String(tokens.access_token || "").trim();
    const phone = String(user.phone || "").trim();
    const name = quworkConnectionName(user);
    return {
      // apiKey = llm_token (inference Bearer; DefaultExecutor prefers apiKey).
      apiKey: llmToken,
      accessToken: account || llmToken,
      refreshToken: account || null,
      expiresIn: account ? tokens.expires_in : undefined,
      email: quworkIdentity({ uid: user.uid, phone, llmToken }),
      name,
      displayName: name,
      providerSpecificData: {
        authMethod: "quwork",
        credentialSource: extra.credentialSource || "sms",
        quworkUid: user.uid || "",
        quworkNickname: user.nickname || "",
        quworkPhoneMasked: phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : "",
        ...(account ? {} : { quworkTokenOnly: true }),
        ...(tokens._quworkDeviceId ? { quworkDeviceId: tokens._quworkDeviceId } : {}),
        loginAt: new Date().toISOString(),
      },
    };
  },
};

export default quwork;
