// Trae 额度查询（usage/trae.js）— 协议移植自 CreditDaddy fetchTraeQuota：
// ide_user_ent_usage 权益包（裸对象，无 code 信封）逐包归并 + ide_user_pay_status 套餐名。
// 站点口径与 traeCheckin 同源：只有 site=cn 连接参与。
import { describe, it, expect, vi, beforeEach } from "vitest";

const { proxyFetchMock } = vi.hoisted(() => ({ proxyFetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => proxyFetchMock(...args) }));

function pack(name, limit, spent, expireSec, productId = 100) {
  return {
    group_name: name,
    entitlement_base_info: { quota: { credits_limit: limit }, product_id: productId, end_time: expireSec },
    usage: { credits_amount: spent },
  };
}

describe("Trae 额度查询 — getTraeUsage", () => {
  beforeEach(() => proxyFetchMock.mockReset());

  it("权益包逐包归并：同名包合并、usage_summary 优先、套餐名附带", async () => {
    const { getTraeUsage } = await import("../../open-sse/services/usage/trae.js");
    proxyFetchMock.mockImplementation(async (url) => {
      if (String(url).includes("ide_user_ent_usage")) {
        return new Response(JSON.stringify({
          user_entitlement_pack_list: [
            pack("通用积分", 150, 10, 1794200000),
            pack("通用积分", 150, 0, 1794300000),   // 同名第二包，到期更晚
            pack("Work 积分", 200, 50, 1794200000, 209),
          ],
          usage_summary: { total_amount: 500, consumed_amount: 60 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, user_pay_identity_str: "Pro", end_time: 1795000000 }), { status: 200 });
    });

    const r = await getTraeUsage("jwt.tok.sig");
    expect(r.plan).toBe("Pro");
    expect(r.total).toBe(500);
    expect(r.used).toBe(60);
    expect(r.remaining).toBe(440);
    const names = Object.keys(r.quotas);
    expect(names).toContain("通用积分");
    expect(names).toContain("Work 积分");
    // 同名合并：total 300、used 10、到期取最早
    expect(r.quotas["通用积分"].total).toBe(300);
    expect(r.quotas["通用积分"].used).toBe(10);
    expect(r.quotas["通用积分"].expiresAt).toBe(new Date(1794200000 * 1000).toISOString());
    // Work 包 recurring=false（不按日重置口径）
    expect(r.quotas["Work 积分"].recurring).toBe(false);
    expect(r.quotas["通用积分"].recurring).toBe(true);
    // 头组合：Cloud-IDE-JWT + 签到同款风控头
    const h = proxyFetchMock.mock.calls.find((c) => String(c[0]).includes("ent_usage"))[1].headers;
    expect(h.authorization).toBe("Cloud-IDE-JWT jwt.tok.sig");
    expect(h["package-type"]).toBe("stable_cn");
  });

  it("空包 + 无 summary → 提示文案（含签到指路）；401 → 凭据失效文案", async () => {
    const { getTraeUsage } = await import("../../open-sse/services/usage/trae.js");
    proxyFetchMock.mockImplementation(async () => new Response(JSON.stringify({ user_entitlement_pack_list: [] }), { status: 200 }));
    const empty = await getTraeUsage("jwt");
    expect(empty.message).toMatch(/签到/);

    proxyFetchMock.mockImplementation(async () => new Response("denied", { status: 401 }));
    const dead = await getTraeUsage("jwt");
    expect(dead.message).toMatch(/expired or unauthorized/);
  });

  it("业务 code != 0 → failed 消息；秒/毫秒时间戳都能解析", async () => {
    const { getTraeUsage } = await import("../../open-sse/services/usage/trae.js");
    proxyFetchMock.mockImplementation(async (url) => {
      if (String(url).includes("ide_user_ent_usage")) {
        return new Response(JSON.stringify({ code: 9074, message: "风控" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const r = await getTraeUsage("jwt");
    expect(r.message).toMatch(/9074|风控/);
  });
});
