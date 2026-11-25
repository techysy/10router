// Issue #99 落地要点 1/3/4 — Trae 新版授权（PKCE + AuthCode 双形态回调 + v3 换票）、
// 国际 core host 候选链换站重试、设备指纹按账号派生。
// 协议口径来自 muskke/trae-api-proxy v0.5 考古（issue #99 情报一）：
//   authorize URL 带 code_challenge（S256）；回调回 authCode / authCodeInfo JSON；
//   POST {host}/trae/api/v3/oauth/ExchangeToken，body 带 CodeVerifier + DeviceInfo
//   （PlatformCode=IDE_PC，DevicePublicKey 为临时 EC P-256 SPKI PEM）。
//   旧 refreshToken 回调 + /cloudide/.../ExchangeToken 保留兼容。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

import { TRAE_CONFIG } from "../../src/lib/oauth/constants/oauth.js";

// vi.mock 工厂会被提升到文件顶部执行——mock 句柄必须用 vi.hoisted 同步创建
const { proxyFetchMock } = vi.hoisted(() => ({ proxyFetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => proxyFetchMock(...args) }));

const INTL_AUTHCODE_HOSTS = ["growsg-normal.trae.ai", "grow-normal.trae.ai", "grow-normal.traeapi.us"];
const CN_AUTHCODE_HOSTS = ["api.trae.cn", "api.trae.com.cn"];

