// OfficeAce request signing: SDK-HMAC-SHA256 (control-plane permission checks)
// and V11-HMAC-SHA256 (APIG-scoped, used by `/v1/subscription*`).
//
// Ported (behaviour, not code) from our Rust provider
// `agent2api .../providers/officeace/signer.rs`, whose vectors were produced by
// the MIT officeace2api `signV4`/`signV11`. Three rules differ from the sibling
// CodeArts signer and must not be "aligned" with it:
//   1. unreserved set is alnum + `- _ . ~` only — `!'()*` ARE escaped
//      (`encodeURIComponent` leaves them alone, so we re-escape them);
//   2. the query string follows WHATWG `URL.searchParams` semantics (decode,
//      `+` → space, re-encode, sort by key then value);
//   3. V11 uses the *lowercase hex string* of the derived key as the HMAC key,
//      not the 32 raw bytes.
//
// `Host` is signed but not returned: fetch implementations own that header.
import { createHash, createHmac } from "node:crypto";

const SDK_ALGORITHM = "SDK-HMAC-SHA256";
const V11_ALGORITHM = "V11-HMAC-SHA256";
const SCOPE_SERVICE = "apic";
const HEADER_XSDK_DATE = "x-sdk-date";
const HEADER_SECURITY_TOKEN = "x-security-token";
const HEADER_PROJECT_ID = "x-project-id";
const HEADER_AUTHORIZATION = "authorization";

export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** RFC3986 percent-encoding: `encodeURIComponent` plus `!'()*`. */
export function encodeOfficeAceComponent(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Canonical header value: collapse every whitespace run, trim the ends. */
export function canonicalizeHeaderValue(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).join(" ");
}

/** Canonical URI: decode each segment, re-encode, force a trailing slash. */
export function canonicalizeUri(pathname) {
  const raw = !pathname || pathname === "" ? "/" : String(pathname);
  const encoded = raw
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Keep the raw segment: `new URL().pathname` is always valid escapes,
        // this branch only guards hand-built inputs.
      }
      return encodeOfficeAceComponent(decoded);
    })
    .join("/");
  return encoded.endsWith("/") ? encoded : `${encoded}/`;
}

