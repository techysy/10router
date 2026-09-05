import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { importUsageFromSqlite, importUsageFromJson } from "./importUsage.js";
import { verifyDashboardPassword, getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { validateApiKey, getSettings } from "@/lib/localDb";

const PASSWORD_HEADER = "x-9r-password";
const CLI_TOKEN_HEADER = "x-9r-cli-token";

// POST /api/settings/database/import-usage
// Import HISTORICAL USAGE ONLY (usageHistory rows) from a 9router backup
// (SQLite data.sqlite or the exported JSON backup). Configuration is never
// touched — only usage statistics are merged in, deduped by exact row signature.
//
// Same auth model as /api/settings/database: dashboard sessions (and
// requireLogin=false instances) pass without re-entering the password; API
// clients (CLI scripts, plugins) present either the dashboard password via
// x-9r-password or a virtual proxy key (sk-…) via Authorization: Bearer.
export async function POST(request) {
  try {
    if (!(await isAuthorized(request))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    const contentType = request.headers.get("content-type") || "";
    let result;
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
      const bytes = Buffer.from(await file.arrayBuffer());
      result = await importUsageFromSqlite(bytes, file.name || "data.sqlite");
    } else {
      const payload = await request.json();
      result = await importUsageFromJson(payload);
    }
    return NextResponse.json(result);
  } catch (error) {
    console.log("Error importing usage history:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import usage history" },
      { status: 400 }
    );
  }
}

async function isAuthorized(request) {
  // CLI token — value already validated by the dashboard guard middleware;
  // presence here mirrors the sibling /api/settings/database route.
  if (request.headers.get(CLI_TOKEN_HEADER)) return true;

  // Dashboard login session — no password re-entry for logged-in users.
  try {
    const cookieStore = await cookies();
    if (await getDashboardAuthSession(cookieStore.get("auth_token")?.value)) return true;
  } catch { /* no cookie context — fall through */ }

  // Zero-auth instances (requireLogin=false) intentionally skip passwords.
  try {
    const settings = await getSettings();
    if (settings?.requireLogin === false) return true;
  } catch { /* settings unavailable — keep verifying credentials */ }

  // Explicit dashboard password (same header as the database export/import).
  const password = request.headers.get(PASSWORD_HEADER);
  if (password && (await verifyDashboardPassword(password))) return true;

  // Virtual proxy key (sk-…) — the same keys clients already hold for /v1,
  // so plugins can reuse them without learning the dashboard password.
  const authHeader = request.headers.get("authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (bearer && (await validateApiKey(bearer))) return true;

  return false;
}
