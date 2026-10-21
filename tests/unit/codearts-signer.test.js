/**
 * CodeArts AKSK signer + DPoP low-S vectors.
 *
 * The reference vector is the exact `reference-vector` entry from our Rust
 * `codearts/signer_vectors.json` (itself generated from the MIT Coding2API
 * `signer_test.go` golden). If the canonical string drifts, the signature test
 * fails on the first byte that changed.
 */
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";

import {
  buildDpopProof,
  canonicalQueryString,
  canonicalUri,
  dpopKeyFromPrivateKey,
  encodeComponent,
  normalizeLowS,
  signCodeArtsRequest,
} from "../../open-sse/shared/codearts/signing.js";

const CREDENTIAL = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", securityToken: "tok", domainId: "dom" };
const FIXED_DATE = "20260102T030405Z";

function b64UrlDecode(value) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4), "base64");
}

describe("codearts AKSK signer", () => {
  it("reproduces the Rust reference vector byte-for-byte", () => {
    const signed = signCodeArtsRequest({
      method: "POST",
      url: "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions",
      headers: {
        "X-Domain-Id": "dom",
        "X-Language": "en-us",
        "X-Sdk-Date": FIXED_DATE,
        "X-Security-Token": "tok",
        "content-type": "application/json",
        "plugin-name": "snap_vscode",
      },
      body: Buffer.from("eyJtb2RlbCI6IngifQ==", "base64"),
      credential: CREDENTIAL,
    });

    expect(signed.signedHeaders).toBe(
      "content-type;plugin-name;x-domain-id;x-language;x-sdk-date;x-security-token"
    );
    expect(signed.canonicalRequest).toBe(
      "POST\n/api/v2/chat/completions/\n\n" +
        "content-type:application/json\nplugin-name:snap_vscode\nx-domain-id:dom\nx-language:en-us\n" +
        "x-sdk-date:20260102T030405Z\nx-security-token:tok\n\n" +
        "content-type;plugin-name;x-domain-id;x-language;x-sdk-date;x-security-token\n" +
        "78b0e11c6754fc9671c2034f4a068d3a0e53c1c22a5a33900dd46bc8cd9136f3"
    );
    expect(signed.signature).toBe("0093888a0805c8535df7212bd72024fea1570eabb927853f44a4d0827204bac4");
    expect(signed.headers.Authorization).toBe(
      "SDK-HMAC-SHA256 Access=AKIDEXAMPLE, SignedHeaders=" +
        "content-type;plugin-name;x-domain-id;x-language;x-sdk-date;x-security-token, " +
        "Signature=0093888a0805c8535df7212bd72024fea1570eabb927853f44a4d0827204bac4"
    );
  });

  it("sorts headers case-insensitively and trims values", () => {
    const signed = signCodeArtsRequest({
      method: "GET",
      url: "https://example.invalid/x",
      headers: { "X-Pad": "  spaced  ", "X-Sdk-Date": FIXED_DATE },
      credential: { accessKeyId: "AK", secretAccessKey: "SK" },
    });
    expect(signed.signedHeaders).toBe("x-pad;x-sdk-date");
    expect(signed.canonicalRequest).toContain("x-pad:spaced\n");
    expect(signed.signature).toBe("f966db85943408b502bcdffbfe46d638a05d7e12be8b511b5db8748bba4ae5b3");
  });

  it("forces a trailing slash and re-encodes each decoded path segment", () => {
    expect(canonicalUri("/api/v2/chat/completions")).toBe("/api/v2/chat/completions/");
    expect(canonicalUri("/api/v2/chat/completions/")).toBe("/api/v2/chat/completions/");
    // Decoded %2F becomes a real separator (Go net/url semantics).
    const signed = signCodeArtsRequest({
      method: "POST",
      url: "https://example.invalid/a%20b/c%2Fd/%E4%B8%AD",
      headers: { "X-Sdk-Date": FIXED_DATE, "content-type": "application/json" },
      body: "{}",
      credential: { accessKeyId: "AK", secretAccessKey: "SK", securityToken: "sts" },
    });
    expect(signed.canonicalRequest.split("\n")[1]).toBe("/a%20b/c/d/%E4%B8%AD/");
    expect(signed.signature).toBe("158bc74e32603bcce4d30f7d9a07eb32d0edc31a8c16dfb4aa210dce4573f0d8");
  });

  it("keeps JS encodeURIComponent's unreserved set (including !'()~*)", () => {
    expect(encodeComponent("a b!*'()~_-.")).toBe("a%20b!*'()~_-.");
    // `+` is a space in a query, not a literal plus.
    expect(canonicalQueryString("ticket=a+b")).toBe("ticket=a%20b");
  });

  it("sorts repeated query keys by value and drops semicolon pairs", () => {
    expect(canonicalQueryString("z=1&a=2&a=1&empty=&bare")).toBe("a=1&a=2&bare=&empty=&z=1");
    expect(canonicalQueryString("ok=1;bad=2&next=3")).toBe("next=3");
  });

  it("honours X-Sdk-Content-Sha256 as the payload hash", () => {
    const signed = signCodeArtsRequest({
      method: "POST",
      url: "https://example.invalid/x",
      headers: { "X-Sdk-Content-Sha256": "deadbeef", "X-Sdk-Date": FIXED_DATE },
      body: "ignored",
      credential: { accessKeyId: "AK", secretAccessKey: "SK", securityToken: "sts" },
    });
    expect(signed.canonicalRequest.endsWith("\ndeadbeef")).toBe(true);
    expect(signed.signature).toBe("9fcd51e0d11e5294025ee97d1249dcf69d4ba44d0ad0f7027cf7c9fc048112ef");
  });
});

