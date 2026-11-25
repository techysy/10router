// Trae 额度查询（usage/trae.js）— 协议移植自 CreditDaddy fetchTraeQuota：
// ide_user_ent_usage 权益包（裸对象，无 code 信封）到期桶分桶 + ide_user_pay_status 套餐名。
// 2026-11-19 用户定版：旧「按名称归并」形态有实锤问题（归并行倒计时撒谎、
// giftPack 折叠致 meta 与正文行数不符、逐包明细与正文重复），改为
// Lingxi/MiniMax 账本先例的「名称 + 到期日」分桶。
// 站点口径与 traeCheckin 同源：只有 site=cn 连接参与。
import { describe, it, expect, vi, beforeEach } from "vitest";

const { proxyFetchMock } = vi.hoisted(() => ({ proxyFetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => proxyFetchMock(...args) }));

const { getTraeUsage, normalizeTraePacks, bucketTraePacks, __test__ } = await import(
  "../../open-sse/services/usage/trae.js"
);
const { parseQuotaData } = await import(
  "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
);
const { needsPerPackDetails } = await import("../../src/shared/utils/quotaRows.js");

function pack(name, limit, spent, expireSec, productId = 100) {
  return {
    group_name: name,
    entitlement_base_info: { quota: { credits_limit: limit }, product_id: productId, end_time: expireSec },
    usage: { credits_amount: spent },
  };
}

const dayKey = (sec) => new Date(sec * 1000).toISOString().slice(0, 10).slice(5);

