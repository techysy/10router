import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  ledgerAmount,
  bucketLedgerByExpiry,
  fetchCreditLedger,
  signedAccountRequest,
  getMiniMaxCodeUsage,
} from "../../open-sse/services/usage/minimax-code.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { isStoredValueRow, needsPerPackDetails } from "../../src/shared/utils/quotaRows.js";
import { extractEarliestPackageExpiry } from "../../open-sse/services/usage/expiryExtractor.js";

// usage.js 层 fetch 都走 proxyAwareFetch（open-sse/utils/proxyFetch.js 补丁全局
// fetch）——mock 那一层，别 mock globalThis.fetch。
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

// MiniMax Code 的「算力币到期包」出卡（2026-11-16 实测口径）：
//   GET /minimax-cloud/api/v1/credit/details?page_number=&page_size=&include_expired=false
//   -> { details: [{credit_type, granted_amount, consumed_amount,
//        remaining_amount, granted_at_ms, expire_at_ms}], total_count }
// 逐包 remaining 求和 = membership 的 op_credit_summary.total_remaining_amount
// （#131/#1697/#3710/#187 四号实测吻合到分位）。逐包按到期日并格成桶
// （lingxi 到期桶同款），Credits 储值行挂 summarizesDetail + expiringBatch。

const DAY = 86400_000;
const now = Date.now();
const atMs = (daysAhead) => now + daysAhead * DAY;
const batch = (over = {}) => ({
  credit_type: 2,
  granted_amount: "400.00",
  consumed_amount: "0.00",
  remaining_amount: "400.00",
  granted_at_ms: now - DAY,
  expire_at_ms: atMs(20),
  ...over,
});

describe("ledgerAmount — 千分位/负数容错", () => {
  it("parses thousands-separated decimals and clamps negatives when asked", () => {
    expect(ledgerAmount("1,200.50")).toBe(1200.5);
    expect(ledgerAmount("400.00")).toBe(400);
    expect(ledgerAmount("-12.5", { clampNegative: true })).toBe(0);
    expect(ledgerAmount("-12.5")).toBeNull();
    expect(ledgerAmount("abc")).toBeNull();
    expect(ledgerAmount(null)).toBeNull();
    expect(ledgerAmount("")).toBeNull();
  });
});

describe("bucketLedgerByExpiry — 同日并格 / 升序 FIFO / 死包剔除", () => {
  it("merges same-day-expiry batches into one bucket with summed amounts", () => {
    const buckets = bucketLedgerByExpiry([
      batch({ expire_at_ms: atMs(20) }),
      batch({ expire_at_ms: atMs(20), granted_amount: "1,000.00", remaining_amount: "1,000.00" }),
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].balance).toBe(1400);
    expect(buckets[0].total).toBe(1400);
    expect(buckets[0].packs).toBe(2);
  });

  it("sorts buckets ascending by expiry day (FIFO 消耗语义)", () => {
    const buckets = bucketLedgerByExpiry([
      batch({ expire_at_ms: atMs(30) }),
      batch({ expire_at_ms: atMs(10) }),
      batch({ expire_at_ms: atMs(20) }),
    ]);
    expect(buckets.map((b) => b.key)).toEqual(
      [atMs(10), atMs(20), atMs(30)].map((ms) => new Date(ms).toISOString().slice(0, 10)),
    );
  });

  it("drops spent and expired batches — they are history, not headroom", () => {
    const buckets = bucketLedgerByExpiry([
      batch({ remaining_amount: "0.00" }),
      batch({ expire_at_ms: now - DAY }),
      batch(),
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].balance).toBe(400);
  });

  it("marks a bucket with its purchased-pack count (credit_type 1)", () => {
    const buckets = bucketLedgerByExpiry([
      batch({ credit_type: 1, granted_amount: "2,000.00", remaining_amount: "2,000.00", expire_at_ms: atMs(15) }),
      batch({ expire_at_ms: atMs(15) }),
    ]);
    expect(buckets[0].purchasedPacks).toBe(1);
    expect(buckets[0].packs).toBe(2);
  });

  it("tolerates garbage amounts without NaN", () => {
    const buckets = bucketLedgerByExpiry([batch({ granted_amount: "abc", remaining_amount: null }), batch()]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].balance).toBe(400);
  });
});

