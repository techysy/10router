import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import {
  parseDeepaiCallbackCode,
  exchangeDeepaiCode,
} from "open-sse/shared/deepai/auth.js";
import { buildDeepaiHeaders, DEEPAI_THEOS_URL } from "open-sse/shared/deepai/constants.js";

/**
 * POST /api/oauth/deepai/exchange
 *
 * Panel-native DeepAI Code sign-in (no desktop app): the user's browser
 * completed the desktop_auth sign-in and landed on a dead 127.0.0.1
 * callback URL; the dashboard sends that URL (or the bare code) here.
 * The server exchanges the code for the account's long-lived API key,
 * validates it against /theos, and stores the connection.
 *
 * Body: { code: "<callback URL or bare code>", name?: string }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const code = parseDeepaiCallbackCode(body?.code);
    if (!code.code) {
      return NextResponse.json(
        { error: "No authorization code found — paste the full callback address from the browser's address bar." },
        { status: 400 },
      );
    }

    let cred;
    try {
      cred = await exchangeDeepaiCode(code.code, { state: code.state });
    } catch (err) {
      // 2026-11-16 实测:上游两种失败语义不可区分地回 "invalid code"/"invalid or
      // expired code"——code 是一次性的且寿命极短(用户从复制到点完成连接隔几分钟
      // 就会撞),瞎编 code 同答。原文透传 + 补时效提示,别让用户以为是输入错了。
      const raw = String(err?.message || err);
      const hint = /invalid|expired/i.test(raw)
        ? "——回调 code 是一次性的且有效期极短（几分钟内失效）。回到登录页重新走一遍，登录完成后立刻粘贴回调地址，不要再等。"
        : "";
      return NextResponse.json(
        { error: `DeepAI sign-in exchange failed: ${raw}${hint}` },
        { status: 400 },
      );
    }

    // Validate the issued key before storing it (the exchange already
    // proves ownership; /theos proves the key is live for inference).
    try {
      const res = await fetch(DEEPAI_THEOS_URL, {
        headers: buildDeepaiHeaders(cred.apiKey),
        redirect: "error",
      });
      if (res.status === 401 || res.status === 403) {
        // 2026-11-16 用户实测:exchange 成功换出的 key 也可能被 /theos 判
        // auth_required——key 的有效期/绑定语义上游未文档化。把上游 body
        // 带回给用户(判别 "Sign in to DeepAI" = 会话绑定的 key 即刻失效),
        // 并留下 exchange 响应形状日志供排查;key 不入库(存了也是死的)。
        const bodyText = await res.text().catch(() => "");
        console.error(`[deepai-exchange] issued key rejected by /theos: status=${res.status} body=${bodyText.slice(0, 300)} username=${cred.username || "-"}`);
        return NextResponse.json(
          {
            error: `DeepAI 拒绝了换出的 API Key（${res.status}）：上游回「${bodyText.slice(0, 160) || "no body"}」。这不是粘贴错误——浏览器登录流签出的 key 被上游判未登录，请改用官方桌面端登录后从 deepai-account.bin 复制 key 手动粘贴（同弹窗「已有 API Key？直接粘贴」）。`,
          },
          { status: 400 },
        );
      }
    } catch {
      // Network hiccup while validating must not block a key the
      // exchange just issued; the connection test will surface problems.
    }

    const name =
      (typeof body?.name === "string" && body.name.trim()) ||
      (cred.username ? `DeepAI ${cred.username}` : "DeepAI Code");

    const connection = await createProviderConnection({
      provider: "deepai",
      authType: "apikey",
      name,
            apiKey: cred.apiKey,
      priority: 1,
      globalPriority: null,
      defaultModel: null,
      providerSpecificData: {},
      isActive: true,
      testStatus: "unknown",
      allowOverwrite: false,
    });

    const result = { ...connection };
    delete result.apiKey;
    return NextResponse.json(
      { connection: result, username: cred.username, isPro: cred.isPro },
      { status: 201 },
    );
  } catch (error) {
    if (error?.code === "PROVIDER_NAME_CONFLICT") {
      return NextResponse.json(
        { error: "A connection with this name already exists — pick a different connection name." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: error?.message || "Failed to create the DeepAI connection" },
      { status: 500 },
    );
  }
}
