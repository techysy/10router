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
    if (!code) {
      return NextResponse.json(
        { error: "No authorization code found — paste the full callback address from the browser's address bar." },
        { status: 400 },
      );
    }

    let cred;
    try {
      cred = await exchangeDeepaiCode(code);
    } catch (err) {
      return NextResponse.json(
        { error: `DeepAI sign-in exchange failed: ${err?.message || err}` },
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
        return NextResponse.json(
          { error: "DeepAI rejected the issued key — please run the browser sign-in again." },
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
