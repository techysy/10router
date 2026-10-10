/**
 * Per-API-key daily token limit — behavior tests.
 *
 * Runs against a real temp SQLite DB (same DATA_DIR + resetModules pattern as
 * db-sqlite-vs-lowdb.test.js), because the feature is exactly the kind that
 * only fails in the seams: the additive column round-tripping through
 * rowToKey/normalize, the local-midnight cutoff matching the dashboard's
 * "today", the 429 body shape OpenAI SDK clients parse, and the backup path
 * (exportDb/importDb enumerate apiKeys columns explicitly — a missing entry
 * there silently drops limits from every backup).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db; // @/lib/db/index.js
let checkApiKeyDailyLimit; // @/sse/services/auth.js
let hashApiKey;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-daily-limit-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ checkApiKeyDailyLimit } = await import("@/sse/services/auth.js"));
  ({ hashApiKey } = await import("@/lib/db/crypto/apiKeyIdentity.js"));
});

afterAll(() => {
  try {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch { /* OS temp reaper will collect it */ }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// Unique content + usageKey per call: saveRequestUsage dedups keyless rows
// on content, and we want every row counted.
async function recordUsage(key, prompt, completion, { timestamp, model = "m-1", usageKey } = {}) {
  await db.saveRequestUsage({
    apiKey: key || undefined,
    provider: "openai",
    model,
    tokens: { prompt_tokens: prompt, completion_tokens: completion },
    ...(timestamp ? { timestamp } : {}),
    ...(usageKey ? { usageKey } : {}),
  });
}

describe("apiKeys.dailyTokenLimit persistence", () => {
  it("two-arg create stays backward compatible (unlimited)", async () => {
    const k = await db.createApiKey("legacy-compat", "machine-a");
    expect(k.dailyTokenLimit).toBe(null);
    const all = await db.getApiKeys();
    expect(all.find((x) => x.id === k.id).dailyTokenLimit).toBe(null);
  });

  it("three-arg create persists and round-trips through getApiKeyByKey", async () => {
    const k = await db.createApiKey("Hermes", "machine-a", 100_000_000);
    expect(k.dailyTokenLimit).toBe(100_000_000);
    const byKey = await db.getApiKeyByKey(k.key);
    expect(byKey.id).toBe(k.id);
    expect(byKey.name).toBe("Hermes");
    expect(byKey.dailyTokenLimit).toBe(100_000_000);
    expect(await db.getApiKeyByKey("sk-not-a-real-key")).toBe(null);
  });

  it("updateApiKey merges: 0 clears, numbers set, untouched fields survive", async () => {
    const k = await db.createApiKey("upd", "machine-b", 50_000_000);
    expect((await db.getApiKeyById(k.id)).dailyTokenLimit).toBe(50_000_000);

    const cleared = await db.updateApiKey(k.id, { dailyTokenLimit: 0 });
    expect(cleared.dailyTokenLimit).toBe(null);
    expect((await db.getApiKeyById(k.id)).dailyTokenLimit).toBe(null);

    const set = await db.updateApiKey(k.id, { dailyTokenLimit: 25_000_000 });
    expect(set.dailyTokenLimit).toBe(25_000_000);

    // A plain pause toggle must NOT rewrite (or clear) the limit.
    const toggled = await db.updateApiKey(k.id, { isActive: false });
    expect(toggled.isActive).toBe(false);
    expect(toggled.dailyTokenLimit).toBe(25_000_000);
  });

  it("normalizeDailyLimit clamps absurd values and rejects garbage", () => {
    const { normalizeDailyLimit, DAILY_LIMIT_MAX } = db;
    expect(normalizeDailyLimit(0)).toBe(null);
    expect(normalizeDailyLimit(null)).toBe(null);
    expect(normalizeDailyLimit("")).toBe(null);
    expect(normalizeDailyLimit("abc")).toBe(null);
    expect(normalizeDailyLimit(-5)).toBe(null);
    expect(normalizeDailyLimit(1.9)).toBe(1);
    expect(normalizeDailyLimit("2000000")).toBe(2_000_000);
    expect(normalizeDailyLimit(1e15)).toBe(DAILY_LIMIT_MAX);
  });

  it("exportDb → importDb round-trip preserves the limit", async () => {
    const k = await db.createApiKey("backup-me", "machine-c", 123_456_789);
    const payload = await db.exportDb();
    const exported = payload.apiKeys.find((x) => x.id === k.id);
    expect(exported.dailyTokenLimit).toBe(123_456_789);

    const restored = await db.importDb(payload);
    expect(restored.apiKeys.find((x) => x.id === k.id).dailyTokenLimit).toBe(123_456_789);
    expect((await db.getApiKeyByKey(k.key)).dailyTokenLimit).toBe(123_456_789);
  });
});