describe("fetchCreditLedger — 分页拉全 + 异常收缩为空", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ledgerResponse = (page) =>
    new Response(
      JSON.stringify({
        details:
          page === 1
            ? [batch(), batch({ expire_at_ms: atMs(21) })]
            : [batch({ expire_at_ms: atMs(22) })],
        total_count: 3,
      }),
      { status: 200 },
    );

  it("walks pages until total_count is reached, merging details", async () => {
    const seenUrls = [];
    proxyAwareFetch.mockImplementation(async (url) => {
      seenUrls.push(String(url));
      const u = new URL(url);
      return ledgerResponse(Number(u.searchParams.get("page_number")));
    });
    const batches = await fetchCreditLedger({ agent: "https://agent.minimaxi.com" }, "tok", "42");
    expect(batches).toHaveLength(3);
    expect(seenUrls).toHaveLength(2);
    const u = new URL(seenUrls[0]);
    expect(u.pathname).toBe("/minimax-cloud/api/v1/credit/details");
    expect(u.searchParams.get("page_size")).toBe("20");
    expect(u.searchParams.get("include_expired")).toBe("false");
    // ledger query params ride ALONGSIDE the mcode signing params (merged, not clobbered)
    expect(u.searchParams.get("client")).toBe("mcode");
    // signed GET carries the auth header
    expect(proxyAwareFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });

  it("returns [] when the endpoint 404s (global 线无此端点时不出桶)", async () => {
    proxyAwareFetch.mockResolvedValue(new Response("Not Found", { status: 404 }));
    const batches = await fetchCreditLedger({ agent: "https://agent.minimaxi.com" }, "tok", "42");
    expect(batches).toEqual([]);
  });
});

describe("getMiniMaxCodeUsage — 余额 + 到期桶 + 徽标信号", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // M Plan 探针 404（无 token plan），membership 返回余额，ledger 返回逐包。
  function mockFetch({ membershipBalance = "4603.823", batches = [batch(), batch({ expire_at_ms: atMs(21) })] } = {}) {
    proxyAwareFetch.mockImplementation(async (url, init = {}) => {
      const u = String(url);
      if (u.includes("coding_plan/remains")) {
        return new Response(JSON.stringify({ base_resp: { status_code: 2062, status_msg: "no active token plan subscription" } }), { status: 404 });
      }
      if (u.includes("get_membership_info")) {
        return new Response(
          JSON.stringify({
            op_credit_summary: { total_remaining_amount: membershipBalance, purchased_remaining_amount: "0", free_remaining_amount: membershipBalance },
            base_resp: { status_code: 0 },
          }),
          { status: 200 },
        );
      }
      if (u.includes("credit/details")) {
        expect(init.headers["x-signature"]).toMatch(/^[0-9a-f]{32}$/);
        return new Response(JSON.stringify({ details: batches, total_count: batches.length }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });
  }

  it("emits the Credits summary plus expiry buckets and the expiringBatch signal", async () => {
    // 两包同日到期（并格带 packs 后缀）+ 一包次日（无后缀）
    mockFetch({
      batches: [
        batch(),
        batch({ expire_at_ms: atMs(20), granted_amount: "1,000.00", remaining_amount: "1,000.00" }),
        batch({ expire_at_ms: atMs(21) }),
      ],
    });
    const usage = await getMiniMaxCodeUsage("tok", "minimax-code");
    expect(usage.message).toBeUndefined();
    const names = Object.keys(usage.quotas);
    expect(names[0]).toBe("Credits");
    const credits = usage.quotas.Credits;
    expect(credits.isCreditBalance).toBe(true);
    expect(credits.summarizesDetail).toBe(true);
    expect(credits.expiringBatch).toEqual({
      remaining: 1400,
      resetAt: new Date(atMs(20)).toISOString(),
    });
    // 桶行：升序、detailOnly、recurring:false（一次性包，非滚动窗）
    const bucketRows = names.slice(1);
    expect(bucketRows).toHaveLength(2);
    expect(bucketRows[0]).toMatch(/^Credits · \d{2}-\d{2} · 2 packs$/);
    expect(bucketRows[1]).toMatch(/^Credits · \d{2}-\d{2}$/);
    expect(usage.quotas[bucketRows[0]].remaining).toBe(1400);
    expect(usage.quotas[bucketRows[1]].remaining).toBe(400);
    for (const n of bucketRows) {
      expect(usage.quotas[n].recurring).toBe(false);
      expect(usage.quotas[n].detailOnly).toBe(true);
    }
  });

  it("keeps the plain stored-value card when the ledger is unreachable", async () => {
    mockFetch();
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("credit/details")) return new Response("Not Found", { status: 404 });
      const u = String(url);
      if (u.includes("coding_plan/remains")) {
        return new Response(JSON.stringify({ base_resp: { status_code: 2062, status_msg: "no active token plan subscription" } }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          op_credit_summary: { total_remaining_amount: "4603.823" },
          base_resp: { status_code: 0 },
        }),
        { status: 200 },
      );
    });
    const usage = await getMiniMaxCodeUsage("tok", "minimax-code");
    expect(Object.keys(usage.quotas)).toEqual(["Credits"]);
    expect(usage.quotas.Credits.summarizesDetail).toBeUndefined();
    expect(usage.quotas.Credits.expiringBatch).toBeUndefined();
  });
});

