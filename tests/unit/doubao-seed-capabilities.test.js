import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Ark lists Doubao-Seed-2.0 as four models (pro / lite / mini / code) and keeps a
// separate, older `doubao-seed-code` family that its own model list already marks
// 「即将下线」. The two ids share the "Seed…Code" shape, so a pattern matching both
// would either clamp the 2.0 model to 32k output or over-advertise the retired one.
const OFFERED = REGISTRY.flatMap((entry) =>
  (entry.models || [])
    .map((m) => (typeof m === "string" ? m : m.id))
    .filter((id) => id && /seed/i.test(id))
    .map((id) => ({ provider: entry.id, id }))
);

// `Doubao-Seed-Code` / `doubao-seed-code-preview-*` — legacy family, no "2.0".
const LEGACY_CODE = OFFERED.filter((m) => /seed-code/i.test(m.id) && !/seed[._-]?2[._-]?0/i.test(m.id));
// The 2.0 series: pro / lite / mini / code.
const SEED_20 = OFFERED.filter((m) => /seed[._-]?2[._-]?0/i.test(m.id));
const SEED_20_CODE = SEED_20.filter((m) => /code/i.test(m.id));

describe("Doubao-Seed capability resolution", () => {
  it("offers both families (sanity check on the fixture)", () => {
    expect(LEGACY_CODE.length).toBeGreaterThan(0);
    expect(SEED_20_CODE.length).toBeGreaterThanOrEqual(2);
    expect(SEED_20.length).toBeGreaterThanOrEqual(8);
  });

  it("keeps the retired seed-code family at Ark's 32k answer cap", () => {
    // Ark's model list (first-party): 上下文窗口 256k / 最大输入 224k /
    // 最大回答(默认 4k) 32k / 最大思维链 32k, capabilities 深度思考 · 多模态理解 ·
    // 视觉定位 · 工具调用. reseller zenmux reports 64000 output — the first-party
    // 32k is the conservative floor, so a 64k request is never forwarded.
    for (const { provider, id } of LEGACY_CODE) {
      const caps = getCapabilitiesForModel(provider, id);
      const at = `${provider}/${id}`;
      expect(`${at} ctx=${caps.contextWindow}`).toBe(`${at} ctx=256000`);
      expect(`${at} out=${caps.maxOutput}`).toBe(`${at} out=32768`);
      expect(`${at} vision=${caps.vision}`).toBe(`${at} vision=true`);
      expect(`${at} reasoning=${caps.reasoning}`).toBe(`${at} reasoning=true`);
      // The doc never lists video for this family, unlike the 2.0 one.
      expect(`${at} video=${caps.videoInput}`).toBe(`${at} video=false`);
    }
  });

  it("keeps Seed-2.0-code at 256k/128k with video", () => {
    // 2026-08-13 first-party `volcengine` entry: 262144 / 131072, text+image+video.
    for (const { provider, id } of SEED_20_CODE) {
      const caps = getCapabilitiesForModel(provider, id);
      const at = `${provider}/${id}`;
      expect(`${at} ctx=${caps.contextWindow}`).toBe(`${at} ctx=262144`);
      expect(`${at} out=${caps.maxOutput}`).toBe(`${at} out=131072`);
      expect(`${at} vision=${caps.vision}`).toBe(`${at} vision=true`);
      expect(`${at} video=${caps.videoInput}`).toBe(`${at} video=true`);
    }
  });

  it("never lets the two Ark display ids collapse onto one another", () => {
    // Both ids ship in the same provider from Ark's coding endpoint, so an earlier
    // revision left `Doubao-Seed-Code` undeclared (falling back to 200000/64000)
    // rather than guess it was the 2.0 model. They are distinct: the retired one
    // caps at 32k, the 2.0 one at 128k.
    const legacy = getCapabilitiesForModel("volcengine-ark", "Doubao-Seed-Code");
    const modern = getCapabilitiesForModel("volcengine-ark", "Doubao-Seed-2.0-Code");
    expect(legacy.maxOutput).toBe(32768);
    expect(modern.maxOutput).toBe(131072);
    expect(legacy.maxOutput).not.toBe(modern.maxOutput);
    expect(legacy.videoInput).toBe(false);
    expect(modern.videoInput).toBe(true);
  });
});
