import { NextResponse } from "next/server";

/**
 * POST /api/oauth/codebuddy-cn/checkin
 * Trigger a manual CodeBuddy CN daily check-in for all active codebuddy-cn
 * connections, and return per-account results.
 *
 * Unlike the sibling `export`/`bulk-import` routes, this route NEVER returns or
 * accepts tokens — it only surfaces a per-account status string
 * ("checked-in" / "already" / "failed"), so no password re-entry is required.
 * The dashboard session already guards the page that calls it.
 */
export async function POST() {
  try {
    const { runCodebuddyCheckinTick } = await import(
      "@/sse/services/codebuddyCheckin.js"
    );
    const results = await runCodebuddyCheckinTick();
    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.log("Error running CodeBuddy CN check-in:", error.message);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
