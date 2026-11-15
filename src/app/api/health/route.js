import { NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * Redact the path-bearing detail out of a driver-load message.
 *
 * The driver layer records the raw `Error.message` of a failed load, and for a
 * native module that is routinely a fully-qualified path
 * ("Cannot find module 'C:\\Users\\someone\\AppData\\...\\better-sqlite3'"). This
 * endpoint is public and CORS-* by design — it is the one thing an outside
 * monitor can poll — so echoing that leaks the local username and layout to any
 * caller. Keep the useful part (which driver failed and roughly why) and drop
 * the location.
 */
function redactDriverError(message) {
  if (!message) return null;
  return message
    // Windows drive path, POSIX path, or a bare UNC path.
    .replace(/[A-Za-z]:\\[^\s'"]*/g, "<path>")
    .replace(/(?:^|[\s'"(])\/(?:[^\s'"]+)/g, (m) => `${m[0] === "/" ? "" : m[0]}<path>`)
    .replace(/\\\\[^\s'"]*/g, "<path>");
}

/**
 * In-flight relay request total — the drain signal the fnOS panel's
 * auto-update reads (issue #97 收尾:重启前等在途请求排空). Reads the live
 * registry global (`usageRepo` owns the shape; `pendingRequests.byAccount`
 * counts per account/model) DIRECTLY so health stays import-free of the DB
 * layer — a probe that opens SQLite is its own outage.
 */
export function sumPendingRequests(byAccount) {
  let total = 0;
  for (const models of Object.values(byAccount || {})) {
    for (const count of Object.values(models || {})) {
      const n = Number(count);
      if (Number.isFinite(n) && n > 0) total += n;
    }
  }
  return total;
}

export async function GET() {
  // Read-only on purpose: /api/health must never initialise the DB (a health
  // probe that opens SQLite is its own outage). Report what the driver layer
  // has ALREADY settled on, or null before it runs.
  //   driver           → which SQLite driver won (better-sqlite3 / node:sqlite / sql.js)
  //   lastDriverError  → why a preferred driver was skipped (e.g. a broken
  //                      better-sqlite3 in the global tree), else null. Paths
  //                      are redacted: see redactDriverError.
  const dbState = global._dbAdapter;
  // Drain signal (issue #97): total in-flight relay requests. The registry
  // global is absent until the first request pipeline module loads — absent
  // field means "unknown", the panel's drain probe treats it as 0.
  let activeRequests;
  try {
    const total = sumPendingRequests(global._pendingRequests?.byAccount);
    if (Number.isFinite(total)) activeRequests = total;
  } catch {
    // Absent field — panel treats as 0 (旧版主应用同口径,向后兼容).
  }
  return NextResponse.json(
    {
      ok: true,
      driver: dbState?.instance?.driver ?? null,
      lastDriverError: redactDriverError(dbState?.lastDriverError),
      ...(activeRequests === undefined ? {} : { activeRequests }),
    },
    { headers: CORS_HEADERS },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
