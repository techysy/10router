import { afterEach, describe, expect, it, vi } from "vitest";
import { generateDpopKeyPair } from "../../src/lib/oauth/providers/codearts.js";
import {
  refreshCodeArtsToken,
  refreshOfficeAceToken,
} from "../../open-sse/services/tokenRefresh/providers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CodeArts automatic refresh", () => {
  it("exchanges the rotating refresh token and keeps the DPoP/PKCE context", async () => {
    const pair = generateDpopKeyPair();
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({
        credentials: {
          access_key_id: "ak-new",
          secret_access_key: "sk-new",
          security_token: "sts-new",
          expiration: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        },
        refresh_token: "rt-new",
      })
    ));

    const result = await refreshCodeArtsToken({
      provider: "codearts",
      refreshToken: "rt-codearts-1",
      providerSpecificData: {
        pkceVerifier: "verifier-1",
        dpopPrivateKeyPem: pair.privateKeyPem,
      },
    });

    expect(result.accessToken).toBe("ak-new");
    expect(result.refreshToken).toBe("rt-new");
    expect(result.providerSpecificData).toMatchObject({
      accessKeyId: "ak-new",
      secretAccessKey: "sk-new",
      securityToken: "sts-new",
      pkceVerifier: "verifier-1",
      dpopPrivateKeyPem: pair.privateKeyPem,
    });
    expect(result.expiresIn).toBeGreaterThan(0);

    const call = global.fetch.mock.calls[0];
    expect(String(call[0])).toContain("/v1/oauth2/tokens");
    expect(call[1].headers.DPoP).toBeTruthy();
  });

  it("marks a rejected refresh as unrecoverable instead of retrying forever", async () => {
    const pair = generateDpopKeyPair();
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({ error: "invalid_grant", error_description: "refresh token used" }, 400)
    ));

    const result = await refreshCodeArtsToken({
      provider: "codearts",
      refreshToken: "rt-codearts-dead",
      providerSpecificData: {
        pkceVerifier: "verifier-2",
        dpopPrivateKeyPem: pair.privateKeyPem,
      },
    });
    expect(result).toMatchObject({ error: "invalid_grant" });
  });
});

describe("OfficeAce automatic refresh", () => {
  it("rotates the temporary AK/SK and refresh token while keeping the Basic pair", async () => {
    const pair = generateDpopKeyPair();
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({
        credentials: {
          access_key_id: "oak-new",
          secret_access_key: "osk-new",
          security_token: "osts-new",
          project_id: "project-1",
          expiration: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        },
        refresh_token: "ort-new",
      })
    ));

    const result = await refreshOfficeAceToken({
      provider: "officeace",
      accessToken: "gw-key:gw-secret",
      refreshToken: "ort-old",
      providerSpecificData: { dpopPrivateKeyPem: pair.privateKeyPem },
    });

    expect(result.accessToken).toBe("gw-key:gw-secret");
    expect(result.refreshToken).toBe("ort-new");
    expect(result.providerSpecificData).toMatchObject({
      accessKeyId: "oak-new",
      secretAccessKey: "osk-new",
      securityToken: "osts-new",
      projectId: "project-1",
      refreshToken: "ort-new",
    });
    expect(result.providerSpecificData.dpopPrivateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(result.providerSpecificData).not.toHaveProperty("modelAppKey");
  });

  it("requires both the refresh token and the original DPoP key", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(await refreshOfficeAceToken({
      provider: "officeace",
      refreshToken: "ort-no-key",
      providerSpecificData: {},
    })).toMatchObject({ error: "invalid_grant" });
  });
});
