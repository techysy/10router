import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import {
  DEFAULT_CAPABILITIES,
  MODEL_CAPABILITIES,
  PROVIDER_CAPABILITIES,
  PATTERN_CAPABILITIES,
  getCapabilitiesForModel,
} from "../../open-sse/providers/capabilities.js";
import { matchPattern } from "../../open-sse/providers/pricing.js";

// Mirror of the chain in getCapabilitiesForModel() so a test can name the winning
// step. The first case below proves it agrees with the real resolver for every
// model in the registry — if the chain changes, that case fails first.
function resolveStep(provider, model) {
  const baseModel = model.includes("/") ? model.split("/").pop() : model;
  if (provider) {
    const pc = PROVIDER_CAPABILITIES[provider];
    if (pc?.[model]) return { step: "provider", caps: pc[model] };
    if (pc?.[baseModel]) return { step: "provider", caps: pc[baseModel] };
  }
  if (MODEL_CAPABILITIES[baseModel]) return { step: "canonical", caps: MODEL_CAPABILITIES[baseModel] };
  if (MODEL_CAPABILITIES[model]) return { step: "canonical", caps: MODEL_CAPABILITIES[model] };
  for (const { pattern, caps } of PATTERN_CAPABILITIES) {
    if (matchPattern(pattern, baseModel) || matchPattern(pattern, model)) return { step: "pattern", caps };
  }
  return { step: "floor", caps: null };
}

// Non-chat modal endpoints: dispatched by the media handlers, no chat caps needed.
const NON_CHAT = /embed|bge-|e5-|gte-|nomic|m2-bert|voyage|rerank|tts|speech|voice|whisper|parakeet|fastpitch|tacotron|deepgram|assemblyai|silero|kokoro|playht|cartesia|inworld|polly|fish-|flux|stable-diffusion|stable-image|sd3\.|sdxl|dall-e|gpt-image|imagen|seedream|ideogram|recraft|lucid|phoenix|dreamshaper|gen4_|gen3a|happyhorse|mai-image|topaz|kling|veo|pika/i;
// Providers that only resell media endpoints
const MEDIA_ONLY = new Set(["cloudflare-ai", "fal-ai", "stability-ai", "black-forest-labs", "runwayml", "comfyui", "sdwebui", "recraft", "agnes-ai", "agnes-ai-cn", "topaz", "selfhosted-stt", "selfhosted-tts", "selfhosted-embedding", "voyage-ai", "assemblyai", "deepgram", "elevenlabs", "aws-polly", "cartesia", "playht", "inworld", "coqui", "tortoise", "fish-audio", "google-tts", "edge-tts"]);

const MEDIA_KIND = new Set(["image", "video", "embedding", "tts", "stt", "audio"]);

const CHAT_MODELS = REGISTRY.flatMap((entry) =>
  (entry.models || [])
    .map((m) => (typeof m === "string" ? { id: m } : m))
    .filter((m) => m.id && !NON_CHAT.test(m.id) && !MEDIA_ONLY.has(entry.id))
    .map((m) => ({ provider: entry.id, id: m.id, kind: m.kind }))
);

// Models with no declaration anywhere. They resolve to DEFAULT_CAPABILITIES, which
// means vision:false (the modality layer strips images), reasoning:false,
// contextWindow 200000 and maxOutput 64000 (a real clamp via claude.js
// adjustMaxTokens) — so every entry here is a conscious decision not to declare,
// never an oversight. Adding a provider model lands it here and fails the suite
// until it is either given a row or listed below.
const ALLOWLIST = {
  // Aggregator / meta-selector ids: the upstream picks the real model per request,
  // so no static capability row can be accurate. Same treatment as before the audit.
  "qoder/auto": "aggregator",
  "qoder/efficient": "aggregator",
  "qoder/lite": "aggregator",
  "cursor/default": "aggregator",
  "bazaarlink/auto:free": "aggregator",
  "kilo-gateway/kilo-auto/free": "aggregator",
  "kilo-gateway/kilo-auto/frontier": "aggregator",
  "kilo-gateway/kilo-auto/balanced": "aggregator",

  // Private codenames with no public spec and no models.dev entry.
  "github/oswe-vscode-prime": "codename",
  "github/goldeneye-free-auto": "codename",
  "iflow/iflow-rome-30ba3b": "codename",
  "dots/dots3-note-prev": "codename",
  "morph/morph-dsv4flash": "codename",
  "tokenrouter/miromind/mirothinker-1-7-deepresearch": "codename",
  "tokenrouter/miromind/mirothinker-1-7-deepresearch-mini": "codename",

  // Sources disagree — held until a first-party spec settles it. See REVIEW-1.0.9-SCOPE.md.
  // kat-coder-pro-v2.5: vercel says 256000/80000 text+image+reasoning, while
  // kilo/openrouter say 262144/235929 text-only without reasoning.
  "kilo-gateway/kwaipilot/kat-coder-pro-v2.5:free": "conflict",
  "cline/kwaipilot/kat-coder-pro": "conflict", // v1 vs v2/v2.5, same split
  // Ark's display id — unclear whether it is seed-2-0-code-preview.
  "volcengine-ark/Doubao-Seed-Code": "conflict",

  // Image-generation endpoints (registry kind: "image"); the NON_CHAT regex simply
  // has no name to match on, so they fall through to the chat bucket. Asserted
  // below to really carry a media kind.
  "sensenova/sensenova-u1.5-lite": "media",
  "sensenova/sensenova-u1-fast": "media",
  "venice/venice-sd35": "media",
};

