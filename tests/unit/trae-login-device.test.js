import { afterEach, describe, expect, it, vi } from "vitest";
import trae from "../../src/lib/oauth/providers/trae.js";
import { buildDeviceInfo, generateDeviceKeyPair } from "../../src/lib/oauth/utils/traeDevice.js";

describe("Trae login device key pair", () => {
  it("generates a P-256 SPKI/PKCS8 pair", () => {
    const pair = generateDeviceKeyPair();
    expect(pair.publicPem).toContain("BEGIN PUBLIC KEY");
    expect(pair.privatePem).toContain("BEGIN PRIVATE KEY");
    const info = buildDeviceInfo(pair);
    expect(info.DevicePublicKey).toBe(pair.publicPem);
    expect(info.DeviceType).toBe("windows");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("puts DevicePublicKey into ExchangeToken and persists the private half", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({ Result: { AccessToken: "at", RefreshToken: "rt2", ExpiresAt: Math.floor(Date.now() / 1000) + 3600 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const tokens = await trae.exchangeToken(
      { region: "intl" },
      "https://x/callback?refreshToken=rt&loginHost=www.trae.ai"
    );

    expect(tokens.accessToken).toBe("at");
    expect(tokens._device?.privatePem).toContain("BEGIN PRIVATE KEY");
    const body = calls[0].body;
    expect(body.DeviceInfo?.DevicePublicKey).toContain("BEGIN PUBLIC KEY");

    const mapped = trae.mapTokens(tokens, { userInfo: {}, _site: "intl" });
    expect(mapped.providerSpecificData.devicePrivateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(mapped.providerSpecificData.devicePublicKeyPem).toContain("BEGIN PUBLIC KEY");
  });
});
