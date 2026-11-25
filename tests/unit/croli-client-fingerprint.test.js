// Croli gateway identity: since 2026-11-25 the upstream gates free models on the
// desktop client version ("请将 Croli 升级到最新版本 (0.0.18 及以上) 后使用免费
// 模型"). 10Router's croli lane used to send no User-Agent at all (node fetch's
// default "node"), which is what tripped the gate. The registry must carry the
// croli/<version> UA the official croli-server.exe reqwest client sends
// (0.0.19 installer, verified by unpacking — device-signature headers
// x-croli-device-id/-timestamp/-nonce/-signature live only on the desktop
// app's local loopback proxy, never on the direct csk_ gateway calls).
import { describe, expect, it } from "vitest";

import { PROVIDERS } from "../../open-sse/config/providers.js";

// config/providers.js flattens the registry's transport block to the top level.
const croli = PROVIDERS.croli;

describe("croli registry — gateway client identity", () => {
  it("sends the official desktop client UA (croli/<semver>), not the bare node default", () => {
    const ua = croli.headers?.["User-Agent"];
    expect(ua).toMatch(/^croli\/\d+\.\d+\.\d+$/);
    // The free-model gate requires >= 0.0.18; the shipped fingerprint must be at least that.
    const [, minor, patch] = ua.split("/")[1].split(".").map(Number);
    expect(minor * 100 + patch).toBeGreaterThanOrEqual(18);
  });

  it("keeps the gateway path and csk_ Bearer auth untouched (device headers stay off the direct lane)", () => {
    expect(croli.baseUrl).toBe("https://ds.croli.net/v1/chat/completions");
    const headerNames = Object.keys(croli.headers);
    expect(headerNames).toEqual(["User-Agent"]);
    for (const name of ["x-croli-device-id", "x-croli-timestamp", "x-croli-nonce", "x-croli-signature"]) {
      expect(headerNames).not.toContain(name);
    }
  });
});
