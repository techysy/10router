import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";

const LEGACY_FALLBACK_SECRET = "endpoint-proxy-api-key-secret";

// Opt-in experimental secret rotation (API_KEY_ROTATION=true). Default OFF:
// enabling regenerates the HMAC secret, which invalidates every existing API
// key's CRC on upgrade — that migration must never happen silently. When on,
// same contract as JWT_SECRET (dashboardSession): env wins, else a random
// secret is auto-generated to $DATA_DIR/api-key-secret (mode 0600).
function loadApiKeySecret() {
  const fromEnv = process.env.API_KEY_SECRET;
  if (fromEnv) return fromEnv;
  if (process.env.API_KEY_ROTATION !== "true") {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[auth] API_KEY_SECRET is unset — falling back to a well-known built-in secret. " +
          "Set API_KEY_SECRET, or opt into experimental auto-rotation with API_KEY_ROTATION=true " +
          "(existing API keys will need to be re-issued after enabling).",
      );
    }
    return LEGACY_FALLBACK_SECRET;
  }
  const file = path.join(DATA_DIR, "api-key-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const API_KEY_SECRET = loadApiKeySecret();

/**
 * Generate 6-char random keyId (crypto-grade randomness — key material
 * must not come from Math.random)
 */
function generateKeyId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(6);
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(bytes[i] % chars.length);
  }
  return result;
}

/**
 * Generate CRC (8-char HMAC)
 */
function generateCrc(machineId, keyId) {
  return crypto
    .createHmac("sha256", API_KEY_SECRET)
    .update(machineId + keyId)
    .digest("hex")
    .slice(0, 8);
}

/**
 * Generate API key with machineId embedded
 * Format: sk-{machineId}-{keyId}-{crc8}
 * @param {string} machineId - 16-char machine ID
 * @returns {{ key: string, keyId: string }}
 */
export function generateApiKeyWithMachine(machineId) {
  const keyId = generateKeyId();
  const crc = generateCrc(machineId, keyId);
  const key = `sk-${machineId}-${keyId}-${crc}`;
  return { key, keyId };
}

/**
 * Parse API key and extract machineId + keyId
 * Supports both formats:
 * - New: sk-{machineId}-{keyId}-{crc8}
 * - Old: sk-{random8}
 * @param {string} apiKey
 * @returns {{ machineId: string, keyId: string, isNewFormat: boolean } | null}
 */
export function parseApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) return null;

  const parts = apiKey.split("-");
  
  // New format: sk-{machineId}-{keyId}-{crc8} = 4 parts
  if (parts.length === 4) {
    const [, machineId, keyId, crc] = parts;
    
    // Validate CRC
    const expectedCrc = generateCrc(machineId, keyId);
    if (crc !== expectedCrc) return null;
    
    return { machineId, keyId, isNewFormat: true };
  }
  
  // Old format: sk-{random8} = 2 parts
  if (parts.length === 2) {
    return { machineId: null, keyId: parts[1], isNewFormat: false };
  }
  
  return null;
}

/**
 * Verify API key CRC (only for new format)
 * @param {string} apiKey
 * @returns {boolean}
 */
export function verifyApiKeyCrc(apiKey) {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return false;
  
  // Old format doesn't have CRC, always valid if parsed
  if (!parsed.isNewFormat) return true;
  
  // New format already verified in parseApiKey
  return true;
}

/**
 * Check if API key is new format (contains machineId)
 * @param {string} apiKey
 * @returns {boolean}
 */
export function isNewFormatKey(apiKey) {
  const parsed = parseApiKey(apiKey);
  return parsed?.isNewFormat === true;
}

