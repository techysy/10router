import { describe, expect, it, vi } from "vitest";
import {
  quworkApiRequest,
  quworkClaimDailyReward,
  quworkCredentialFromLogin,
  quworkLoginByCode,
  quworkSendLoginCode,
  quworkRefreshAccess,
  quworkPointsFromSelf,
  quworkProbeInference,
  quworkLiveModels,
  quworkIdentity,
  quworkDeviceIdentifier,
  QUWORK_FALLBACK_MODELS,
} from "open-sse/shared/quwork/client.js";
import quworkRegistry from "open-sse/providers/registry/quwork.js";
import registry from "open-sse/providers/registry/index.js";
import quworkOAuth from "@/lib/oauth/providers/quwork";
import { testQuworkConnection } from "../../src/app/api/providers/[id]/test/quworkConnection.js";
import { getQuworkUsage } from "open-sse/services/usage/quwork.js";

function res(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

// Generic resolveConnectionProxyConfig shape (10Router per-connection proxy).
const PROXY = { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:18440", connectionNoProxy: "", strictProxy: true };

describe("QuWork client protocol", () => {
  it("unwraps {success,data} and sends QurWork headers through the given proxy", async () => {
    const fetch = vi.fn(async () => res(200, { success: true, data: { a: 1 } }));
    const out = await quworkApiRequest("/api/user/self", { accessToken: "acc", proxyOptions: PROXY, fetchImpl: fetch });
    expect(out).toEqual({ a: 1 });
    const [url, init, proxy] = fetch.mock.calls[0];
    expect(url).toBe("https://llm.rrzu.com/api/user/self");
    expect(init.headers).toMatchObject({ Authorization: "Bearer acc", "X-QurWork-Env": "prod", "X-QurWork-Version": "0.2.2-rc.1" });
    expect(proxy).toBe(PROXY);
  });

  it("maps 401 to an expired error and 405 to a WAF error", async () => {
    await expect(quworkApiRequest("/x", { fetchImpl: async () => res(401, {}) })).rejects.toMatchObject({ expired: true, status: 401 });
    await expect(quworkApiRequest("/x", { fetchImpl: async () => res(405, "<html>") })).rejects.toMatchObject({ status: 405 });
    await expect(quworkApiRequest("/x", { fetchImpl: async () => res(200, { success: false, message: "验证码错误" }) })).rejects.toThrow("验证码错误");
  });

  it("sends the SMS code with the captcha token as aliyun_captcha query + form body", async () => {
    const fetch = vi.fn(async () => res(200, { success: true, data: {} }));
    await quworkSendLoginCode("13800000000", "tok en", { proxyOptions: PROXY, fetchImpl: fetch });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://llm.rrzu.com/api/sendVerifyCode?aliyun_captcha=tok+en");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("phone=13800000000&type=login");
    await expect(quworkSendLoginCode("123", "t", { fetchImpl: fetch })).rejects.toThrow(/11 位/);
  });

  it("logs in with platform qurvis and a 64-hex device identifier", async () => {
    const fetch = vi.fn(async () => res(200, { success: true, data: { llm_token: "llm", token: "acc", expire: 2000000000, user: { id: 7, display_name: "小明" } } }));
    const cred = await quworkLoginByCode("13800000000", " 123456 ", { fetchImpl: fetch });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ phone: "13800000000", verification_code: "123456", platform: "qurvis", device_uuid: "" });
    expect(body.device_identifier).toMatch(/^[0-9a-f]{64}$/);
    expect(cred).toMatchObject({ llmToken: "llm", accessToken: "acc", accessExpiresAt: 2000000000000, nickname: "小明", uid: "7" });
  });

  it("rejects a login response without llm_token", () => {
    expect(() => quworkCredentialFromLogin({ token: "acc" })).toThrow(/llm_token/);
  });

  it("refresh keeps the old token when the server omits a new one", async () => {
    const r = await quworkRefreshAccess("acc", { fetchImpl: async () => res(200, { success: true, data: { expire: 2000000000 } }) });
    expect(r).toEqual({ accessToken: "acc", accessExpiresAt: 2000000000000 });
  });

  it("daily reward is status-gated (never claims when already claimed)", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push([url, init.method]);
      return res(200, { success: true, data: { claimed: true, can_claim: false } });
    };
    const r = await quworkClaimDailyReward("acc", { fetchImpl: fetch });
    expect(r.outcome).toBe("done");
    expect(calls).toEqual([["https://llm.rrzu.com/api/user/daily-reward/status", "GET"]]);
  });

  it("daily reward claims when can_claim and reports points", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(res(200, { success: true, data: { can_claim: true } }))
      .mockResolvedValueOnce(res(200, { success: true, data: { granted: true, points: 50 } }));
    const r = await quworkClaimDailyReward("acc", { fetchImpl: fetch });
    expect(r).toMatchObject({ outcome: "claimed", claimed: true, points: 50 });
    expect(fetch.mock.calls[1][0]).toBe("https://llm.rrzu.com/api/user/daily-reward/claim");
    expect(fetch.mock.calls[1][1].method).toBe("POST");
  });

  it("daily reward reports wechat_required without claiming", async () => {
    const fetch = vi.fn(async () => res(200, { success: true, data: { can_claim: true, wechat_required: true } }));
    const r = await quworkClaimDailyReward("acc", { fetchImpl: fetch });
    expect(r.outcome).toBe("wechat_required");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reads the points balance from points_entitlement.total_points", () => {
    expect(quworkPointsFromSelf({ points_entitlement: { total_points: "1200", limited_points: 200, permanent_points: 1000 } }))
      .toMatchObject({ remaining: 1200, limited: 200, permanent: 1000 });
  });

  it("probes inference with the llm_token and parses model ids", async () => {
    const fetch = vi.fn(async () => res(200, { data: [{ id: "deepseek-flash" }, { id: "glm-5.2" }] }));
    const r = await quworkProbeInference("llm", { proxyOptions: PROXY, fetchImpl: fetch });
    expect(r).toMatchObject({ ok: true, models: ["deepseek-flash", "glm-5.2"] });
    expect(fetch.mock.calls[0][0]).toBe("https://llm.quwork.cn/v1/models");
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer llm");
  });

  it("live catalog filters qurwork providers and falls back on failure", async () => {
    const ok = await quworkLiveModels({ fetchImpl: async () => res(200, { providers: [{ id: "qurwork", models: [{ id: "a", name: "A" }, { id: "b", enabled: false }] }, { id: "other", models: [{ id: "c" }] }] }) });
    expect(ok).toEqual([{ id: "a", name: "A" }]);
    const fb = await quworkLiveModels({ fetchImpl: async () => { throw new Error("x"); } });
    expect(fb).toBe(QUWORK_FALLBACK_MODELS);
  });

  it("identity and device id are stable and never embed the raw phone", () => {
    expect(quworkIdentity({ uid: "7" })).toBe("quwork-user-7");
    expect(quworkIdentity({ phone: "13800000000" })).not.toContain("13800000000");
    expect(quworkDeviceIdentifier("seed")).toBe(quworkDeviceIdentifier("seed"));
  });

  it("passes no proxy by default (global fetch / global outbound proxy)", async () => {
    const fetch = vi.fn(async () => res(200, { success: true, data: {} }));
    await quworkApiRequest("/x", { fetchImpl: fetch });
    expect(fetch.mock.calls[0][2]).toBeNull();
  });
});