describe("codearts DPoP low-S", () => {
  const P256_ORDER = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");

  it("flips a high-S signature to n - S and leaves low-S untouched", () => {
    const high = Buffer.concat([Buffer.alloc(32, 1), Buffer.from((P256_ORDER - 1n).toString(16).padStart(64, "0"), "hex")]);
    const low = normalizeLowS(high);
    expect(low.subarray(0, 32).equals(Buffer.alloc(32, 1))).toBe(true);
    expect(BigInt(`0x${low.subarray(32).toString("hex")}`)).toBe(1n);

    const alreadyLow = Buffer.concat([Buffer.alloc(32, 2), Buffer.from((P256_ORDER / 2n).toString(16).padStart(64, "0"), "hex")]);
    expect(normalizeLowS(alreadyLow).equals(alreadyLow)).toBe(true);
  });

  it("every DPoP proof carries S <= n/2 and verifies against the embedded JWK", () => {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const { privateKey: key, publicJwk } = dpopKeyFromPrivateKey(privateKey);
    const publicKey = crypto.createPublicKey({ key: { ...publicJwk }, format: "jwk" });
    let high = 0;

    for (let index = 0; index < 60; index += 1) {
      const proof = buildDpopProof({ privateKey: key, publicJwk, method: "POST", url: "https://sts.example/v1/oauth2/tokens?x=1" });
      const [headerPart, payloadPart, signaturePart] = proof.split(".");
      const header = JSON.parse(b64UrlDecode(headerPart).toString("utf8"));
      const payload = JSON.parse(b64UrlDecode(payloadPart).toString("utf8"));
      expect(header.alg).toBe("ES256");
      expect(header.typ).toBe("dpop+jwt");
      expect(header.jwk).toEqual({ kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y });
      expect(payload.htu).toBe("https://sts.example/v1/oauth2/tokens");
      expect(payload.htm).toBe("POST");

      const signature = b64UrlDecode(signaturePart);
      expect(signature).toHaveLength(64);
      const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
      if (s > P256_ORDER / 2n) high += 1;
      expect(s <= P256_ORDER / 2n).toBe(true);
      expect(
        crypto.verify("sha256", Buffer.from(`${headerPart}.${payloadPart}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)
      ).toBe(true);
    }
    // 60 random signatures would all be low with probability 2^-60; this asserts
    // the loop actually exercised distinct signatures rather than a stuck input.
    expect(high).toBe(0);
  });
});
