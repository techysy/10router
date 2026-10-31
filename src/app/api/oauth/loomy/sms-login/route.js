import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { loginLoomyBySms, loomyConnectionName, LOOMY_PHONE_RE } from "@/lib/oauth/providers/loomy";
import { smsRateLimit } from "@/lib/auth/smsRateLimiter";
import { getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

// POST /api/oauth/loomy/sms-login — Loomy 手机直登第二步：验证码换 14 天 session，
// 直接落成 loomy 连接（apikey 形态按 name 幂等去重，同手机号重复登录=原位更新）。
// 连接 providerSpecificData 记 userid/phone/loginAt，供面板展示与 CD 同步对账。
// 限流：checkCode 在 msgid 5 分钟有效窗内可爆破（6 位码 10^6 空间）——单手机号
// 6 次/10 分钟 + 单 IP 20 次/10 分钟，机器人在第一档就出局，人工输入不受影响。
export async function POST(request) {
  try {
    const { phone: rawPhone, code, msgid } = await request.json().catch(() => ({}));
    const phone = String(rawPhone || "").trim();
    if (!LOOMY_PHONE_RE.test(phone)) {
      return NextResponse.json({ error: "手机号格式不正确" }, { status: 400 });
    }
    const byPhone = smsRateLimit(`loomy-login:phone:${phone}`, 6, 10 * 60 * 1000);
    const byIp = smsRateLimit(`loomy-login:ip:${getClientIp(request)}`, 20, 10 * 60 * 1000);
    const limited = !byPhone.ok ? byPhone : !byIp.ok ? byIp : null;
    if (limited) {
      return NextResponse.json(
        { error: "尝试过于频繁，请稍后再试", retryAfter: limited.retryAfterSeconds },
        { status: 429 },
      );
    }
    const r = await loginLoomyBySms({ phone, code, msgid });
    const name = loomyConnectionName(r.phone, r.userid);
    const connection = await createProviderConnection({
      provider: "loomy",
      authType: "apikey",
      name,
      apiKey: r.session,
      isActive: true,
      providerSpecificData: {
        userId: r.userid || null,
        phone: r.phone,
        loginAt: new Date().toISOString(),
        credentialSource: "sms-login",
      },
    });
    return NextResponse.json({ success: true, connection });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
