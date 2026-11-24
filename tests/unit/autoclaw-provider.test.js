/**
 * AutoClaw（智谱澳龙）providers — `autoclaw` (intl, account-plane web OAuth,
 * paste-callback) and `autoclaw-cn` (+86 phone SMS two-step login): registry
 * wiring, the managed-layer signature + identity headers, the CN SMS
 * request shape (numeric code, trailing-slash login path), the intl OAuth
 * authorize/exchange shape, the rotating refresh with host ordering and the
 * 400002 → agent-refresh fallback, the executor's region routing / headers /
 * body shaping, the credits card and the daily sign-in claim.
 *
 * Protocol ported from hj01857655/AutoClaw2api (docs/dual-domain-protocol.md,
 * internal/{oauth,lanes,account}) and hubo1989/opencode-autoclaw-auth. No
 * network here — every upstream call is stubbed (global fetch before module
 * import, or an injected fetchImpl).
 */
import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import {
  AUTOCLAW_APP_ID,
  AUTOCLAW_APP_KEY,
  AUTOCLAW_BANNER,
  AUTOCLAW_CHAT_URL_CN,
  AUTOCLAW_CHAT_URL_INTL,
  AUTOCLAW_CN_HOST,
  AUTOCLAW_GLOBAL_HOST,
  stripAutoclawModelPrefix,
  autoclawRedirectUri,
} from "../../open-sse/shared/autoclaw/constants.js";
import {
  autoclawRegionOfToken,
  autoclawRegionFor,
  autoclawSignHeaders,
  autoclawSmsCodeValue,
  bareToken,
  ensureAutoclawBanner,
  isTrustedAutoclawAuthorizeUrl,
  neutralizeForeignIdentity,
  normalizeAutoclawEffort,
  sanitizeAutoclawBody,
} from "../../open-sse/shared/autoclaw/client.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

function fakeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.fakesig`;
}
const future = () => Math.floor(Date.now() / 1000) + 24 * 3600;
const CN_ACCESS = fakeJwt({ source_id: "agent-autoclaw", exp: future(), device_id: "dev-cn" });
const CN_REFRESH = fakeJwt({ source_id: "agent-autoclaw", exp: future() + 86400 * 30, device_id: "dev-cn" });
const INTL_ACCESS = fakeJwt({ source_id: "autoclaw", exp: future(), device_id: "dev-intl" });
const INTL_REFRESH = fakeJwt({ source_id: "autoclaw", exp: future() + 86400 * 30, device_id: "dev-intl" });

function envelope(data, code = 0, msg = "ok", status = 200) {
  const body = { code, msg, data };
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}
function rawResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new Error("not json")),
    text: () => Promise.resolve(text),
  };
}
const headerOf = (opts, name) => {
  const h = opts?.headers || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
};

const originalFetch = global.fetch;

describe("AutoClaw registry", () => {
  const intl = REGISTRY.find((e) => e.id === "autoclaw");
  const cn = REGISTRY.find((e) => e.id === "autoclaw-cn");

  it("registers both account systems as OAuth-category providers", () => {
    expect(intl).toBeDefined();
    expect(cn).toBeDefined();
    for (const e of [intl, cn]) {
      expect(e.category).toBe("oauth");
      expect(e.hasOAuth).toBe(true);
      expect(e.authModes).toEqual(["oauth"]);
      expect(e.features?.usage).toBe(true);
    }
  });

  it("points each card at its own chat gateway (CN has no /v1)", () => {
    expect(PROVIDERS["autoclaw"].baseUrl).toBe(AUTOCLAW_CHAT_URL_INTL);
    expect(PROVIDERS["autoclaw-cn"].baseUrl).toBe(AUTOCLAW_CHAT_URL_CN);
    expect(AUTOCLAW_CHAT_URL_INTL).toBe("https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/v1/chat/completions");
    expect(AUTOCLAW_CHAT_URL_CN).toBe("https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions");
    expect(PROVIDERS["autoclaw"].format).toBe("openai");
  });

  it("lists the four live upstream models on both cards", () => {
    const ids = ["zai_auto", "zai_auto-fast", "zai_glm-5.3-flash", "zaicoding_glm-5.3"];
    expect(PROVIDER_MODELS["autoclaw"].map((m) => m.id)).toEqual(ids);
    expect(PROVIDER_MODELS["autoclaw-cn"].map((m) => m.id)).toEqual(ids);
  });

  it("carries the fixed TokenServer loopback redirect for the intl OAuth", () => {
    expect(PROVIDER_OAUTH["autoclaw"].redirectUri).toBe("http://localhost:18432/auth/callback-google");
    expect(autoclawRedirectUri("zai")).toBe("http://localhost:18432/auth/callback-zai");
  });

  it("declares 1M context and the low/high/max reasoning variants", () => {
    for (const p of ["autoclaw", "autoclaw-cn"]) {
      for (const m of ["zai_auto", "zai_auto-fast", "zai_glm-5.3-flash", "zaicoding_glm-5.3"]) {
        const caps = getCapabilitiesForModel(p, m);
        expect(caps.reasoning).toBe(true);
        expect(caps.contextWindow).toBe(1_000_000);
        expect(getThinkingLevels(p, m)).toEqual(["low", "high", "max"]);
      }
    }
  });
});

describe("AutoClaw wire helpers", () => {
  it("signs X-Auth-Sign = md5(appId&ts&appKey)", () => {
    const now = 1_790_000_000_000;
    const h = autoclawSignHeaders(now);
    const ts = String(Math.floor(now / 1000));
    expect(h["X-Auth-Appid"]).toBe(AUTOCLAW_APP_ID);
    expect(h["X-Auth-TimeStamp"]).toBe(ts);
    expect(h["X-Auth-Sign"]).toBe(crypto.createHash("md5").update(`${AUTOCLAW_APP_ID}&${ts}&${AUTOCLAW_APP_KEY}`).digest("hex"));
  });

  it("routes by the JWT source_id claim (agent* = CN), card id only as fallback", () => {
    expect(autoclawRegionOfToken(CN_REFRESH)).toBe("cn");
    expect(autoclawRegionOfToken(INTL_REFRESH)).toBe("intl");
    expect(autoclawRegionOfToken("not-a-jwt")).toBeNull();
    // A CN token stored under the intl card still routes to CN.
    expect(autoclawRegionFor("autoclaw", { refreshToken: CN_REFRESH })).toBe("cn");
    expect(autoclawRegionFor("autoclaw-cn", { accessToken: "opaque" })).toBe("cn");
    expect(autoclawRegionFor("autoclaw", {})).toBe("intl");
    expect(bareToken("Bearer Bearer abc")).toBe("abc");
  });

  it("sends all-digit SMS codes as numbers", () => {
    expect(autoclawSmsCodeValue("012345")).toBe(12345);
    expect(autoclawSmsCodeValue(" 654321 ")).toBe(654321);
    expect(autoclawSmsCodeValue("ab12")).toBe("ab12");
  });

  it("strips the zai_/zaicoding_ prefix for the body model", () => {
    expect(stripAutoclawModelPrefix("zai_auto")).toBe("auto");
    expect(stripAutoclawModelPrefix("zai_auto-fast")).toBe("auto-fast");
    expect(stripAutoclawModelPrefix("zaicoding_glm-5.3")).toBe("glm-5.3");
    expect(stripAutoclawModelPrefix("glm-5.3")).toBe("glm-5.3");
  });

  it("only trusts https authorize URLs on the vendor's exact host", () => {
    expect(isTrustedAutoclawAuthorizeUrl("https://accounts.google.com/o/oauth2/auth?state=x", "google")).toBe(true);
    expect(isTrustedAutoclawAuthorizeUrl("https://chatglm.cn/oauth?state=x", "zai")).toBe(true);
    expect(isTrustedAutoclawAuthorizeUrl("http://accounts.google.com/?state=x", "google")).toBe(false);
    expect(isTrustedAutoclawAuthorizeUrl("https://evil.example/?state=x", "google")).toBe(false);
    expect(isTrustedAutoclawAuthorizeUrl("https://accounts.google.com:8443/?state=x", "google")).toBe(false);
  });

  it("injects the 2.x banner and neutralizes foreign harness identities", () => {
    const { text, hits } = neutralizeForeignIdentity("You are Claude Code, built on Anthropic's Claude Agent SDK.");
    expect(hits).toContain("you are claude code");
    expect(text).not.toMatch(/claude code/i);
    const out = ensureAutoclawBanner([{ role: "system", content: "You are Cline, a coder." }, { role: "user", content: "hi" }]);
    expect(out[0].content.startsWith(AUTOCLAW_BANNER)).toBe(true);
    expect(out[0].content).not.toMatch(/you are cline/i);
    const noSys = ensureAutoclawBanner([{ role: "user", content: "hi" }]);
    expect(noSys[0]).toEqual({ role: "system", content: AUTOCLAW_BANNER });
  });

  it("sanitizes the body: max_tokens family + unsupported fields gone, effort clamped", () => {
    const original = {
      model: "zai_auto",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      max_completion_tokens: 100,
      max_output_tokens: 100,
      n: 2,
      seed: 7,
      parallel_tool_calls: true,
      reasoning_effort: "medium",
      stream: true,
    };
    const out = sanitizeAutoclawBody(original, "zai_auto");
    for (const f of ["max_tokens", "max_completion_tokens", "max_output_tokens", "n", "seed", "parallel_tool_calls"]) {
      expect(out[f]).toBeUndefined();
    }
    expect(out.model).toBe("auto");
    expect(out.reasoning_effort).toBe("high");
    expect(out.stream).toBe(true);
    expect(original.max_tokens).toBe(100); // caller's object untouched
    expect(normalizeAutoclawEffort("xhigh")).toBe("max");
    expect(normalizeAutoclawEffort("minimal")).toBe("low");
  });
});

describe("AutoClaw CN — phone SMS login", () => {
  it("sends the code on the CN account host with signed CN identity headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(envelope({}));
    const { sendAutoclawCnSms } = await import("../../src/lib/oauth/providers/autoclaw-cn.js");
    const r = await sendAutoclawCnSms("+8613800138000", { fetchImpl });
    expect(r.phone).toBe("13800138000");
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${AUTOCLAW_CN_HOST}/userapi/v1/agent-send-code`);
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ source_id: "autoclaw", phone: "13800138000" });
    expect(typeof body.device_id).toBe("string");
    expect(body.device_id).toMatch(/^[0-9a-f]{64}$/);
    expect(headerOf(opts, "User-Agent")).toBe("AutoClaw/2.1.0");
    expect(headerOf(opts, "X-Channel")).toBe("AutoClaw26");
    expect(headerOf(opts, "X-Auth-Appid")).toBe(AUTOCLAW_APP_ID);
    expect(headerOf(opts, "X-Auth-Sign")).toMatch(/^[0-9a-f]{32}$/);
    expect(headerOf(opts, "X-Harness-Type")).toBeUndefined();
  });

  it("rejects malformed phone numbers before any network call", async () => {
    const fetchImpl = vi.fn();
    const { sendAutoclawCnSms } = await import("../../src/lib/oauth/providers/autoclaw-cn.js");
    await expect(sendAutoclawCnSms("12345", { fetchImpl })).rejects.toThrow(/手机号/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("logs in on agent-login/ (trailing slash) with a NUMERIC code and builds the connection", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/userapi/v1/agent-login/")) {
        return envelope({ access_token: CN_ACCESS, refresh_token: CN_REFRESH, user_id: "u-42" });
      }
      if (url.endsWith("/userapi/v1/user-profile")) return envelope({ user_name: "", user_phone: "13800138000" });
      throw new Error(`unexpected ${url}`);
    });
    const { loginAutoclawCnBySms, autoclawCnConnectionPayload } = await import("../../src/lib/oauth/providers/autoclaw-cn.js");
    const r = await loginAutoclawCnBySms({ phone: "13800138000", code: "123456" }, { fetchImpl });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${AUTOCLAW_CN_HOST}/userapi/v1/agent-login/`);
    const body = JSON.parse(opts.body);
    expect(body.code).toBe(123456);
    expect(typeof body.code).toBe("number");
    expect(r.accessToken).toBe(CN_ACCESS);
    expect(r.refreshToken).toBe(CN_REFRESH);
    expect(r.userId).toBe("u-42");
    expect(r.expiresIn).toBeGreaterThan(3600);

    const payload = autoclawCnConnectionPayload(r);
    expect(payload.provider).toBe("autoclaw-cn");
    expect(payload.authType).toBe("oauth");
    expect(payload.email).toBe("autoclaw-u-42");
    expect(payload.name).toBe("138****8000");
    expect(payload.providerSpecificData.region).toBe("cn");
    expect(Date.parse(payload.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("surfaces a wrong code (630202) as a readable error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(envelope(null, 630202, "验证码错误"));
    const { loginAutoclawCnBySms } = await import("../../src/lib/oauth/providers/autoclaw-cn.js");
    await expect(loginAutoclawCnBySms({ phone: "13800138000", code: "000000" }, { fetchImpl })).rejects.toThrow(/验证码错误/);
  });
});

describe("AutoClaw intl — captcha-gated web OAuth (paste-callback)", () => {
  beforeEach(async () => {
    const { _resetAutoclawFlows } = await import("../../src/lib/oauth/providers/autoclaw.js");
    _resetAutoclawFlows();
  });

  it("reads the Aliyun captcha config from the global account host", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(envelope({ enabled: true, region: "ga", prefix: "sq51tr", scene_id: "18vhnjxl", captcha_supplier: "aliyun" }));
    const { autoclawCaptchaConfig } = await import("../../src/lib/oauth/providers/autoclaw.js");
    const cfg = await autoclawCaptchaConfig({ fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${AUTOCLAW_GLOBAL_HOST}/userapi/overseasv1/oauth-captcha-config`);
    expect(cfg).toEqual({ enabled: true, region: "ga", prefix: "sq51tr", sceneId: "18vhnjxl", supplier: "aliyun" });
  });

  it("mints the authorize URL with the captcha receipt and the registered loopback redirect", async () => {
    const authorize = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=up-state-1";
    const fetchImpl = vi.fn().mockResolvedValue(envelope({ oauth_url: authorize }));
    const { startAutoclawOAuth } = await import("../../src/lib/oauth/providers/autoclaw.js");
    const r = await startAutoclawOAuth({ vendor: "google", captchaVerifyParam: "receipt-1" }, { fetchImpl });
    expect(r.authUrl).toBe(authorize);
    expect(r.redirectUri).toBe("http://localhost:18432/auth/callback-google");
    expect(typeof r.flowId).toBe("string");

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${AUTOCLAW_GLOBAL_HOST}/userapi/overseasv1/google-oauth-url`);
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      navigate_uri: "http://localhost:18432/auth/callback-google",
      ali_captcha_verify_param: "receipt-1",
      source_id: "autoclaw",
    });
    expect(body.device_id).toMatch(/^[0-9a-f]{64}$/);
    expect(headerOf(opts, "X-Channel")).toBe("AutoClaw4");
    expect(headerOf(opts, "User-Agent")).toBe("AutoClaw/1.18.1");
  });

  it("explains a missing captcha receipt (upstream 400001) instead of a raw code", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(envelope(null, 400001, "请求数据有问题,请检查后重试"));
    const { startAutoclawOAuth } = await import("../../src/lib/oauth/providers/autoclaw.js");
    await expect(startAutoclawOAuth({ vendor: "google" }, { fetchImpl })).rejects.toThrow(/滑块安全验证/);
  });

  it("refuses an authorize URL on an unexpected host", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(envelope({ oauth_url: "https://phish.example/auth?state=s" }));
    const { startAutoclawOAuth } = await import("../../src/lib/oauth/providers/autoclaw.js");
    await expect(startAutoclawOAuth({ vendor: "google", captchaVerifyParam: "r" }, { fetchImpl })).rejects.toThrow(/host/);
  });

  it("exchanges the pasted callback on oauth-login and builds the connection", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      calls.push([url, opts]);
      if (url.endsWith("-oauth-url")) return envelope({ oauth_url: "https://chatglm.cn/oauth/authorize?state=st-9" });
      if (url.endsWith("-oauth-login")) return envelope({ access_token: INTL_ACCESS, refresh_token: INTL_REFRESH, user_id: "g-7" });
      if (url.endsWith("/userapi/v1/user-profile")) return envelope({ user_name: "Ada", email: "ada@example.com" });
      throw new Error(`unexpected ${url}`);
    });
    const { startAutoclawOAuth, completeAutoclawOAuth, autoclawIntlConnectionPayload } =
      await import("../../src/lib/oauth/providers/autoclaw.js");
    const flow = await startAutoclawOAuth({ vendor: "zai", captchaVerifyParam: "r" }, { fetchImpl });
    const r = await completeAutoclawOAuth(
      { flowId: flow.flowId, callbackUrl: "http://localhost:18432/auth/callback-zai?code=code-abc&state=st-9" },
      { fetchImpl },
    );

    const login = calls.find(([u]) => u.endsWith("/userapi/overseasv1/zai-oauth-login"));
    expect(login).toBeDefined();
    const loginBody = JSON.parse(login[1].body);
    expect(loginBody).toMatchObject({
      code: "code-abc",
      state: "st-9",
      navigate_uri: "http://localhost:18432/auth/callback-zai",
      source_id: "autoclaw",
    });
    // url and login carry the same device_id (bound into the JWT)
    const urlCall = calls.find(([u]) => u.endsWith("-oauth-url"));
    expect(loginBody.device_id).toBe(JSON.parse(urlCall[1].body).device_id);

    const payload = autoclawIntlConnectionPayload(r);
    expect(payload.provider).toBe("autoclaw");
    expect(payload.authType).toBe("oauth");
    expect(payload.accessToken).toBe(INTL_ACCESS);
    expect(payload.refreshToken).toBe(INTL_REFRESH);
    expect(payload.email).toBe("ada@example.com");
    expect(payload.displayName).toBe("Ada");
    expect(payload.providerSpecificData).toMatchObject({ region: "intl", vendor: "zai", userId: "g-7" });
    expect(Date.parse(payload.expiresAt)).toBeGreaterThan(Date.now() + 3600 * 1000);

    // The flow is single-use.
    await expect(completeAutoclawOAuth({ flowId: flow.flowId, callbackUrl: "x?code=a&state=st-9" }, { fetchImpl }))
      .rejects.toThrow(/过期/);
  });

  it("rejects a callback whose state does not match the minted one", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("-oauth-url")) return envelope({ oauth_url: "https://accounts.google.com/auth?state=good" });
      throw new Error(`unexpected ${url}`);
    });
    const { startAutoclawOAuth, completeAutoclawOAuth } = await import("../../src/lib/oauth/providers/autoclaw.js");
    const flow = await startAutoclawOAuth({ vendor: "google", captchaVerifyParam: "r" }, { fetchImpl });
    await expect(completeAutoclawOAuth({ flowId: flow.flowId, callbackUrl: "http://localhost:18432/auth/callback-google?code=c&state=evil" }, { fetchImpl }))
      .rejects.toThrow(/state/);
    expect(fetchImpl.mock.calls.some(([u]) => u.endsWith("-oauth-login"))).toBe(false);
  });

  it("parses callback URLs, bare query strings and provider errors", async () => {
    const { parseAutoclawCallback } = await import("../../src/lib/oauth/providers/autoclaw.js");
    expect(parseAutoclawCallback("http://localhost:18432/auth/callback-google?code=a&state=b")).toEqual({ code: "a", state: "b" });
    expect(parseAutoclawCallback("code=a&state=b")).toEqual({ code: "a", state: "b" });
    expect(() => parseAutoclawCallback("http://localhost:18432/?error=access_denied")).toThrow(/access_denied/);
    expect(() => parseAutoclawCallback("")).toThrow();
  });
});

describe("refreshAutoclawToken (host order + 400002 fallback + rotation)", () => {
  beforeEach(() => {
    vi.resetModules();
    global.fetch = originalFetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("refreshes a CN (agent*) token on the CN host first and returns the rotated pair", async () => {
    const newAccess = fakeJwt({ source_id: "agent-autoclaw", exp: future() });
    const fetchMock = vi.fn().mockResolvedValue(envelope({ access_token: newAccess, refresh_token: "rt-rotated", refresh: true }));
    global.fetch = fetchMock;
    const { refreshAutoclawToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const r = await refreshAutoclawToken(CN_REFRESH, { region: "intl" });
    expect(r.accessToken).toBe(newAccess);
    expect(r.refreshToken).toBe("rt-rotated");
    expect(r.expiresIn).toBeGreaterThan(3600);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${AUTOCLAW_CN_HOST}/userapi/v1/refresh`);
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ source_id: "autoclaw", device_id: "dev-cn", refresh_token: CN_REFRESH });
  });

  it("falls back to /agent-refresh on business code 400002", async () => {
    const newAccess = fakeJwt({ source_id: "autoclaw", exp: future() });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(envelope(null, 400002, "Middleware sign error"))
      .mockResolvedValueOnce(envelope({ access_token: newAccess }));
    global.fetch = fetchMock;
    const { refreshAutoclawToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const r = await refreshAutoclawToken(INTL_REFRESH);
    expect(fetchMock.mock.calls[0][0]).toBe(`${AUTOCLAW_GLOBAL_HOST}/userapi/v1/refresh`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${AUTOCLAW_GLOBAL_HOST}/userapi/v1/agent-refresh`);
    expect(r.accessToken).toBe(newAccess);
    // No new refresh_token in the response → keep the current one.
    expect(r.refreshToken).toBe(INTL_REFRESH);
  });

  it("classifies a dead login (401) as invalid_grant", async () => {
    const fetchMock = vi.fn().mockResolvedValue(rawResponse(401, "Unauthorized"));
    global.fetch = fetchMock;
    const { refreshAutoclawToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const r = await refreshAutoclawToken(fakeJwt({ source_id: "autoclaw", n: 1 }));
    expect(r).toEqual({ error: "invalid_grant" });
  });

  it("treats 400000 用户未登录 on every host as a dead login, but not when one host is only transient", async () => {
    const dead = () => envelope(null, 400000, "用户未登录，请重新登录");
    const fetchMock = vi.fn().mockImplementation(async () => dead());
    global.fetch = fetchMock;
    const { refreshAutoclawToken } = await import("open-sse/services/tokenRefresh/providers.js");
    expect(await refreshAutoclawToken(fakeJwt({ source_id: "agent-x", n: 5 }))).toEqual({ error: "invalid_grant" });
    expect(fetchMock.mock.calls[0][0]).toBe(`${AUTOCLAW_CN_HOST}/userapi/v1/refresh`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${AUTOCLAW_GLOBAL_HOST}/userapi/v1/refresh`);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(dead()).mockResolvedValueOnce(rawResponse(502, "<html>bad gateway</html>"));
    expect(await refreshAutoclawToken(fakeJwt({ source_id: "agent-x", n: 6 }))).toBeNull();
  });

  it("dedupes concurrent refreshes of the same token (single-use rotation)", async () => {
    const newAccess = fakeJwt({ source_id: "autoclaw", exp: future() });
    const fetchMock = vi.fn().mockResolvedValue(envelope({ access_token: newAccess, refresh_token: "rt-x" }));
    global.fetch = fetchMock;
    const { refreshAutoclawToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const rt = fakeJwt({ source_id: "autoclaw", n: 2 });
    const [a, b] = await Promise.all([refreshAutoclawToken(rt), refreshAutoclawToken(rt)]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is wired into the refresh handler table for both cards", async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ access_token: INTL_ACCESS, refresh_token: "rt-y" }));
    global.fetch = fetchMock;
    const { refreshTokenByProvider } = await import("open-sse/services/tokenRefresh.js");
    const r = await refreshTokenByProvider("autoclaw-cn", { refreshToken: fakeJwt({ source_id: "autoclaw", n: 3 }) });
    expect(r.refreshToken).toBe("rt-y");
  });
});

describe("AutoclawExecutor", () => {
  beforeEach(() => {
    vi.resetModules();
    global.fetch = originalFetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("is registered for both cards", async () => {
    const { getExecutor } = await import("open-sse/executors/index.js");
    const { AutoclawExecutor } = await import("open-sse/executors/autoclaw.js");
    expect(getExecutor("autoclaw")).toBeInstanceOf(AutoclawExecutor);
    expect(getExecutor("autoclaw-cn")).toBeInstanceOf(AutoclawExecutor);
  });

  it("routes by the token's region, not the card", async () => {
    const { AutoclawExecutor } = await import("open-sse/executors/autoclaw.js");
    const intl = new AutoclawExecutor("autoclaw");
    expect(intl.buildUrl("zai_auto", true, 0, { accessToken: INTL_ACCESS })).toBe(AUTOCLAW_CHAT_URL_INTL);
    expect(intl.buildUrl("zai_auto", true, 0, { accessToken: CN_ACCESS })).toBe(AUTOCLAW_CHAT_URL_CN);
    const cn = new AutoclawExecutor("autoclaw-cn");
    expect(cn.buildUrl("zai_auto", true, 0, { accessToken: "opaque" })).toBe(AUTOCLAW_CHAT_URL_CN);
  });

  it("builds signed headers with the full route model and CN agent id", async () => {
    const { AutoclawExecutor } = await import("open-sse/executors/autoclaw.js");
    const ex = new AutoclawExecutor("autoclaw-cn");
    const h = ex.buildHeaders({ accessToken: `Bearer ${CN_ACCESS}` }, true, AUTOCLAW_CHAT_URL_CN, "zaicoding_glm-5.3", { model: "glm-5.3" });
    expect(h.Authorization).toBe(`Bearer ${CN_ACCESS}`);
    expect(h["X-Authorization"]).toBe(`Bearer ${CN_ACCESS}`);
    expect(h["X-Request-Model"]).toBe("zaicoding_glm-5.3");
    expect(h["X-Agent-Id"]).toBe("main");
    expect(h["X-Channel"]).toBe("AutoClaw26");
    expect(h["User-Agent"]).toBe("AutoClaw/2.1.0");
    expect(h["X-Auth-Sign"]).toMatch(/^[0-9a-f]{32}$/);
    expect(h["X-Request-Id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(h["X-Harness-Type"]).toBeUndefined();
    expect(h.Accept).toBe("text/event-stream");

    const hi = new AutoclawExecutor("autoclaw").buildHeaders({ accessToken: INTL_ACCESS }, false, "", "zai_auto", {});
    expect(hi["X-Agent-Id"]).toBeUndefined();
    expect(hi["X-Channel"]).toBe("AutoClaw4");
    expect(hi["User-Agent"]).toBe("AutoClaw/1.18.1");
  });

  it("transformRequest strips max_tokens, prefixes and injects the banner", async () => {
    const { AutoclawExecutor } = await import("open-sse/executors/autoclaw.js");
    const ex = new AutoclawExecutor("autoclaw");
    const out = ex.transformRequest("zai_auto-fast", {
      model: "zai_auto-fast",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
      stream: true,
    });
    expect(out.max_tokens).toBeUndefined();
    expect(out.model).toBe("auto-fast");
    expect(out.messages[0]).toEqual({ role: "system", content: AUTOCLAW_BANNER });
  });

  it("execute() posts the shaped request to the region's gateway", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
    global.fetch = fetchMock;
    const { AutoclawExecutor } = await import("open-sse/executors/autoclaw.js");
    const ex = new AutoclawExecutor("autoclaw-cn");
    const { response, url } = await ex.execute({
      model: "zai_glm-5.3-flash",
      body: { model: "zai_glm-5.3-flash", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 10, stream: true },
      stream: true,
      credentials: { accessToken: CN_ACCESS },
    });
    expect(response.status).toBe(200);
    expect(url).toBe(AUTOCLAW_CHAT_URL_CN);
    const [, opts] = fetchMock.mock.calls[0];
    const sent = JSON.parse(opts.body);
    expect(sent.model).toBe("glm-5.3-flash");
    expect(sent.max_completion_tokens).toBeUndefined();
    expect(headerOf(opts, "X-Request-Model")).toBe("zai_glm-5.3-flash");
  });

  it("refreshCredentials routes through refreshAutoclawToken", async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ access_token: INTL_ACCESS, refresh_token: "rt-exec" }));
    global.fetch = fetchMock;
    const { AutoclawExecutor } = await import("open-sse/executors/autoclaw.js");
    const r = await new AutoclawExecutor("autoclaw").refreshCredentials({ refreshToken: fakeJwt({ source_id: "autoclaw", n: 4 }) }, null);
    expect(r.refreshToken).toBe("rt-exec");
    expect(await new AutoclawExecutor("autoclaw").refreshCredentials({}, null)).toBeNull();
  });
});

