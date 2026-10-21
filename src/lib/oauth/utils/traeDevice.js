// Trae login device key pair (EC P-256).
//
// The official client generates a fresh pair on every login and puts the SPKI
// public PEM into ExchangeToken's `DeviceInfo.DevicePublicKey`. The server binds
// it to that login's DeviceID/MachineID; an empty value is answered with HTTP 401
// / business code 20405, so this is not optional metadata.
//
// The private key must be persisted with the credential: the SOLO refresh path
// (`open-sse/services/tokenRefresh/trae-solo.js`) signs its DeviceProof with it.
// Discarding it silently breaks the device binding on the first refresh.
import crypto from "node:crypto";

export function generateDeviceKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Shape used inside ExchangeToken's DeviceInfo block. */
export function buildDeviceInfo(device) {
  return {
    DevicePublicKey: device?.publicPem || "",
    DeviceType: "windows",
    DeviceBrand: "83DG",
    DeviceName: "DESKTOP-CPASOLO",
    OSVersion: "Windows 11 Pro",
  };
}
