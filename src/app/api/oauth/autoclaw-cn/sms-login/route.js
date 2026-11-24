import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import {
  loginAutoclawCnBySms,
  autoclawCnConnectionPayload,
  AUTOCLAW_CN_PHONE,
} from "@/lib/oauth/providers/autoclaw-cn";
import { smsRateLimit } from "@/lib/auth/smsRateLimiter";
import { getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

// POST /api/oauth/autoclaw-cn/sms-login — 第二步：验证码换 token 对，落成
// autoclaw-cn oauth 连接（accessToken=账号 JWT，refreshToken=轮换 refresh
// JWT，expiresAt 取 access JWT 的 exp；同 user_id 再登录=原位更新）。
// 限流：短信码可爆破——单手机号 6 次/10 分钟 + 单 IP 20 次/10 分钟（同 loomy）。
export async function POST(request) {
  try {
    const { phone: rawPhone, code } = await request.json().catch(() => ({}));
    const phone = String(rawPhone || "").trim().replace(/^\+?86/, "");
    if (!AUTOCLAW_CN_PHONE.test(phone)) {
      return NextResponse.json({ error: "手机号格式不正确" }, { status: 400 });
    }
    const byPhone = smsRateLimit(`autoclaw-cn-login:phone:${phone}`, 6, 10 * 60 * 1000);
    const byIp = smsRateLimit(`autoclaw-cn-login:ip:${getClientIp(request)}`, 20, 10 * 60 * 1000);
    const limited = !byPhone.ok ? byPhone : !byIp.ok ? byIp : null;
    if (limited) {
      return NextResponse.json(
        { error: "尝试过于频繁，请稍后再试", retryAfter: limited.retryAfterSeconds },
        { status: 429 },
      );
    }
    const r = await loginAutoclawCnBySms({ phone, code });
    const connection = await createProviderConnection(autoclawCnConnectionPayload(r));
    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.displayName,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