describe("per-key token aggregation with local-midnight cutoff", () => {
  it("sums today's prompt+completion for one key, ignoring others and older rows", async () => {
    const kA = await db.createApiKey("agg-a", "machine-d");
    const kB = await db.createApiKey("agg-b", "machine-d");
    const noKey = await db.createApiKey("agg-none", "machine-d");
    void noKey;

    await recordUsage(kA.key, 100, 50, { usageKey: "a1" });          // 150 today
    await recordUsage(kA.key, 60, 40, { usageKey: "a2", model: "m-2" }); // 100 today → 250
    await recordUsage(kB.key, 700, 300, { usageKey: "b1" });         // different key
    await recordUsage(undefined, 9999, 9999, { usageKey: "n1" });    // local-no-key row
    const yesterday = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    await recordUsage(kA.key, 5000, 1, { usageKey: "a-old", timestamp: yesterday });

    const cutoff = db.localStartOfDayIso();
    expect(await db.sumApiKeyTokensSince(hashApiKey(kA.key), cutoff)).toBe(250);
    expect(await db.sumApiKeyTokensSince(hashApiKey(kB.key), cutoff)).toBe(1000);
    expect(await db.sumApiKeyTokensSince(null, cutoff)).toBe(0);

    const rows = await db.sumAllApiKeyTokensSince(cutoff);
    const byHash = new Map(rows.map((r) => [r.apiKeyHash, r.tokens]));
    expect(byHash.get(hashApiKey(kA.key))).toBe(250);
    expect(byHash.get(hashApiKey(kB.key))).toBe(1000);
    // NULL-hash rows must not appear at all (GROUP BY excludes them).
    expect(rows.some((r) => r.apiKeyHash == null)).toBe(false);
  });
});

