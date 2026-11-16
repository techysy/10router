// DeepAI Code provider: registry wiring, live-catalog normalization and
// the providers/deepai.json sync contract. No network — the wire
// protocol itself (Api-Key header + Theos lane header against
// api.deepai.org) was verified live on 2026-11-16 from a signed-in
// desktop account; the comments in open-sse/shared/deepai/constants.js
// carry the attestation notes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import {
  DEEPAI_STATIC_MODEL_SPECS,
  normalizeDeepaiModels,
} from "../../open-sse/services/deepaiModels.js";
import {
  DEEPAI_MODELS_URL,
  DEEPAI_THEOS_URL,
  buildDeepaiHeaders,
} from "../../open-sse/shared/deepai/constants.js";

const ATTESTED_MODEL_IDS = [
  "glm-5.3-flash",
  "deepseek-v4.1-flash",
  "mimo-2.6-flash",
  "qwen-3.8-flash",
  "minimax-m3.1-flash",
  "muse-ember",
  "solar-mini-4",
  "gpt-6-luna",
  "mimo-2.6-pro",
  "glyph-cluster",
  "deepai-cyber",
  "minimax-m3",
  "gpt-6.1-sol",
  "gemini-4-argon",
  "glm-5.3",
  "kimi-k3",
  "kimi-k3.1-pro",
  "gpt-6.1-terra",
  "muse-spark-1.3",
  "gemini-4-hydrogen",
  "gemini-4-carbon",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "muse-wonder",
  "qwen-3.8-max-prime",
  "claude-fable-5-2",
  "gpt-6-astra",
];

describe("DeepAI provider registry", () => {
  const entry = REGISTRY.find((e) => e.id === "deepai");

  it("is registered as an API-key provider on the OpenAI-shaped endpoint", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.authModes).toEqual(["apikey"]);
    expect(entry.hasOAuth).toBeFalsy();
    expect(PROVIDERS["deepai"]).toBeDefined();
    expect(PROVIDERS["deepai"].format).toBe("openai");
    expect(PROVIDERS["deepai"].baseUrl).toBe(
      "https://api.deepai.org/deepai_code/chat/completions",
    );
  });

  it("authenticates with the custom Api-Key header plus the Theos lane header", () => {
    expect(entry.transport.auth).toEqual({
      combined: true,
      header: "api-key",
      scheme: "raw",
    });
    expect(entry.transport.headers["X-DeepAI-Code-Theos"]).toBe("4");
    expect(buildDeepaiHeaders("uuid-key")).toEqual({
      Accept: "application/json",
      "User-Agent": "10router-deepai/1.0",
      "Api-Key": "uuid-key",
      "X-DeepAI-Code-Theos": "4",
    });
    expect(DEEPAI_MODELS_URL).toBe("https://api.deepai.org/deepai_code/models");
    expect(DEEPAI_THEOS_URL).toBe("https://api.deepai.org/deepai_code/theos");
  });

  it("seeds the attested static models, all covered by the spec table", () => {
    const ids = (PROVIDER_MODELS["deepai"] || []).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(ATTESTED_MODEL_IDS));
    expect(ids.length).toBe(ATTESTED_MODEL_IDS.length);
    for (const id of ids) {
      expect(DEEPAI_STATIC_MODEL_SPECS[id], `spec for ${id}`).toBeDefined();
    }
    // Free tier is unmetered; frontier models spend the daily grant.
    expect(DEEPAI_STATIC_MODEL_SPECS["glm-5.3-flash"].theosPerRequest).toBe(0);
    expect(DEEPAI_STATIC_MODEL_SPECS["gpt-6-astra"].theosPerRequest).toBe(50);
  });

  it("keeps providers/deepai.json in sync with the registry model list", () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, "../../providers/deepai.json"), "utf8"),
    );
    expect(catalog.provider).toBe("deepai");
    const jsonIds = catalog.models.map((m) => m.id).sort();
    const registryIds = (entry.models || []).map((m) => m.id).sort();
    expect(jsonIds).toEqual(registryIds);
  });
});