// Ids whose resolved value is disputed (they resolve through a pattern, so they are
// not floor models — they are listed here only to be excused by the multimodal
// check at the bottom). nvidia (first-party) + deepinfra / crusoe / kilo /
// openrouter report the nano-omni as text+image+video+audio, while vultr and
// requesty report text-only; it currently inherits the text-only *nemotron* pattern.
const DISPUTED = new Set([
  "tokenrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
]);

describe("capability resolution invariants", () => {
  it("the test-side chain agrees with getCapabilitiesForModel for every registry model", () => {
    const mismatches = [];
    for (const entry of REGISTRY) {
      for (const raw of entry.models || []) {
        const id = typeof raw === "string" ? raw : raw.id;
        if (!id) continue;
        const { caps } = resolveStep(entry.id, id);
        const expected = { ...DEFAULT_CAPABILITIES, ...caps };
        if (JSON.stringify(getCapabilitiesForModel(entry.id, id)) !== JSON.stringify(expected)) {
          mismatches.push(`${entry.id}/${id}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("names a capability source (provider / canonical / pattern) for every chat model not on the allowlist", () => {
    const floor = CHAT_MODELS.filter((m) => resolveStep(m.provider, m.id).step === "floor");
    const unexpected = floor
      .map((m) => `${m.provider}/${m.id}`)
      .filter((key) => !(key in ALLOWLIST));
    // A new model here means it silently inherits DEFAULT_CAPABILITIES. Give it a
    // row in open-sse/providers/capabilities.js, or add a reasoned allowlist entry.
    expect(unexpected).toEqual([]);
  });

  it("keeps the allowlist free of stale entries", () => {
    const floorKeys = new Set(
      CHAT_MODELS.filter((m) => resolveStep(m.provider, m.id).step === "floor").map((m) => `${m.provider}/${m.id}`)
    );
    const stale = Object.keys(ALLOWLIST).filter((key) => !floorKeys.has(key));
    // If a model here gained a row, delete the allowlist entry instead of leaving
    // a note that no longer describes reality.
    expect(stale).toEqual([]);
  });

  it("allows media ids only when the registry really tags them as media", () => {
    for (const [key, reason] of Object.entries(ALLOWLIST)) {
      if (reason !== "media") continue;
      const model = CHAT_MODELS.find((m) => `${m.provider}/${m.id}` === key);
      expect(`${key} kind=${model?.kind}`).toBe(`${key} kind=image`);
    }
  });

  it("never marks an id that reads as multimodal as text-only", () => {
    // Guards the DeepSeek-V4 / hy4-preview class of bug in the other direction: an
    // id explicitly marked vision (…-vision-…, -vl-, omni) must not resolve to
    // vision:false. Only the knowingly-unresolved nemotron nano-omni is allowed,
    // and only while it sits on the conflict list.
    const wrong = CHAT_MODELS.filter((m) => /vision|(^|[-_/])vl([-_/]|$)|omni/i.test(m.id))
      .filter((m) => getCapabilitiesForModel(m.provider, m.id).vision === false)
      .map((m) => `${m.provider}/${m.id}`)
      .filter((key) => !DISPUTED.has(key));
    expect(wrong).toEqual([]);
  });
});
