import { NextResponse } from "next/server";
import { getDistinctProviders } from "@/lib/requestDetailsDb";
import { getProviderNodes } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

/**
 * GET /api/usage/providers
 * Returns list of unique providers from request details plus imported usage
 * rows (importUsageRows writes usageHistory only, so providers from the ZCode
 * plugin / 9r backup imports must be unioned in or the filter dropdown hides
 * them).
 */
export async function GET() {
  try {
    // Query DISTINCT provider column directly — avoids parsing every row's
    // full JSON blob (can be hundreds of MB), which previously caused OOM.
    const providerIds = await getDistinctProviders();

    try {
      const db = await getAdapter();
      const importedRows = db.all(
        `SELECT DISTINCT provider FROM usageHistory WHERE provider IS NOT NULL AND meta LIKE '%"imported":true%' ORDER BY provider ASC`
      );
      for (const r of importedRows) {
        if (!providerIds.includes(r.provider)) providerIds.push(r.provider);
      }
    } catch { /* usageHistory unavailable — filter falls back to details-only */ }

    const providerNodes = await getProviderNodes();
    const nodeMap = {};
    for (const node of providerNodes) {
      nodeMap[node.id] = node.name;
    }

    const providers = providerIds.map(providerId => {
      let name = providerId;
      if (nodeMap[providerId]) {
        name = nodeMap[providerId];
      } else {
        const providerConfig = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
        if (providerConfig?.name) name = providerConfig.name;
      }
      return { id: providerId, name };
    });

    return NextResponse.json({ providers });
  } catch (error) {
    console.error("[API] Failed to get providers:", error);
    return NextResponse.json(
      { error: "Failed to fetch providers" },
      { status: 500 }
    );
  }
}
