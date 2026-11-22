// MiMo official-catalog resolver: feeds the "Fetch MiMo Models" button on the
// xiaomi-mimo provider page (route: /api/providers/[id]/models,
// PROVIDER_MODELS_CONFIG["xiaomi-mimo"].customResolver). Guards two things:
// the public /v1/models surface imports cleanly, and the two client-internal
// mimo-x preview models can never leak back through the import.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveMimoModels, MIMO_CLIENT_PREVIEW_PREFIX } from "../../open-sse/services/mimoModels.js";

const okResponse = (models) => ({
  ok: true,
  json: async () => ({ data: models.map((id) => ({ id, object: "model" })) }),
});

describe("resolveMimoModels", () => {
  it("fetches /v1/models with the connection's bearer token", async () => {
    const fetchImpl = vi.fn(async () => okResponse(["mimo-v2.5", "mimo-v2.5-pro"]));
    const result = await resolveMimoModels(
      { accessToken: "sk-test", baseUrl: "https://api.xiaomimimo.com/v1/chat/completions" },
      { fetchImpl }
    );
    expect(result.warning).toBeUndefined();
    expect(result.models.map((m) => m.id)).toEqual(["mimo-v2.5", "mimo-v2.5-pro"]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.xiaomimimo.com/v1/models");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
  });

  it("derives the origin from providerSpecificData.baseUrl when present", async () => {
    const fetchImpl = vi.fn(async () => okResponse(["mimo-v2.5"]));
    await resolveMimoModels({ accessToken: "sk-t", providerSpecificData: { baseUrl: "https://mirror.example.com/v1" } }, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://mirror.example.com/v1/models");
  });

  it("never imports the client-internal mimo-x preview models", async () => {
    // Even if an allow-listed account enumerates them upstream, the resolver
    // must drop every "mimo-x*" id so the fixed registry entries (which route
    // through the signed in-client path) stay untouched.
    const fetchImpl = vi.fn(async () =>
      okResponse(["mimo-v2.5", "mimo-x-pro-preview", "mimo-x-flash-preview"])
    );
    const result = await resolveMimoModels({ accessToken: "sk-t" }, { fetchImpl });
    expect(result.models.map((m) => m.id)).toEqual(["mimo-v2.5"]);
    expect(result.models.some((m) => m.id.startsWith(MIMO_CLIENT_PREVIEW_PREFIX))).toBe(false);
  });

  it("warns without throwing when the connection has no token", async () => {
    const fetchImpl = vi.fn();
    const result = await resolveMimoModels({}, { fetchImpl });
    expect(result.models).toEqual([]);
    expect(result.warning).toMatch(/token/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces upstream HTTP failures as a warning", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const result = await resolveMimoModels({ accessToken: "sk-bad" }, { fetchImpl });
    expect(result.models).toEqual([]);
    expect(result.warning).toMatch(/401/);
  });

  it("treats an empty upstream list as a warning, not a silent success", async () => {
    const fetchImpl = vi.fn(async () => okResponse([]));
    const result = await resolveMimoModels({ accessToken: "sk-t" }, { fetchImpl });
    expect(result.models).toEqual([]);
    expect(result.warning).toMatch(/no models/i);
  });
});

describe("MiMo catalog wiring (source scan)", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const routeSrc = readFileSync(path.join(repoRoot, "src/app/api/providers/[id]/models/route.js"), "utf8");
  const pageSrc = readFileSync(path.join(repoRoot, "src/app/(dashboard)/dashboard/providers/[id]/page.js"), "utf8");

  it("registers the resolver under xiaomi-mimo in the models route", () => {
    expect(routeSrc).toMatch(/resolveMimoModels/);
    expect(routeSrc).toMatch(/["']xiaomi-mimo["']\s*:\s*\{[\s\S]{0,120}customResolver/);
  });

  it("shows the fetch-catalog button for xiaomi-mimo with its own label", () => {
    expect(pageSrc).toMatch(/supportsCatalogImport[\s\S]{0,120}xiaomi-mimo/);
    expect(pageSrc).toMatch(/Fetch MiMo Models/);
    // The qoder-family pricing overlay must stay exclusive to the qoder
    // family (qoder/qoder-cn + the 2026-11-22 additions qwenwork/qwenwork-cn).
    expect(pageSrc).toMatch(
      /isQoderFamily = providerId === "qoder" \|\| providerId === "qoder-cn"\s*\|\| providerId === "qwenwork" \|\| providerId === "qwenwork-cn";/
    );
  });
});

describe("xiaomi-mimo registry integrity", () => {
  const registryDir = path.join(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    "open-sse/providers/registry"
  );
  const registry = readFileSync(path.join(registryDir, "xiaomi-mimo.js"), "utf8");
  const desktopRegistry = readFileSync(path.join(registryDir, "mimo-desktop.js"), "utf8");

  it("keeps account-session models on the Desktop card only", () => {
    // The 2026-09-22 three-card split moved the account-session models into
    // registry/mimo-desktop.js, and the retired mimo-x-*-preview pair was replaced
    // by the Desktop plan's current list. Both directions still matter: the
    // Desktop card lists them with requiresSession, the base card lists none.
    expect(desktopRegistry).toMatch(/requiresSession:\s*true/);
    expect(registry).not.toMatch(/requiresSession/);
    // The retired previews are gone from BOTH cards, not just moved.
    expect(registry).not.toMatch(/mimo-x-pro-preview/);
    expect(desktopRegistry).not.toMatch(/mimo-x-pro-preview/);
    expect(registry).not.toMatch(/"mimo-v2-omni"/);
    expect(registry).not.toMatch(/"mimo-v2-flash"/);
  });

  it("carries the V2.6 chat line and no longer offers the retiring V2.5 pair", () => {
    // Platform model list, page updated 2026-09-21: V2.6 pro + flash are the
    // current text-generation models; mimo-v2.5 / mimo-v2.5-pro retire at
    // 2026-10-21 10:00 CST. The quotes matter — the deletion rationale in the
    // registry comment names the retired ids in prose, and only a live entry is
    // quoted as an id.
    expect(registry).toMatch(/\{\s*id:\s*"mimo-v2\.6-pro"/);
    expect(registry).toMatch(/\{\s*id:\s*"mimo-v2\.6-flash"/);
    expect(registry).not.toMatch(/\{\s*id:\s*"mimo-v2\.5-pro"/);
    expect(registry).not.toMatch(/\{\s*id:\s*"mimo-v2\.5"/);
    // ultraspeed is 定制服务 on the open API (a session/key without the contract
    // gets an upstream error), but cloud + Token Plan + Desktop cards all list it
    // anyway so a contracted user can call it out of the box instead of
    // hand-adding a custom model (2026-09-27 user decision: pre-list on the
    // Desktop card too — whether it works depends on the user's plan).
    expect(registry).toMatch(/\{\s*id:\s*"mimo-v2\.6-pro-ultraspeed"/);
    expect(desktopRegistry).toMatch(/\{\s*id:\s*"mimo-v2\.6-pro-ultraspeed"/);
  });
});

describe("MiMo catalog kind tagging (2026-09-19 user report)", () => {
  it("tags upstream ids by function: chat=llm, -tts*=tts, -asr=stt", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([
        "mimo-v2.5",
        "mimo-v2.5-pro",
        "mimo-v2.5-asr",
        "mimo-v2.5-tts",
        "mimo-v2.5-tts-voiceclone",
        "mimo-v2.5-tts-voicedesign",
      ])
    );
    const result = await resolveMimoModels({ accessToken: "sk-t" }, { fetchImpl });
    const kinds = Object.fromEntries(result.models.map((m) => [m.id, m.kind]));
    expect(kinds).toEqual({
      "mimo-v2.5": "llm",
      "mimo-v2.5-pro": "llm",
      "mimo-v2.5-asr": "stt",
      "mimo-v2.5-tts": "tts",
      "mimo-v2.5-tts-voiceclone": "tts",
      "mimo-v2.5-tts-voicedesign": "tts",
    });
  });

  it("the import loop must only accept llm-kind rows (media goes to media-providers)", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const pageSrc = readFileSync(path.join(repoRoot, "src/app/(dashboard)/dashboard/providers/[id]/page.js"), "utf8");
    expect(pageSrc).toMatch(/if \(\(model\.kind \|\| "llm"\) !== "llm"\)/);
    expect(pageSrc).toMatch(/mediaSkipped/);
  });

  it("registry no longer carries the retired mimo-v2.5-pro-ultraspeed", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const registry = readFileSync(path.join(repoRoot, "open-sse/providers/registry/xiaomi-mimo.js"), "utf8");
    // The deletion note may mention the name in prose; assert no live entry.
    expect(registry).not.toMatch(/\{\s*id:\s*"mimo-v2\.5-pro-ultraspeed"/);
    // the chat line + tts media entry remain
    expect(registry).toMatch(/"mimo-v2.6-pro"/);
    expect(registry).toMatch(/"mimo-v2.5-tts".*kind:\s*"tts"/);
  });
});
