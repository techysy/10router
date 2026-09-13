import { NextResponse } from "next/server";
import { openTransfer } from "@/lib/auth/secureTransfer";
import { importAccounts } from "@/lib/oauth/accountTransfer";

/**
 * POST /api/oauth/transfer/import
 * Import connections from an encrypted transfer blob. Body:
 * { provider, passphrase, blob }.
 *
 * Authorization = the transfer passphrase itself: correct decryption (GCM tag)
 * proves possession of the export passphrase, so no dashboard password is
 * required on top of it. The guard still requires JWT/CLI for the route
 * (ALWAYS_PROTECTED), so anonymous/免密 deployments can't reach it at all.
 *
 * The provider in the body wins over the blob's stored provider — the operator
 * decides which provider the credentials land on (cross-recovery use case).
 */
export async function POST(request) {
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
