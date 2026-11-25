/**
 * Codex 域 registry 清理 + 裸 slug 路由（上游 v0.5.95, 8f9ff44f 的重实现）。
 *
 * Registry（#4202 对应问题）：
 * - gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex-spark / gpt-5.4-image 是幽灵模型——
 *   不在 backend-api/codex/models 里，后端一律 400 "model is not supported"。
 * - gpt-daybreak-blue-latest / gpt-reserve 已由 codex 模型目录确认在线。
 *
 * 路由（#4405 对应问题）：
 * - Codex CLI 会发裸 model id（/model 选择器，如 gpt-5.6-terra）。这些 slug 只在
 *   codex 后端存在，若按前缀推断到 openai，只有 Codex OAuth 账号的用户会吃到 404。
 * - 规则只覆盖 Codex CLI 真实会发的 gpt-* slug（gpt-5.x / gpt-6.x / daybreak /
 *   reserve），普通 gpt-4o / gpt-3.5 等仍归 openai；未知裸名在 chat 主路径依旧
 *   返回 provider: null（#34 的 400 行为不变）。
 */

import { describe, it, expect, vi } from "vitest";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { getModelInfoCore, isCodexBareSlug } from "../../open-sse/services/model.js";
import { PROVIDER_OAUTH } from "../../open-sse/providers/index.js";

// ── Registry：幽灵模型清理 ───────────────────────────────────────────────────

const GHOST_IDS = [
  "gpt-5.4",
  "gpt-5.4-review",
  "gpt-5.4-mini",
  "gpt-5.4-mini-review",
  "gpt-5.3-codex-spark",
  "gpt-5.3-codex-spark-review",
  "gpt-5.4-image",
  // gpt-5.5 系随 ChatGPT 登录下线（2026-10-14, 上游 7878f53b）——后端一律 400
  "gpt-5.5",
  "gpt-5.5-review",
  "gpt-5.5-image",
];

const codexIds = () => getModelsByProviderId("codex").map((m) => m.id);

describe("codex registry — ghost models removed (backend returns 400 for all of them)", () => {
  it.each(GHOST_IDS)("%s is gone from the codex model list", (id) => {
    expect(codexIds()).not.toContain(id);
  });
});

describe("codex registry — new models added", () => {
  it.each(["gpt-daybreak-blue-latest", "gpt-reserve"])("%s is present", (id) => {
    expect(codexIds()).toContain(id);
  });
});

describe("codex registry — still-live models kept (regression guard)", () => {
  it.each([
    "gpt-6-astra",
    "gpt-5.6-terra",
    "gpt-5.6-terra-review",
    "gpt-5.6-sol",
    "gpt-6-sol",
    "gpt-6.1-sol",
  ])("%s still present", (id) => {
    expect(codexIds()).toContain(id);
  });
});

describe("codex registry — CLI identity version (upstream ca6e8407)", () => {
  it("advertises codex_cli_rs 0.169.0 (pre-0.155 versions are rate-limit-rejected upstream; 0.169.0 rides the GPT-6.2 line)", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    expect(PROVIDERS.codex.cliVersion).toBe("0.169.0");
    expect(PROVIDERS.codex.headers["User-Agent"]).toBe("codex_cli_rs/0.169.0");
  });
});

describe("codex registry — refresh hardening (upstream 0bc7f86e)", () => {
  it("refreshLeadMs is the 10-minute window, not the 5-day one", () => {
    // 访问令牌寿命约 1h；5 天 lead 会让每次调用都轮换 refresh token，
    // 复用被轮换的旧 token 会吊销整个 session。
    expect(PROVIDER_OAUTH["codex"]?.refreshLeadMs).toBe(600000);
  });
});

// ── isCodexBareSlug 形状 ─────────────────────────────────────────────────────

describe("isCodexBareSlug", () => {
  // 上游语义：gpt-5.x / gpt-6.x 全段归 codex（含 gpt-5.1/gpt-5.1-codex 这类 OpenAI API
  // 也有的 id——裸名本来就只从 Codex CLI 的现实使用中来；带 provider 前缀的请求不受影响）
  it.each([
    "gpt-5.5",
    "gpt-5.1",
    "gpt-5.1-codex-max",
    "gpt-5.6-terra",
    "gpt-5.6-luna-review",
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-daybreak-blue-latest",
    "gpt-reserve",
  ])("%s → true (codex 专属 slug)", (slug) => {
    expect(isCodexBareSlug(slug)).toBe(true);
  });

  it.each([
    "gpt-4o",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
    "gpt-5",
    "gpt-5-codex",
    "claude-opus-4-7",
    null,
    "",
  ])("%s → false (openai/其他模型不受影响)", (slug) => {
    expect(isCodexBareSlug(slug)).toBe(false);
  });
});

// ── getModelInfoCore：推断兜底里的 codex 归属 ────────────────────────────────

describe("getModelInfoCore — bare codex slugs route to codex, not openai", () => {
  it.each([
    ["gpt-5.6-terra", "codex"],
    ["gpt-5.6-sol", "codex"],
    ["gpt-5.5", "codex"],
    ["gpt-5.1", "codex"],
    ["gpt-6-astra", "codex"],
    ["gpt-daybreak-blue-latest", "codex"],
    ["gpt-reserve", "codex"],
    ["gpt-4o", "openai"],
    ["gpt-4-turbo", "openai"],
    ["gpt-3.5-turbo", "openai"],
    ["gpt-5", "openai"],
    ["claude-opus-4-7", "anthropic"],
  ])("%s → %s", async (slug, provider) => {
    const info = await getModelInfoCore(slug, {});
    expect(info).toEqual({ provider, model: slug });
  });
});

// ── src 侧 getModelInfo：chat 主路径（inferFallback: false）─────────────────

vi.mock("@/lib/localDb", () => ({
  getModelAliases: vi.fn(async () => ({ "my-alias": "cc/claude-sonnet-5" })),
  getComboByName: vi.fn(async (name) => (name === "my-combo" ? { models: ["cc/claude-sonnet-5"] } : null)),
  getProviderNodes: vi.fn(async () => []),
}));

const { getModelInfo } = await import("../../src/sse/services/model.js");

describe("getModelInfo — chat path adopts codex bare slugs before the #34 400", () => {
  it.each(["gpt-5.5", "gpt-5.6-terra", "gpt-6-astra", "gpt-daybreak-blue-latest", "gpt-reserve"])(
    "%s resolves to codex even with inferFallback off",
    async (slug) => {
      const info = await getModelInfo(slug, { inferFallback: false });
      expect(info).toEqual({ provider: "codex", model: slug });
    }
  );

  it("unknown bare names still resolve to provider null (#34 intact)", async () => {
    const info = await getModelInfo("totally-made-up-xyz", { inferFallback: false });
    expect(info).toEqual({ provider: null, model: "totally-made-up-xyz" });
  });

  it("non-codex gpt bare names still resolve to provider null on the chat path", async () => {
    // gpt-4o 不是 codex 专属 slug，chat 主路径不因本改动放开裸名推断
    const info = await getModelInfo("gpt-4o", { inferFallback: false });
    expect(info).toEqual({ provider: null, model: "gpt-4o" });
  });

  it("combo names keep precedence over the codex slug rule", async () => {
    const info = await getModelInfo("my-combo", { inferFallback: false });
    expect(info).toEqual({ provider: null, model: "my-combo" });
  });

  it("user aliases keep precedence over the codex slug rule", async () => {
    const info = await getModelInfo("my-alias", { inferFallback: false });
    expect(info).toEqual({ provider: "claude", model: "claude-sonnet-5" });
  });
});
