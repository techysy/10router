import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { getProvider } from "@/lib/oauth/providers";

export const dynamic = "force-dynamic";

// POST /api/oauth/quwork/import-token — 粘贴 llm_token（必填，推理）+ 账号
// access token（选填，积分/签到/续期）。llm_token 经 GET /v1/models 校验（不耗积分）。
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const provider = getProvider("quwork");
    const tokens = await provider.importToken(provider.config, { llmToken: body.llmToken, accessToken: body.accessToken });
    const mapped = provider.mapTokens(tokens, { credentialSource: "token" });
    const connection = await createProviderConnection({
      provider: "quwork",
      authType: "oauth",
      ...mapped,
      expiresAt: mapped.expiresIn ? new Date(Date.now() + mapped.expiresIn * 1000).toISOString() : null,
      isActive: true,
      testStatus: "active",
    });
    return NextResponse.json({
      success: true,
      warning: tokens._warning || "",
      connection: { id: connection.id, provider: connection.provider, name: connection.name },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
