/**
 * CodeArts OAuth refresh: one-time refresh tokens must be single-flight.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import crypto from "node:crypto";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { refreshCodeArtsCredential } from "../../open-sse/shared/codearts/oauth.js";

function credential() {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  return {
    providerSpecificData: {
      refreshToken: "refresh-once",
      codeVerifier: "verifier-fixture",
      dpopPrivateJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
      domainId: "dom-1",
    },
  };
}

afterEach(() => {
  proxyAwareFetch.mockReset();
});

describe("codearts oauth refresh", () => {
  it("collapses concurrent refreshes into one token request", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      credentials: {
        access_key_id: "AK-NEW",
        secret_access_key: "SK-NEW",
        security_token: "STS-NEW",
        expiration: "2026-10-20T12:00:00Z",
        refresh_token: "refresh-rotated",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    proxyAwareFetch.mockImplementation(fetchMock);

    const input = credential();
    const [a, b] = await Promise.all([
      refreshCodeArtsCredential(input, {}),
      refreshCodeArtsCredential(input, {}),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe("AK-NEW");
    expect(b.refreshToken).toBe("refresh-rotated");
    expect(a.providerSpecificData).toMatchObject({
      accessKeyId: "AK-NEW",
      secretAccessKey: "SK-NEW",
      securityToken: "STS-NEW",
      domainId: "dom-1",
    });
    // The DPoP proof header is present and the body carries the refresh grant.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/oauth2/tokens");
    expect(init.headers.DPoP.split(".")).toHaveLength(3);
    expect(init.body).toContain("grant_type=refresh_token");
    // Input is never mutated: the caller persists the returned bundle first.
    expect(input.providerSpecificData.accessKeyId).toBeUndefined();
  });

  it("returns null when the connection has no refresh token", async () => {
    await expect(refreshCodeArtsCredential({ providerSpecificData: {} }, {})).resolves.toBeNull();
  });
});
