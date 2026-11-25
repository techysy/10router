import { NextResponse } from "next/server";
import { sendLoomySms, LOOMY_PHONE_RE } from "@/lib/oauth/providers/loomy";
import { smsRateLimit } from "@/lib/auth/smsRateLimiter";
import { getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

// POST /api/oauth/loomy/sms-send — Loomy 手机直登第一步：下发验证码。
// 保护级别沿用 /api/oauth/*（PROTECTED_API_PATHS：JWT 会话或 requireLogin=false）。
// 限流：验证码下发是计费型动作（讯飞网关侧成本），成功失败都计数——
// 单手机号 3 条/10 分钟 + 单 IP 10 条/小时（getClientIp 防 XFF 伪造，同登录限流）。
export async function POST(request) {
  try {
    const { phone: rawPhone } = await request.json().catch(() => ({}));
    const phone = String(rawPhone || "").trim();
    if (!LOOMY_PHONE_RE.test(phone)) {
      return NextResponse.json({ error: "手机号格式不正确" }, { status: 400 });
    }
    const byPhone = smsRateLimit(`loomy-send:phone:${phone}`, 3, 10 * 60 * 1000);
    const byIp = smsRateLimit(`loomy-send:ip:${getClientIp(request)}`, 10, 60 * 60 * 1000);
    const limited = !byPhone.ok ? byPhone : !byIp.ok ? byIp : null;
    if (limited) {
      return NextResponse.json(
        { error: "发送过于频繁，请稍后再试", retryAfter: limited.retryAfterSeconds },
        { status: 429 },
      );
    }
    const r = await sendLoomySms(phone);
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
