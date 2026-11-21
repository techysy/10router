import { NextResponse } from "next/server";
import { sendCapyCode, CAPY_EMAIL_RE } from "@/lib/oauth/providers/capy";
import { smsRateLimit } from "@/lib/auth/smsRateLimiter";
import { getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

// POST /api/oauth/capy/code-send — Capy 邮箱登录第一步：经 Clerk Native API
// （Capy 官方桌面端同一通道）向账号邮箱下发 6 位验证码。
// 限流对齐 loomy/sms-send：单邮箱 3 条/10 分钟 + 单 IP 10 条/小时。
export async function POST(request) {
  try {
    const { email: rawEmail } = await request.json().catch(() => ({}));
    const email = String(rawEmail || "").trim();
    if (!CAPY_EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
    }
    const byEmail = smsRateLimit(`capy-send:email:${email.toLowerCase()}`, 3, 10 * 60 * 1000);
    const byIp = smsRateLimit(`capy-send:ip:${getClientIp(request)}`, 10, 60 * 60 * 1000);
    const limited = !byEmail.ok ? byEmail : !byIp.ok ? byIp : null;
    if (limited) {
      return NextResponse.json(
        { error: "发送过于频繁，请稍后再试", retryAfter: limited.retryAfterSeconds },
        { status: 429 },
      );
    }
    const r = await sendCapyCode(email);
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