describe("checkApiKeyDailyLimit", () => {
  it("allows requests without a key or with an unlimited key", async () => {
    expect(await checkApiKeyDailyLimit(null)).toBe(null);
    const k = await db.createApiKey("unlimited", "machine-e");
    expect(await checkApiKeyDailyLimit(k.key)).toBe(null);
  });

  it("allows below the cap and refuses at/over it with a 429 OpenAI-shaped body", async () => {
    const k = await db.createApiKey("Hermes", "machine-f", 200);
    await recordUsage(k.key, 100, 50, { usageKey: "q1" }); // 150 < 200

    expect(await checkApiKeyDailyLimit(k.key)).toBe(null);

    await recordUsage(k.key, 30, 30, { usageKey: "q2", model: "m-9" }); // 210 ≥ 200
    const deny = await checkApiKeyDailyLimit(k.key);
    expect(deny).toBeInstanceOf(Response);
    expect(deny.status).toBe(429);

    const body = await deny.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(body.error.message).toContain("Hermes");
    expect(body.error.message).toContain("Resets in");

    const retryAfter = Number(deny.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(86400);
  });

  it("unknown key strings are allowed (fail-open, no throw)", async () => {
    expect(await checkApiKeyDailyLimit("sk-garbage-not-in-db")).toBe(null);
  });

  it("a refusal is recorded in usageHistory with 0 tokens and shows in details", async () => {
    const k = await db.createApiKey("logged", "machine-h", 100);
    await recordUsage(k.key, 60, 50, { usageKey: "l1" }); // 110 ≥ 100

    const before = await db.getUsageHistory({});
    const deny = await checkApiKeyDailyLimit(k.key, {
      request: new Request("http://localhost:20128/v1/chat/completions", { method: "POST" }),
      model: "gpt-test",
    });
    expect(deny?.status).toBe(429);
    const after = await db.getUsageHistory({});

    const row = after[after.length - 1];
    expect(before.length + 1).toBe(after.length);
    expect(row.status).toBe("rate_limited");
    expect(row.model).toBe("gpt-test");
    expect(row.endpoint).toBe("/v1/chat/completions");
    // The refusal must not consume the quota it enforces.
    expect(await db.sumApiKeyTokensSince(hashApiKey(k.key), db.localStartOfDayIso())).toBe(110);

    // requestDetails row: observability is off by default in a fresh DATA_DIR
    // (saveRequestDetail self-gates), so enable it, drop the repo's 5s config
    // cache, and drain the batched write buffer before asserting.
    const rdRepo = await import("@/lib/db/repos/requestDetailsRepo.js");
    await db.updateSettings({ enableObservability: true });
    rdRepo.__test__.invalidateConfigCache();
    const deny2 = await checkApiKeyDailyLimit(k.key, {
      request: new Request("http://localhost:20128/v1/chat/completions", { method: "POST" }),
      model: "gpt-test",
    });
    expect(deny2?.status).toBe(429);
    await rdRepo.__test__.flushToDatabase();
    const details = await db.getRequestDetails({ page: 1, pageSize: 50 });
    const rd = details.details.find((d) => d.status === "rate_limited");
    expect(rd).toBeTruthy();
    expect(rd.model).toBe("gpt-test");
    await db.updateSettings({ enableObservability: false });
    rdRepo.__test__.invalidateConfigCache();
  });

  it("master switch dailyTokenLimitEnabled=false stops enforcement without clearing limits", async () => {
    const k = await db.createApiKey("switched", "machine-i", 10);
    await recordUsage(k.key, 9, 9, { usageKey: "s1" }); // 18 ≥ 10 — over cap
    expect((await checkApiKeyDailyLimit(k.key))?.status).toBe(429);

    await db.updateSettings({ dailyTokenLimitEnabled: false });
    expect(await checkApiKeyDailyLimit(k.key)).toBe(null);

    // Flipping back on restores the cap exactly — the value was never touched.
    await db.updateSettings({ dailyTokenLimitEnabled: true });
    expect((await checkApiKeyDailyLimit(k.key))?.status).toBe(429);
    expect((await db.getApiKeyByKey(k.key)).dailyTokenLimit).toBe(10);
  });

  it("the 429 message localizes from the locale cookie / Accept-Language", async () => {
    const k = await db.createApiKey("本地化", "machine-j", 5);
    await recordUsage(k.key, 3, 3, { usageKey: "i1" }); // 6 ≥ 5

    const zhCookie = new Request("http://localhost/v1/chat/completions", {
      headers: { cookie: "locale=zh-CN; other=1" },
    });
    const denyZh = await checkApiKeyDailyLimit(k.key, { request: zhCookie, model: "m" });
    const msgZh = (await denyZh.json()).error.message;
    expect(msgZh).toContain("今日 Token 限额已用完");
    expect(msgZh).toContain("本地化"); // key name stays verbatim (user-typed)
    expect(msgZh).not.toContain("Daily token limit exceeded");

    const zhHeader = new Request("http://localhost/v1/chat/completions", {
      headers: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
    });
    const denyHdr = await checkApiKeyDailyLimit(k.key, { request: zhHeader, model: "m" });
    expect((await denyHdr.json()).error.message).toContain("将在");

    // No locale signal at all → English fallback (what an SDK caller sees).
    const plain = new Request("http://localhost/v1/chat/completions");
    const denyEn = await checkApiKeyDailyLimit(k.key, { request: plain, model: "m" });
    const msgEn = (await denyEn.json()).error.message;
    expect(msgEn).toContain("Daily token limit exceeded");
    expect(msgEn).toContain("Resets in");
  });

  it("validateApiKey contract untouched: still returns booleans", async () => {
    const k = await db.createApiKey("contract", "machine-g");
    expect(await db.validateApiKey(k.key)).toBe(true);
    expect(await db.validateApiKey("sk-nope")).toBe(false);
  });
});
