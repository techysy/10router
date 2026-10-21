// POST /api/checkin/run  { provider?: string, force?: boolean, dryRun?: boolean }
//
// Manual trigger for the generic check-in scheduler. The sweep still honours
// the per-provider settings toggle — a disabled adapter is a no-op. `force`
// bypasses today's ledger memo and an active channel block; `dryRun` skips the
// ledger write (useful to probe an upstream without recording a claim).
import { NextResponse } from "next/server";
import { runCheckinSweep } from "@/sse/services/checkin/scheduler.js";

export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const provider = typeof body?.provider === "string" && body.provider ? body.provider : null;
  const result = await runCheckinSweep({
    reason: "manual",
    provider,
    force: body?.force === true,
    dryRun: body?.dryRun === true,
  });
  return NextResponse.json(result);
}
