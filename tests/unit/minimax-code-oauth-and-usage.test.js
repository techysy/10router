import { describe, it, expect, vi, beforeEach } from "vitest";
import { minimaxCode, minimaxCodeGlobal } from "../../src/lib/oauth/providers/minimax-code.js";
import { parsePlanWindows, signedAccountRequest } from "../../open-sse/services/usage/minimax-code.js";

describe("MiniMax Code OAuth Device Flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requests device code with S256 PKCE challenge", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        device_code: "dev_123",
        user_code: "ABCD-EFGH",
        verification_uri_complete: "https://account.minimax.cn/device?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      }),
    });

    const res = await minimaxCode.requestDeviceCode(minimaxCode.config, "challenge_code_s256");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://account.minimax.cn/oauth2/device/code");
    expect(opts.body).toContain("code_challenge=challenge_code_s256");
    expect(opts.body).toContain("client_id=mcode-public");
    expect(res.device_code).toBe("dev_123");
    expect(res.user_code).toBe("ABCD-EFGH");
    expect(res.verification_uri).toBe("https://account.minimax.cn/device?user_code=ABCD-EFGH");
  });

  it("handles pollToken pending status envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "pending" }),
    });

    const res = await minimaxCode.pollToken(minimaxCode.config, "dev_123", "verifier_123", null);
    expect(res.ok).toBe(true);
    expect(res.data.error).toBe("authorization_pending");
  });

  it("handles pollToken success and mapTokens", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: "acc_token_xyz",
        refresh_token: "ref_token_xyz",
        expires_in: 3600,
      }),
    });

    const res = await minimaxCode.pollToken(minimaxCode.config, "dev_123", "verifier_123", null);
    expect(res.ok).toBe(true);
    expect(res.data.access_token).toBe("acc_token_xyz");

    const mapped = minimaxCode.mapTokens(res.data);
    expect(mapped.accessToken).toBe("acc_token_xyz");
    expect(mapped.refreshToken).toBe("ref_token_xyz");
    expect(mapped.expiresIn).toBe(3600);
    expect(mapped.providerSpecificData.authMethod).toBe("device_code");
  });
});

describe("MiniMax Code Usage Parsing & Signing", () => {
  it("parses M Plan rate windows correctly", () => {
    const sampleBody = {
      base_resp: { status_code: 0 },
      model_remains: [
        {
          model_name: "general",
          current_interval_remaining_percent: 85,
          current_interval_status: 1,
          start_time: 1700000000,
          end_time: 1700018000,
          current_weekly_remaining_percent: 92,
          current_weekly_status: 1,
          weekly_start_time: 1700000000,
          weekly_end_time: 1700604800,
        },
      ],
    };

    const windows = parsePlanWindows(sampleBody);
    expect(windows).toHaveLength(2);
    expect(windows[0].name).toMatch(/5 hours|Allowance/);
    expect(windows[0].remainingPercentage).toBe(85);
    expect(windows[0].used).toBe(15);
    expect(windows[1].name).toBe("7 days");
    expect(windows[1].remainingPercentage).toBe(92);
  });

  it("generates deterministic signedAccountRequest headers", () => {
    const site = { agent: "https://agent.minimax.cn", lang: "zh" };
    const fixedNow = 1700000000000;
    const req = signedAccountRequest(site, "/v1/api/user/info", {
      access: "test_token",
      userID: "1001",
      now: fixedNow,
      tzOffsetSec: 28800,
    });

    expect(req.init.headers.Authorization).toBe("Bearer test_token");
    expect(req.init.headers.yy).toBeDefined();
    expect(req.init.headers["x-signature"]).toBeDefined();
    expect(req.init.headers["x-timestamp"]).toBe("1700000000");
  });
});
