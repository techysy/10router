import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { loginCapyByCode, capyConnectionName } from "@/lib/oauth/providers/capy";
import { smsRateLimit } from "@/lib/auth/smsRateLimiter";
import { getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

// POST /api/oauth/capy/code-login — 第二步：验证码换 Clerk 会话，验证组织/
// 设备/模型访问后落成 oauth 连接（同邮箱再登录=原位更新凭证）。
// 凭证：accessToken=60s session JWT；refreshToken=rotating clientJwt；
// providerSpecificData 记 sessionId/orgId/deviceId 等执行所需上下文。
// 限流：6 位码可爆破——单邮箱 6 次/10 分钟 + 单 IP 20 次/10 分钟（同 loomy）。
export async function POST(request) {
  try {
    const { flowId, code: rawCode, email: rawEmail } = await request.json().catch(() => ({}));
    const code = String(rawCode || "").trim();
    const emailKey = String(rawEmail || "").toLowerCase();
    if (!flowId || !code) {
      return NextResponse.json({ error: "缺少登录状态或验证码" }, { status: 400 });
    }
    const byEmail = smsRateLimit(`capy-login:email:${emailKey}`, 6, 10 * 60 * 1000);
    const byIp = smsRateLimit(`capy-login:ip:${getClientIp(request)}`, 20, 10 * 60 * 1000);
    const limited = !byEmail.ok ? byEmail : !byIp.ok ? byIp : null;
    if (limited) {
      return NextResponse.json(
        { error: "尝试过于频繁，请稍后再试", retryAfter: limited.retryAfterSeconds },
        { status: 429 },
      );
    }
    const r = await loginCapyByCode({ flowId, code });
    const connection = await createProviderConnection({
      provider: "capy",
      authType: "oauth",
      name: capyConnectionName(r.email, r.orgName),
      email: r.email,
      accessToken: r.sessionJwt,
      refreshToken: r.clientJwt,
      // Session JWTs live ~60s; the refresh machinery reads expiresAt (ISO).
      expiresAt: new Date(Date.now() + r.expiresIn * 1000).toISOString(),
      isActive: true,
      providerSpecificData: {
        sessionId: r.sessionId,
        userId: r.userId,
        orgId: r.orgId,
        orgName: r.orgName,
        deviceId: r.deviceId,
        machineId: r.machineId,
        deviceEnrolled: r.deviceEnrolled ?? false,
        deviceToken: r.deviceToken ?? null,
        jamId: r.jamId,
        loginAt: new Date().toISOString(),
        credentialSource: "email-code",
      },
    });
    return NextResponse.json({ success: true, connection });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
