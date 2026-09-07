import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, updateApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// POST /api/keys/rotate — re-issue every active key under the current secret.
// Only allowed while the experimental key-secret rotation is enabled: keys
// issued under the old secret stop validating the moment the secret changes,
// and there is no way back (the previous secret is not stored).
export async function POST() {
  try {
    const settings = await getSettings();
    if (settings?.apiKeyRotation !== true) {
      return NextResponse.json(
        { error: "Key secret rotation is not enabled" },
        { status: 409 }
      );
    }

    const machineId = await getConsistentMachineId();
    const existing = await getApiKeys();
    const rotated = [];

    for (const key of existing) {
      if (key.isActive === false) continue;
      // Issue a replacement signed under the current secret, then retire the old row.
      const fresh = await createApiKey(`${key.name} (rotated)`, machineId);
      await updateApiKey(key.id, { isActive: false });
      rotated.push({
        id: fresh.id,
        name: fresh.name,
        key: fresh.key,
        previousName: key.name,
      });
    }

    return NextResponse.json({ rotated, machineId });
  } catch (error) {
    console.log("Error rotating keys:", error);
    return NextResponse.json({ error: "Failed to rotate keys" }, { status: 500 });
  }
}