describe("Trae 额度查询 — getTraeUsage（到期桶形态）", () => {
  beforeEach(() => proxyFetchMock.mockReset());

  it("同名不同日不并格：逐桶 detailOnly + 汇总行 summarizesDetail，总额信 usage_summary", async () => {
    proxyFetchMock.mockImplementation(async (url) => {
      if (String(url).includes("ide_user_ent_usage")) {
        return new Response(JSON.stringify({
          user_entitlement_pack_list: [
            pack("通用积分", 150, 10, 1794200000),
            pack("通用积分", 150, 0, 1794300000),   // 同名第二包，到期更晚 → 独立桶
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

    // 汇总行：大数字 + 分段条的分母，排除出逐包明细
    const summary = r.quotas["积分"];
    expect(summary.summarizesDetail).toBe(true);
    expect(summary.recurring).toBe(false);
    expect(summary.total).toBe(500);
    expect(summary.used).toBe(60);

    // 三个桶行（同名不同日各自成桶），到期升序
    const bucketNames = Object.keys(r.quotas).filter((n) => n !== "积分");
    expect(bucketNames).toHaveLength(3);
    expect(bucketNames).toContain(`通用积分 · ${dayKey(1794200000)}`);
    expect(bucketNames).toContain(`Work 积分 · ${dayKey(1794200000)}`);
    expect(bucketNames).toContain(`通用积分 · ${dayKey(1794300000)}`);
    // 先到期先显示：day1 的两桶（同日次序按名称 localeCompare，不钉）都在 day2 前
    const dayOf = (name) => /· (\d\d-\d\d)/.exec(name)?.[1] || "";
    expect(dayOf(bucketNames[0])).toBe(dayOf(bucketNames[1]));
    expect(dayOf(bucketNames[0]) < dayOf(bucketNames[2])).toBe(true);

    const b1 = r.quotas[`通用积分 · ${dayKey(1794200000)}`];
    expect(b1.total).toBe(150);
    expect(b1.used).toBe(10);
    expect(b1.remaining).toBe(140);
    expect(b1.detailOnly).toBe(true);
    expect(b1.recurring).toBe(false);
    expect(b1.resetAt).toBe(new Date(1794200000 * 1000).toISOString());

    // 头组合：Cloud-IDE-JWT + 签到同款风控头
    const h = proxyFetchMock.mock.calls.find((c) => String(c[0]).includes("ent_usage"))[1].headers;
    expect(h.authorization).toBe("Cloud-IDE-JWT jwt.tok.sig");
    expect(h["package-type"]).toBe("stable_cn");
  });

  it("同名同日并格：total/used 求和、包数进名字", () => {
    const packs = normalizeTraePacks([
      pack("每日签到", 150, 0, 1794200000),
      pack("每日签到", 150, 20, 1794203600), // 同日另一包
    ]);
    const buckets = bucketTraePacks(packs);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].total).toBe(300);
    expect(buckets[0].used).toBe(20);
    expect(buckets[0].packs).toBe(2);
    const row = __test__.bucketRow(buckets[0]);
    expect(row.name).toBe(`每日签到 · ${dayKey(1794200000)} · 2 包`);
  });

  it("无到期日的包排最后且无 resetAt；credits_limit ≤ 0 不出行", () => {
    const packs = normalizeTraePacks([
      pack("通用积分", 100, 0, 0),
      { group_name: "零包", entitlement_base_info: { quota: { credits_limit: 0 } }, usage: { credits_amount: 0 } },
      pack("每日签到", 150, 0, 1794200000),
    ]);
    expect(packs).toHaveLength(2); // 零包被剔除
    const buckets = bucketTraePacks(packs);
    expect(buckets.map((b) => b.name)).toEqual(["每日签到", "通用积分"]);
    expect(buckets[1].expireAt).toBe(null);
  });

  it("超过 MAX_BUCKETS 的远期桶并进「更远到期 · N 包」", () => {
    const base = 1794200000;
    const packs = normalizeTraePacks(
      Array.from({ length: __test__.MAX_BUCKETS + 3 }, (_, i) =>
        pack(`包${i}`, 10, 0, base + i * 86400)),
    );
    const buckets = bucketTraePacks(packs);
    expect(buckets).toHaveLength(__test__.MAX_BUCKETS + 1);
    const tail = buckets[buckets.length - 1];
    expect(tail.packs).toBe(3);
    const row = __test__.bucketRow(tail);
    expect(row.name).toBe("更远到期 · 3 包");
    // 求和守恒：桶行 total 之和 = 逐包之和
    const sum = buckets.reduce((s, b) => s + b.total, 0);
    expect(sum).toBe((__test__.MAX_BUCKETS + 3) * 10);
  });

  it("空包 + 无 summary → 提示文案（含签到指路）；401 → 凭据失效文案", async () => {
    proxyFetchMock.mockImplementation(async () => new Response(JSON.stringify({ user_entitlement_pack_list: [] }), { status: 200 }));
    const empty = await getTraeUsage("jwt");
    expect(empty.message).toMatch(/签到/);

    proxyFetchMock.mockImplementation(async () => new Response("denied", { status: 401 }));
    const dead = await getTraeUsage("jwt");
    expect(dead.message).toMatch(/expired or unauthorized/);
  });

  it("业务 code != 0 → failed 消息；秒/毫秒时间戳都能解析", async () => {
    proxyFetchMock.mockImplementation(async (url) => {
      if (String(url).includes("ide_user_ent_usage")) {
        return new Response(JSON.stringify({ code: 9074, message: "风控" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const r = await getTraeUsage("jwt");
    expect(r.message).toMatch(/9074|风控/);

    // 毫秒时间戳同样入桶
    const ms = 1794200000 * 1000;
    const packs = normalizeTraePacks([{
      group_name: "每日签到",
      entitlement_base_info: { quota: { credits_limit: 150 }, product_id: 100 },
      usage: { credits_amount: 0 },
      expire_time: ms,
    }]);
    expect(packs[0].expiresAt).toBe(new Date(ms).toISOString());
  });
});

describe("Trae 额度卡接线 — parseQuotaData 直通 + 逐包明细门", () => {
  function payload() {
    return {
      quotas: {
        积分: { name: "积分", used: 535.43, total: 5200, remaining: 4664.57, displayRemaining: true, summarizesDetail: true, recurring: false, unit: "积分" },
        "用户福利 · 11-21": { name: "用户福利 · 11-21", used: 535.43, total: 4000, remaining: 3464.57, resetAt: "2026-11-21T12:00:00.000Z", detailOnly: true, recurring: false, displayRemaining: true, unit: "积分" },
        "邀请好友奖励 · 12-13": { name: "邀请好友奖励 · 12-13", used: 0, total: 500, remaining: 500, resetAt: "2026-12-13T12:00:00.000Z", detailOnly: true, recurring: false, displayRemaining: true, unit: "积分" },
        "每日签到 · 12-13": { name: "每日签到 · 12-13", used: 0, total: 200, remaining: 200, resetAt: "2026-12-13T12:00:00.000Z", detailOnly: true, recurring: false, displayRemaining: true, unit: "积分" },
        "每月登录积分 · 12-13": { name: "每月登录积分 · 12-13", used: 0, total: 500, remaining: 500, resetAt: "2026-12-13T12:00:00.000Z", detailOnly: true, recurring: false, displayRemaining: true, unit: "积分" },
      },
      total: 5200,
      used: 535.43,
      remaining: 4664.57,
    };
  }

  it("trae-cn 行旗标直通：汇总行是明细的摘要，桶行 detailOnly", () => {
    const rows = parseQuotaData("trae-cn", payload());
    const summary = rows.find((r) => r.name === "积分");
    expect(summary.summarizesDetail).toBe(true);
    expect(summary.isCreditBalance).toBeFalsy(); // 「积分」不是储值余额：X/Y 总额必须保留
    const buckets = rows.filter((r) => r.name !== "积分");
    expect(buckets).toHaveLength(4);
    for (const b of buckets) {
      expect(b.detailOnly).toBe(true);
      expect(b.recurring).toBe(false);
      expect(b.resetAt).toBeTruthy();
    }
  });

  it("逐包明细门打开且只列桶行（不再与正文重复、不再缺行）", () => {
    const rows = parseQuotaData("trae", payload());
    expect(needsPerPackDetails(rows)).toBe(true);
    const detail = rows.filter((r) => !r.summarizesDetail);
    expect(detail).toHaveLength(4); // meta 计数 = 明细行数 = 桶数，三处一致
  });
});
