import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { sealTransfer } from "@/lib/auth/secureTransfer";
import { buildExportAccounts } from "@/lib/oauth/accountTransfer";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const PASSWORD_HEADER = "x-9r-password";

// CLI token requests are already trusted (local machine); skip password re-auth.
function isCliRequest(request) {
  return Boolean(request.headers.get(CLI_TOKEN_HEADER));
}

/**
 * POST /api/oauth/transfer/export
 * Export one OAuth provider's connections as an ENCRYPTED transfer blob
 * (passphrase-scrypted, AES-256-GCM). Body: { provider, password, passphrase }.
 * `password` re-authenticates the dashboard user; `passphrase` encrypts the
 * file and is required again at import time.
 */
export async function POST(request) {
  try {
    if (!isCliRequest(request) && !(await verifyDashboardPassword(request.headers.get(PASSWORD_HEADER)))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const { provider, passphrase } = await request.json();
    if (!provider || !passphrase) {
      return NextResponse.json({ error: "provider and passphrase required" }, { status: 400 });
    }

    const connections = await getProviderConnections({ provider });
    const accounts = buildExportAccounts(provider, connections);
    if (accounts.length === 0) {
      return NextResponse.json({ error: "No connections to export" }, { status: 404 });
    }

    const blob = sealTransfer({ provider, exportedAt: new Date().toISOString(), accounts }, passphrase);
    return NextResponse.json({ blob, count: accounts.length });
  } catch (error) {
    if (error.message === "PASSPHRASE_TOO_SHORT") {
      return NextResponse.json({ error: "Passphrase must be at least 4 characters" }, { status: 400 });
    }
    console.log("Error exporting oauth transfer:", error.message);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