/** Canonical query per WHATWG `URLSearchParams` + `(key, value)` sort. */
export function canonicalizeQuery(search) {
  const params = new URLSearchParams(search || "");
  const pairs = [...params.entries()].sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  return pairs
    .map(([key, value]) => `${encodeOfficeAceComponent(key)}=${encodeOfficeAceComponent(value)}`)
    .join("&");
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hmacSha256(key, message) {
  return createHmac("sha256", key).update(message).digest();
}

function toBytes(body) {
  if (body === null || body === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(String(body), "utf8");
}

/** UTC `yyyyMMddTHHmmssZ`, the exact shape `X-Sdk-Date` carries. */
export function formatSdkDate(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(Number(input));
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function normalizeHeaders(headers) {
  const map = new Map(); // lowercased name -> { name, value }
  const entries = Array.isArray(headers) ? headers : Object.entries(headers || {});
  for (const [name, value] of entries) {
    if (value === null || value === undefined) continue;
    const lower = String(name).toLowerCase();
    map.set(lower, { name: String(name), value: String(value) });
  }
  return map;
}

/**
 * Build the canonical request pieces shared by both algorithms.
 *
 * @param {object} input
 * @param {string} input.method
 * @param {string} input.url
 * @param {object|Array} [input.headers]
 * @param {string|Buffer} [input.body]
 * @param {string} [input.date] fixed `X-Sdk-Date` (tests); defaults to now
 * @param {{accessKeyId:string, secretAccessKey:string, securityToken?:string, projectId?:string}} input.credential
 */
export function buildOfficeAceCanonicalRequest({ method, url, headers, body, date, credential }) {
  const parsed = new URL(url);
  const headerMap = normalizeHeaders(headers);

  if (credential?.securityToken) {
    headerMap.set(HEADER_SECURITY_TOKEN, { name: "X-Security-Token", value: credential.securityToken });
  }
  if (credential?.projectId) {
    headerMap.set(HEADER_PROJECT_ID, { name: "X-Project-ID", value: credential.projectId });
  }
  if (!headerMap.has(HEADER_XSDK_DATE)) {
    headerMap.set(HEADER_XSDK_DATE, { name: "X-Sdk-Date", value: date || formatSdkDate() });
  }
  if (!headerMap.has("host")) {
    headerMap.set("host", { name: "Host", value: parsed.host });
  }

  const sdkDate = headerMap.get(HEADER_XSDK_DATE)?.value || "";

  const canonical = [...headerMap.entries()]
    .map(([lower, entry]) => [lower, canonicalizeHeaderValue(entry.value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalHeaders = canonical.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = canonical.map(([name]) => name).join(";");

  const bytes = toBytes(body);
  const payloadHash = bytes.length === 0 ? EMPTY_BODY_SHA256 : sha256Hex(bytes);

  const canonicalRequest = [
    String(method || "GET").toUpperCase(),
    canonicalizeUri(parsed.pathname),
    canonicalizeQuery(parsed.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  return { headerMap, sdkDate, canonicalHeaders, signedHeaders, payloadHash, canonicalRequest };
}

/**
 * Sign a request. Returns the headers to SEND (Host excluded) plus every
 * intermediate value, so callers can log/compare without re-deriving.
 *
 * @returns {{headers: object, canonicalRequest: string, stringToSign: string,
 *   signedHeaders: string, signature: string, authorization: string}}
 */
export function signOfficeAceRequest({
  algorithm = "V11",
  method,
  url,
  headers,
  body,
  credential,
  region = "cn-southwest-2",
  date,
}) {
  const ak = credential?.accessKeyId || "";
  const sk = credential?.secretAccessKey || "";
  if (!ak || !sk) throw new Error("OfficeAce signing needs accessKeyId + secretAccessKey");

  const built = buildOfficeAceCanonicalRequest({ method, url, headers, body, date, credential });
  const hash = sha256Hex(built.canonicalRequest);
  const algo = String(algorithm).toUpperCase().startsWith("SDK") ? "SDK" : "V11";

  let stringToSign;
  let signature;
  let authorization;

  if (algo === "SDK") {
    stringToSign = [SDK_ALGORITHM, built.sdkDate, hash].join("\n");
    signature = hmacSha256(Buffer.from(sk, "utf8"), stringToSign).toString("hex");
    authorization =
      `${SDK_ALGORITHM} Access=${ak}, SignedHeaders=${built.signedHeaders}, Signature=${signature}`;
  } else {
    const scope = `${built.sdkDate.slice(0, 8)}/${region}/${SCOPE_SERVICE}`;
    stringToSign = [V11_ALGORITHM, built.sdkDate, scope, hash].join("\n");
    const step1 = hmacSha256(Buffer.from(ak, "utf8"), sk);
    const derived = hmacSha256(step1, `${scope}\u0001`).subarray(0, 32);
    // ⚠️ hex STRING as the key (see file header rule 3).
    const signingKeyHex = derived.toString("hex");
    signature = hmacSha256(Buffer.from(signingKeyHex, "utf8"), stringToSign).toString("hex");
    authorization =
      `${V11_ALGORITHM} Credential=${ak}/${scope}, SignedHeaders=${built.signedHeaders}, Signature=${signature}`;
  }

  const out = {};
  for (const [lower, entry] of built.headerMap.entries()) {
    if (lower === "host") continue;
    out[entry.name] = entry.value;
  }
  out.Authorization = authorization;

  return {
    headers: out,
    canonicalRequest: built.canonicalRequest,
    stringToSign,
    signedHeaders: built.signedHeaders,
    signature,
    authorization,
  };
}