describe("normalizeDeepaiModels", () => {
  it("maps the live { models: [...] } envelope onto resolver rows", () => {
    const models = normalizeDeepaiModels({
      default: "glm-5.3-flash",
      models: [
        {
          id: "glm-5.3-flash",
          name: "GLM 5.3 Flash",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1048576,
          maxTokens: 131072,
          premier: false,
          theosPerRequest: "0",
        },
        {
          id: "solar-mini-4",
          name: "Solar Mini 4",
          reasoning: true,
          input: ["text"],
          contextWindow: 524288,
          maxTokens: 131072,
          premier: false,
          theosPerRequest: "0",
        },
      ],
    });
    expect(models).toEqual([
      {
        id: "glm-5.3-flash",
        name: "GLM 5.3 Flash",
        contextLength: 1048576,
        maxOutputTokens: 131072,
        isVL: true,
        theosPerRequest: 0,
      },
      {
        id: "solar-mini-4",
        name: "Solar Mini 4",
        contextLength: 524288,
        maxOutputTokens: 131072,
        isVL: false,
        theosPerRequest: 0,
      },
    ]);
  });

  it("falls back to the static spec table for rows without fields", () => {
    const models = normalizeDeepaiModels({ models: [{ id: "kimi-k3" }] });
    expect(models[0].name).toBe("Kimi K3");
    expect(models[0].contextLength).toBe(1048576);
    expect(models[0].theosPerRequest).toBe(3);
  });

  it("returns an empty list for unusable bodies", () => {
    expect(normalizeDeepaiModels(null)).toEqual([]);
    expect(normalizeDeepaiModels({})).toEqual([]);
    expect(normalizeDeepaiModels({ models: [{ name: "no id" }] })).toEqual([]);
  });
});

describe("DeepAI free/quota labeling + notice i18n", () => {
  const entry = REGISTRY.find((e) => e.id === "deepai");

  it("labels every registry model with its Theos price (11 free / 16 quota)", () => {
    const models = entry.models || [];
    expect(models.length).toBe(27);
    for (const m of models) {
      expect(typeof m.theosPerRequest, `theos for ${m.id}`).toBe("number");
      expect(m.theosPerRequest).toBe(DEEPAI_STATIC_MODEL_SPECS[m.id].theosPerRequest);
    }
    expect(models.filter((m) => m.theosPerRequest === 0).length).toBe(11);
    expect(models.filter((m) => m.theosPerRequest > 0).length).toBe(16);
  });

  it("renders the free/quota badge on model rows", () => {
    const rowSource = readFileSync(
      resolve(__dirname, "../../src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js"),
      "utf8",
    );
    expect(rowSource).toContain('typeof model.theosPerRequest === "number"');
    expect(rowSource).toContain('translate("Free")');
    expect(rowSource).toContain('translate("Quota")');
  });

  it("ships zh-CN/zh-TW translations for the notice and badge strings", () => {
    const notice = entry.display.notice.text;
    for (const loc of ["zh-CN", "zh-TW"]) {
      const literals = JSON.parse(
        readFileSync(resolve(__dirname, `../../public/i18n/literals/${loc}.json`), "utf8"),
      );
      expect(typeof literals[notice], `${loc} notice`).toBe("string");
      expect(literals[notice].length).toBeGreaterThan(20);
      expect(typeof literals["Quota"], `${loc} Quota`).toBe("string");
      expect(typeof literals["Unmetered, does not spend Theos"]).toBe("string");
    }
    const zhCN = JSON.parse(
      readFileSync(resolve(__dirname, "../../public/i18n/literals/zh-CN.json"), "utf8"),
    );
    expect(zhCN["Quota"]).toBe("配额");
    expect(zhCN["Free"]).toBe("免费");
  });
});
