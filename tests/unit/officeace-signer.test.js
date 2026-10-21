/**
 * OfficeAce signing — pinned against the vectors produced by the MIT
 * officeace2api `signV4`/`signV11` (same fixture our Rust provider uses).
 *
 * The two rules that make this signer different from CodeArts' are asserted
 * with control cases: whitespace collapsing of header VALUES, and the extra
 * RFC3986 escapes (`!'()*`) that `encodeURIComponent` leaves alone.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  EMPTY_BODY_SHA256,
  canonicalizeHeaderValue,
  canonicalizeQuery,
  canonicalizeUri,
  encodeOfficeAceComponent,
  signOfficeAceRequest,
} from "../../open-sse/shared/officeace/signer.js";

const CREDENTIAL = {
  accessKeyId: "AKTESTACCESSKEY0001",
  secretAccessKey: "SKTESTSECRETKEY0001000000000000000000",
  securityToken: "STTESTSECURITYTOKEN0001",
  projectId: "pid-00000000000000000000000000000001",
};
const REGION = "cn-southwest-2";
const DATE = "20261010T031500Z";
const HOST = "https://modelgw-0004.officeace.cn-southwest-2.huaweicloud-agentarts.com";

const sign = (overrides) =>
  signOfficeAceRequest({
    credential: CREDENTIAL,
    region: REGION,
    date: DATE,
    ...overrides,
  });

describe("encodeOfficeAceComponent", () => {
  it("escapes ! ' ( ) * — the four extra characters vs encodeURIComponent", () => {
    const raw = "a!b'c(d)e*f";
    expect(encodeURIComponent(raw)).toBe("a!b'c(d)e*f"); // control: left alone
    expect(encodeOfficeAceComponent(raw)).toBe("a%21b%27c%28d%29e%2Af");
    // Truly unreserved stays literal.
    expect(encodeOfficeAceComponent("AZaz09-_.~")).toBe("AZaz09-_.~");
    expect(encodeOfficeAceComponent("a b")).toBe("a%20b");
  });

  it("canonical URI decodes, re-encodes and forces a trailing slash", () => {
    expect(canonicalizeUri("/v1/subscription")).toBe("/v1/subscription/");
    expect(canonicalizeUri("/v1/a(b)c!d/e'f")).toBe("/v1/a%28b%29c%21d/e%27f/");
    expect(canonicalizeUri("")).toBe("/");
  });

  it("canonical query follows WHATWG searchParams and sorts by (key, value)", () => {
    expect(canonicalizeQuery("?b=2&a=1")).toBe("a=1&b=2");
    expect(canonicalizeQuery("?q=a+b")).toBe("q=a%20b");
    expect(canonicalizeQuery("?s=1*2&r=x'y")).toBe("r=x%27y&s=1%2A2");
  });
});

describe("canonicalizeHeaderValue", () => {
  it("collapses internal whitespace runs, not just trims", () => {
    expect(canonicalizeHeaderValue("  a \t  b\n c  ")).toBe("a b c");
    expect(canonicalizeHeaderValue("single")).toBe("single");
    expect(canonicalizeHeaderValue("")).toBe("");
  });

  it("folds the value inside the canonical request", () => {
    const out = sign({
      algorithm: "SDK",
      method: "GET",
      url: `${HOST}/v1/subscription`,
      headers: { "x-test": "  a \t b  " },
      body: "",
    });
    expect(out.canonicalRequest).toContain("\nx-test:a b\n");
    expect(out.canonicalRequest).not.toContain("a  b");
  });
});

describe("SDK-HMAC-SHA256", () => {
  it("matches the reference vectors for GET /v1/subscription", () => {
    const out = sign({
      algorithm: "SDK",
      method: "GET",
      url: `${HOST}/v1/subscription`,
      headers: { "x-subscription-type": "v2" },
      body: "",
    });
    expect(out.canonicalRequest).toBe(
      "GET\n/v1/subscription/\n\n" +
        `host:modelgw-0004.officeace.cn-southwest-2.huaweicloud-agentarts.com\n` +
        "x-project-id:pid-00000000000000000000000000000001\n" +
        "x-sdk-date:20261010T031500Z\n" +
        "x-security-token:STTESTSECURITYTOKEN0001\n" +
        "x-subscription-type:v2\n\n" +
        "host;x-project-id;x-sdk-date;x-security-token;x-subscription-type\n" +
        EMPTY_BODY_SHA256
    );
    expect(out.stringToSign).toBe(
      "SDK-HMAC-SHA256\n20261010T031500Z\n" +
        "e934f58149c2ff2121b72fff77e515341053c64220279158ed76e10fad7646a3"
    );
    expect(out.signature).toBe(
      "dda3e12a3463ccf699bce0fd863fb678c933aa377a79c8f5233026c630a43494"
    );
    expect(out.authorization).toBe(
      "SDK-HMAC-SHA256 Access=AKTESTACCESSKEY0001, " +
        "SignedHeaders=host;x-project-id;x-sdk-date;x-security-token;x-subscription-type, " +
        "Signature=dda3e12a3463ccf699bce0fd863fb678c933aa377a79c8f5233026c630a43494"
    );
  });
});

describe("V11-HMAC-SHA256", () => {
  it("matches the reference vectors for the bonus claim POST", () => {
    const out = sign({
      algorithm: "V11",
      method: "POST",
      url: `${HOST}/v1/subscription/bonus/claim`,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(out.canonicalRequest).toBe(
      "POST\n/v1/subscription/bonus/claim/\n\n" +
        "content-type:application/json\n" +
        "host:modelgw-0004.officeace.cn-southwest-2.huaweicloud-agentarts.com\n" +
        "x-project-id:pid-00000000000000000000000000000001\n" +
        "x-sdk-date:20261010T031500Z\n" +
        "x-security-token:STTESTSECURITYTOKEN0001\n\n" +
        "content-type;host;x-project-id;x-sdk-date;x-security-token\n" +
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    );
    expect(out.stringToSign).toBe(
      "V11-HMAC-SHA256\n20261010T031500Z\n20261010/cn-southwest-2/apic\n" +
        "615f37e103167c4c69a8db8ff390c3f627677d071880dcca4aa85e3f15b1d05a"
    );
    expect(out.signature).toBe(
      "72bc4b415e3fe720b0bb040d0d4c78a18eb4821babc814381d8336d27c31d96a"
    );
    // Host is signed, never sent.
    expect(out.headers.Host).toBeUndefined();
    expect(out.headers["Content-Type"]).toBe("application/json");
    expect(out.headers.Authorization).toContain("Credential=AKTESTACCESSKEY0001/20261010/cn-southwest-2/apic");
  });

  it("matches the escaping vector (path and query)", () => {
    const out = sign({
      algorithm: "V11",
      method: "GET",
      url:
        "https://gw.example.com/v1/a(b)c!d/e'f/g*h/i~j/things" +
        "?q=a b&r=x'y&s=1*2&t=%7Bbrace%7D",
      body: "",
    });
    expect(out.canonicalRequest.split("\n")[1]).toBe(
      "/v1/a%28b%29c%21d/e%27f/g%2Ah/i~j/things/"
    );
    expect(out.canonicalRequest.split("\n")[2]).toBe(
      "q=a%20b&r=x%27y&s=1%2A2&t=%7Bbrace%7D"
    );
    expect(out.signature).toBe(
      "7e9cf7348c3a1e9c84167fb8ef074a939e309553b724d7ecfe4034fe6ca59074"
    );
    // Control: the CodeArts escape set would leave these literal, so the same
    // request cannot produce this canonical path.
    expect(out.canonicalRequest).not.toContain("/v1/a(b)c!d/");
  });

  it("uses the derived key as a HEX STRING (control: raw bytes differ)", () => {
    const out = sign({
      algorithm: "V11",
      method: "GET",
      url: `${HOST}/v1/subscription`,
      headers: { "x-subscription-type": "v2" },
      body: "",
    });
    // Independent re-derivation, then the WRONG key form on purpose.
    const scope = "20261010/cn-southwest-2/apic";
    const step1 = createHmac("sha256", CREDENTIAL.accessKeyId).update(CREDENTIAL.secretAccessKey).digest();
    const derived = createHmac("sha256", step1).update(`${scope}\u0001`).digest().subarray(0, 32);
    const rawBytesSignature = createHmac("sha256", derived).update(out.stringToSign).digest("hex");
    expect(rawBytesSignature).not.toBe(out.signature);
    expect(out.signature).toBe(
      "43806175f2f6b0d16c6698eea222bd39db3830caeee2d9b68b3ac21170270fba"
    );
  });
});
