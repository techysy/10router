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
  quworkWechatQrUrl,
  quworkParseWechatCallback,
  quworkWechatExchange,
  quworkBindWechatFromCallback,
  quworkActivateCode,
  quworkAccountFromSelf,
} from "open-sse/shared/quwork/client.js";
import quworkRegistry from "open-sse/providers/registry/quwork.js";
import registry from "open-sse/providers/registry/index.js";
import quworkOAuth from "@/lib/oauth/providers/quwork";
import { testQuworkConnection } from "../../src/app/api/providers/[id]/test/quworkConnection.js";
import { getQuworkUsage, quworkQuotasFromSelf, quworkCheckinToday, quworkTimeToIso } from "open-sse/services/usage/quwork.js";
import { extractConnectionBalance } from "open-sse/services/usage/balanceExtractor.js";

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
    expect(init.headers).toMatchObject({ Authorization: "Bearer acc", "X-QurWork-Env": "prod", "X-QurWork-Version": "1.7.5" });
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

  it("usage reports the points balance as a tracker quota (no top-level message), through the given proxy", async () => {
    const fetch = vi.fn(async () => res(200, { success: true, data: { points_entitlement: { total_points: 1500 } } }));
    const u = await getQuworkUsage("acc", {}, PROXY, fetch);
    expect(u.message).toBeUndefined();
    expect(u.quotas["Balance （积分）"]).toMatchObject({ total: 1500, used: 0, isCreditBalance: true, remainingPercentage: 100 });
    expect(u.quwork.points).toBe(1500);
    expect(u.quwork.summary).toContain("1,500");
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

describe("QuWork WeChat bind + invite/redeem activation", () => {
  const DEV = "a".repeat(64);

  it("sends client version >= 1.6.5 (activate rejects older clients)", async () => {
    const fetch = vi.fn(async () => res(200, { success: true, data: {} }));
    await quworkApiRequest("/x", { fetchImpl: fetch });
    const [maj, min, pat] = fetch.mock.calls[0][1].headers["X-QurWork-Version"].split(/[.-]/).map(Number);
    expect(maj * 10000 + min * 100 + pat).toBeGreaterThanOrEqual(10605);
    expect(quworkRegistry.transport.headers["X-QurWork-Version"]).toBe(quworkRegistry.oauth.clientVersion);
  });

  it("builds the WeChat qrconnect URL with QuWork's appid, callback and a random state", () => {
    const a = quworkWechatQrUrl();
    const b = quworkWechatQrUrl();
    expect(a.state).toMatch(/^[0-9a-f]{32}$/);
    expect(a.state).not.toBe(b.state);
    const u = new URL(a.url);
    expect(u.origin + u.pathname).toBe("https://open.weixin.qq.com/connect/qrconnect");
    expect(u.searchParams.get("appid")).toBe("wxac3315fe86ebb901");
    expect(u.searchParams.get("redirect_uri")).toBe("https://llm.rrzu.com/oauth/wechat");
    expect(u.searchParams.get("scope")).toBe("snsapi_login");
    expect(u.searchParams.get("state")).toBe(a.state);
    expect(u.hash).toBe("#wechat_redirect");
    expect(a.url).toContain("redirect_uri=https%3A%2F%2Fllm.rrzu.com%2Foauth%2Fwechat");
    expect(quworkWechatQrUrl({ state: "abc123" }).state).toBe("abc123");
  });

  it("parses the pasted callback URL, a query string, or a bare code", () => {
    expect(quworkParseWechatCallback("https://llm.rrzu.com/oauth/wechat?code=081AbCdEfGh123&state=ff00")).toEqual({ code: "081AbCdEfGh123", state: "ff00" });
    expect(quworkParseWechatCallback("code=081AbCdEfGh123&state=ff00")).toEqual({ code: "081AbCdEfGh123", state: "ff00" });
    expect(quworkParseWechatCallback("  081AbCdEfGh123 ")).toEqual({ code: "081AbCdEfGh123", state: "" });
    expect(() => quworkParseWechatCallback("")).toThrow();
    expect(() => quworkParseWechatCallback("https://llm.rrzu.com/oauth/wechat?state=ff")).toThrow(/code/);
    expect(() => quworkParseWechatCallback("bad code!")).toThrow();
  });

  it("exchange returns wechat_token only for need_bind and refuses an already-bound WeChat", async () => {
    const ok = vi.fn(async () => res(200, { success: true, data: { bind_type: "need_bind", wechat_token: "wt" } }));
    const r = await quworkWechatExchange("acc", "081AbCdEfGh123", { state: "ff", proxyOptions: PROXY, fetchImpl: ok });
    expect(r).toEqual({ bindType: "need_bind", wechatToken: "wt" });
    const [url, init, proxy] = ok.mock.calls[0];
    expect(url).toBe("https://llm.rrzu.com/api/oauth/wechat?code=081AbCdEfGh123&platform=qurvis&state=ff");
    expect(init.method).toBe("GET");
    expect(proxy).toBe(PROXY);
    const taken = async () => res(200, { success: true, data: { bind_type: "login", token: "x" } });
    await expect(quworkWechatExchange("acc", "081AbCdEfGh123", { fetchImpl: taken })).rejects.toMatchObject({ code: "wechat_already_bound" });
    const noTok = async () => res(200, { success: true, data: { bind_type: "need_bind" } });
    await expect(quworkWechatExchange("acc", "081AbCdEfGh123", { fetchImpl: noTok })).rejects.toMatchObject({ code: "wechat_exchange_failed" });
  });

  it("full bind: exchange then POST /api/user/wechat/bind with the account token; never binds a taken WeChat", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(res(200, { success: true, data: { bind_type: "need_bind", wechat_token: "wt" } }))
      .mockResolvedValueOnce(res(200, { success: true, data: {} }));
    const r = await quworkBindWechatFromCallback("acc", "https://llm.rrzu.com/oauth/wechat?code=081AbCdEfGh123&state=s1", { expectedState: "s1", proxyOptions: PROXY, fetchImpl: fetch });
    expect(r).toEqual({ bound: true });
    const [url, init, proxy] = fetch.mock.calls[1];
    expect(url).toBe("https://llm.rrzu.com/api/user/wechat/bind");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ wechat_token: "wt" });
    expect(init.headers.Authorization).toBe("Bearer acc");
    expect(proxy).toBe(PROXY);

    const taken = vi.fn(async () => res(200, { success: true, data: { bind_type: "already_bound" } }));
    await expect(quworkBindWechatFromCallback("acc", "081AbCdEfGh123", { fetchImpl: taken })).rejects.toThrow(/已绑定其他/);
    expect(taken).toHaveBeenCalledOnce();

    const mism = vi.fn();
    await expect(quworkBindWechatFromCallback("acc", "code=081AbCdEfGh123&state=other", { expectedState: "s1", fetchImpl: mism })).rejects.toThrow(/state/);
    expect(mism).not.toHaveBeenCalled();
  });

  it("activate posts invite_code + device_identifier + empty device_uuid and returns the server message", async () => {
    const fetch = vi.fn(async () => res(200, { success: true, data: {}, message: "激活成功，已绑定销售" }));
    const r = await quworkActivateCode("acc", " AB12cd ", { deviceId: DEV, proxyOptions: PROXY, fetchImpl: fetch });
    expect(r).toMatchObject({ activated: true, message: "激活成功，已绑定销售" });
    const [url, init, proxy] = fetch.mock.calls[0];
    expect(url).toBe("https://llm.rrzu.com/api/user/activate");
    expect(JSON.parse(init.body)).toEqual({ invite_code: "AB12cd", device_identifier: DEV, device_uuid: "" });
    expect(proxy).toBe(PROXY);
  });

  it("activate surfaces data.error_code (wechat_bind_required / client_version_too_low) and validates input", async () => {
    const needWx = async () => res(200, { success: false, message: "请先绑定微信", data: { error_code: "wechat_bind_required" } });
    await expect(quworkActivateCode("acc", "AB12", { deviceId: DEV, fetchImpl: needWx })).rejects.toMatchObject({ code: "wechat_bind_required", message: expect.stringContaining("绑定微信") });
    const old = async () => res(200, { success: false, message: "x", data: { error_code: "client_version_too_low" } });
    await expect(quworkActivateCode("acc", "AB12", { deviceId: DEV, fetchImpl: old })).rejects.toMatchObject({ code: "client_version_too_low" });
    const never = vi.fn();
    await expect(quworkActivateCode("acc", "", { deviceId: DEV, fetchImpl: never })).rejects.toThrow();
    await expect(quworkActivateCode("acc", "AB12", { deviceId: "short", fetchImpl: never })).rejects.toThrow(/device/);
    expect(never).not.toHaveBeenCalled();
  });

  it("reads wechat_bound / inviter_id / aff_code (+ optional invite summary) from /api/user/self", () => {
    expect(quworkAccountFromSelf({ wechat_bound: true, inviter_id: 7726, aff_code: "Xy9" }))
      .toEqual({ wechatBound: true, inviterId: "7726", affCode: "Xy9", invite: null });
    expect(quworkAccountFromSelf({ wechat_bound: false, inviter_id: 0 })).toMatchObject({ wechatBound: false, inviterId: "", affCode: "" });
    expect(quworkAccountFromSelf({}, { invited_count: 3, total_points: 150 }).invite).toEqual({ count: 3, points: 150 });
  });

  it("SMS login records the device identifier on the connection (activate reuses it)", () => {
    const data = quworkOAuth.mapTokens({ llm_token: "llm", access_token: "acc", _quworkUser: { uid: "7" }, _quworkDeviceId: DEV });
    expect(data.providerSpecificData.quworkDeviceId).toBe(DEV);
  });

  it("usage message appends WeChat status and the account's own invite code", async () => {
    const fetch = vi.fn(async () => res(200, { success: true, data: { points_entitlement: { total_points: 2000 }, wechat_bound: true, aff_code: "Xy9", inviter_id: 34 } }));
    const u = await getQuworkUsage("acc", {}, PROXY, fetch);
    expect(u.quwork.summary).toContain("微信：已绑定");
    expect(u.quwork.summary).toContain("邀请码 Xy9");
    expect(u.quwork).toMatchObject({ points: 2000, wechatBound: true, affCode: "Xy9", inviterId: "34" });
    const v = await getQuworkUsage("acc", {}, PROXY, async () => res(200, { success: true, data: { points_entitlement: { total_points: 1 }, wechat_bound: false } }));
    expect(v.quwork.summary).toContain("微信：未绑定");
  });
});

