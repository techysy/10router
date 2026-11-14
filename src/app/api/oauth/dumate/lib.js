/*
 * Shared helpers for the DuMate QR-login / cookie-import routes.
 * Lives next to the routes (not in open-sse) because it touches the DB layer
 * and the dashboard test path — the open-sse side stays provider-runtime only.
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  getProviderConnections,
  getProviderConnectionById,
  createProviderConnection,
  updateProviderConnection,
  deleteProviderConnection,
} from "@/models";
import { testSingleConnection } from "@/app/api/providers/[id]/test/testUtils.js";
import { finish, pub } from "open-sse/shared/dumate/qr.js";
import { passportKey } from "open-sse/shared/dumate/cookies.js";
import { tokenFor } from "open-sse/shared/dumate/token.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

/** Owner key for QR/import session scoping — hash of the dashboard credential. */
export function ownerOf(request) {
  const token = request.cookies.get("auth_token")?.value || request.headers.get("authorization") || "";
  return createHash("sha256").update(token).digest("hex");
}

export const json = (obj, status = 200, headers) =>
  NextResponse.json(obj, { status, headers: { "Cache-Control": "no-store", ...(headers || {}) } });

/**
 * Persist a fresh DuMate credential and prove it works end to end:
 *   dedup by generated name -> create or update -> testSingleConnection.
 * Returns {id, name, tokenExpiresAt}; throws with a user-facing message.
 */
export async function persistDumateCredential({ creds, connectionId, connName, accountKey, proxyOptions = null }) {
  let id = connectionId;
  if (!id && connName) {
    const list = await getProviderConnections({ provider: "dumate" });
    const hit = accountKey
      ? (list || []).find((c) => c.providerSpecificData?.dumateAccountKey === accountKey)
      : null;
    if (hit) id = hit.id;
  }

  const old = id ? await getProviderConnectionById(id) : null;
  if (id && (!old || old.provider !== "dumate")) throw new Error("Target connection is not a DuMate connection");
  if (!proxyOptions) {
    const proxyConfig = await resolveConnectionProxyConfig(old?.providerSpecificData || {});
    proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: proxyConfig.strictProxy === true,
    };
  }

  // Validate before touching the database. This catches a dead/partial passport
  // credential without destroying a currently working connection.
  const validated = await tokenFor(creds, { force: true, proxyOptions });
  const candidateCreds = validated.raw || creds;
  const effectiveAccountKey = passportKey(candidateCreds) || accountKey;

  if (id) {
    await updateProviderConnection(id, {
      apiKey: candidateCreds,
      providerSpecificData: { ...(old.providerSpecificData || {}), ...(effectiveAccountKey ? { dumateAccountKey: effectiveAccountKey } : {}) },
      testStatus: "unknown",
    });
  } else {
    const conn = await createProviderConnection({
      provider: "dumate",
      authType: "cookie",
      name: connName || "DuMate（扫码）",
      apiKey: candidateCreds,
      priority: 1,
      testStatus: "unknown",
      isActive: true,
      ...(effectiveAccountKey ? { providerSpecificData: { dumateAccountKey: effectiveAccountKey } } : {}),
    });
    id = conn?.id;
    if (!id) throw new Error("Failed to create the provider connection");
  }

  const rollback = async () => {
    if (old) {
      const restored = { ...old };
      delete restored.id;
      await updateProviderConnection(id, restored);
    } else {
      await deleteProviderConnection(id);
    }
  };
  let test;
  try {
    test = await testSingleConnection(id, {});
  } catch (e) {
    await rollback();
    throw new Error("Credential test failed; the previous connection was kept: " + (e.message || e));
  }
  if (!test.valid) {
    await rollback();
    throw new Error("Credential test failed; the previous connection was kept: " + (test.error || "unknown error"));
  }

  const conn = await getProviderConnectionById(id);
  return {
    id,
    name: conn?.name || connName || null,
    tokenExpiresAt: conn?.expiresAt || conn?.earliestPackageExpiry || null,
  };
}

/**
 * After a QR session reaches "authorized" (s.creds holds the serialized
 * cookies), persist + test it, then finish the session. Idempotent — only the
 * first caller runs the save; later polls just observe the status.
 */
export async function persistQrSession(s) {
  if (!s.saving) {
    s.saving = (async () => {
      s.status = "saving";
      try {
        const r = await persistDumateCredential({ creds: s.creds, connectionId: s.connectionId, connName: s.connName, accountKey: s.accountKey, proxyOptions: s.proxyOptions });
        s.connectionId = r.id;
        s.connectionName = r.name;
        s.tokenExpiresAt = r.tokenExpiresAt;
        s.creds = null;
        finish(s, "success");
      } catch (e) {
        s.creds = null;
        finish(s, "error", String(e.message || e).slice(0, 240));
      }
    })();
  }
  await s.saving;
  return pub(s);
}
