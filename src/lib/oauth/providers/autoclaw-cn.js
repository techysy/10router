// AutoClaw（智谱澳龙）国内版 — +86 手机验证码直登（AutoClaw2api SmsLogin /
// opencode-autoclaw-auth phoneSmsMethod 同源移植）。
//
// 国内版没有网页 OAuth（overseasv1 是国际版专用），登录是两步 API，全挂在
// 国内账号域 autoglm-api.zhipuai.cn：
//   POST /userapi/v1/agent-send-code { source_id, device_id, phone }
//   POST /userapi/v1/agent-login/    { source_id, device_id, phone, code }
//        → { access_token, refresh_token, user_id }
// 两个实证约束：验证码必须按 **数字** 发送（字符串 → 400001；code:0 会被当
// 空值），端点路径带尾斜杠（少斜杠 404）。device_id 用本机稳定 id——refresh
// 时服务端按 JWT 里的 device_id 对账，登录与续期必须同一份。
//
// 纯函数无 DB 依赖：路由层（/api/oauth/autoclaw-cn/sms-*）负责把结果落成
// oauth 连接（accessToken + 轮换 refreshToken + expiresAt），之后的续期、
// 积分卡、签到与国际版共用同一套（按 JWT source_id 选域）。

import {
  autoclawDeviceId,
  autoclawDisplayName,
  fetchAutoclawProfile,
  loginAutoclawBySms,
  sendAutoclawSmsCode,
} from "open-sse/shared/autoclaw/client.js";
import { AUTOCLAW_CN_PHONE_RE, AUTOCLAW_REGIONS } from "open-sse/shared/autoclaw/constants.js";

/** 路由层限流键预校验用（与 send/login 内部同一条规则） */
export const AUTOCLAW_CN_PHONE = AUTOCLAW_CN_PHONE_RE;

function cleanPhone(phone) {
  const p = String(phone || "").trim().replace(/^\+?86/, "");
  if (!AUTOCLAW_CN_PHONE_RE.test(p)) throw new Error("手机号格式不正确（11 位，不带 +86）");
  return p;
}

/** 第一步：下发短信验证码。 */
export async function sendAutoclawCnSms(phone, { fetchImpl } = {}) {
  const p = cleanPhone(phone);
  const deviceId = await autoclawDeviceId();
  await sendAutoclawSmsCode(p, { deviceId, fetchImpl });
  return { phone: p };
}

/** 第二步：验证码换 token 对 → 建连接所需的一切。 */
export async function loginAutoclawCnBySms({ phone, code }, { fetchImpl } = {}) {
  const p = cleanPhone(phone);
  const c = String(code || "").trim();
  if (!/^\d{4,8}$/.test(c)) throw new Error("验证码应为 4–8 位数字");
  const deviceId = await autoclawDeviceId();
  const fields = await loginAutoclawBySms({ phone: p, code: c }, { deviceId, fetchImpl });
  // 显示名：user-profile 的昵称/手机号（登录响应的 user_name 常为空）
  const profile = await fetchAutoclawProfile(fields.accessToken, { region: "cn", deviceId, fetchImpl });
  return { ...fields, phone: p, deviceId, profile };
}

/** 连接展示名（手机号脱敏） */
export function autoclawCnConnectionName(phone, profile) {
  const masked = phone && phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : null;
  return autoclawDisplayName(profile, masked ? `AutoClaw CN (${masked})` : "AutoClaw CN");
}

/** createProviderConnection 载荷（route 与测试共用）。 */
export function autoclawCnConnectionPayload(r) {
  return {
    provider: "autoclaw-cn",
    authType: "oauth",
    name: autoclawCnConnectionName(r.phone, r.profile),
    // 稳定归户身份：同一 user_id 再登录=原位更新凭证（不叠新连接）
    email: r.userId ? `autoclaw-${r.userId}` : null,
    displayName: autoclawCnConnectionName(r.phone, r.profile),
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    expiresAt: new Date(Date.now() + r.expiresIn * 1000).toISOString(),
    isActive: true,
    testStatus: "active",
    providerSpecificData: {
      authMethod: "sms",
      region: "cn",
      userId: r.userId,
      phone: r.phone,
      deviceId: r.deviceId,
      accountHost: AUTOCLAW_REGIONS.cn.accountHost,
      loginAt: new Date().toISOString(),
      credentialSource: "sms-login",
    },
  };
}
