import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, updateApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// POST /api/keys/rotate — re-issue every active key under the current secret.
// Only allowed while the experimental key-secret rotation is enabled: keys
// issued under the old secret stop validating the moment the secret changes,
// and there is no way back (the previous secret is not stored).
// Module-level in-flight flag: a double-submit (or two tabs) racing this
// endpoint would retire and re-issue every key twice. Second caller gets 409.
let rotateInFlight = false;

export async function POST() {
  if (rotateInFlight) {
    return NextResponse.json(
      { error: "A rotation is already in progress" },
      { status: 409 }
    );
  }
  rotateInFlight = true;
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
      // Issue a replacement signed under the current secret, then retire the
      // old row. Strip any prior "(rotated)" suffixes so repeated rotations
      // don't stack into "name (rotated) (rotated)".
      const baseName = key.name.replace(/(?:\s*\(rotated\))+$/, "");
      const fresh = await createApiKey(`${baseName} (rotated)`, machineId);
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
  } finally {
    rotateInFlight = false;
  }
}
