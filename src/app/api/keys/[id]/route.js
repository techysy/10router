import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey, DAILY_LIMIT_MAX } from "@/lib/localDb";

// Same contract as POST /api/keys: absent/empty/0 clears the limit, anything
// else must be an integer in (0, DAILY_LIMIT_MAX].
function parseDailyTokenLimit(raw) {
  if (raw === undefined || raw === null || raw === "" || raw === 0) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > DAILY_LIMIT_MAX) {
    return { ok: false, error: "Invalid dailyTokenLimit" };
  }
  return { ok: true, value: n };
}

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, dailyTokenLimit } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    // Only touched when the caller sent the field at all — a plain
    // isActive toggle must never rewrite (or clear) an existing limit.
    if (dailyTokenLimit !== undefined) {
      const parsed = parseDailyTokenLimit(dailyTokenLimit);
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      updateData.dailyTokenLimit = parsed.value;
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
