/**
 * 商汤小浣熊 (SenseTime Raccoon) provider: registry wiring, the 微信小程序扫码
 * device-code shim (server-issued qrcode_code + iam/confirm activation),
 * token mapping, and the points-based usage fetcher.
 *
 * Wire protocol live-verified 2026-11-24 against xiaohuanxiong.com:
 *   POST /api/iam/v1/auth/mp/qrcode        -> {data:{qrcode_code,scan_path,...}}
 *   POST /api/iam/v1/auth/mp/qrcode/login  -> {status:"success",access_token}
 *   POST /api/web/auth/v1/iam/confirm      -> {code:0}   (required before LLM)
 *   GET  /api/web/points/v1/balance|tasks  -> points + task states
 * No network in these tests — fetch is stubbed per test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// proxyAwareFetch snapshots globalThis.fetch at module-load time, so stubbing the
// global after import would never reach it. Mock the module instead; the handler
// tests below stub the global directly (they import fetch live).
const proxyFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: proxyFetchMock }));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import handler from "../../src/lib/oauth/providers/xiaohuanxiong.js";
import { getXiaohuanxiongUsage } from "../../open-sse/services/usage/xiaohuanxiong.js";

const CHAT_URL = "https://xiaohuanxiong.com/api/web/llm/v2/chat/completions";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("xiaohuanxiong registry entry", () => {
  const entry = REGISTRY.find((e) => e.id === "xiaohuanxiong");

  it("is an OAuth provider behind the xhx alias", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("oauth");
    expect(entry.hasOAuth).toBe(true);
    expect(entry.authModes).toEqual(["oauth"]);
    expect(entry.alias).toBe("xhx");
    expect(entry.transport.format).toBe("openai");
  });

  it("posts to the full chat/completions URL (buildUrl appends nothing)", () => {
    // Non openai-compatible/anthropic-compatible providers get config.baseUrl
    // back verbatim, so the path must already be complete.
    expect(entry.transport.baseUrl).toBe(CHAT_URL);
    expect(PROVIDERS["xiaohuanxiong"].baseUrl).toBe(CHAT_URL);
  });

  it("declares usage and passes unknown models through", () => {
    expect(entry.features?.usage).toBe(true);
    expect(entry.passthroughModels).toBe(true);
    expect(entry.models.map((m) => m.id)).toContain("raccoon-090dd3");
    expect(entry.models.map((m) => m.id)).toContain("sn-glm-5-3");
  });

  it("exposes the oauth endpoint block to PROVIDER_OAUTH", () => {
    expect(PROVIDER_OAUTH["xiaohuanxiong"]).toEqual(entry.oauth);
    expect(entry.oauth.qrcodeCreateUrl).toBe("https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode");
    expect(entry.oauth.qrcodePollUrl).toBe("https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode/login");
    expect(entry.oauth.iamConfirmUrl).toBe("https://xiaohuanxiong.com/api/web/auth/v1/iam/confirm");
  });

  it("uses the device_code flow with no PKCE", () => {
    expect(handler.flowType).toBe("device_code");
    expect(typeof handler.requestDeviceCode).toBe("function");
    expect(typeof handler.pollToken).toBe("function");
  });
});

describe("xiaohuanxiong device-code login", () => {
  const config = { ...PROVIDER_OAUTH["xiaohuanxiong"] };
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("mints a server-issued qrcode and returns a QR-image verification URL", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: "OK", data: { qrcode_code: "qr-abc", scan_path: "/login/mp", expires_in: 600, poll_interval: 1 } }),
    );
    const d = await handler.requestDeviceCode(config);

    expect(fetchMock).toHaveBeenCalledWith(config.qrcodeCreateUrl, expect.objectContaining({ method: "POST" }));
    expect(d.device_code).toBe("qr-abc");
    expect(d.expires_in).toBe(300); // clamped to 300s
    expect(d.interval).toBe(2); // floored at 2s
    // The mp URL is unopenable in a browser, so verification_uri points at the
    // SVG route that renders it as a scannable QR image.
    expect(d.verification_uri).toContain("/api/oauth/xiaohuanxiong/qr?data=");
    const data = decodeURIComponent(d.verification_uri.split("data=")[1]);
    expect(data).toBe("https://xiaohuanxiong.com/login/mp?code=qr-abc");
  });

  it("throws when the server refuses to issue a code", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "ERR", message: "rate limited" }, 429));
    await expect(handler.requestDeviceCode(config)).rejects.toThrow(/rate limited/);
  });

  it("stays pending while the phone has not confirmed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "OK", data: { status: "pending" } }));
    const r = await handler.pollToken(config, "qr-abc");
    expect(r.ok).toBe(true);
    expect(r.data.error).toBe("authorization_pending");
  });

  it("reports access_denied when the user cancels on the phone", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "OK", data: { status: "canceled" } }));
    const r = await handler.pollToken(config, "qr-abc");
    expect(r.data.error).toBe("access_denied");
  });

  it("activates the IAM token via iam/confirm on success", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: "OK", data: { status: "success", access_token: "iam-token" } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0 }));

    const r = await handler.pollToken(config, "qr-abc");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [confirmUrl, confirmInit] = fetchMock.mock.calls[1];
    expect(confirmUrl).toBe(config.iamConfirmUrl);
    expect(confirmInit.headers.Authorization).toBe("Bearer iam-token");
    expect(r.data.access_token).toBe("iam-token");
    expect(r.data.expires_in).toBe(86400 * 30); // default 30d when absent
  });

  it("still returns the token when iam/confirm fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: "OK", data: { status: "success", access_token: "iam-token" } }))
      .mockRejectedValueOnce(new Error("network down"));
    const r = await handler.pollToken(config, "qr-abc");
    expect(r.data.access_token).toBe("iam-token");
  });

  it("maps tokens into a 30-day oauth connection", () => {
    const mapped = handler.mapTokens({ access_token: "t", office_identity: "张三", office_org_name: "测试组织" });
    expect(mapped.accessToken).toBe("t");
    expect(mapped.expiresIn).toBe(86400 * 30);
    expect(mapped.providerSpecificData.authMethod).toBe("oauth");
    expect(mapped.providerSpecificData.identity).toBe("张三");
    expect(mapped.providerSpecificData.orgName).toBe("测试组织");
  });
});

describe("xiaohuanxiong usage (points)", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = proxyFetchMock;
    fetchMock.mockReset();
  });

  it("asks for a login when there is no token", async () => {
    const r = await getXiaohuanxiongUsage(null);
    expect(r.message).toMatch(/扫码登录/);
  });

  it("surfaces an expired login on 401", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    const r = await getXiaohuanxiongUsage("expired");
    expect(r.message).toMatch(/重新扫码/);
  });

  it("maps balances and task progress into quota rows", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            available_points: 6289,
            daily_points: 289,
            monthly_points: 0,
            reward_points: 6000,
            topup_points: 0,
            total_chargeable_points: 6289,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            invite: {
              invite_code: "abc123",
              registered_invitee_count: 2,
              remaining_reward_invitees: 18,
              granted_points: 3000,
            },
            new_user_task_states: [
              { key: "register_pack", status: "completed" },
              { key: "desktop_login", status: "completed" },
              { key: "mobile_login", status: "unfinished" },
            ],
          },
        }),
      );

    const r = await getXiaohuanxiongUsage("iam-token");

    expect(r.plan).toBe("商汤小浣熊");
    expect(r.quotas["可用积分"].remaining).toBe(6289);
    expect(r.quotas["日常积分"].total).toBe(289);
    expect(r.quotas["奖励积分"].total).toBe(6000);
    expect(r.quotas["月度积分"]).toBeUndefined(); // zero buckets are skipped

    const tasks = r.quotas["积分任务"];
    expect(tasks.used).toBe(2);
    expect(tasks.total).toBe(3);
    expect(tasks.note).toContain("移动端登录:○(装App登录)");
    expect(tasks.note).toContain("https://xiaohuanxiong.com/zh/events/refer?code=abc123");
  });

  it("skips the task row when the tasks endpoint fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { available_points: 10, total_chargeable_points: 10 } }))
      .mockRejectedValueOnce(new Error("boom"));
    const r = await getXiaohuanxiongUsage("iam-token");
    expect(r.quotas["可用积分"].remaining).toBe(10);
    expect(r.quotas["积分任务"]).toBeUndefined();
  });
});
