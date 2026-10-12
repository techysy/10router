/**
 * POST   /api/external-quota/<source> — push a provider's parsed quota numbers
 * DELETE /api/external-quota/<source> — drop the snapshot (hides the card)
 *
 * Written for external companion apps (CreditDaddy and successors) that own the
 * scraping/parsing side: this endpoint only DISPLAYS quota. The payload is
 * whitelisted to scalar quota fields (see src/lib/externalQuota.js) — there is
 * no field that could store a credential, and normalization refuses nested
 * values outright.
 *
 * Auth: the guard passes POST/DELETE on this prefix only with a dashboard
 * virtual key (sk-…) or the local CLI token, but the route VERIFIES AGAIN
 * itself — the guard exception for /api/usage/quotas-style paths is documented
 * as "the route verifies itself", and requireLogin=false deployments would
 * otherwise have any LAN writer pushing cards. A dashboard JWT also counts
 * (the page's own "delete this pushed card" button rides the user's session).
 */

import { NextResponse } from "next/server";
import { validateApiKey, getSettings } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { readCliToken } from "@/lib/auth/authHeaders";
import {
  normalizeExternalQuotaPayload,
  saveExternalQuotaSnapshot,
  deleteExternalQuotaSnapshot,
  isValidExternalQuotaSource,
} from "@/lib/externalQuota";

const CLI_TOKEN_SALT = "9r-cli-auth";

// Same extraction order the guard uses for virtual keys (Bearer → x-api-key →
// ?key=); the /v1-family headers are irrelevant for a dashboard-side push.
function extractVirtualKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return request.headers.get("x-api-key") || request.nextUrl?.searchParams?.get("key") || null;
}

async function authorized(request) {
  const cliToken = readCliToken(request);
  if (cliToken && cliToken === (await getConsistentMachineId(CLI_TOKEN_SALT))) return true;

  const apiKey = extractVirtualKey(request);
  if (apiKey && (await validateApiKey(apiKey))) return true;

  const jwt = request.cookies.get("auth_token")?.value;
  if (jwt && (await verifyDashboardAuthToken(jwt))) return true;

  // LAN mode (requireLogin=false): the dashboard operator has no cookie by
  // design, and the guard's catch-all lets the session through — the page's
  // own "remove pushed card" button must keep working there. The exposure is
  // identical to every other dashboard write in that mode, so mirror it here.
  try {
    const settings = await getSettings();
    if (settings?.requireLogin === false) return true;
  } catch { /* settings unreadable → fall through to deny */ }

  return false;
}

export async function POST(request, { params }) {
  try {
    const { source } = await params;
    if (!isValidExternalQuotaSource(source)) {
      return NextResponse.json(
        { error: "invalid source: use ^[a-z0-9][a-z0-9-]{0,31}$" },
        { status: 400 },
      );
    }
    if (!(await authorized(request))) {
      return NextResponse.json(
        { error: "Unauthorized: virtual API key (Bearer sk-…) or CLI token required" },
        { status: 401 },
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
    }

    const result = normalizeExternalQuotaPayload(source, body);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    await saveExternalQuotaSnapshot(result.snapshot);
    return NextResponse.json({
      ok: true,
      source: result.snapshot.source,
      entries: result.snapshot.entries.length,
      pushedAt: result.snapshot.pushedAt,
    });
  } catch (error) {
    console.error("Error saving external quota:", error);
    return NextResponse.json({ error: "Failed to save external quota" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { source } = await params;
    if (!isValidExternalQuotaSource(source)) {
      return NextResponse.json({ error: "invalid source" }, { status: 400 });
    }
    if (!(await authorized(request))) {
      return NextResponse.json(
        { error: "Unauthorized: virtual API key (Bearer sk-…), CLI token or dashboard session required" },
        { status: 401 },
      );
    }

    const removed = await deleteExternalQuotaSnapshot(source);
    return NextResponse.json({ ok: true, removed });
  } catch (error) {
    console.error("Error deleting external quota:", error);
    return NextResponse.json({ error: "Failed to delete external quota" }, { status: 500 });
  }
}
