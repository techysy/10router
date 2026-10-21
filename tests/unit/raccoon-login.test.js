// 小浣熊网页授权码登录：URL 构造 / 回调解析（state 校验）/ 换码错误语义。
import { describe, expect, it, vi } from "vitest";

import {
  RACCOON_LOGIN_CONFIG,
  buildAuthorizeUrl,
  parseCallbackUrl,
  exchangeCode,
} from "@/lib/oauth/providers/raccoon.js";

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** 仅用于本地读声明的假 JWT（服务端不验签，与实现口径一致）。 */
function fakeJwt(claims) {
  return `${base64UrlJson({ alg: "HS256", typ: "JWT" })}.${base64UrlJson(claims)}.signature`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("raccoon buildAuthorizeUrl", () => {
  it("builds the official authorize URL with login_source, appname and state", () => {
    const url = new URL(buildAuthorizeUrl({ state: "state-1" }));
    expect(url.origin).toBe("https://xiaohuanxiong.com");
    expect(url.pathname).toBe("/code/authorize");
    expect(url.searchParams.get("login_source")).toBe("desktop");
    expect(url.searchParams.get("appname")).toBe("办公小浣熊客户端");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("percent-encodes a custom app name and refuses a missing state", () => {
    const raw = buildAuthorizeUrl({ state: "s-2", appName: "自定义客户端 A" });
    // searchParams 把空格写成 "+"，中文必须是百分号编码（不能原样拼进 URL）
    expect(raw).toContain(encodeURIComponent("自定义客户端"));
    expect(raw).not.toContain("自定义客户端 A");
    expect(new URL(raw).searchParams.get("appname")).toBe("自定义客户端 A");
    expect(() => buildAuthorizeUrl({})).toThrow(/state/);
  });
});

describe("raccoon parseCallbackUrl", () => {
  it("accepts office-raccoon://auth/callback and URL-decodes code/state", () => {
    const callback =
      "office-raccoon://auth/callback?code=" +
      encodeURIComponent("code/+ with space") +
      "&state=" +
      encodeURIComponent("st ate");
    expect(parseCallbackUrl(callback, "st ate")).toEqual({
      code: "code/+ with space",
      state: "st ate",
      ok: true,
    });
  });

  it("accepts an https landing URL", () => {
    const callback =
      "https://xiaohuanxiong.com/code/authorize/callback?code=abc%2B123&state=s1";
    expect(parseCallbackUrl(callback, "s1")).toMatchObject({
      ok: true,
      code: "abc+123",
      state: "s1",
    });
  });

  it("accepts a bare code (state falls back to the expected value)", () => {
    expect(parseCallbackUrl("  raw-code-1  ")).toEqual({
      code: "raw-code-1",
      state: "",
      ok: true,
    });
    expect(parseCallbackUrl("raw-code-2", "session-state")).toEqual({
      code: "raw-code-2",
      state: "session-state",
      ok: true,
    });
  });

  it("rejects a state mismatch and never returns a usable code", () => {
    const result = parseCallbackUrl(
      "office-raccoon://auth/callback?code=abc&state=forged",
      "expected",
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("");
    expect(result.state).toBe("forged");
    expect(result.error).toMatch(/state/);
  });

  it("rejects callbacks without state, with the wrong host, or without a code", () => {
    expect(parseCallbackUrl("office-raccoon://auth/callback?code=abc", "expected").ok).toBe(false);
    expect(
      parseCallbackUrl("office-raccoon://evil/callback?code=abc&state=expected", "expected").ok,
    ).toBe(false);
    expect(
      parseCallbackUrl("https://xiaohuanxiong.com/code/authorize?state=expected", "expected").ok,
    ).toBe(false);
  });
});

describe("raccoon exchangeCode", () => {
  it("posts authorization_code and maps tokens plus JWT identity", async () => {
    const accessToken = fakeJwt({
      iss: "6d446a", // 7160938
      name: "测试用户",
      email: "user@example.com",
      exp: 1_893_456_000,
    });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: {
          access_token: `Bearer ${accessToken}`,
          refresh_token: "refresh-1",
          office_identity: "office-user-1",
          office_org_name: "小浣熊公司",
          office_org_role: "owner",
        },
      }),
    );

    const result = await exchangeCode("one-time-code", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(RACCOON_LOGIN_CONFIG.exchangeUrl);
    expect(String(url)).toBe(
      "https://xiaohuanxiong.com/api/web/auth/v1/login_with_authorization_code",
    );
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ authorization_code: "one-time-code" });

    expect(result.accessToken).toBe(accessToken);
    expect(result.refreshToken).toBe("refresh-1");
    expect(result.expiresAt).toBe(1_893_456_000 * 1000);
    expect(result.uid).toBe("7160938");
    expect(result.name).toBe("测试用户");
    expect(result.email).toBe("user@example.com");
    expect(result.providerSpecificData).toMatchObject({
      authMethod: "oauth",
      uid: "7160938",
      name: "测试用户",
      officeIdentity: "office-user-1",
      officeOrgName: "小浣熊公司",
      officeOrgRole: "owner",
    });
  });

  it("reports an expired authorization code (200035) as a readable error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 200035, message: "authorization code expired" }),
    );
    await expect(exchangeCode("stale-code", { fetchImpl })).rejects.toThrow(
      "授权码已失效，请重新登录",
    );

    // 上游把业务码当字符串回时同样命中
    const stringCodeFetch = vi.fn(async () =>
      jsonResponse({ code: "200035", message: "expired" }),
    );
    await expect(exchangeCode("stale-code", { fetchImpl: stringCodeFetch })).rejects.toThrow(
      /授权码已失效/,
    );
  });

  it("surfaces upstream failures and missing refresh tokens", async () => {
    const serverError = vi.fn(async () =>
      jsonResponse({ code: 500, message: "internal_server_error" }, 500),
    );
    await expect(exchangeCode("code", { fetchImpl: serverError })).rejects.toThrow(
      "登录服务异常，请稍后重试",
    );

    const tokenOnly = vi.fn(async () =>
      jsonResponse({ code: 0, data: { access_token: fakeJwt({ sub: "u-1" }) } }),
    );
    await expect(exchangeCode("code", { fetchImpl: tokenOnly })).rejects.toThrow(
      /缺少 access_token/,
    );
  });

  it("rejects an empty code without calling fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(exchangeCode("   ", { fetchImpl })).rejects.toThrow(/缺少授权码/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
