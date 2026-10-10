/**
 * Per-API-key daily token limit — wiring guards.
 *
 * The behavior lives in api-key-daily-limit.test.js; this file pins the seams
 * that cannot be exercised without a running server: every /v1 handler must
 * call the shared helper (a handler added later that forgets it is invisible
 * in the browser), the backup path must enumerate the new column, and the
 * admin routes must actually accept the field the UI sends.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel) => readFileSync(abs(rel), "utf8");

const HANDLERS = [
  "chat", "embeddings", "fetch", "imageGeneration", "search",
  "stt", "systemone", "tts", "videoGeneration",
].map((f) => `src/sse/handlers/${f}.js`);

describe("handler enforcement wiring", () => {
  it("every /v1 handler calls the shared daily-limit helper", () => {
    for (const rel of HANDLERS) {
      const src = read(rel);
      expect(src, `${rel} must import the helper`).toMatch(/checkApiKeyDailyLimit[,\n][\s\S]*from "\.\.\/services\/auth\.js"/);
      // The { request, model } context is what lets the refusal be localized
      // and logged — a bare call would silently regress both. videoGeneration
      // legitimately omits model (its body is read after auth).
      expect(src, `${rel} must enforce it with request context`).toMatch(
        /const limitResponse = await checkApiKeyDailyLimit\(apiKey, \{ request(?:, model: \w+)? \}\);/
      );
      expect(src, `${rel} must return the deny`).toContain("if (limitResponse) return limitResponse;");
    }
  });

  it("stt/tts hoist apiKey above the requireApiKey block (meters keyed traffic even when requireApiKey is off)", () => {
    for (const rel of ["src/sse/handlers/stt.js", "src/sse/handlers/tts.js"]) {
      const src = read(rel);
      const hoist = src.indexOf("const apiKey = extractApiKey(request);");
      const gate = src.indexOf("if (settings.requireApiKey) {");
      const limit = src.indexOf("const limitResponse = await checkApiKeyDailyLimit(apiKey, { request");
      expect(hoist).toBeGreaterThan(-1);
      expect(hoist).toBeLessThan(gate);
      expect(gate).toBeLessThan(limit);
    }
  });

  it("videoGeneration funnels both endpoints through one gate", () => {
    const src = read("src/sse/handlers/videoGeneration.js");
    // The single edit lives inside requireValidApiKey; the two handlers keep
    // consuming its return value as before.
    const gate = src.slice(src.indexOf("async function requireValidApiKey"), src.indexOf("/**", src.indexOf("async function requireValidApiKey")));
    expect(gate).toContain("const limitResponse = await checkApiKeyDailyLimit(apiKey, { request });");
    expect((src.match(/const authError = await requireValidApiKey\(request\);/g) || []).length).toBe(2);
  });

  it("auth.js exports the helper, fails open, logs refusals, localizes them, and honors the master switch", () => {
    const src = read("src/sse/services/auth.js");
    expect(src).toContain("export async function checkApiKeyDailyLimit(apiKey, { request, model } = {})");
    // Fail-open: DB errors must never become a 429/500.
    expect(src).toMatch(/catch \(e\) \{\s*log\.warn\("AUTH", `Daily token limit check failed \(allowing request\)/);
    // Refusals must reach usageHistory (status rate_limited, 0 tokens — a
    // refusal may not consume the quota it enforces) AND requestDetails.
    expect(src).toContain('status: "rate_limited"');
    expect(src).toContain("prompt_tokens: 0, completion_tokens: 0");
    expect(src).toContain("saveRequestUsage");
    expect(src).toContain("saveRequestDetail");
    // Server-side localization: the client runtime never sees an API error body.
    expect(src).toContain('serverTranslate(locale, \'Daily token limit exceeded for API key "{name}"');
    expect(src).toContain("resolveRequestLocale(request)");
    // Master switch read before any enforcement.
    expect(src).toContain("settings?.dailyTokenLimitEnabled === false");
    // validateApiKey must keep its boolean contract (dashboardGuard depends on it).
    expect(src).toMatch(/export async function isValidApiKey\(apiKey\) \{\s*if \(!apiKey\) return false;\s*return await validateApiKey\(apiKey\);/);
  });

  it("settings default carries the master switch on", () => {
    expect(read("src/lib/db/repos/settingsRepo.js")).toContain("dailyTokenLimitEnabled: true,");
  });

  it("the edit-limit button is always visible (no hover-reveal on the new control)", () => {
    const src = read("src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js");
    const at = src.indexOf('title={translate("Edit Daily Token Limit")}');
    // className sits BEFORE the title attribute in the JSX, so look backwards.
    const btn = src.slice(Math.max(0, at - 260), at);
    expect(btn).toContain("className=");
    expect(btn).not.toContain("sm:opacity-0");
    // Master switch rendered next to the requireApiKey toggle section.
    expect(src).toContain('translate("Daily token limits")');
    expect(src).toContain("handleDailyLimitEnabled");
    // App-generated key names go through the dictionary so a Chinese UI does
    // not mix "Default Key (rotated)" into localized rows.
    expect(src).toContain("function translateKeyName(name)");
    expect(src).toContain("{translateKeyName(key.name)}");
  });

  it("dashboardGuard/proxy never learned about the quota (stays off the hot path)", () => {
    for (const rel of ["src/dashboardGuard.js", "src/proxy.js"]) {
      expect(read(rel)).not.toContain("checkApiKeyDailyLimit");
    }
  });
});

describe("schema & backup-path plumbing", () => {
  it("schema declares the additive column and bumps the version", () => {
    const src = read("src/lib/db/schema.js");
    expect(src).toContain('export const SCHEMA_VERSION = 2;');
    expect(src).toMatch(/isActive: "INTEGER DEFAULT 1",[\s\S]*?dailyTokenLimit: "INTEGER",[\s\S]*?createdAt: "TEXT NOT NULL",\s*}\,\s*indexes: \["CREATE INDEX IF NOT EXISTS idx_ak_key/);
  });

  it("exportDb/importDb enumerate the column (explicit lists — silent drops otherwise)", () => {
    const src = read("src/lib/db/index.js");
    expect(src).toMatch(/SELECT \* FROM apiKeys`\)\.map\(\(r\) => \(\{[\s\S]*?dailyTokenLimit: r\.dailyTokenLimit \?\? null[\s\S]*?\}\)\)/);
    expect(src).toContain("INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, dailyTokenLimit, createdAt)");
    // Export surface: enforcement + admin routes reach everything through it.
    expect(src).toContain("getApiKeys, getApiKeyById, getApiKeyByKey, createApiKey,");
    expect(src).toContain("localStartOfDayIso, sumApiKeyTokensSince, sumAllApiKeyTokensSince,");
  });

  it("localDb shim mirrors the new names", () => {
    const src = read("src/lib/localDb.js");
    expect(src).toContain("getApiKeyByKey");
    expect(src).toContain("localStartOfDayIso, sumApiKeyTokensSince, sumAllApiKeyTokensSince");
    expect(src).toContain("normalizeDailyLimit, DAILY_LIMIT_MAX");
  });

  it("rotate carries the limit across re-issue", () => {
    expect(read("src/app/api/keys/rotate/route.js"))
      .toContain("createApiKey(`${baseName} (rotated)`, machineId, key.dailyTokenLimit)");
  });
});

describe("admin API contract", () => {
  it("POST /api/keys accepts and echoes dailyTokenLimit", () => {
    const src = read("src/app/api/keys/route.js");
    expect(src).toContain("const { name, dailyTokenLimit } = body;");
    expect(src).toContain("createApiKey(name, machineId, parsed.value)");
    expect(src).toContain("dailyTokenLimit: apiKey.dailyTokenLimit,");
    // GET attaches today-usage only for limited keys.
    expect(src).toContain("sumAllApiKeyTokensSince(localStartOfDayIso())");
    expect(src).toMatch(/k\.dailyTokenLimit\s*\?\s*\{ \.\.\.k, todayTokens:/);
  });

  it("PUT /api/keys/[id] only rewrites the limit when the field was sent", () => {
    const src = read("src/app/api/keys/[id]/route.js");
    expect(src).toContain("const { isActive, dailyTokenLimit } = body;");
    expect(src).toContain("if (dailyTokenLimit !== undefined) {");
    expect(src).toContain("updateData.dailyTokenLimit = parsed.value;");
  });
});

describe("i18n dictionaries", () => {
  const NEW_KEYS = [
    "Daily Token Limit",
    "Edit Daily Token Limit",
    "e.g. 100000000 — empty means unlimited",
    "Leave empty to remove the limit.",
    "Limit reached",
    // Master switch + server-side 429 template + rotated-suffix label. The
    // 429 template is looked up by auth.js verbatim — a dict edit that breaks
    // the exact string silently reverts zh users to English.
    "Daily token limits",
    "Master switch for the per-key daily token caps. Turning this off stops enforcement but keeps every key's configured limit.",
    "Daily token limit exceeded for API key \"{name}\" (used {used} / {limit} today). Resets in {reset}.",
    "(rotated)",
  ];

  it("zh-CN and zh-TW carry every new literal", () => {
    for (const lang of ["zh-CN", "zh-TW"]) {
      const dict = JSON.parse(read(`public/i18n/literals/${lang}.json`));
      for (const key of NEW_KEYS) {
        expect(dict[key], `${lang} missing "${key}"`).toBeTruthy();
      }
      // Reused existing keys — must stay present (the UI row depends on them).
      expect(dict["Today"]).toBeTruthy();
      expect(dict["tokens"]).toBeTruthy();
      expect(dict["Save"]).toBeTruthy();
    }
  });
});
