// Issue #69 — Trae 国内站 (trae.cn) 登录支持。
//
// 国内站与国际站共用同一套 cloudide 接口形态，但**账号不互通**：国内签发的
// refresh token 拿到国际站换必回 20101 "refresh token is invalid"（反之亦然）。
// 这些用例锁住三件事：
//   1) 站点判定（region 归一 + loginHost 反推，尤其是 trae.com.cn 的子串陷阱）；
//   2) 换 token / 取用户信息打的是选中那一端的白名单 origin；
//   3) 落库的 providerSpecificData 带 site，且作用域/区域跟着站点走——
//      token 刷新（open-sse/services/tokenRefresh）靠它选网关。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  normalizeTraeRegion,
  traeRegionFromHost,
} from "../../src/lib/oauth/providers/trae.js";
import { TRAE_CONFIG } from "../../src/lib/oauth/constants/oauth.js";

describe("Trae 站点判定", () => {
  it("正常化 region", () => {
    expect(normalizeTraeRegion("cn")).toBe("cn");
    expect(normalizeTraeRegion(" CN ")).toBe("cn");
    expect(normalizeTraeRegion("China")).toBe("cn");
    expect(normalizeTraeRegion("intl")).toBe("intl");
    expect(normalizeTraeRegion(undefined)).toBe("intl");
    expect(normalizeTraeRegion("sg")).toBe("intl");
  });

  it("从 loginHost 反推站点", () => {
    expect(traeRegionFromHost("www.trae.cn")).toBe("cn");
    // trae.com.cn 同时是 trae.cn / trae.com 的子串陷阱，必须判成 cn
    expect(traeRegionFromHost("https://www.trae.com.cn")).toBe("cn");
    expect(traeRegionFromHost("api.trae.com.cn")).toBe("cn");
    expect(traeRegionFromHost("api.marscode.cn")).toBe("cn");
    expect(traeRegionFromHost("www.trae.ai")).toBe("intl");
    expect(traeRegionFromHost("api.marscode.com")).toBe("intl");
  });

  it("host 判不出时回落到调用方给的默认站点", () => {
    expect(traeRegionFromHost("", "cn")).toBe("cn");
    expect(traeRegionFromHost("example.com", "cn")).toBe("cn");
    expect(traeRegionFromHost("example.com")).toBe("intl");
  });

  it("两端白名单互不重叠且都是 https", () => {
    for (const origin of TRAE_CONFIG.apiOrigins) expect(origin.startsWith("https://")).toBe(true);
    for (const origin of TRAE_CONFIG.cnApiOrigins) expect(origin.startsWith("https://")).toBe(true);
    const overlap = TRAE_CONFIG.apiOrigins.filter((o) => TRAE_CONFIG.cnApiOrigins.includes(o));
    expect(overlap).toEqual([]);
  });
});

describe("Trae 换 token 走对应站点的网关", () => {
  const realFetch = globalThis.fetch;
  let calls;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body });
      // GetUserInfo 用 token 认站点：国内端才认这个（探测出来的）CN token
      if (String(url).includes("/GetUserInfo")) {
        // GetUserInfo 用 token 认站点：国内端才认这个（探测出来的）CN token
        if (String(url).startsWith("https://api.trae.com.cn/")) {
          return new Response(JSON.stringify({ Result: { Email: "cn@example.com", AIRegion: "CN" } }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          ResponseMetadata: { Error: { Code: "20101", Message: "Token invalid." } },
        }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      // 只认国内端：其它 origin 一律回 20101（模拟真实的"站点不匹配"）
      if (String(url).startsWith("https://api.trae.com.cn/")) {
        return new Response(JSON.stringify({
          Result: { AccessToken: "jwt-cn", RefreshToken: "rt-cn-2", ExpiresAt: 4102444800 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        ResponseMetadata: { Error: { Code: "20101", Message: "Token 无效：refresh token is invalid." } },
      }), { status: 401, headers: { "Content-Type": "application/json" } });
    });
  });

  afterEach(() => { globalThis.fetch = realFetch; });

  it("国内回调 → 只打 cn 白名单，落库带 site=cn", async () => {
    const trae = (await import("../../src/lib/oauth/providers/trae.js")).default;
    const tokens = await trae.exchangeToken({}, "http://127.0.0.1:1234/callback?refreshToken=rt-cn&loginHost=www.trae.cn");
    expect(tokens._site).toBe("cn");
    const exchanged = calls.filter((c) => c.url.includes("ExchangeToken"));
    expect(exchanged.length).toBeGreaterThan(0);
    expect(exchanged.every((c) => c.url.startsWith("https://api.trae.com.cn/"))).toBe(true);

    const after = await trae.postExchange(tokens);
    const userInfoCall = calls.find((c) => c.url.includes("/GetUserInfo"));
    expect(userInfoCall.url.startsWith("https://api.trae.com.cn/")).toBe(true);

    const mapped = trae.mapTokens(tokens, after);
    const psd = mapped.providerSpecificData;
    expect(psd.site).toBe("cn");
    expect(psd.scope).toBe("marscode-cn");
    expect(psd.region).toBe("CN");
    expect(psd.userRegion).toBe("CN");
    expect(psd.appLanguage).toBe("zh");
  });

  it("回调里的 loginHost 优先于声明的 region（国内回调声明 intl 也能换成功）", async () => {
    const trae = (await import("../../src/lib/oauth/providers/trae.js")).default;
    const tokens = await trae.exchangeToken(
      { region: "intl" },
      "http://127.0.0.1:1234/callback?refreshToken=rt-cn&loginHost=www.trae.cn"
    );
    expect(tokens._site).toBe("cn");
    expect(tokens.accessToken).toBe("jwt-cn");
  });

  it("站点判不出且选错端时给出人话提示，而不是裸 401", async () => {
    const trae = (await import("../../src/lib/oauth/providers/trae.js")).default;
    // loginHost 不属于任何已知后缀 → 回落声明 region=intl → 打国际端全 20101
    await expect(
      trae.exchangeToken({ region: "intl" }, "http://127.0.0.1:1/callback?refreshToken=rt-cn&loginHost=mirror.example.com")
    ).rejects.toThrow(/站点不匹配|20101/);
  });

  it("粘贴的裸 JWT：国际端不认 → postExchange 探测国内端并纠正 site", async () => {
    const trae = (await import("../../src/lib/oauth/providers/trae.js")).default;
    const tokens = await trae.exchangeToken({}, "eyJhbGciOiJSUzI1NiJ9.fake-cn-jwt.sig");
    expect(tokens._authMethod).toBe("imported");
    expect(tokens._site).toBe("intl"); // 裸 JWT 走默认站点，探测在 postExchange 里纠正
    const after = await trae.postExchange(tokens);
    expect(after._site).toBe("cn");
    const mapped = trae.mapTokens(tokens, after);
    expect(mapped.providerSpecificData.site).toBe("cn");
    expect(mapped.providerSpecificData.scope).toBe("marscode-cn");
    // 探测确实打过国内端的 GetUserInfo
    expect(calls.some((c) => c.url.startsWith("https://api.trae.com.cn/") && c.url.includes("GetUserInfo"))).toBe(true);
  });
});

