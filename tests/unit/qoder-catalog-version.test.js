/**
 * Qoder catalog fingerprint gates (2026-11-25).
 *
 * Qoder's /model/list decides WHICH rows it publishes from the caller's
 * fingerprint, and the two regions gate differently:
 *   - `Cosy-Version` (CN only): at 1.0.0 the CN catalog returns 13 keys, at
 *     ≥1.2.0 it also publishes `fast` (快速, 0.6x).
 *   - `Cosy-Clienttype` (both): at ct=5 (CLI) neither region publishes `fast`
 *     or `hmodel` (HungerG, free tier); ct=0 publishes both on both sides.
 *     ct=10 (desktop IDE) adds them too, but on intl it ALSO adds `smodel`
 *     (Sonus) and `cmodel` (Cantus) — keys with no registry rows, which would
 *     leak into /v1/models and the catalog import as unpriceable rows.
 * `fast` has had a CN registry row since 5058bcf7c, and model_config is taken
 * only from the live catalog (the executor does not fall back to
 * QODER_MODEL_MAP), so with the old read both 快速 and HungerG died at chat
 * time with `model_config for "<key>" not yet known`.
 *
 * All of this applies to the CATALOG read only — the chat signature keeps
 * QODER_IDE_VERSION / QODER_CLIENT_TYPE, verified live: fast and hmodel both
 * answer normally when signed at the shipped CLI fingerprint.
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
  QODER_CATALOG_CLIENT_TYPE,
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

  it("reads the CN catalog with the catalog client type — hmodel lives there", async () => {
    await resolveQoderModels(conn("qoder-cn"));
    expect(fetchMock.calls[0].headers["Cosy-Clienttype"]).toBe(QODER_CATALOG_CLIENT_TYPE);
    // ct=5's CN catalog has 14 keys and no hmodel; ct=0 (like ct=10) adds it.
    expect(QODER_CATALOG_CLIENT_TYPE).not.toBe(QODER_CLIENT_TYPE);
  });

  it("reads the intl catalog at the same catalog client type, IDE version kept", async () => {
    await resolveQoderModels(conn("qoder"));
    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0].url).toBe(QODER_MODEL_LIST_URL);
    expect(fetchMock.calls[0].headers["Cosy-Version"]).toBe(QODER_IDE_VERSION);
    // intl needs the client-type raise too (its picker publishes fast + hmodel),
    // but NOT the version raise — and ct=0 rather than ct=10, because the intl
    // catalog at ct=10 also publishes smodel/cmodel, which have no registry rows
    // and would leak into /v1/models as rows we cannot price.
    expect(fetchMock.calls[0].headers["Cosy-Clienttype"]).toBe(QODER_CATALOG_CLIENT_TYPE);
    expect(QODER_CATALOG_CLIENT_TYPE).not.toBe(QODER_CLIENT_TYPE);
  });

  it("the raised read still yields usable model_config for the gated keys", async () => {
    const cached = await resolveQoderModels(conn("qoder-cn"));
    expect(cached.rawConfigs.get("fast")).toMatchObject({ display_name: "Fast", price_factor: 0.6 });
    expect(cached.rawConfigs.get("hmodel")).toMatchObject({ display_name: "HungerG", price_factor: 0 });
    expect(cached.models.map((m) => m.id)).toContain("gmodel_latest");
  });
});

describe("qoder HungerG (hmodel) / Fast (fast) on both regions", () => {
  for (const id of ["qoder", "qoder-cn"]) {
    it(`${id}: HungerG registered free, named as upstream publishes it`, () => {
      const row = rowsOf(id).find((m) => m.id === "hmodel");
      expect(row, `${id} missing hmodel`).toBeDefined();
      expect(row.name).toBe("HungerG");
      // price_factor 0 → the 0x multiplier renders as the green `free` badge.
      expect(row.rateMultiplier, `${id} HungerG must be 0x`).toBe(0);
    });

    it(`${id}: Fast registered at the probed 0.6x`, () => {
      const row = rowsOf(id).find((m) => m.id === "fast");
      expect(row, `${id} missing fast`).toBeDefined();
      expect(row.rateMultiplier).toBe(0.6);
    });

    it(`${id}: resolves both by id and by display name without hitting the floor`, () => {
      // The two regions spell the same key differently in their registry rows
      // (CN 快速 / intl Fast), so each side is checked against its own name.
      const fastName = id === "qoder-cn" ? "快速" : "Fast";
      for (const [key, name] of [["hmodel", "HungerG"], ["fast", fastName]]) {
        const caps = getCapabilitiesForModel(id, key);
        expect(caps.vision, `${id}/${key} vision`).toBe(true);
        expect(caps.reasoning, `${id}/${key} reasoning`).toBe(true);
        expect(caps.contextWindow, `${id}/${key} context`).toBe(1000000);
        expect(caps.thinkingCanDisable, `${id}/${key} thinking`).toBe(false);
        expect(getCapabilitiesForModel(id, name), `${id}/${name}`).toEqual(caps);
      }
      // HungerG's base model is unpublished: the row takes the entry's own
      // declared `format` instead of guessing a family, and clamps maxOutput
      // conservatively (small over large) until upstream states a ceiling.
      expect(getCapabilitiesForModel(id, "hmodel").thinkingFormat).toBe("openai");
      expect(getCapabilitiesForModel(id, "hmodel").maxOutput).toBe(65536);
    });
  }

  it("keeps each region's own spelling of fast, and nothing else's", () => {
    // CN's registry names it 快速, intl's names it Fast (upstream publishes the
    // key under different display names per region). The other region must NOT
    // resolve it — a shared alias would hand one region the other's name.
    expect(getCapabilitiesForModel("qoder-cn", "快速")).toEqual(getCapabilitiesForModel("qoder-cn", "fast"));
    expect(getCapabilitiesForModel("qoder", "Fast")).toEqual(getCapabilitiesForModel("qoder", "fast"));
    expect(getCapabilitiesForModel("qoder", "快速")).not.toEqual(getCapabilitiesForModel("qoder", "fast"));
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
