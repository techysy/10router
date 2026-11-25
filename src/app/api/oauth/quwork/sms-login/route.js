import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { getProvider } from "@/lib/oauth/providers";
import { QUWORK_PHONE_RE } from "@/lib/oauth/providers/quwork";
import { smsRateLimit } from "@/lib/auth/smsRateLimiter";
import { getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

// POST /api/oauth/quwork/sms-login — 第二步：短信验证码换 llm_token + 账号 token，
// 经 provider.mapTokens 落成 oauth 连接（同账号再登录 = 原位更新）。
// 限流：单号 6 次/10 分钟 + 单 IP 20 次/10 分钟（同 loomy/sms-login）。
export async function POST(request) {
  try {
    const { phone: rawPhone, code: rawCode } = await request.json().catch(() => ({}));
    const phone = String(rawPhone || "").trim();
    const code = String(rawCode || "").trim();
    if (!QUWORK_PHONE_RE.test(phone) || !code) {
      return NextResponse.json({ error: "缺少手机号或验证码" }, { status: 400 });
    }
    const byPhone = smsRateLimit(`quwork-login:phone:${phone}`, 6, 10 * 60 * 1000);
    const byIp = smsRateLimit(`quwork-login:ip:${getClientIp(request)}`, 20, 10 * 60 * 1000);
    const limited = !byPhone.ok ? byPhone : !byIp.ok ? byIp : null;
    if (limited) {
      return NextResponse.json({ error: "尝试过于频繁，请稍后再试", retryAfter: limited.retryAfterSeconds }, { status: 429 });
    }
    const provider = getProvider("quwork");
    const tokens = await provider.exchangeToken(provider.config, code, phone);
    const mapped = provider.mapTokens(tokens, { credentialSource: "sms" });
    const connection = await createProviderConnection({
      provider: "quwork",
      authType: "oauth",
      ...mapped,
      expiresAt: mapped.expiresIn ? new Date(Date.now() + mapped.expiresIn * 1000).toISOString() : null,
      isActive: true,
      testStatus: "active",
    });
    return NextResponse.json({ success: true, connection: { id: connection.id, provider: connection.provider, name: connection.name } });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
