// Trae 回调代理：裸 GET 防误触（2026-11-12 浏览器登录 ERR_CONNECTION_REFUSED 根因修复）。
// 授权页渲染登录 UI 前会 GET 预检 auth_callback_url；裸请求绝不能进 exchangeTokens ——
// trae 的 paste-token 分支会把路径串误判成导入 token，写垃圾连接并杀掉代理，
// 真正的授权回调随之 ERR_CONNECTION_REFUSED。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";

// stub 掉 exchangeTokens / createProviderConnection（provider DB 层），只验证代理的请求分诊
vi.mock("../src/lib/oauth/providers.js", () => ({
  exchangeTokens: vi.fn(async () => { throw new Error("SHOULD NOT BE CALLED for bare GET"); }),
}));
vi.mock("@/models", () => ({
  createProviderConnection: vi.fn(async () => { throw new Error("SHOULD NOT CREATE CONNECTION"); }),
}));

describe("Trae proxy bare-GET guard", () => {
  let startTraeProxy, stopTraeProxy, registerTraeSession, getTraeSessionStatus;
  let fetchMock;

  beforeEach(async () => {
    vi.resetModules();
    ({ startTraeProxy, stopTraeProxy, registerTraeSession, getTraeSessionStatus } = await import("../../src/lib/oauth/utils/server.js"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    stopTraeProxy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function hit(port, path) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
    });
  }

  it("裸 GET /authorize（授权页预检）不杀代理、不写连接，回提示页", async () => {
    const { port } = await startTraeProxy();
    registerTraeSession({ state: "s1", provider: "trae-cn" });
    const r1 = await hit(port, "/authorize");
    expect(r1.status).toBe(200);
    expect(r1.body).toContain("alive");
    // proxy 还活着：第二次探测仍 200
    const r2 = await hit(port, "/authorize");
    expect(r2.status).toBe(200);
    // 没有任何 DB 写入尝试
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("裸 GET /callback、/auth/callback 同样存活", async () => {
    const { port } = await startTraeProxy();
    registerTraeSession({ state: "s2", provider: "trae-cn" });
    for (const p of ["/callback", "/auth/callback"]) {
      const r = await hit(port, p);
      expect(r.status).toBe(200);
      expect(r.body).toContain("alive");
    }
    // 代理未死
    const r3 = await hit(port, "/authorize");
    expect(r3.status).toBe(200);
  });

  it("带授权参数（authCodeInfo）仍进 exchange 流程", async () => {
    const { port } = await startTraeProxy();
    registerTraeSession({ state: "s3", provider: "trae-cn" });
    const q = `authCodeInfo=${encodeURIComponent(JSON.stringify({ AuthCode: "ac-1", ExpireAt: Date.now() + 60000 }))}&loginHost=www.trae.cn`;
    const r = await hit(port, `/authorize?${q}`);
    // 进过 exchange 路径：失败页（非「alive」提示页）；代理随后被 stop
    expect(r.body).not.toContain("alive");
    expect(r.body).toContain("Authentication Failed");
    await new Promise((r2) => setTimeout(r2, 50));
    await expect(hit(port, "/authorize")).rejects.toThrow();
  });

  it("带 refreshToken 的旧式回调也进 exchange 流程", async () => {
    const { port } = await startTraeProxy();
    registerTraeSession({ state: "s4", provider: "trae-cn" });
    const r = await hit(port, `/authorize?refreshToken=rt-1&loginHost=www.trae.cn`);
    expect(r.body).not.toContain("alive");
    expect(r.body).toContain("Authentication Failed");
  });

  it("error 回调（用户取消）也进 exchange 流程并报告错误", async () => {
    const { port } = await startTraeProxy();
    registerTraeSession({ state: "s5", provider: "trae-cn" });
    const r = await hit(port, `/authorize?error=user_cancel&error_description=nope`);
    expect(r.body).not.toContain("alive");
    expect(r.body).toContain("Authentication Failed");
  });
});
