import { describe, expect, it } from "vitest";
import { bucketByExpiry, expiryKey, isAuthFailure, MAX_BUCKETS } from "../../open-sse/services/usage/lingxi.js";

// 官方智点详情口径（2026-11-15 截图）：逐包「任务奖励 / 生效 / 到期 / 已用-总量」，
// 一天一包 30 天有效。桶 = 同日到期并格，先到期先显示。
const pack = (over = {}) => ({
  balance: 100,
  value: 100,
  consumed: 0,
  expire_time: "2026-12-16T00:28:00+08:00",
  sku_key: "ai_credits_grant",
  ...over,
});

describe("lingxi expiryKey", () => {
  it("extracts the date part from the ISO expire_time", () => {
    expect(expiryKey(pack())).toBe("2026-12-16");
    expect(expiryKey(pack({ expire_time: null }))).toBe("");
    expect(expiryKey({})).toBe("");
  });
});

describe("lingxi bucketByExpiry", () => {
  it("merges same-day packs into one bucket with summed fields", () => {
    const rows = bucketByExpiry([
      pack({ expire_time: "2026-12-16T00:28:00+08:00" }),
      pack({ expire_time: "2026-12-16T09:00:00+08:00", balance: 200, value: 200, consumed: 30 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].balance).toBe(300);
    expect(rows[0].total).toBe(300);
    expect(rows[0].consumed).toBe(30);
    expect(rows[0].packs).toBe(2);
    // resetAt = bucket 内最早到期时刻
    expect(rows[0].expireAt).toBe("2026-12-16T00:28:00+08:00");
  });

  it("sorts buckets by expiry ascending (FIFO 消耗语义：先到期先显示)", () => {
    const rows = bucketByExpiry([
      pack({ expire_time: "2026-12-20T00:00:00+08:00" }),
      pack({ expire_time: "2026-12-10T00:00:00+08:00" }),
      pack({ expire_time: "2026-12-15T00:00:00+08:00" }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["2026-12-10", "2026-12-15", "2026-12-20"]);
  });

  it("puts no-expiry packs last with no resetAt", () => {
    const rows = bucketByExpiry([
      pack({ expire_time: null }),
      pack({ expire_time: "2026-12-10T00:00:00+08:00" }),
    ]);
    expect(rows[0].key).toBe("2026-12-10");
    expect(rows[1].key).toBe("");
    expect(rows[1].expireAt).toBeNull();
  });

  it("merges overflow beyond the cap into a 更远到期 tail", () => {
    const packs = [];
    for (let d = 1; d <= MAX_BUCKETS + 5; d++) {
      packs.push(pack({ expire_time: `2026-12-${String(d).padStart(2, "0")}T00:00:00+08:00` }));
    }
    const rows = bucketByExpiry(packs);
    expect(rows.length).toBe(MAX_BUCKETS + 1); // 19 桶 + 1 尾桶
    expect(rows[rows.length - 1].key).toBe("__overflow__");
    expect(rows[rows.length - 1].packs).toBe(5);
    expect(rows[rows.length - 1].balance).toBe(500);
    // 尾桶 resetAt = 最远到期日
    expect(rows[rows.length - 1].expireAt).toBe("2026-12-24T00:00:00+08:00");
  });

  it("marks a bucket non-grant when any purchased pack mixes in", () => {
    const rows = bucketByExpiry([
      pack({ sku_key: "ai_credits_grant" }),
      pack({ sku_key: "ai_credits_purchased" }),
    ]);
    expect(rows[0].grant).toBe(false);
    const pure = bucketByExpiry([pack()]);
    expect(pure[0].grant).toBe(true);
  });

  it("handles negative/garbage numbers without NaN", () => {
    const rows = bucketByExpiry([pack({ balance: -5, value: "abc", consumed: null })]);
    expect(rows[0].balance).toBe(0);
    expect(rows[0].total).toBe(0);
    expect(rows[0].consumed).toBe(0);
  });
});

describe("lingxi usage auth failure shape", () => {
  it("flags 401/403 and the gateway JSON auth payload", () => {
    expect(isAuthFailure({ status: 401, text: "" })).toBe(true);
    expect(isAuthFailure({ status: 403, text: "" })).toBe(true);
    expect(
      isAuthFailure({
        status: 200,
        text: '{"hint":"用户无权限","result":"UserUnauthorized","v7code":401020001}',
      }),
    ).toBe(true);
    expect(isAuthFailure({ status: 200, text: '{"result":"ok","data":{}}' })).toBe(false);
    expect(isAuthFailure({ status: 200, text: "not-json" })).toBe(false);
  });
});
