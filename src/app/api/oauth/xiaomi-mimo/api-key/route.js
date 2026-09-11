import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/xiaomi-mimo/api-key
 * Import a Xiaomi MiMo API key manually (or from the Desktop auto-import).
 * The key is validated against the models endpoint, then stored.
 *
 * Body: { apiKey, uid?, baseUrl?, mimoPassToken?, mimoUserId?, mimoCUserId? }
 *
 * The account-session passToken is the credential that unlocks the Desktop-exclusive
 * models (see open-sse/shared/mimoAccount.js). It is read server-side from MiMo
 * Desktop's own cookie store when the caller does not supply one, so our dashboard
 * flow never has to send it through the browser.
 */
export async function POST(request) {
  try {
    const { apiKey, uid, baseUrl, mimoPassToken, mimoUserId, mimoCUserId } = await request.json();

    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json({ error: "API key is required" }, { status: 400 });
    }

    const key = apiKey.trim();
    if (!key.startsWith("sk-")) {
      return NextResponse.json({ error: "Invalid key format — expected sk- prefix" }, { status: 400 });
    }

    const effectiveBaseUrl = (baseUrl || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "");

    // Validate the key against the models endpoint. Soft-fail: a blocked network
    // must not prevent importing a key the user knows is good.
    let validated = false;
    let modelCount = 0;
    try {
      const resp = await fetch(`${effectiveBaseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          "X-Mimo-Source": "mimocode-cli",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        modelCount = Array.isArray(data?.data) ? data.data.length : 0;
        validated = true;
      }
    } catch {
      // Network error — still allow import (key may be valid but network blocked)
    }

    if (!validated) {
      console.log("[xiaomi-mimo] key validation failed, storing as untested");
    }

    // Account-session credential, for the Desktop-exclusive models. Prefer a
    // server-side read so it never has to round-trip through the client.
    let session = { passToken: mimoPassToken || null, userId: mimoUserId || null, cUserId: mimoCUserId || null };
    if (!session.passToken) {
      try {
        const { readDesktopPassToken } = await import("open-sse/shared/mimoAccount.js");
        const desktop = await readDesktopPassToken();
        if (desktop) session = { passToken: desktop.passToken, userId: desktop.userId, cUserId: desktop.cUserId };
      } catch (e) {
        console.log("[xiaomi-mimo] passToken read failed (non-fatal):", e.message);
      }
    }

    // Dedup: if a connection with the same uid or the same key already exists, update it
    const { getProviderConnections, updateProviderConnection } = await import("@/models");
    const existing = (await getProviderConnections()).find(
      (c) => c.provider === "xiaomi-mimo" && ((uid && c.email === `${uid}@xiaomi`) || c.accessToken === key),
    );

    const sessionData = {
      mimoPassToken: session.passToken,
      mimoUserId: session.userId,
      mimoCUserId: session.cUserId,
    };

    if (existing) {
      const updated = await updateProviderConnection(existing.id, {
        accessToken: key,
        providerSpecificData: {
          ...existing.providerSpecificData,
          uid: uid || existing.providerSpecificData?.uid || null,
          baseUrl: effectiveBaseUrl,
          // Per-account session credential — enables multi-account rotation.
          mimoPassToken: session.passToken || existing.providerSpecificData?.mimoPassToken || null,
          mimoUserId: session.userId || existing.providerSpecificData?.mimoUserId || null,
          mimoCUserId: session.cUserId || existing.providerSpecificData?.mimoCUserId || null,
          modelCount,
        },
        testStatus: validated ? "active" : existing.testStatus,
      });
      return NextResponse.json({
        success: true,
        validated,
        modelCount,
        updated: true,
        connection: {
          id: existing.id,
          provider: existing.provider,
          email: existing.email,
          displayName: existing.displayName,
        },
      });
    }

    const connection = await createProviderConnection({
      provider: "xiaomi-mimo",
      authType: "api_key",
      accessToken: key,
      refreshToken: null,
      // API keys don't expire on a fixed schedule; use a long horizon
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      email: uid ? `${uid}@xiaomi` : null,
      displayName: uid ? `Xiaomi ${uid}` : "Xiaomi MiMo",
      providerSpecificData: {
        uid: uid || null,
        baseUrl: effectiveBaseUrl,
        authMethod: "api_key",
        provider: "API Key",
        modelCount,
        ...sessionData,
      },
      testStatus: validated ? "active" : "untested",
    });

    return NextResponse.json({
      success: true,
      validated,
      modelCount,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.displayName,
      },
    });
  } catch (error) {
    console.log("Xiaomi MiMo API key import error:", error);
    // Do not reflect upstream response bodies to the client (SSRF hardening)
    return NextResponse.json({ error: "API key import failed" }, { status: 500 });
  }
}
