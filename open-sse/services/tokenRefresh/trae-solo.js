// Trae SOLO token refresh — per-edition ExchangeToken with DeviceProof.
//
// Contract (dingminhua/dsh-connect-trae `src/refresh.ts`, MIT; cross-checked
// against MIT TraeWorkAssistant `icube_auth.rs` and Buddy2api `traework/token.py`):
//
//   POST {ug_host}/trae/api/v3/oauth/ExchangeToken
//   headers: x-device-id, x-app-id, x-platform-code: SOLO_PC,
//            x-cloudide-token: ""   ← empty string on purpose
//   body:    { ClientID, ClientSecret:"", RefreshToken, DeviceInfo, DeviceProof, IDEVersion }
//   proof:   ECDSA P-256 + SHA-256 over
//            "POST\n<path>\n<ClientID>\n<RefreshToken>\n<timestamp>\n<nonce>"
//            signature base64 of the 64-byte P1363 r||s form (DER is rejected).
//
// Error codes on this endpoint:
//   20405 — DeviceProof required / rejected (no key, or DER instead of P1363)
//   20403 — device does not match (device id / public key pair)
//   10101 — SOLO refresh does not accept the desktop ClientID
//
// Legacy `cloudide/.../ExchangeToken` (no proof, JSON body) stays as the
// fallback for credentials issued before a device key existed.
//
// Tokens are never logged. Refresh is single-flight per refresh token.

import { dedupRefresh } from "./dedup.js";

const EXCHANGE_PATH = "/trae/api/v3/oauth/ExchangeToken";
const LEGACY_PATH = "/cloudide/api/v3/trae/oauth/ExchangeToken";
const PLATFORM_CODE = "SOLO_PC";
const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const IDE_VERSION = "0.1.61";

const EDITIONS = {
  cn: {
    hosts: ["https://api.trae.cn", "https://api.trae.com.cn"],
    // SOLO CN client id (from the official product.json / TraeWork constants).
    clientId: "en1oxy7wnw8j9n",
    legacyHosts: ["https://api.trae.com.cn", "https://api.marscode.cn", "https://api.trae.cn"],
    legacyClientId: "ono9krqynydwx5",
  },
  intl: {
    hosts: ["https://api.trae.ai", "https://www.trae.ai"],
    // Not verified for the intl edition — kept as the desktop client id and
    // covered by the legacy fallback.
    clientId: "ono9krqynydwx5",
    legacyHosts: ["https://api.marscode.com", "https://api.trae.ai", "https://www.trae.ai"],
    legacyClientId: "ono9krqynydwx5",
  },
};

export function traeSoloSiteFromCredentials(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const declared = String(psd.site || "").trim().toLowerCase();
  if (declared === "cn" || declared === "intl") return declared;
  // This channel is CN-only today (trae-api-cn.mchost.guru), so an undeclared
  // site means CN — unlike `trae`, whose default is intl.
  return "cn";
}

/** Map a failed ExchangeToken body to a stable reason string (testable). */
export function classifyTraeSoloExchangeError(bodyText) {
  const text = String(bodyText || "");
  if (/"\s*Code\s*"\s*:\s*20405\b/.test(text) || /\b20405\b/.test(text)) return "device_proof_required";
  if (/"\s*Code\s*"\s*:\s*20403\b/.test(text) || /\b20403\b/.test(text)) return "device_not_match";
  if (/\b10101\b/.test(text)) return "solo_client_mismatch";
  return null;
}

function expiresInFromResult(result) {
  if (!result || typeof result !== "object") return undefined;
  const duration = Number(result.TokenExpireDuration);
  if (Number.isFinite(duration) && duration > 0) {
    // TokenExpireDuration is milliseconds in the reference implementation.
    return Math.max(1, Math.floor(duration / 1000));
  }
  const iso = result.TokenExpireAt || result.expiredAt;
  if (typeof iso === "string" && iso) {
    const ms = Date.parse(iso) - Date.now();
    if (Number.isFinite(ms) && ms > 0) return Math.max(1, Math.floor(ms / 1000));
  }
  const numeric = Number(result.ExpiresAt || result.expiresAt);
  if (Number.isFinite(numeric) && numeric > 0) {
    // Legacy endpoint returns absolute seconds; some editions return ms.
    const seconds = numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;
    return Math.max(1, Math.floor(seconds - Math.floor(Date.now() / 1000)));
  }
  return undefined;
}

function parseExchangePayload(payload, fallbackRefreshToken) {
  const result = payload?.Result || payload?.result || payload?.data || payload;
  if (!result || typeof result !== "object") return null;
  const accessToken = result.Token || result.AccessToken || result.accessToken || result.token;
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: result.RefreshToken || result.refreshToken || fallbackRefreshToken,
    expiresIn: expiresInFromResult(result),
  };
}