describe("dashboard rendering of the ledger buckets", () => {
  const PAYLOAD = {
    quotas: {
      Credits: {
        used: 0, total: 4603.823, remaining: 4603.823, isCreditBalance: true, currency: "credits",
        recurring: false, summarizesDetail: true, resetAt: "2026-12-05T16:00:00.000Z",
        expiringBatch: { remaining: 203.82, resetAt: "2026-12-05T16:00:00.000Z" },
      },
      "Credits · 12-05": { used: 196.18, total: 400, remaining: 203.82, resetAt: "2026-12-05T16:00:00.000Z", recurring: false, displayRemaining: true, detailOnly: true },
      "Credits · 12-06 · 2 packs": { used: 0, total: 800, remaining: 800, resetAt: "2026-12-06T16:00:00.000Z", recurring: false, displayRemaining: true, detailOnly: true },
    },
  };

  it("parseQuotaData keeps the flags through the generic fallback", () => {
    const rows = parseQuotaData("minimax-code", PAYLOAD);
    expect(rows).toHaveLength(3);
    const credits = rows.find((r) => r.name === "Credits");
    expect(credits.isCreditBalance).toBe(true);
    expect(credits.summarizesDetail).toBe(true);
    expect(credits.expiringBatch).toEqual({ remaining: 203.82, resetAt: "2026-12-05T16:00:00.000Z" });
    const bucket = rows.find((r) => r.name === "Credits · 12-05");
    expect(bucket.detailOnly).toBe(true);
    expect(bucket.recurring).toBe(false);
    expect(bucket.displayRemaining).toBe(true);
  });

  it("card renders one settled balance + per-pack details (no double counting)", () => {
    const rows = parseQuotaData("minimax-code", PAYLOAD);
    expect(isStoredValueRow(rows[0])).toBe(true);
    // 桶明细在场 → 逐包明细展开有内容
    expect(needsPerPackDetails(rows)).toBe(true);
  });

  it("extractEarliestPackageExpiry reads the earliest bucket, not the balance", () => {
    const info = extractEarliestPackageExpiry(PAYLOAD);
    expect(info?.expiry).toBe("2026-12-05T16:00:00.000Z");
    expect(info?.name).toBe("Credits · 12-05");
    // 储值余额行不供百分比红区（isPerpetual 短路），桶行供
    expect(info?.expiry).toBeTruthy();
  });
});

describe("signedAccountRequest — ledger 路径携带自有 query 时不被 mcode 参数覆盖", () => {
  it("merges page params alongside the mcode client params", () => {
    const { url } = signedAccountRequest(
      { agent: "https://agent.minimaxi.com", lang: "zh" },
      "/minimax-cloud/api/v1/credit/details?page_number=2&page_size=20&include_expired=false",
      { access: "tok", userID: "7" },
    );
    const u = new URL(url);
    expect(u.searchParams.get("page_number")).toBe("2");
    expect(u.searchParams.get("page_size")).toBe("20");
    expect(u.searchParams.get("include_expired")).toBe("false");
    expect(u.searchParams.get("client")).toBe("mcode");
    expect(u.searchParams.get("device_platform")).toBe("mcode");
    expect(u.searchParams.get("user_id")).toBe("7");
  });
});
