import { NextResponse } from "next/server";
import { startAutoclawOAuth } from "@/lib/oauth/providers/autoclaw";
import { smsRateLimit } from "@/lib/auth/smsRateLimiter";
import { getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

// POST /api/oauth/autoclaw/oauth-start — 第一步：带浏览器产出的滑块回执调账号面
// {vendor}-oauth-url，铸授权页（Google / z.ai）。返回 { flowId, authUrl }。
// 限流：单 IP 20 次/10 分钟（每次铸授权页都会消耗一次验证回执）。
export async function POST(request) {
  try {
    const { vendor, captchaVerifyParam } = await request.json().catch(() => ({}));
    const byIp = smsRateLimit(`autoclaw-oauth-start:ip:${getClientIp(request)}`, 20, 10 * 60 * 1000);
    if (!byIp.ok) {
      return NextResponse.json(
        { error: "尝试过于频繁，请稍后再试", retryAfter: byIp.retryAfterSeconds },
        { status: 429 },
      );
    }
    const receipt = typeof captchaVerifyParam === "string" && captchaVerifyParam.trim()
      ? captchaVerifyParam.trim().slice(0, 8192)
      : null;
    const r = await startAutoclawOAuth({ vendor, captchaVerifyParam: receipt });
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
