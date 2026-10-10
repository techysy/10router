import { NextResponse } from "next/server";
import {
  getApiKeys, createApiKey,
  sumAllApiKeyTokensSince, localStartOfDayIso, DAILY_LIMIT_MAX,
} from "@/lib/localDb";
import { hashApiKey } from "@/lib/db/crypto/apiKeyIdentity.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// Shared input contract for POST(create)/PUT(update): accepts the optional
// per-key daily token cap. Absent/empty/0 → unlimited (null); anything else
// must be an integer in (0, DAILY_LIMIT_MAX]. Returns {ok, value} or an error
// message — keeping the two routes honest in one place.
function parseDailyTokenLimit(raw) {
  if (raw === undefined || raw === null || raw === "" || raw === 0) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > DAILY_LIMIT_MAX) {
    return { ok: false, error: "Invalid dailyTokenLimit" };
  }
  return { ok: true, value: n };
}

// GET /api/keys - List API keys
//
// Keys that carry a daily limit also get `todayTokens` attached (server-side
// join over usageHistory by apiKeyHash, same local-midnight boundary as the
// enforcement) so the UI can render "37.2M / 100M today" without hashing raw
// keys in the browser. Aggregation failure degrades to "no usage shown",
// never to a failed list.
export async function GET() {
  try {
    const keys = await getApiKeys();
    const limited = keys.filter((k) => k.dailyTokenLimit);
    if (limited.length === 0) return NextResponse.json({ keys });

    let usageByHash = new Map();
    try {
      const rows = await sumAllApiKeyTokensSince(localStartOfDayIso());
      usageByHash = new Map(rows.map((r) => [r.apiKeyHash, r.tokens]));
    } catch (error) {
      console.log("Error aggregating per-key usage:", error);
    }
    const out = keys.map((k) =>
      k.dailyTokenLimit
        ? { ...k, todayTokens: usageByHash.get(hashApiKey(k.key)) || 0 }
        : k
    );
    return NextResponse.json({ keys: out });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, dailyTokenLimit } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    const parsed = parseDailyTokenLimit(dailyTokenLimit);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, parsed.value);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      dailyTokenLimit: apiKey.dailyTokenLimit,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
