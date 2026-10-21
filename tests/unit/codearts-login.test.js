/**
 * CodeArts web-login protocol: portal URL shape, form encoding, DPoP (low-S),
 * refresh context retention, callback state checking and STS error classes.
 *
 * Gold authorize URL is the Rust `login_url_vectors.json` "default-en" case
 * (ticket_id is the `state` we pass). It pins param order and the portal's
 * `encodeURIComponent`-style escaping (`!'()*` stay literal).
 */
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  config,
  buildAuthorizeUrl,
  exchangeCode,
  refresh,
  parseLoopbackCallback,
  generateDpopKeyPair,
} from "../../src/lib/oauth/providers/codearts.js";

const P256_ORDER = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const TICKET = "f4415ec8-6377-43f7-b909-dc90d177aa50";
const CALLBACK = "http://127.0.0.1:40605/oauth/callback";
const { privateKeyPem } = generateDpopKeyPair();

function tokenPayload(overrides = {}) {
  return {
    credentials: {
      access_key_id: "AK-NEW",
      secret_access_key: "SK-NEW",
      security_token: "STS-NEW",
      expiration: new Date(Date.now() + 3600_000).toISOString(),
      refresh_token: "refresh-new",
      ...overrides,
    },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Decode the proof, check htm/htu and low-S, then verify against its own JWK. */
function verifyDpop(proof, { method = "POST", url = config.tokenUrl } = {}) {
  const parts = String(proof || "").split(".");
  expect(parts).toHaveLength(3);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));

  expect(header).toMatchObject({ alg: "ES256", typ: "dpop+jwt" });
  expect(header.jwk).toMatchObject({ kty: "EC", crv: "P-256" });
  expect(header.jwk.d).toBeUndefined();
  expect(payload.htm).toBe(method);
  expect(payload.htu).toBe(url);

  const signature = Buffer.from(parts[2], "base64url");
  expect(signature).toHaveLength(64);
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  expect(s <= P256_ORDER / 2n).toBe(true);

  const publicKey = crypto.createPublicKey({ key: header.jwk, format: "jwk" });
  const valid = crypto.verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    signature
  );
  expect(valid).toBe(true);
}

describe("codearts authorize URL", () => {
  it("matches the Rust gold vector (port, path, order, escaping)", () => {
    const url = buildAuthorizeUrl({
      redirectUri: CALLBACK,
      state: TICKET,
      pkceChallenge: "challenge-value",
    });
    expect(url).toBe(
      "https://codearts.huaweicloud.com/portal/authorize?theme=2&locale=en" +
        "&uri_scheme=vscode-codebot&client_id=vscode-codebot&port=40605" +
        "&code_challenge=challenge-value&code_challenge_method=SHA-256" +
        `&ticket_id=${TICKET}` +
        "&auth_callback_url=http%3A%2F%2F127.0.0.1%3A40605%2Foauth%2Fcallback" +
        "&plugin-name=snap_vscode&plugin-version=26.9.101"
    );

    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/portal/authorize");
    expect(parsed.searchParams.get("port")).toBe("40605");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("SHA-256");
    expect(parsed.searchParams.get("ticket_id")).toBe(TICKET);
    expect(config.callbackPath).toBe("/oauth/callback");
    expect(config.fixedPort).toBe(0);
  });

  it("keeps !'()* literal but encodes / and space like the portal expects", () => {
    const url = buildAuthorizeUrl({
      redirectUri: CALLBACK,
      state: "state-1",
      pkceChallenge: "abc-_~!*()def",
      language: "zh-cn",
    });
    expect(url).toContain("code_challenge=abc-_~!*()def");
    expect(url).toContain("locale=zh-cn");

    const encoded = buildAuthorizeUrl({
      redirectUri: CALLBACK,
      state: "state-1",
      pkceChallenge: "chal/2 a",
    });
    expect(encoded).toContain("code_challenge=chal%2F2%20a");
  });

  it("requires a loopback port", () => {
    expect(() =>
      buildAuthorizeUrl({ redirectUri: "http://127.0.0.1/oauth/callback", state: "s", pkceChallenge: "c" })
    ).toThrow(/端口/);
  });
});

describe("codearts exchangeCode", () => {
  it("posts form-urlencoded with a valid DPoP proof and keeps the refresh context", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(tokenPayload()));

    const result = await exchangeCode(
      {
        code: "a b+c/d=&",
        codeVerifier: "verifier-fixture",
        dpopPrivateKeyPem: privateKeyPem,
        redirectUri: CALLBACK,
      },
      { fetchImpl }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.body).toBe(
      "client_id=vscode-codebot" +
        "&code=a+b%2Bc%2Fd%3D%26" +
        "&code_verifier=verifier-fixture" +
        "&grant_type=authorization_code" +
        "&redirect_uri=http%3A%2F%2F127.0.0.1%3A40605%2Foauth%2Fcallback"
    );
    verifyDpop(init.headers.DPoP);

    expect(result).toMatchObject({
      accessToken: "AK-NEW",
      refreshToken: "refresh-new",
    });
    expect(result.expiresIn).toBeGreaterThan(3000);
    expect(result.providerSpecificData).toMatchObject({
      accessKeyId: "AK-NEW",
      secretAccessKey: "SK-NEW",
      securityToken: "STS-NEW",
      refreshToken: "refresh-new",
      pkceVerifier: "verifier-fixture",
      codeVerifier: "verifier-fixture",
      dpopPrivateKeyPem: privateKeyPem,
      clientId: "vscode-codebot",
    });
  });

  it("rejects a response that cannot be refreshed later", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(tokenPayload({ refresh_token: "" })));
    await expect(
      exchangeCode(
        { code: "c", codeVerifier: "v", dpopPrivateKeyPem: privateKeyPem, redirectUri: CALLBACK },
        { fetchImpl }
      )
    ).rejects.toMatchObject({ statusCode: 502, code: "missing_refresh_token" });
  });
});