describe("QuWork registry + connection shape", () => {
  it("is registered as an OpenAI-compatible oauth provider with QurWork headers", () => {
    expect(registry.some((p) => p.id === "quwork")).toBe(true);
    expect(quworkRegistry.transport.baseUrl).toBe("https://llm.quwork.cn/v1/chat/completions");
    expect(quworkRegistry.transport.headers).toMatchObject({ "X-QurWork-Env": "prod" });
    expect(quworkRegistry.authModes).toEqual(["oauth"]);
    expect(quworkRegistry.models.length).toBeGreaterThan(5);
  });

  it("is an sms_code provider; mapTokens stores llm_token as apiKey, account token as access/refresh", () => {
    expect(quworkOAuth.flowType).toBe("sms_code");
    const data = quworkOAuth.mapTokens({
      llm_token: "llm", access_token: "acc", refresh_token: "acc", expires_in: 7000,
      _quworkUser: { uid: "7", nickname: "小明", phone: "13800000000" },
    });
    expect(data).toMatchObject({ apiKey: "llm", accessToken: "acc", refreshToken: "acc", expiresIn: 7000, email: "quwork-user-7", name: "小明" });
    expect(data.providerSpecificData).toMatchObject({ authMethod: "quwork", quworkPhoneMasked: "138****0000", credentialSource: "sms" });
    expect(data.providerSpecificData.quworkTokenOnly).toBeUndefined();
    expect(JSON.stringify(data.providerSpecificData)).not.toMatch(/proxy/i);
    expect(JSON.stringify(data)).not.toContain("13800000000");
  });

  it("token-only rows keep inference working without an account token", () => {
    const data = quworkOAuth.mapTokens({ llm_token: "llm" }, { credentialSource: "token" });
    expect(data).toMatchObject({ apiKey: "llm", accessToken: "llm", refreshToken: null, expiresIn: undefined });
    expect(data.providerSpecificData).toMatchObject({ quworkTokenOnly: true, credentialSource: "token" });
  });
});

describe("QuWork connection test + usage", () => {
  it("connection test lists models via the resolved connection proxy and spends nothing", async () => {
    const fetch = vi.fn(async () => res(200, { data: [{ id: "glm-5.2" }] }));
    const conn = { apiKey: "llm", providerSpecificData: {} };
    // testUtils resolves the connection's proxy (pool / legacy) and passes it in.
    expect(await testQuworkConnection(conn, PROXY, fetch)).toMatchObject({ valid: true });
    expect(fetch.mock.calls[0][0]).toBe("https://llm.quwork.cn/v1/models");
    expect(fetch.mock.calls[0][2]).toBe(PROXY);
    const waf = await testQuworkConnection(conn, null, async () => res(405, "blocked"));
    expect(waf.valid).toBe(false);
    expect(waf.error).toMatch(/405/);
  });

  it("usage shows the points balance as a display-only message, through the given proxy", async () => {
    const fetch = vi.fn(async () => res(200, { success: true, data: { points_entitlement: { total_points: 1500 } } }));
    const u = await getQuworkUsage("acc", {}, PROXY, fetch);
    expect(u.quotas).toEqual({});
    expect(u.quwork.points).toBe(1500);
    expect(u.message).toContain("1,500");
    expect(fetch.mock.calls[0][2]).toBe(PROXY);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer acc");
  });

  it("usage on a token-only row explains instead of calling the account API", async () => {
    const fetch = vi.fn();
    const u = await getQuworkUsage("llm", { quworkTokenOnly: true }, null, fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(u.quotas).toEqual({});
  });
});
