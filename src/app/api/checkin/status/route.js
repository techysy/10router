// GET /api/checkin/status?days=7&provider=raccoon&day=YYYY-MM-DD
//
// Read-only view of the check-in ledger (migrations/007-checkin-runs.js).
// No credentials in the response — ids, labels, status, amounts only.
import { NextResponse } from "next/server";
import { getCheckinRuns, getCheckinSummary } from "@/lib/db/repos/checkinRepo.js";
import { dayKey } from "@/sse/services/checkin/scheduler.js";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider") || null;
  const day = searchParams.get("day") || null;
  const days = Math.max(1, Math.min(Number(searchParams.get("days")) || 7, 90));
  const limit = Math.max(1, Math.min(Number(searchParams.get("limit")) || 200, 1000));

  const [runs, summary] = await Promise.all([
    getCheckinRuns({ day, provider, limit }),
    getCheckinSummary({ days }),
  ]);

  return NextResponse.json({
    ok: true,
    today: dayKey(),
    summary,
    runs,
  });
}