describe("AutoClaw credits card + daily sign-in", () => {
  it("reports the wallet total, non-zero category wallets and the sign-in state", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes("/agent-assetmgr/api/v2/wallets")) {
        return envelope({
          total_balance: 1200,
          wallets: [
            { public_wallet_type: "reward", display_name: "奖励积分", balance: 800 },
            { public_wallet_type: "daily", balance: 400 },
            { public_wallet_type: "subscription", balance: 0 },
          ],
        });
      }
      if (url.includes("autoclaw-task-list")) {
        return envelope([{ task_id: "daily_signin", status: "completed", reward_points: 200 }]);
      }
      throw new Error(`unexpected ${url}`);
    });
    const { getAutoclawUsage } = await import("open-sse/services/usage/autoclaw.js");
    const u = await getAutoclawUsage("autoclaw-cn", { accessToken: CN_ACCESS }, null, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${AUTOCLAW_CN_HOST}/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`);
    expect(u.plan).toBe("AutoClaw CN");
    expect(u.quotas["Balance （积分）"].total).toBe(1200);
    expect(u.quotas["奖励积分"].total).toBe(800);
    expect(u.quotas["每日积分"].total).toBe(400);
    expect(u.quotas["订阅积分"]).toBeUndefined();
    expect(u.autoclaw.dailySignin).toEqual({ done: true, reward: 200 });
  });

  it("never reports an unreadable wallet as zero", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rawResponse(401, "nope"));
    const { getAutoclawUsage } = await import("open-sse/services/usage/autoclaw.js");
    const u = await getAutoclawUsage("autoclaw", { accessToken: INTL_ACCESS }, null, { fetchImpl });
    expect(u.quotas).toEqual({});
    expect(u.message).toMatch(/登录已失效/);
  });

  it("claims daily_signin on the token's region with a refreshed token", async () => {
    const claim = vi.fn().mockResolvedValue({ claimed: true, already: false, points: 200, streak: 3, message: "已签到 +200" });
    const checkAndRefreshToken = vi.fn(async (_p, c) => ({ ...c, accessToken: CN_ACCESS }));
    const { claimAutoclawCheckin } = await import("../../src/sse/services/autoclawCheckin.js");
    const { autoclawRegionFor } = await import("open-sse/shared/autoclaw/client.js");
    const r = await claimAutoclawCheckin(
      { id: "c1", provider: "autoclaw", accessToken: "stale", refreshToken: CN_REFRESH },
      { deps: { checkAndRefreshToken, claimAutoclawDailySignin: claim, autoclawRegionFor } },
    );
    expect(r.claimed).toBe(true);
    expect(checkAndRefreshToken).toHaveBeenCalledWith("autoclaw", expect.objectContaining({ connectionId: "c1" }));
    expect(claim).toHaveBeenCalledWith(CN_ACCESS, expect.objectContaining({ region: "cn" }));
  });

  it("parses the task-complete response (claimed / already / failed)", async () => {
    const { claimAutoclawDailySignin } = await import("open-sse/shared/autoclaw/client.js");
    const ok = vi.fn().mockResolvedValue(envelope({ success: true, reward_points: 200, continuous_days: 2 }));
    const r1 = await claimAutoclawDailySignin(INTL_ACCESS, { region: "intl", fetchImpl: ok });
    expect(ok.mock.calls[0][0]).toBe(`${AUTOCLAW_GLOBAL_HOST}/autoclaw-proxy/proxy/autoclaw-task-complete`);
    expect(JSON.parse(ok.mock.calls[0][1].body)).toEqual({ task_id: "daily_signin", source_id: "autoclaw" });
    expect(r1).toMatchObject({ claimed: true, points: 200, streak: 2 });
    const again = vi.fn().mockResolvedValue(envelope({ success: false, already_completed: true }));
    expect((await claimAutoclawDailySignin(INTL_ACCESS, { fetchImpl: again })).already).toBe(true);
  });

  it("uses the Beijing calendar day for the done map", async () => {
    const { dayKey } = await import("../../src/sse/services/autoclawCheckin.js");
    // 2026-11-24 17:00 UTC = 2026-11-25 01:00 Beijing
    expect(dayKey(Date.UTC(2026, 10, 24, 17, 0, 0))).toBe("2026-11-25");
  });
});
