import { NextResponse } from "next/server";
import { sendAutoclawCnSms, AUTOCLAW_CN_PHONE } from "@/lib/oauth/providers/autoclaw-cn";
import { smsRateLimit } from "@/lib/auth/smsRateLimiter";
import { getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

// POST /api/oauth/autoclaw-cn/sms-send — AutoClaw 国内版手机直登第一步：
// 经国内账号域 agent-send-code 下发短信验证码。
// 限流对齐 loomy/sms-send：单手机号 3 条/10 分钟 + 单 IP 10 条/小时
// （短信是计费型动作，成功失败都计数；getClientIp 防 XFF 伪造）。
export async function POST(request) {
  try {
    const { phone: rawPhone } = await request.json().catch(() => ({}));
    const phone = String(rawPhone || "").trim().replace(/^\+?86/, "");
    if (!AUTOCLAW_CN_PHONE.test(phone)) {
      return NextResponse.json({ error: "手机号格式不正确" }, { status: 400 });
    }
    const byPhone = smsRateLimit(`autoclaw-cn-send:phone:${phone}`, 3, 10 * 60 * 1000);
    const byIp = smsRateLimit(`autoclaw-cn-send:ip:${getClientIp(request)}`, 10, 60 * 60 * 1000);
    const limited = !byPhone.ok ? byPhone : !byIp.ok ? byIp : null;
    if (limited) {
      return NextResponse.json(
        { error: "发送过于频繁，请稍后再试", retryAfter: limited.retryAfterSeconds },
        { status: 429 },
      );
    }
    await sendAutoclawCnSms(phone);
    return NextResponse.json({ success: true, phone });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