describe("codearts refresh", () => {
  it("sends the verifier plus the same DPoP key and returns the rotated bundle", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(tokenPayload({ refresh_token: "refresh-rotated" })));

    const result = await refresh(
      {
        refreshToken: "refresh-once",
        pkceVerifier: "verifier-fixture",
        dpopPrivateKeyPem: privateKeyPem,
      },
      { fetchImpl }
    );

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(config.tokenUrl);
    expect(init.body).toBe(
      "client_id=vscode-codebot" +
        "&code_verifier=verifier-fixture" +
        "&grant_type=refresh_token" +
        "&refresh_token=refresh-once"
    );
    verifyDpop(init.headers.DPoP);

    expect(result.accessToken).toBe("AK-NEW");
    expect(result.refreshToken).toBe("refresh-rotated");
    expect(result.providerSpecificData).toMatchObject({
      refreshToken: "refresh-rotated",
      pkceVerifier: "verifier-fixture",
      dpopPrivateKeyPem: privateKeyPem,
      clientId: "vscode-codebot",
    });
  });

  it("keeps the old refresh token when the response does not rotate it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(tokenPayload({ refresh_token: "" })));
    const result = await refresh(
      { refreshToken: "refresh-once", pkceVerifier: "v", dpopPrivateKeyPem: privateKeyPem },
      { fetchImpl }
    );
    expect(result.refreshToken).toBe("refresh-once");
    expect(result.providerSpecificData.refreshToken).toBe("refresh-once");
  });

  it("refuses to refresh without the verifier or the DPoP key", async () => {
    await expect(refresh({ refreshToken: "rt", dpopPrivateKeyPem: privateKeyPem })).rejects.toMatchObject({
      code: "missing_code_verifier",
    });
    await expect(refresh({ refreshToken: "rt", pkceVerifier: "v" })).rejects.toMatchObject({
      code: "missing_dpop_key",
    });
  });
});

describe("codearts loopback callback", () => {
  it("extracts code/state and rejects a mismatched state", () => {
    expect(parseLoopbackCallback(`${CALLBACK}?code=the-code&state=good`, "good")).toEqual({
      code: "the-code",
      state: "good",
    });

    expect(() => parseLoopbackCallback(`${CALLBACK}?code=the-code&state=evil`, "good")).toThrow(
      /state 不匹配/
    );
    try {
      parseLoopbackCallback(`${CALLBACK}?code=the-code&state=evil`, "good");
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 400, code: "state_mismatch" });
    }
  });

  it("tolerates the portal's code-only callback but requires a code", () => {
    expect(parseLoopbackCallback(`${CALLBACK}?code=the-code`, "good")).toEqual({
      code: "the-code",
      state: null,
    });
    expect(() => parseLoopbackCallback(`${CALLBACK}?state=good`, "good")).toThrow(/缺少 code/);
    expect(() => parseLoopbackCallback(`${CALLBACK}?error=access_denied&error_description=no`)).toThrow(
      /access_denied/
    );
  });
});

describe("codearts STS error classification", () => {
  it.each([401, 403])("marks HTTP %s as re-login", async (status) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "invalid_token", error_description: "token rejected" }, status)
    );
    await expect(
      exchangeCode(
        { code: "c", codeVerifier: "v", dpopPrivateKeyPem: privateKeyPem, redirectUri: CALLBACK },
        { fetchImpl }
      )
    ).rejects.toMatchObject({
      statusCode: status,
      code: "reauth_required",
      reauthRequired: true,
    });
  });

  it("treats invalid_grant as re-login and 5xx as a plain upstream failure", async () => {
    const invalidGrant = vi.fn(async () =>
      jsonResponse({ error: "invalid_grant", error_description: "refresh token used" }, 400)
    );
    await expect(
      refresh({ refreshToken: "rt", pkceVerifier: "v", dpopPrivateKeyPem: privateKeyPem }, { fetchImpl: invalidGrant })
    ).rejects.toMatchObject({ statusCode: 400, code: "reauth_required" });

    const upstream = vi.fn(async () => jsonResponse({ message: "boom" }, 500));
    await expect(
      refresh({ refreshToken: "rt", pkceVerifier: "v", dpopPrivateKeyPem: privateKeyPem }, { fetchImpl: upstream })
    ).rejects.toMatchObject({ statusCode: 500, code: "token_request_failed", reauthRequired: false });
  });
});
