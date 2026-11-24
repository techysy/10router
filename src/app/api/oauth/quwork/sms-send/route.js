import { NextResponse } from "next/server";
import { getProvider } from "@/lib/oauth/providers";
import { QUWORK_PHONE_RE } from "@/lib/oauth/providers/quwork";
import { smsRateLimit } from "@/lib/auth/smsRateLimiter";
import { getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

// POST /api/oauth/quwork/sms-send — QuWork 手机直登第一步（同 loomy/sms-send）：
// 带阿里云滑块结果（captcha 页 postMessage 回传）下发短信验证码。
// 限流：单号 3 条/10 分钟 + 单 IP 10 条/小时。
export async function POST(request) {
  try {
    const { phone: rawPhone, captcha: rawCaptcha } = await request.json().catch(() => ({}));
    const phone = String(rawPhone || "").trim();
    const captcha = String(rawCaptcha || "").trim();
    if (!QUWORK_PHONE_RE.test(phone)) {
      return NextResponse.json({ error: "请输入 11 位中国大陆手机号" }, { status: 400 });
    }
    if (!captcha) return NextResponse.json({ error: "请先完成滑块人机验证" }, { status: 400 });
    const byPhone = smsRateLimit(`quwork-send:phone:${phone}`, 3, 10 * 60 * 1000);
    const byIp = smsRateLimit(`quwork-send:ip:${getClientIp(request)}`, 10, 60 * 60 * 1000);
    const limited = !byPhone.ok ? byPhone : !byIp.ok ? byIp : null;
    if (limited) {
      return NextResponse.json({ error: "发送过于频繁，请稍后再试", retryAfter: limited.retryAfterSeconds }, { status: 429 });
    }
    const provider = getProvider("quwork");
    await provider.sendCode(provider.config, phone, captcha);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
