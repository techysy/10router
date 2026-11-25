import { NextResponse } from "next/server";
import { autoclawCaptchaConfig } from "@/lib/oauth/providers/autoclaw";

export const dynamic = "force-dynamic";

// GET /api/oauth/autoclaw/captcha-config — AutoClaw 国际版登录第 0 步：读取账号面
// 的阿里云滑块验证配置（enabled / region / prefix / scene_id），由弹窗在用户浏览器
// 里加载 Aliyun Captcha SDK 产出回执。只读、无凭据。
export async function GET() {
  try {
    const cfg = await autoclawCaptchaConfig();
    return NextResponse.json({ success: true, ...cfg });
  } catch (e) {
    // 读不到配置时按「未启用」交给下一步——oauth-url 若真要回执会明确报错。
    return NextResponse.json({ success: false, enabled: false, error: e.message });
  }
}
