import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { isMeooControlKey } from "open-sse/shared/meoo/constants.js";
import { MeooService, MeooApiError } from "@/lib/oauth/services/meoo";

/**
 * POST /api/oauth/meoo/import-apikey
 * Connect a Meoo account by pasting its control-plane API key
 * (meoo_ak_…, created in meoo.com 设置 → API 密钥), bypassing the OAuth
 * popup flow — Meoo's OAuth client only registers loopback redirect
 * URIs, so the gateway-domain callback is rejected upstream
 * (invalid_redirect_uri, verified 2026-11-13). The control plane accepts
 * the API key as the same Bearer credential as an OAuth access token
 * (CLI credentialType "api_key"), so the key is verified by resolving
 * the project service AK with it (identity is display-only — a scoped
 * key may not be entitled to it). When Meoo rejects the key, its HTTP
 * status, error code and message are returned verbatim in the response
 * (fields meooStatus / meooCode / detail) so scope problems can be told
 * apart from bad keys.
 *
 * The resolved AK is stored as the connection's apiKey (what the model
 * gateway accepts); the control key itself is stored in
 * providerSpecificData.meooControlKey so the runtime can re-resolve the
 * AK whenever it goes missing/stale. Neither key is ever returned or
 * logged.
 *
 * Body: { apiKey: string, name?: string }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw =
      typeof body?.apiKey === "string"
        ? body.apiKey
        : typeof body?.controlKey === "string"
          ? body.controlKey
          : "";
    const controlKey = raw.trim();

    if (!isMeooControlKey(controlKey)) {
      return NextResponse.json(
        {
          error:
            "Invalid Meoo API key: paste the account API key starting with meoo_ak_ (meoo.com → 设置 → API 密钥)",
        },
        { status: 400 },
      );
    }

    let extra;
    try {
      extra = await new MeooService().resolveControlKeyImport(controlKey);
    } catch (err) {
      // The control plane rejected the key in both namespaces. Surface
      // Meoo's HTTP status / error code / message verbatim (never the key
      // itself) so the user can tell a scope problem from a bad key.
      const meooStatus = err instanceof MeooApiError ? err.status : 0;
      const meooCode = err instanceof MeooApiError ? err.code : "";
      const detail = err?.message || "verification failed";
      const status = meooStatus >= 400 && meooStatus < 600 ? meooStatus : 502;
      return NextResponse.json(
        {
          error: `Meoo rejected the API key (HTTP ${meooStatus || "network error"}${meooCode ? `, ${meooCode}` : ""}): ${detail}`,
          meooStatus,
          meooCode,
          detail,
        },
        { status },
      );
    }

    const identity = extra.identity || {};
    const username = (identity.username || "").trim();
    const rawEmail = (identity.email || "").trim();
    const userId = (identity.userId || "").trim();
    // Same fallback shape as the OAuth mapTokens: a stable synthetic
    // identity when the account exposes neither email nor username, so
    // repeat imports dedupe onto one connection row.
    const email = rawEmail || username || (userId ? `meoo-user-${userId}` : null);
    const connectionName =
      (typeof body?.name === "string" && body.name.trim()) ||
      email ||
      extra.projectName ||
      "Meoo API Key";

    const providerSpecificData = {
      authMethod: "api_key",
      username,
      tenantId: identity.tenantId || "",
      meooControlKey: controlKey,
      projectUrlId: extra.projectUrlId || "",
      projectName: extra.projectName || "",
      projectApiKey: extra.projectApiKey || "",
      akStatus: extra.akStatus || "pending",
      ...(extra.akError ? { akError: extra.akError } : {}),
      ...(extra.projectApiKey ? { akResolvedAt: new Date().toISOString() } : {}),
    };

    const connection = await createProviderConnection({
      provider: "meoo",
      authType: "oauth",
      name: connectionName,
      email,
      displayName: username || rawEmail || null,
      ...(extra.projectApiKey ? { ["apiKey"]: extra.projectApiKey } : {}),
      providerSpecificData,
      ...(extra.projectApiKey ? { testStatus: "active" } : {}),
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        name: connection.name,
        projectUrlId: providerSpecificData.projectUrlId,
        projectName: providerSpecificData.projectName,
        akStatus: providerSpecificData.akStatus,
        ...(providerSpecificData.akError ? { akError: providerSpecificData.akError } : {}),
      },
    });
  } catch (error) {
    console.log("Meoo API key import error:", error?.message || error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
