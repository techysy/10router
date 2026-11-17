import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import {
  parseDeepaiCallbackCode,
  exchangeDeepaiCode,
} from "open-sse/shared/deepai/auth.js";
import { buildDeepaiHeaders, DEEPAI_THEOS_URL } from "open-sse/shared/deepai/constants.js";
import { formatDeepaiQuotaError } from "open-sse/shared/deepai/errors.js";

/**
 * POST /api/oauth/deepai/exchange
 *
 * Panel-native DeepAI Code sign-in (no desktop app): the user's browser
 * completed the desktop_auth sign-in and landed on a dead 127.0.0.1
 * callback URL; the dashboard sends that URL (or the bare code) here.
 * The server exchanges the code for the account's long-lived API key
 * and stores the connection. A best-effort /theos probe supplies a warning;
 * quota access is separate from sign-in and must not discard an issued key.
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

    // The one-time exchange proves ownership. The quota endpoint can reject
    // access for account restrictions, rate limits or a gateway challenge;
    // none of those undo the successful exchange. Preserve the issued key
    // and show a warning instead of consuming the code without a connection.
    let warning = null;
    try {
      const res = await fetch(DEEPAI_THEOS_URL, {
        headers: buildDeepaiHeaders(cred.apiKey),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // 2026-11-17 合并(654d69461 的诊断分支并入 PR 的 always-save 骨架):
        // quota 拒绝不撤销 exchange——key 落库 + warning。machine_required 的
        // 用户文案走 errors.js 精细分支;上游 body 摘要留 console.error 供
        // check-in 端点考古(不回显全文——可能含凭据或网关 HTML)。
        const payload = await res.json().catch(() => null);
        const bodyText = payload ? JSON.stringify(payload) : "";
        console.error(`[deepai-exchange] /theos probe warning: status=${res.status} body=${bodyText.slice(0, 300)} username=${cred.username || "-"}`);
        warning = `登录已完成，API Key 已保存；${formatDeepaiQuotaError(res.status, payload, cred.apiKey)}`;
      }
      }
    } catch {
      warning = "登录已完成，API Key 已保存；额度查询暂时无法完成，请稍后运行连接测试。";
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
      ...(warning ? { lastError: warning, lastErrorAt: new Date().toISOString() } : {}),
      allowOverwrite: false,
    });

    const result = { ...connection };
    delete result.apiKey;
    return NextResponse.json(
      { connection: result, username: cred.username, isPro: cred.isPro, ...(warning ? { warning } : {}) },
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