async function buildDeviceProof(credentials, clientId, refreshToken, nodeCrypto) {
  const psd = credentials?.providerSpecificData || {};
  const privateKeyPem = psd.devicePrivateKeyPem || psd.deviceKeyPem;
  if (!privateKeyPem) return null;
  const crypto = nodeCrypto;
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const material = `POST\n${EXCHANGE_PATH}\n${clientId}\n${refreshToken}\n${timestamp}\n${nonce}`;
  const signature = crypto
    .sign("sha256", Buffer.from(material, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" })
    .toString("base64");
  return {
    proof: { Signature: signature, Timestamp: timestamp, Nonce: nonce },
    publicKeyPem,
  };
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => "");
  return { response, text };
}

async function tryProofExchange({ credentials, refreshToken, site, edition, log }) {
  let nodeCrypto;
  try {
    nodeCrypto = await import("node:crypto");
  } catch {
    return { result: null, reason: "crypto_unavailable" };
  }
  const device = await buildDeviceProof(credentials, edition.clientId, refreshToken, nodeCrypto).catch((error) => {
    log?.warn?.("TOKEN_REFRESH", `trae-solo: device key unusable: ${error.message}`, { site });
    return null;
  });
  if (!device) return { result: null, reason: "no_device_key" };

  const psd = credentials?.providerSpecificData || {};
  const body = {
    ClientID: edition.clientId,
    ClientSecret: "",
    RefreshToken: refreshToken,
    DeviceInfo: {
      DeviceID: String(psd.deviceId || ""),
      MachineID: String(psd.machineId || ""),
      PlatformCode: PLATFORM_CODE,
      DeviceType: "PC",
      DeviceName: String(psd.deviceName || "PC"),
      ClientVersion: IDE_VERSION,
      DevicePublicKey: device.publicKeyPem,
      OSInfo: "windows",
    },
    DeviceProof: device.proof,
    IDEVersion: IDE_VERSION,
  };

  let lastReason = null;
  for (const host of edition.hosts) {
    const url = `${host.replace(/\/$/, "")}${EXCHANGE_PATH}`;
    const headers = {
      "Content-Type": "application/json",
      Accept: "*/*",
      "x-app-id": APP_ID,
      "x-platform-code": PLATFORM_CODE,
      // The reference implementation requires an EMPTY value here: sending the
      // old access token answers 20405, omitting the header answers 20403.
      "x-cloudide-token": "",
      "User-Agent": "TRAE-SOLO-CN/0.1.61",
    };
    if (psd.deviceId) headers["x-device-id"] = String(psd.deviceId);
    try {
      const { response, text } = await postJson(url, headers, body);
      const reason = classifyTraeSoloExchangeError(text);
      if (response.ok) {
        const parsed = parseExchangePayload(text ? JSON.parse(text) : null, refreshToken);
        if (parsed) {
          log?.info?.("TOKEN_REFRESH", "trae-solo: DeviceProof ExchangeToken succeeded", { site });
          return { result: parsed, reason: null };
        }
        lastReason = "missing_token";
        continue;
      }
      lastReason = reason || `http_${response.status}`;
      log?.warn?.("TOKEN_REFRESH", `trae-solo: DeviceProof exchange rejected (${lastReason})`, {
        site,
        host,
        status: response.status,
      });
      // 20403 / 20405 are device-binding failures; another host will not fix
      // them, but continuing keeps the edition list symmetric and cheap.
    } catch (error) {
      lastReason = "network_error";
      log?.warn?.("TOKEN_REFRESH", `trae-solo: DeviceProof exchange failed: ${error.message}`, { site, host });
    }
  }
  return { result: null, reason: lastReason };
}

async function tryLegacyExchange({ refreshToken, site, edition, log }) {
  const body = {
    ClientID: edition.legacyClientId,
    RefreshToken: refreshToken,
    ClientSecret: "-",
    UserID: "",
  };
  let lastReason = null;
  for (const host of edition.legacyHosts) {
    const url = `${host.replace(/\/$/, "")}${LEGACY_PATH}`;
    try {
      const { response, text } = await postJson(
        url,
        {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Trae/1.0.0 antigravity-cockpit-tools",
        },
        body
      );
      const reason = classifyTraeSoloExchangeError(text);
      if (response.ok) {
        const parsed = parseExchangePayload(text ? JSON.parse(text) : null, refreshToken);
        if (parsed) {
          log?.info?.("TOKEN_REFRESH", "trae-solo: legacy ExchangeToken succeeded", { site });
          return { result: parsed, reason: null };
        }
        lastReason = "missing_token";
        continue;
      }
      lastReason = reason || `http_${response.status}`;
      log?.warn?.("TOKEN_REFRESH", `trae-solo: legacy exchange rejected (${lastReason})`, {
        site,
        host,
        status: response.status,
      });
    } catch (error) {
      lastReason = "network_error";
      log?.warn?.("TOKEN_REFRESH", `trae-solo: legacy exchange failed: ${error.message}`, { site, host });
    }
  }
  return { result: null, reason: lastReason };
}

/**
 * Refresh a `trae-solo` credential.
 *
 * Order: DeviceProof exchange → legacy (no proof) exchange. `10101` means the
 * SOLO refresh endpoint refuses this client id entirely; when BOTH paths say
 * that, the refresh token needs a re-login (invalid_grant).
 */
export async function refreshTraeSoloToken(refreshToken, credentials, log) {
  if (!refreshToken) return null;
  const site = traeSoloSiteFromCredentials(credentials);
  const edition = EDITIONS[site] || EDITIONS.cn;

  return dedupRefresh("trae-solo", refreshToken, async () => {
    const proof = await tryProofExchange({ credentials, refreshToken, site, edition, log });
    if (proof.result) return proof.result;

    const legacy = await tryLegacyExchange({ refreshToken, site, edition, log });
    if (legacy.result) return legacy.result;

    if (proof.reason === "solo_client_mismatch" && legacy.reason === "solo_client_mismatch") {
      log?.warn?.("TOKEN_REFRESH", "trae-solo: refresh endpoint rejected the desktop client id (10101) — re-login required", { site });
      return { error: "invalid_grant" };
    }
    return null;
  }, log);
}
