import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";
import { getSettings } from "@/lib/db/index.js";

const LEGACY_FALLBACK_SECRET = "endpoint-proxy-api-key-secret";
let _generatedSecretCache = null;

// Opt-in experimental secret rotation (settings.apiKeyRotation, or env
// API_KEY_ROTATION=true). Default OFF: enabling regenerates the HMAC secret,
// which invalidates every existing API key's CRC — that migration must never
// happen silently. When on, same contract as JWT_SECRET (dashboardSession):
// env wins, else a random secret is auto-generated to
// $DATA_DIR/api-key-secret (mode 0600).
async function isRotationEnabled() {
  if (process.env.API_KEY_SECRET) return false; // explicit env secret always wins
  if (process.env.API_KEY_ROTATION === "true") return true;
  try {
    const settings = await getSettings();
    return settings?.apiKeyRotation === true;
  } catch {
    return false; // DB unavailable → legacy behavior
  }
}

function ensureGeneratedSecret() {
  if (_generatedSecretCache) return _generatedSecretCache;
  const file = path.join(DATA_DIR, "api-key-secret");
  try {
    _generatedSecretCache = fs.readFileSync(file, "utf8").trim();
    return _generatedSecretCache;
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _generatedSecretCache = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, _generatedSecretCache, { mode: 0o600 });
  return _generatedSecretCache;
}

// Resolved per call (cheap after first rotation): env secret → generated
// secret (rotation on) → legacy fallback (rotation off, production warns).
async function resolveApiKeySecret() {
  const fromEnv = process.env.API_KEY_SECRET;
  if (fromEnv) return fromEnv;
  if (await isRotationEnabled()) return ensureGeneratedSecret();
  if (process.env.NODE_ENV === "production" && !process.env.API_KEY_ROTATION) {
    // Warn once per process — the built-in secret is public knowledge.
    if (!resolveApiKeySecret._warned) {
      resolveApiKeySecret._warned = true;
      console.warn(
        "[auth] API_KEY_SECRET is unset — falling back to a well-known built-in secret. " +
          "Set API_KEY_SECRET, or enable key rotation in Endpoint settings (experimental; " +
          "existing API keys will need to be re-issued after enabling).",
      );
    }
  }
  return LEGACY_FALLBACK_SECRET;
}

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
async function generateCrc(machineId, keyId) {
  const secret = await resolveApiKeySecret();
  return crypto
    .createHmac("sha256", secret)
    .update(machineId + keyId)
    .digest("hex")
    .slice(0, 8);
}

/**
 * Generate API key with machineId embedded
 * Format: sk-{machineId}-{keyId}-{crc8}
 * @param {string} machineId - 16-char machine ID
 * @returns {Promise<{ key: string, keyId: string }>}
 */
export async function generateApiKeyWithMachine(machineId) {
  const keyId = generateKeyId();
  const crc = await generateCrc(machineId, keyId);
  const key = `sk-${machineId}-${keyId}-${crc}`;
  return { key, keyId };
}

/**
 * Parse API key and extract machineId + keyId
 * Supports both formats:
 * - New: sk-{machineId}-{keyId}-{crc8}
 * - Old: sk-{random8}
 * @param {string} apiKey
 * @returns {Promise<{ machineId: string, keyId: string, isNewFormat: boolean } | null>}
 */
export async function parseApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) return null;

  const parts = apiKey.split("-");

  // New format: sk-{machineId}-{keyId}-{crc8} = 4 parts
  if (parts.length === 4) {
    const [, machineId, keyId, crc] = parts;

    // Validate CRC
    const expectedCrc = await generateCrc(machineId, keyId);
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
 * @returns {Promise<boolean>}
 */
export async function verifyApiKeyCrc(apiKey) {
  const parsed = await parseApiKey(apiKey);
  if (!parsed) return false;

  // Old format doesn't have CRC, always valid if parsed
  if (!parsed.isNewFormat) return true;

  // New format already verified in parseApiKey
  return true;
}

/**
 * Check if API key is new format (contains machineId)
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
export async function isNewFormatKey(apiKey) {
  const parsed = await parseApiKey(apiKey);
  return parsed?.isNewFormat === true;
}