function s256(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

describe("Trae 新版授权 — PKCE + AuthCode", () => {
  const realFetch = globalThis.fetch;
  let calls;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, body: init.body, headers: init.headers });
      if (u.includes("GetLoginGuidance")) {
        const isCn = ["api.trae.com.cn", "api.marscode.cn", "api.trae.cn"].some((h) => u.includes(h));
        return new Response(
          JSON.stringify({ Result: { LoginHost: isCn ? "www.trae.cn" : "www.trae.ai" } }),
          { status: 200 }
        );
      }
      if (u.includes("/trae/api/v3/oauth/ExchangeToken")) {
        // v3 端点只在换代的 host 族上服务：国际 grow-normal 族、国内 api.trae.cn 族；
        // 打老 host（api.marscode.com 等）一律 404
        const okHost = INTL_AUTHCODE_HOSTS.some((h) => u.includes(h)) || CN_AUTHCODE_HOSTS.some((h) => u.includes(h));
        if (!okHost) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify({
          Result: { AccessToken: "jwt-new", RefreshToken: "rt-new", ExpiresAt: 4102444800 },
        }), { status: 200 });
      }
      if (u.includes("ExchangeToken")) {
        return new Response(JSON.stringify({
          Result: { AccessToken: "jwt-legacy", RefreshToken: "rt-legacy", ExpiresAt: 4102444800 },
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
  });

  afterEach(() => { globalThis.fetch = realFetch; });

  it("prepareConfig 登记 PKCE，buildAuthUrl 携带 code_challenge（S256）", async () => {
    const trae = (await import("../../src/lib/oauth/providers/trae.js")).default;
    const cfg = await trae.prepareConfig(trae.config);
    expect(cfg.codeChallenge).toBeTruthy();
    expect(cfg.codeChallenge).not.toContain("=");
    const authUrl = trae.buildAuthUrl(cfg, "http://127.0.0.1:1/callback", cfg.loginTraceID);
    const u = new URL(authUrl);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(cfg.codeChallenge);
  });

  it("AuthCode 回调走 v3 端点换票，CodeVerifier 与 authorize 的 challenge 成对，DeviceInfo 齐", async () => {
    const trae = (await import("../../src/lib/oauth/providers/trae.js")).default;
    const cfg = await trae.prepareConfig(trae.config);
    const authUrl = new URL(trae.buildAuthUrl(cfg, "http://127.0.0.1:1/callback", cfg.loginTraceID));
    const tokens = await trae.exchangeToken(
      cfg,
      `http://127.0.0.1:1/callback?authCode=ac-123&loginHost=www.trae.ai`,
      undefined, undefined,
      cfg.loginTraceID
    );
    expect(tokens.accessToken).toBe("jwt-new");
    expect(tokens._site).toBe("intl");
    const exchangeCalls = calls.filter((c) => c.url.includes("/trae/api/v3/oauth/ExchangeToken"));
    expect(exchangeCalls.length).toBeGreaterThan(0);
    // host 换代：老 host（api.marscode.com 等）不该被打
    expect(exchangeCalls.every((c) => INTL_AUTHCODE_HOSTS.some((h) => c.url.includes(h)))).toBe(true);
    const body = JSON.parse(exchangeCalls[0].body);
    expect(body.ClientID).toBe(TRAE_CONFIG.clientId);
    expect(body.AuthCode).toBe("ac-123");
    // PKCE 成对：pending 表里的 verifier 摘回后 == authorize URL 里的 challenge
    expect(s256(body.CodeVerifier)).toBe(authUrl.searchParams.get("code_challenge"));
    expect(body.DeviceInfo.PlatformCode).toBe("IDE_PC");
    expect(body.DeviceInfo.DevicePublicKey).toContain("BEGIN PUBLIC KEY");
    expect(body.DeviceInfo.DeviceID).toBeTruthy();
    expect(body.DeviceInfo.MachineID).toBeTruthy();
  });

  it("authCodeInfo JSON 形态：新鲜 ExpireAt 正常换票，过期直接拒绝", async () => {
    const trae = (await import("../../src/lib/oauth/providers/trae.js")).default;
    const cfg = await trae.prepareConfig(trae.config);
    const fresh = await trae.exchangeToken(
      cfg,
      `http://127.0.0.1:1/callback?authCodeInfo=${encodeURIComponent(JSON.stringify({ AuthCode: "ac-9", ExpireAt: Date.now() + 60000 }))}&loginHost=www.trae.ai`,
      undefined, undefined, cfg.loginTraceID
    );
    expect(fresh.accessToken).toBe("jwt-new");
    await expect(
      trae.exchangeToken(
        cfg,
        `http://127.0.0.1:1/callback?authCodeInfo=${encodeURIComponent(JSON.stringify({ AuthCode: "ac-9", ExpireAt: Date.now() - 1000 }))}&loginHost=www.trae.ai`,
        undefined, undefined, cfg.loginTraceID
      )
    ).rejects.toThrow(/expired/);
  });

  it("trae-cn 条目：AuthCode 换票只打国内 v3 host", async () => {
    const traeCn = (await import("../../src/lib/oauth/providers/trae.js")).traeCn;
    const cfg = await traeCn.prepareConfig(traeCn.config);
    expect(cfg.region).toBe("cn");
    const tokens = await traeCn.exchangeToken(
      cfg,
      `http://127.0.0.1:1/callback?authCode=ac-cn&loginHost=www.trae.cn`,
      undefined, undefined, cfg.loginTraceID
    );
    expect(tokens._site).toBe("cn");
    const exchangeCalls = calls.filter((c) => c.url.includes("/trae/api/v3/oauth/ExchangeToken"));
    expect(exchangeCalls.length).toBeGreaterThan(0);
    expect(exchangeCalls.every((c) => CN_AUTHCODE_HOSTS.some((h) => c.url.includes(h)))).toBe(true);
  });

  it("旧 refreshToken 回调不受影响（兼容路径回归）", async () => {
    const trae = (await import("../../src/lib/oauth/providers/trae.js")).default;
    const tokens = await trae.exchangeToken({}, "http://127.0.0.1:1/callback?refreshToken=rt-old&loginHost=www.trae.ai");
    expect(tokens.accessToken).toBe("jwt-legacy");
    expect(tokens._site).toBe("intl");
    expect(calls.some((c) => c.url.includes("/cloudide/api/v3/trae/oauth/ExchangeToken"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/trae/api/v3/oauth/ExchangeToken"))).toBe(false);
  });

  it("host 判不出时 userRegion 兜底定站（US → intl，CN → cn）", async () => {
    const trae = (await import("../../src/lib/oauth/providers/trae.js")).default;
    const us = await trae.exchangeToken({}, "http://127.0.0.1:1/cb?authCode=a1&userRegion=US&loginHost=mirror.example.com");
    expect(us._site).toBe("intl");
    const cn = await trae.exchangeToken({}, "http://127.0.0.1:1/cb?refreshToken=r1&userRegion=CN&loginHost=mirror.example.com");
    expect(cn._site).toBe("cn");
  });

  // 回归钉：CN+intl 授权页（2026-11-08 真机浏览器实测，#99 用户报障「登录失败/
  // 网络错误」）在渲染登录 UI 前用 /^http:\/\/127\.0\.0\.1:(\d+)\/authorize$/ 校验
  // auth_callback_url——路径必须是 /authorize，否则直接进失败死页且不发任何请求。
  // 回调路径错在弹窗侧完全无感（本地代理照常监听），只有真开授权页才会翻车。
  it("auth_callback_url 必须是 http://127.0.0.1:<port>/authorize（授权页白名单正则）", async () => {
    const trae = (await import("../../src/lib/oauth/providers/trae.js")).default;
    expect(trae.callbackPath).toBe("/authorize");
    expect(TRAE_CONFIG.callbackPath).toBe("/authorize");
    const traeCn = (await import("../../src/lib/oauth/providers/trae.js")).traeCn;
    expect(traeCn.callbackPath).toBe("/authorize");
    for (const provider of [trae, traeCn]) {
      const cfg = await provider.prepareConfig(provider.config);
      const authUrl = new URL(provider.buildAuthUrl(cfg, `http://127.0.0.1:52345${TRAE_CONFIG.callbackPath}`, cfg.loginTraceID));
      const cb = authUrl.searchParams.get("auth_callback_url");
      expect(cb).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/authorize$/);
    }
  });
});

describe("Trae executor — 设备指纹与换站重试", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    proxyFetchMock.mockReset();
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("buildHeaders 设备指纹：同账号稳定、跨账号不同、request-id 每次新", async () => {
    const { default: TraeExecutor } = await import("../../open-sse/executors/trae.js");
    const exec = new TraeExecutor("trae");
    const cred = { accessToken: "tok", providerSpecificData: { site: "intl", userId: "u-1" } };
    const h1 = exec.buildHeaders(cred, true);
    const h2 = exec.buildHeaders(cred, true);
    expect(h1["x-device-id"]).toMatch(/^\d{16}$/);
    expect(h1["x-device-id"]).toBe(h2["x-device-id"]);
    expect(h1["x-machine-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(h1["x-request-id"]).not.toBe(h2["x-request-id"]);
    expect(h1["x-uid"]).toBe("u-1");
    const other = exec.buildHeaders({ accessToken: "tok", providerSpecificData: { site: "intl", userId: "u-2" } }, true);
    expect(other["x-device-id"]).not.toBe(h1["x-device-id"]);
  });

  it("createSession 按候选链换站重试，胜出 host 回传给 events 流", async () => {
    const { default: TraeExecutor } = await import("../../open-sse/executors/trae.js");
    const exec = new TraeExecutor("trae");
    proxyFetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.startsWith("https://core-normal.trae.ai/")) return new Response("boom", { status: 500 });
      if (u.startsWith("https://core-normal.traeapi.us/")) {
        return new Response(JSON.stringify({ code: 0, data: { chat_session_id: "s1", message_id: "m1" } }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const session = await exec.createSession({}, "query", "glm-5.3", { site: "intl" }, undefined);
    expect(session.base).toBe("https://core-normal.traeapi.us/api/remote/v1");
    expect(session.sessionId).toBe("s1");
  });

  it("baseCandidates：cn 单一国内网关，intl 配置优先且去重", async () => {
    const { default: TraeExecutor } = await import("../../open-sse/executors/trae.js");
    const cnExec = new TraeExecutor("trae-cn");
    expect(cnExec.baseCandidates({})).toEqual(["https://trae-api-cn.mchost.guru/api/remote/v1"]);
    const intlExec = new TraeExecutor("trae");
    const candidates = intlExec.baseCandidates({});
    expect(candidates[0]).toBe("https://core-normal.trae.ai/api/remote/v1");
    expect(candidates).toContain("https://core-normal.traeapi.us/api/remote/v1");
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});
