import { NextResponse } from "next/server";
// Bulk enable/disable for a provider's custom models (P2: 100+-model imports
// default-disabled need a one-click path back, and a panic "disable all").
import { setCustomModelsEnabled } from "@/lib/db/repos/aliasRepo";

// POST /api/models/custom/bulk
// body: { providerAlias, type?, enabled, ids? } — ids omitted = every custom
// model of that provider+type.
export async function POST(request) {
  try {
    const { providerAlias, type, enabled, ids } = await request.json();
    if (!providerAlias || typeof enabled !== "boolean") {
      return NextResponse.json({ error: "providerAlias and enabled (boolean) required" }, { status: 400 });
    }
    const updated = await setCustomModelsEnabled({
      providerAlias,
      type: type || "llm",
      enabled,
      ids: Array.isArray(ids) ? ids : null,
    });
    return NextResponse.json({ success: true, updated });
  } catch (error) {
    console.log("Error bulk-updating custom models:", error);
    return NextResponse.json({ error: "Failed to bulk-update custom models" }, { status: 500 });
  }
}
