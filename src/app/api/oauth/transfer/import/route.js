import { NextResponse } from "next/server";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { openTransfer } from "@/lib/auth/secureTransfer";
import { importAccounts } from "@/lib/oauth/accountTransfer";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const PASSWORD_HEADER = "x-9r-password";

// CLI token requests are already trusted (local machine); skip password re-auth.
function isCliRequest(request) {
  return Boolean(request.headers.get(CLI_TOKEN_HEADER));
}

/**
 * POST /api/oauth/transfer/import
 * Import connections from an encrypted transfer blob. Body:
 * { provider, password, passphrase, blob } — `password` re-authenticates the
 * dashboard user, `passphrase` decrypts the blob (must match the export
 * passphrase). The decrypted accounts are merged into `provider` by identity
 * (JWT sub → refreshToken → name; new identities create connections).
 *
 * The provider in the body wins over the blob's stored provider — the operator
 * decides which provider the credentials land on (cross-recovery use case).
 */
export async function POST(request) {
  if (!isCliRequest(request) && !(await verifyDashboardPassword(request.headers.get(PASSWORD_HEADER)))) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json({ error: `Invalid JSON body: ${err.message}` }, { status: 400 });
  }
  const { provider, passphrase, blob } = body || {};
  if (!provider || !passphrase || !blob) {
    return NextResponse.json({ error: "provider, passphrase and blob required" }, { status: 400 });
  }

  let accounts;
  try {
    const opened = openTransfer(blob, passphrase);
    accounts = opened.accounts;
  } catch (error) {
    if (error.message === "WRONG_PASSWORD") {
      return NextResponse.json({ error: "Wrong passphrase" }, { status: 401 });
    }
    return NextResponse.json({ error: "Unreadable transfer file" }, { status: 400 });
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return NextResponse.json({ error: "Transfer file contains no accounts" }, { status: 400 });
  }

  const summary = await importAccounts(provider, accounts);
  return NextResponse.json(summary);
}
