import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { loginLoomyBySms, loomyConnectionName } from "@/lib/oauth/providers/loomy";

export const dynamic = "force-dynamic";

// POST /api/oauth/loomy/sms-login — Loomy 手机直登第二步：验证码换 14 天 session，
// 直接落成 loomy 连接（apikey 形态按 name 幂等去重，同手机号重复登录=原位更新）。
// 连接 providerSpecificData 记 userid/phone/loginAt，供面板展示与 CD 同步对账。
export async function POST(request) {
  try {
    const { phone, code, msgid } = await request.json().catch(() => ({}));
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
