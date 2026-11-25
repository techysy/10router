/**
 * Qoder CN catalog fingerprint gates (2026-11-25).
 *
 * Qoder CN's /model/list decides WHICH rows it publishes from two parts of the
 * caller's fingerprint:
 *   - `Cosy-Version`: at 1.0.0 the CN catalog returns 13 keys, at ≥1.2.0 it also
 *     publishes `fast` (快速, 0.6x).
 *   - `Cosy-Clienttype`: at ct=5 (CLI) it returns 14 keys, at ct=10 (desktop
 *     IDE) it adds `hmodel` (HungerG, free tier).
 * `fast` has had a registry row since 5058bcf7c, and model_config is taken only
 * from the live catalog (the executor does not fall back to QODER_MODEL_MAP), so
 * with the old read both 快速 and HungerG died at chat time.
 *
 * Both raises apply to the CATALOG read only. These tests pin that split: CN
 * reads at QODER_CN_CATALOG_VERSION / QODER_CN_CATALOG_CLIENT_TYPE, intl keeps
 * QODER_IDE_VERSION / QODER_CLIENT_TYPE, and the chat signature is untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.hoisted(() => ({ calls: [] }));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, options = {}) => {
    fetchMock.calls.push({ url, headers: options.headers || {} });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        chat: [
          { key: "auto", display_name: "Auto", price_factor: 0.3, enable: true },
          { key: "fast", display_name: "Fast", price_factor: 0.6, enable: true },
          { key: "gmodel_latest", display_name: "GLM-5.4", price_factor: 0.8, enable: true, is_vl: true, tags: ["new"] },
        ],
        // hmodel is NOT in the chat scene upstream — it reaches the merged
        // catalog through the app-only path (assistant/app scenes).
        app: [
          { key: "auto", display_name: "Auto", price_factor: 0.3, enable: true },
          { key: "hmodel", display_name: "HungerG", price_factor: 0, enable: true, is_vl: true, is_reasoning: true, max_input_tokens: 1000000, tags: ["free"], is_free: true, format: "openai" },
        ],
      }),
    };
  },
}));

const {
  resolveQoderModels,
  clearQoderCatalog,
} = await import("../../open-sse/services/qoderModels.js");
const {
  QODER_IDE_VERSION,
  QODER_CLIENT_TYPE,
  QODER_CN_CATALOG_VERSION,
  QODER_CN_CATALOG_CLIENT_TYPE,
  QODER_CN_MODEL_LIST_URL,
  QODER_MODEL_LIST_URL,
} = await import("../../open-sse/shared/qoder/constants.js");
const { default: REGISTRY_ALL } = await import("../../open-sse/providers/registry/index.js");
const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");

const rowsOf = (id) => REGISTRY_ALL.find((p) => p.id === id).models;

let seq = 0;
function conn(provider) {
  // A fresh userId per call: the catalog cache is keyed by credential and
  // lives for the whole module, so a reused id would answer from cache and
  // record no fetch at all.
  seq += 1;
  return {
    provider,
    accessToken: "dt-test-token",
    providerSpecificData: { userId: `test-user-${seq}`, machineId: "test-machine" },
  };
}

beforeEach(() => {
  clearQoderCatalog();
  fetchMock.calls.length = 0;
});

describe("qoder catalog fingerprint (version + client type)", () => {
  it("reads the CN catalog at the version that publishes fast, not 1.0.0", async () => {
    await resolveQoderModels(conn("qoder-cn"));
    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0].url).toBe(QODER_CN_MODEL_LIST_URL);
    expect(fetchMock.calls[0].headers["Cosy-Version"]).toBe(QODER_CN_CATALOG_VERSION);
    expect(QODER_CN_CATALOG_VERSION).not.toBe(QODER_IDE_VERSION);
  });

  it("reads the CN catalog with the desktop client type — hmodel lives there", async () => {
    await resolveQoderModels(conn("qoder-cn"));
    expect(fetchMock.calls[0].headers["Cosy-Clienttype"]).toBe(QODER_CN_CATALOG_CLIENT_TYPE);
    // ct=5's CN catalog has 14 keys and no hmodel; ct=10 adds exactly that one.
    expect(QODER_CN_CATALOG_CLIENT_TYPE).not.toBe(QODER_CLIENT_TYPE);
  });

  it("leaves the intl catalog read at the shipped IDE version and client type", async () => {
    await resolveQoderModels(conn("qoder"));
    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0].url).toBe(QODER_MODEL_LIST_URL);
    expect(fetchMock.calls[0].headers["Cosy-Version"]).toBe(QODER_IDE_VERSION);
    // The intl catalog at ct=10 would also publish smodel/cmodel, which have
    // no registry rows — the read must stay on the CLI fingerprint.
    expect(fetchMock.calls[0].headers["Cosy-Clienttype"]).toBe(QODER_CLIENT_TYPE);
  });

  it("the raised read still yields usable model_config for the gated keys", async () => {
    const cached = await resolveQoderModels(conn("qoder-cn"));
    expect(cached.rawConfigs.get("fast")).toMatchObject({ display_name: "Fast", price_factor: 0.6 });
    expect(cached.rawConfigs.get("hmodel")).toMatchObject({ display_name: "HungerG", price_factor: 0 });
    expect(cached.models.map((m) => m.id)).toContain("gmodel_latest");
  });
});

describe("qoder-cn HungerG (hmodel)", () => {
  it("is registered CN-only at the probed free tier", () => {
    const row = rowsOf("qoder-cn").find((m) => m.id === "hmodel");
    expect(row, "qoder-cn missing hmodel").toBeDefined();
    expect(row.name).toBe("HungerG");
    expect(row.rateMultiplier, "price_factor 0 → free").toBe(0);
    // The intl catalog publishes no hmodel key at either client type.
    expect(rowsOf("qoder").some((m) => m.id === "hmodel")).toBe(false);
  });

  it("reads as a free badge with vision + reasoning, not the 200K floor", () => {
    const caps = getCapabilitiesForModel("qoder-cn", "hmodel");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
    // Base model unknown: the row takes the entry's own declared format rather
    // than guessing a family, and clamps maxOutput conservatively (small over
    // large) until upstream publishes a real ceiling.
    expect(caps.thinkingFormat).toBe("openai");
    expect(caps.maxOutput).toBe(65536);
    expect(getCapabilitiesForModel("qoder-cn", "HungerG")).toEqual(caps);
  });
});

describe("qoder-cn HungerG (hmodel)", () => {
  it("is registered on CN only, free, and named as upstream publishes it", () => {
    const row = rowsOf("qoder-cn").find((m) => m.id === "hmodel");
    expect(row, "qoder-cn missing hmodel").toBeDefined();
    expect(row.name).toBe("HungerG");
    // price_factor 0 → the 0x multiplier renders as the green `free` badge in
    // ModelRow (displayMultiplier === 0), which is the intended read.
    expect(row.rateMultiplier).toBe(0);
    expect(rowsOf("qoder").some((m) => m.id === "hmodel"), "intl must NOT list hmodel").toBe(false);
  });

  it("resolves capabilities by id and by display name without hitting the floor", () => {
    const caps = getCapabilitiesForModel("qoder-cn", "hmodel");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
    // thinkingFormat follows the entry's own `format`, not a guessed family.
    expect(caps.thinkingFormat).toBe("openai");
    expect(getCapabilitiesForModel("qoder-cn", "HungerG")).toEqual(caps);
  });
});

describe("qoder GLM-5.4 (gmodel_latest)", () => {
  it("is registered on both regions at the probed 0.8x", () => {
    for (const id of ["qoder", "qoder-cn"]) {
      const row = rowsOf(id).find((m) => m.id === "gmodel_latest");
      expect(row, `${id} missing gmodel_latest`).toBeDefined();
      expect(row.name, `${id} display name`).toBe("GLM-5.4");
      expect(row.rateMultiplier, `${id} multiplier`).toBe(0.8);
    }
  });

  it("is a separate model from GLM-5.3, not another spelling of it", () => {
    // The live catalog publishes both keys side by side with the same 0.8x, so
    // a merge would silently drop one of them.
    const cn = rowsOf("qoder-cn");
    expect(cn.some((m) => m.id === "gmodel" && m.name === "GLM-5.3")).toBe(true);
    expect(cn.find((m) => m.id === "gmodel_latest").name).not.toBe("GLM-5.3");
  });

  it("carries vision + reasoning from the provider row, not the 200K floor", () => {
    for (const id of ["qoder", "qoder-cn"]) {
      const caps = getCapabilitiesForModel(id, "gmodel_latest");
      expect(caps.vision, `${id} vision`).toBe(true);
      expect(caps.reasoning, `${id} reasoning`).toBe(true);
      expect(caps.contextWindow, `${id} context`).toBe(1000000);
      // Clients may address it by the registry display name.
      expect(getCapabilitiesForModel(id, "GLM-5.4")).toEqual(caps);
    }
  });
});