// Issue #99 拆线：trae / trae-cn 两条 registry 条目，oauth 侧各钉一个站点。
describe("Trae 拆线 — trae-cn 条目钉死国内站", () => {
  const realFetch = globalThis.fetch;
  let guidanceCalls;

  beforeEach(() => {
    guidanceCalls = [];
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("GetLoginGuidance")) {
        guidanceCalls.push(u);
        const isCn = ["api.trae.com.cn", "api.marscode.cn", "api.trae.cn"].some((h) => u.includes(h));
        return new Response(
          JSON.stringify(isCn ? { Result: { LoginHost: "www.trae.cn" } } : { Result: { LoginHost: "www.trae.ai" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // 换票：只认国内端（模拟真实的「站点不匹配」20101）
      if (["api.trae.com.cn", "api.marscode.cn", "api.trae.cn"].some((h) => u.includes(h))) {
        return new Response(
          JSON.stringify({ Result: { AccessToken: "jwt-cn", RefreshToken: "rt-cn-2", ExpiresAt: 4102444800 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ ResponseMetadata: { Error: { Code: "20101", Message: "refresh token is invalid" } } }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    });
  });

  afterEach(() => { globalThis.fetch = realFetch; });

  it("oauth 注册表含 trae-cn，config 钉死 cn", async () => {
    const { getProvider } = await import("../../src/lib/oauth/providers/index.js");
    const cn = getProvider("trae-cn");
    expect(cn).toBeTruthy();
    expect(cn.config.region).toBe("cn");
    expect(getProvider("trae").config.region).toBeUndefined(); // 国际条目不带站点偏置
  });

  it("trae-cn 的登录引导只打国内白名单，落库 site=cn", async () => {
    const { getProvider } = await import("../../src/lib/oauth/providers/index.js");
    const cfg = await getProvider("trae-cn").prepareConfig(getProvider("trae-cn").config);
    expect(cfg.region).toBe("cn");
    expect(cfg.loginHost).toBe("www.trae.cn");
    expect(guidanceCalls.length).toBeGreaterThan(0);
    expect(guidanceCalls.every((u) => ["api.trae.com.cn", "api.marscode.cn", "api.trae.cn"].some((h) => u.includes(h)))).toBe(true);
  });

  it("trae 条目显式 meta.region=cn 时也走国内引导（修复：meta 此前从未传入 prepareConfig）", async () => {
    const { getProvider } = await import("../../src/lib/oauth/providers/index.js");
    const intl = getProvider("trae");
    const cfg = await intl.prepareConfig(intl.config, { region: "cn" });
    expect(cfg.region).toBe("cn");
    expect(guidanceCalls.every((u) => ["api.trae.com.cn", "api.marscode.cn", "api.trae.cn"].some((h) => u.includes(h)))).toBe(true);
  });

  it("trae-cn 换票 fallback 站点为 cn（回调缺 loginHost 时不再赌国际端）", async () => {
    const traeCn = (await import("../../src/lib/oauth/providers/trae.js")).traeCn;
    // loginHost 判不出 → 回落 config.region=cn → cn origins 换票成功
    const tokens = await traeCn.exchangeToken({ region: "cn" }, "http://127.0.0.1:1/cb?refreshToken=rt&loginHost=mirror.example.com");
    expect(tokens._site).toBe("cn");
    expect(tokens.accessToken).toBe("jwt-cn");
  });
});
