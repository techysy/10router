// Model-family distribution chart: model ids normalize to gateway-agnostic
// families (provider prefix stripped, NO version segment), and getChartData
// buckets carry byModel token series with the tail folded into "other".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let usageRepo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-model-family-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  usageRepo = await import("@/lib/db/repos/usageRepo.js");
});

afterAll(() => {
  if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("modelFamilyName normalization", () => {
  it("maps acceptance examples to families", () => {
    const { modelFamilyName } = usageRepo;
    expect(modelFamilyName("openai/gpt-4")).toBe("gpt");
    expect(modelFamilyName("OpenAI/GPT-4")).toBe("gpt");
    expect(modelFamilyName("Xiaomi/MiMo-V2.5")).toBe("mimo");
    expect(modelFamilyName("mimo-x-flash-preview")).toBe("mimo");
    expect(modelFamilyName("bai/glm-5.3-flash")).toBe("glm");
    expect(modelFamilyName("claude-opus-4-6-thinking")).toBe("claude");
    // Alphabetic qualifiers collapse to the product family — one category.
    expect(modelFamilyName("gemini-pro")).toBe("gemini");
    expect(modelFamilyName("nemotron-3.5-lightning-free")).toBe("nemotron");
    expect(modelFamilyName("deepseek-v4.1-flash")).toBe("deepseek");
    expect(modelFamilyName("Molotov-1206/mimo-x-flash-preview")).toBe("mimo");
    // Qoder opaque codenames map to real product families
    expect(modelFamilyName("qfmodel")).toBe("qwen");
    expect(modelFamilyName("qdc/qfmodel")).toBe("qwen");
    expect(modelFamilyName("qd/qmodel_38max")).toBe("qwen");
    expect(modelFamilyName("qmodel_latest")).toBe("qwen");
    expect(modelFamilyName("dfmodel")).toBe("deepseek");
    expect(modelFamilyName("kmodel")).toBe("kimi");
    expect(modelFamilyName("gfmodel")).toBe("glm");
    expect(modelFamilyName("mmodel")).toBe("minimax");
    // 2026-11-11 live-traffic gaps: lmodel (QoDuck) is Qoder's Qwen-family test
    // model, q37fmodel is Qwen3.7-Flash, jmodel is Step-5-Preview. Without these
    // each leaked out as its own chart legend entry (lmodel was visible at 37.8M
    // tokens in the daily chart — bigger than most real families).
    expect(modelFamilyName("lmodel")).toBe("qwen");
    expect(modelFamilyName("qoder-cn/lmodel")).toBe("qwen");
    expect(modelFamilyName("q37fmodel")).toBe("qwen");
    expect(modelFamilyName("jmodel")).toBe("step");
    expect(modelFamilyName("ultimate")).toBe("claude");
    expect(modelFamilyName("qwq-32b-preview")).toBe("qwen");
    // Custom-channel UUID-ish ids collapse into "other".
    expect(modelFamilyName("85d2a64e-c610-4b3b-8c12-b857b6367207:323e6d8d")).toBe("other");
  });

  it("never splits one product line across integer and decimal majors", () => {
    // Regression: the old "keep a pure-integer version segment" rule kept
    // `gpt-6-astra` as gpt-6 but folded `gpt-5.6-sol` into gpt, so the legend
    // showed `gpt` AND `gpt-6` side by side (same split for gemini/claude).
    const { modelFamilyName } = usageRepo;
    expect(modelFamilyName("gpt-6-astra")).toBe("gpt");
    expect(modelFamilyName("gpt-5.6-sol")).toBe("gpt");
    expect(modelFamilyName("gpt-5.5")).toBe("gpt");
    expect(modelFamilyName("gpt-4")).toBe("gpt");
    expect(modelFamilyName("gpt-5")).toBe("gpt");
    expect(modelFamilyName("gemini-3-flash")).toBe("gemini");
    expect(modelFamilyName("gemini-3.5-flash")).toBe("gemini");
    expect(modelFamilyName("claude-3-sonnet")).toBe("claude");
    expect(modelFamilyName("claude-3.5-sonnet")).toBe("claude");
  });

  it("folds one brand's product-line prefixes into a single family", () => {
    // StepFun ships `step-*` (LLM/vision/image) and `stepaudio-*` (TTS/ASR).
    // Same brand — the Model Type chart must show ONE "step" bar, not "step" +
    // "stepaudio" side by side. Provider prefix is stripped before matching.
    const { modelFamilyName } = usageRepo;
    expect(modelFamilyName("step-5-preview")).toBe("step");
    expect(modelFamilyName("step-router-v1")).toBe("step");
    expect(modelFamilyName("step-image-edit-2")).toBe("step");
    expect(modelFamilyName("stepaudio-3-tts")).toBe("step");
    expect(modelFamilyName("stepaudio-2.5-asr")).toBe("step");
    expect(modelFamilyName("stepp-cn/stepaudio-2.5-tts")).toBe("step");
  });
});

describe("getChartData byModel series", () => {
  it("aggregates same-family models into one series and folds tail into other", async () => {
    const todayIso = new Date().toISOString();
    for (const [model, tokens] of [
      ["mimo-x-flash-preview", 100],
      ["mimo-v2.5", 50],          // same family → merged
      ["glm-5.3-flash", 30],
      ["deepseek-v4-flash", 20],
      ["nemotron-3.5-lightning-free", 10],
      ["qwen3.8-flash", 10],
      ["longcat-2.0-free", 10],
      ["kimi-k2.5", 10],          // tied tail families → one folds into other (top-7 cap)
      ["big-pickle", 10],
    ]) {
      await usageRepo.saveRequestUsage({
        timestamp: todayIso, provider: "acmefam", model, status: "ok",
        tokens: { prompt_tokens: 0, completion_tokens: tokens },
      });
    }

    const data = await usageRepo.getChartData("today");
    const byModel = data.reduce((acc, b) => {
      for (const [f, t] of Object.entries(b.byModel || {})) acc[f] = (acc[f] || 0) + t;
      return acc;
    }, {});
    expect(byModel.mimo).toBe(150);
    expect(byModel.glm).toBe(30);
    expect(byModel["gpt-4"]).toBeUndefined();
    // Eight families compete for top-7; among the five tied at 10 tokens
    // exactly one folds into "other" (which one is tie-order dependent).
    expect(byModel.other).toBe(10);
    const total = Object.values(byModel).reduce((a, b) => a + b, 0);
    expect(total).toBe(250); // nothing lost in the fold
  });
});