describe("QuWork quota tracker rows", () => {
  const NOW = Date.parse("2026-11-24T08:00:00Z"); // 16:00 Beijing, day 2026-11-24

  it("headline Balance row = current balance (stored-value pool), with permanent/limited detail rows", () => {
    const q = quworkQuotasFromSelf({ points_entitlement: { total_points: 2199.95, permanent_points: 2000, limited_points: 199.95 } }, { nowMs: NOW });
    expect(q["Balance （积分）"]).toEqual({
      used: 0, total: 2199.95, remainingPercentage: 100, resetAt: null, unlimited: true, isCreditBalance: true, summarizesDetail: true,
    });
    expect(q["永久积分"]).toEqual({ used: 0, total: 2000, resetAt: null, detailOnly: true, recurring: false });
    expect(q["限时积分"]).toMatchObject({ total: 199.95, detailOnly: true, resetAt: null });
    // balance routing / quotaBalance reads the headline row
    expect(extractConnectionBalance({ quotas: q })).toBe(2199.95);
  });

  it("limited points with an expiry ride the headline as expiringBatch", () => {
    const q = quworkQuotasFromSelf({ points_entitlement: { total_points: 300, limited_points: 100, limited_expires_at: 1796000000 } }, { nowMs: NOW });
    const iso = new Date(1796000000 * 1000).toISOString();
    expect(q["限时积分"].resetAt).toBe(iso);
    expect(q["Balance （积分）"].expiringBatch).toEqual({ remaining: 100, resetAt: iso });
  });

  it("an active subscription becomes a used/total detail row with its expiry", () => {
    const q = quworkQuotasFromSelf({ points_entitlement: { total_points: 50, active_subscription: { plan_name: "月卡", total_points: 1000, remaining_points: 400, expires_at: "2026-12-01T00:00:00Z" } } }, { nowMs: NOW });
    expect(q["月卡"]).toEqual({ used: 600, total: 1000, resetAt: "2026-12-01T00:00:00.000Z", detailOnly: true, recurring: false });
  });

  it("zero balance reads as depleted and carries no detail rows", () => {
    const q = quworkQuotasFromSelf({ points_entitlement: { total_points: 0, permanent_points: 0, limited_points: 0 } }, { nowMs: NOW });
    expect(Object.keys(q)).toEqual(["Balance （积分）"]);
    expect(q["Balance （积分）"]).toMatchObject({ total: 0, remainingPercentage: 0, unlimited: false });
  });

  it("checkinToday only when today's (Beijing) claim closed as claimed/done; otherwise absent (unknown)", () => {
    expect(quworkCheckinToday({ day: "2026-11-24", outcome: "done" }, NOW)).toBe(true);
    expect(quworkCheckinToday({ day: "2026-11-24", outcome: "claimed" }, NOW)).toBe(true);
    expect(quworkCheckinToday({ day: "2026-11-24", outcome: "wechat_required" }, NOW)).toBeUndefined();
    expect(quworkCheckinToday({ day: "2026-11-23", outcome: "done" }, NOW)).toBeUndefined();
    expect(quworkCheckinToday(null, NOW)).toBeUndefined();
    const q = quworkQuotasFromSelf({ points_entitlement: { total_points: 10 } }, { lastClaim: { day: "2026-11-24", outcome: "done" }, nowMs: NOW });
    expect(q["Balance （积分）"].checkinToday).toBe(true);
    const q2 = quworkQuotasFromSelf({ points_entitlement: { total_points: 10 } }, { nowMs: NOW });
    expect("checkinToday" in q2["Balance （积分）"]).toBe(false);
  });

  it("normalizes epoch seconds, epoch ms and date strings", () => {
    expect(quworkTimeToIso(1796000000)).toBe(quworkTimeToIso(1796000000000));
    expect(quworkTimeToIso("2026-12-01T00:00:00Z")).toBe("2026-12-01T00:00:00.000Z");
    expect(quworkTimeToIso(0)).toBeNull();
    expect(quworkTimeToIso("nope")).toBeNull();
  });

  it("usage errors keep the message (tracker shows the reason) and no quotas", async () => {
    const u = await getQuworkUsage("acc", {}, null, async () => res(405, "<html>"));
    expect(u.quotas).toEqual({});
    expect(u.message).toMatch(/405/);
  });
});
