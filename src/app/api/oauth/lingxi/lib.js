/*
 * Shared helpers for the lingxi bookmarklet / cookie-import routes.
 * Same role as ../dumate/lib.js: touches the DB layer + the dashboard test
 * path; open-sse stays provider-runtime only.
 */

import { createHash } from "node:crypto";
import {
  getProviderConnections,
  getProviderConnectionById,
  createProviderConnection,
  updateProviderConnection,
  deleteProviderConnection,
} from "@/models";
import { testSingleConnection } from "@/app/api/providers/[id]/test/testUtils.js";
import { lingxiAccountKey, lingxiUidFromCookie, maskLingxiUid } from "open-sse/shared/lingxi/capture.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

/** Owner key for import-session scoping — hash of the dashboard credential. */
export function ownerOf(request) {
  const token = request.cookies.get("auth_token")?.value || request.headers.get("authorization") || "";
  return createHash("sha256").update(token).digest("hex");
}

export const json = (obj, status = 200, headers) =>
  NextResponseJson(obj, status, headers);

import { NextResponse } from "next/server";
function NextResponseJson(obj, status = 200, headers) {
  return NextResponse.json(obj, { status, headers: { "Cache-Control": "no-store", ...(headers || {}) } });
}

/** Label for a fresh connection: masked uid when we have it. */
export function lingxiConnectionName(cookieHeader) {
  const uid = lingxiUidFromCookie(cookieHeader);
  return uid ? `Lingxi（${maskLingxiUid(uid)}）` : "Lingxi（导入）";
}

/**
 * Persist a lingxi cookie jar and prove it works end to end before keeping it:
 * dedup by uid accountKey -> create/update -> testSingleConnection. On test
 * failure the previous connection is restored. Returns {id, name}.
 */
export async function persistLingxiCredential({ cookieHeader, connectionId, connName }) {
  let id = connectionId;
  const accountKey = lingxiAccountKey(cookieHeader);

  if (!id && accountKey) {
    const list = await getProviderConnections({ provider: "lingxi" });
    const hit = (list || []).find((c) => c.providerSpecificData?.lingxiAccountKey === accountKey);
    if (hit) id = hit.id;
  }

  const old = id ? await getProviderConnectionById(id) : null;
  if (id && (!old || old.provider !== "lingxi")) throw new Error("Target connection is not a WPS 灵犀 connection");

  if (id) {
    await updateProviderConnection(id, {
      apiKey: cookieHeader,
      providerSpecificData: {
        ...(old.providerSpecificData || {}),
        ...(accountKey ? { lingxiAccountKey: accountKey } : {}),
        ...(lingxiUidFromCookie(cookieHeader) ? { lingxiUid: lingxiUidFromCookie(cookieHeader) } : {}),
      },
      testStatus: "unknown",
    });
  } else {
    const conn = await createProviderConnection({
      provider: "lingxi",
      authType: "cookie",
      name: connName || lingxiConnectionName(cookieHeader),
      apiKey: cookieHeader,
      priority: 1,
      testStatus: "unknown",
      isActive: true,
      ...(accountKey
        ? {
            providerSpecificData: {
              lingxiAccountKey: accountKey,
              ...(lingxiUidFromCookie(cookieHeader) ? { lingxiUid: lingxiUidFromCookie(cookieHeader) } : {}),
            },
          }
        : {}),
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
  return { id, name: conn?.name || connName || null };
}
