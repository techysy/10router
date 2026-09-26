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
    const { apiKey, uid, baseUrl, mimoPassToken, mimoUserId, mimoCUserId, sessionOnly, region, provider: requestedProvider } = await request.json();

    // 区域集群（对照上游 910db749）：cn/sgp/ams/ru/in 选择账号服务集群，
    // 缺省 cn（存量 Desktop cookie 都是 CN 签发）。非法值一律忽略回落 cn。
    const VALID_REGIONS = ["cn", "sgp", "ams", "ru", "in"];
    const effectiveRegion = VALID_REGIONS.includes(String(region || "").toLowerCase())
      ? String(region).toLowerCase()
      : "cn";

    // Which Xiaomi card this import targets. Both cards share this endpoint
    // (`xiaomi-mimo` = cloud models, `mimo-desktop` = account-session models, split
    // 2026-09-22), so the row must be created under the card the user opened.
    // Anything unrecognised falls back to the base card rather than inventing an id.
    const targetProvider = requestedProvider === "mimo-desktop" ? "mimo-desktop" : "xiaomi-mimo";
    const isDesktopCard = targetProvider === "mimo-desktop";

    // Session-only mode: the user signed in through MiMo Desktop (QR scan) and
    // holds an account session but no sk- API key. The session alone unlocks the
    // Desktop-exclusive Preview models, so a connection is worth creating even
    // without a key — cloud models will simply fail until a key is added.
    // The account session is the Desktop card's surface ONLY: a cloud-card row
    // that stores one starts advertising a Desktop session it does not own
    // (badge + weekly quota). So session-only is never honoured for the cloud
    // card — there, an sk- key is required.
    const isSessionOnly =
      isDesktopCard && (sessionOnly === true || (!apiKey && (mimoPassToken || mimoUserId)));

    let key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!isSessionOnly) {
      if (!key) {
        return NextResponse.json({ error: "API key is required" }, { status: 400 });
      }
      if (!key.startsWith("sk-")) {
        return NextResponse.json({ error: "Invalid key format — expected sk- prefix" }, { status: 400 });
      }
    } else if (key && !key.startsWith("sk-")) {
      key = ""; // ignore a malformed key rather than storing it
    }

    const effectiveBaseUrl = (baseUrl || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "");

    // Validate the key against the models endpoint. Soft-fail: a blocked network
    // must not prevent importing a key the user knows is good.
    let validated = false;
    let modelCount = 0;
    if (key) {
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
    }

    // Account-session credential, for the Desktop-exclusive models. It belongs to
    // the Desktop card only — a cloud-card row must never hold a passToken, or it
    // renders the Desktop-session badge and reads the weekly quota through this
    // machine's Desktop login. The cloud card therefore ignores whatever the
    // client sent and skips the server-side read entirely.
    let session = isDesktopCard
      ? { passToken: mimoPassToken || null, userId: mimoUserId || null, cUserId: mimoCUserId || null }
      : { passToken: null, userId: null, cUserId: null };
    // A running Desktop locks its cookie store, so the session read can fail — the
    // import itself does not depend on it (the sk- key covers the cloud models),
    // but Preview models do, so report the reason instead of swallowing it.
    let desktopLocked = false;
    if (isDesktopCard && !session.passToken) {
      try {
        const { readDesktopPassToken } = await import("open-sse/shared/mimoAccount.js");
        const desktop = await readDesktopPassToken();
        if (desktop) session = { passToken: desktop.passToken, userId: desktop.userId, cUserId: desktop.cUserId };
      } catch (e) {
        desktopLocked = e?.code === "DESKTOP_LOCKED";
        console.log("[xiaomi-mimo] passToken read failed (non-fatal):", e.message);
      }
    }

    // Session-only connections carry no real key: store a stable placeholder so
    // downstream code paths that require a non-empty accessToken keep working
    // (the executor uses the session cookie for Preview models, and cloud models
    // will report a clear auth error until the user adds an sk- key).
    const accessToken = key || `mimo-desktop-session${session.userId ? `-${session.userId}` : ""}`;

    // Dedup: if a connection with the same uid or the same key already exists, update it
    const { getProviderConnections, updateProviderConnection } = await import("@/models");
    // Dedup through the SHARED identity matcher (same rules as the browser
    // exchange path) — uid → mimoUserId → email → accessToken. Previously each
    // route had its own list and they disagreed, so the same account could end
    // up with two rows depending on which flow ran last.
    const { findXiaomiConnection } = await import("@/lib/oauth/xiaomiIdentity.js");
    const existing = findXiaomiConnection(await getProviderConnections({ provider: targetProvider }), {
      uid,
      key: key || null,
      mimoUserId: session.userId || null,
    });

    const sessionData = isDesktopCard
      ? {
          mimoPassToken: session.passToken,
          mimoUserId: session.userId,
          mimoCUserId: session.cUserId,
          region: effectiveRegion,
        }
      : {};

    if (existing) {
      // Merged base psd: on the cloud card, drop any session fields an older
      // build folded into this row — the spread would otherwise carry them back.
      const existingPsd = { ...(existing.providerSpecificData || {}) };
      if (!isDesktopCard) {
        delete existingPsd.mimoPassToken;
        delete existingPsd.mimoUserId;
        delete existingPsd.mimoCUserId;
      }
      const updated = await updateProviderConnection(existing.id, {
        // Never downgrade a real key to the session placeholder.
        accessToken: key || existing.accessToken,
        providerSpecificData: {
          ...existingPsd,
          uid: uid || existingPsd.uid || null,
          baseUrl: effectiveBaseUrl,
          authMethod: key ? "api_key" : existingPsd.authMethod || "desktop-session",
          // Per-account session credential — enables multi-account rotation.
          // Desktop card only; the cloud card stores the sk- key and nothing else.
          ...(isDesktopCard
            ? {
                mimoPassToken: session.passToken || existingPsd.mimoPassToken || null,
                mimoUserId: session.userId || existingPsd.mimoUserId || null,
                mimoCUserId: session.cUserId || existingPsd.mimoCUserId || null,
                // 区域随本次导入刷新（用户可能换集群重新登录）。
                region: effectiveRegion,
              }
            : {}),
          modelCount: modelCount || existingPsd.modelCount,
        },
        testStatus: validated ? "active" : existing.testStatus,
        // Re-imported key/session supersedes any stored failure text.
        resetErrorState: true,
      });
      return NextResponse.json({
        success: true,
        validated,
        modelCount,
        updated: true,
        desktopLocked,
        connection: {
          id: existing.id,
          provider: existing.provider,
          email: existing.email,
          displayName: existing.displayName,
        },
      });
    }

    const connection = await createProviderConnection({
      provider: targetProvider,
      authType: "api_key",
      accessToken,
      refreshToken: null,
      // API keys don't expire on a fixed schedule; use a long horizon
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      email: uid ? `${uid}@xiaomi` : null,
      displayName: uid ? `Xiaomi ${uid}` : "Xiaomi MiMo",
      providerSpecificData: {
        uid: uid || null,
        baseUrl: effectiveBaseUrl,
        authMethod: key ? "api_key" : "desktop-session",
        provider: key ? "API Key" : "Xiaomi MiMo Desktop Session",
        modelCount,
        ...sessionData,
      },
      testStatus: validated ? "active" : "untested",
    });

    return NextResponse.json({
      success: true,
      validated,
      modelCount,
      sessionOnly: isSessionOnly,
      desktopLocked,
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
