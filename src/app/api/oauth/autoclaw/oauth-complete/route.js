import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { completeAutoclawOAuth, autoclawIntlConnectionPayload } from "@/lib/oauth/providers/autoclaw";
import { smsRateLimit } from "@/lib/auth/smsRateLimiter";
import { getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

// POST /api/oauth/autoclaw/oauth-complete — 第二步：用户粘贴授权后打不开的
// localhost:18432 回调地址，校验 state 后调 {vendor}-oauth-login 换 token 对，
// 落成 autoclaw oauth 连接（同账号再登录=原位更新凭证）。
// 限流：单 IP 20 次/10 分钟。
export async function POST(request) {
  try {
    const { flowId, callbackUrl } = await request.json().catch(() => ({}));
    const byIp = smsRateLimit(`autoclaw-oauth-complete:ip:${getClientIp(request)}`, 20, 10 * 60 * 1000);
    if (!byIp.ok) {
      return NextResponse.json(
        { error: "尝试过于频繁，请稍后再试", retryAfter: byIp.retryAfterSeconds },
        { status: 429 },
      );
    }
    const r = await completeAutoclawOAuth({ flowId, callbackUrl });
    const connection = await createProviderConnection(autoclawIntlConnectionPayload(r));
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
