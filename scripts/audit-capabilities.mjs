#!/usr/bin/env node
/**
 * Capability audit — offline. No network, no dependencies, no writes.
 *
 * Walks every model in the provider registry and replays the same fallback chain
 * as getCapabilitiesForModel() (open-sse/providers/capabilities.js) to report which
 * models resolve where, and to flag four classes of problem:
 *
 *   1. floor     — nothing declared anywhere, so the model silently inherits
 *                  DEFAULT_CAPABILITIES (vision:false strips images in
 *                  open-sse/translator/concerns/modality.js, contextWindow 200000,
 *                  maxOutput 64000 clamps max_tokens in translator/formats/claude.js)
 *   2. vision    — the id reads as multimodal (…-vision-…, -vl-, omni) but resolves
 *                  to vision:false, i.e. the model name and the table disagree
 *   3. image-out — the id reads as an image generator but imageOutput is not true
 *   4. dead      — a row declared for an id the provider no longer offers
 *
 * This module is also the single source of truth for the floor allowlist: the
 * guard test (tests/unit/capability-floor-allowlist.test.js) imports the tables
 * below, and CI runs the report as a step. Keep them here rather than duplicating.
 *
 * Usage:
 *   node scripts/audit-capabilities.mjs          # report
 *   node scripts/audit-capabilities.mjs --check  # exit 1 if an invariant is broken
 */
import { pathToFileURL } from "node:url";
import REGISTRY from "../open-sse/providers/registry/index.js";
import {
  DEFAULT_CAPABILITIES,
  MODEL_CAPABILITIES,
  PROVIDER_CAPABILITIES,
  PATTERN_CAPABILITIES,
  getCapabilitiesForModel,
} from "../open-sse/providers/capabilities.js";
import { matchPattern } from "../open-sse/providers/pricing.js";

/** Replay of the resolver chain that also names the winning step. */
export function resolveStep(provider, model) {
  const baseModel = model.includes("/") ? model.split("/").pop() : model;
  if (provider) {
    const pc = PROVIDER_CAPABILITIES[provider];
    if (pc?.[model]) return { step: "provider", key: model, caps: pc[model] };
    if (pc?.[baseModel]) return { step: "provider", key: baseModel, caps: pc[baseModel] };
  }
  if (MODEL_CAPABILITIES[baseModel]) return { step: "canonical", key: baseModel, caps: MODEL_CAPABILITIES[baseModel] };
  if (MODEL_CAPABILITIES[model]) return { step: "canonical", key: model, caps: MODEL_CAPABILITIES[model] };
  for (const { pattern, caps } of PATTERN_CAPABILITIES) {
    if (matchPattern(pattern, baseModel) || matchPattern(pattern, model)) return { step: "pattern", key: pattern, caps };
  }
  return { step: "floor", key: null, caps: null };
}

// Non-chat modal endpoints: dispatched by the media handlers, no chat caps needed.
const NON_CHAT = /embed|bge-|e5-|gte-|nomic|m2-bert|voyage|rerank|tts|speech|voice|whisper|parakeet|fastpitch|tacotron|deepgram|assemblyai|silero|kokoro|playht|cartesia|inworld|polly|fish-|flux|stable-diffusion|stable-image|sd3\.|sdxl|dall-e|gpt-image|imagen|seedream|ideogram|recraft|lucid|phoenix|dreamshaper|gen4_|gen3a|happyhorse|mai-image|topaz|kling|veo|pika/i;
// Providers that only resell media endpoints.
const MEDIA_ONLY = new Set(["cloudflare-ai", "fal-ai", "stability-ai", "black-forest-labs", "runwayml", "comfyui", "sdwebui", "recraft", "agnes-ai", "agnes-ai-cn", "topaz", "selfhosted-stt", "selfhosted-tts", "selfhosted-embedding", "voyage-ai", "assemblyai", "deepgram", "elevenlabs", "aws-polly", "cartesia", "playht", "inworld", "coqui", "tortoise", "fish-audio", "google-tts", "edge-tts"]);

export const MEDIA_KIND = new Set(["image", "video", "embedding", "tts", "stt", "audio"]);
export const ALL_MODELS = REGISTRY.flatMap((entry) =>
  (entry.models || [])
    .map((m) => (typeof m === "string" ? { id: m } : m))
    .filter((m) => m.id)
    .map((m) => ({ provider: entry.id, id: m.id, kind: m.kind }))
);
export const CHAT_MODELS = ALL_MODELS.filter((m) => !NON_CHAT.test(m.id) && !MEDIA_ONLY.has(m.provider));

/** Ids that read as multimodal and must therefore not resolve to vision:false. */
export const VISION_NAME = /vision|(^|[-_/])vl([-_/]|$)|omni/i;
/** Ids that read as image generators and must therefore set imageOutput. */
export const IMAGE_NAME = /-image$|imagen|image-generation/i;

// Models with no declaration anywhere. They resolve to DEFAULT_CAPABILITIES, which
// means vision:false (the modality layer strips images), reasoning:false,
// contextWindow 200000 and maxOutput 64000 (a real clamp via claude.js
// adjustMaxTokens) — so every entry here is a conscious decision not to declare,
// never an oversight. Adding a provider model lands it here and fails the suite
// until it is either given a row or listed below.
export const ALLOWLIST = {
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
  // Present in opencode-go's public /models catalog, absent from their endpoint table and
  // from every first-party source (models.dev marks it deprecated and carries it only under
  // opencode-go itself, which is the same catalog — not independent evidence). It gets no
  // supportedFormats either, so it keeps the sourceFormat-matched transport untouched.
  "opencode-go/omen-alpha": "codename",

  // Sources disagree — held until a first-party spec settles it.
  // kat-coder-pro-v2.5: vercel says 256000/80000 text+image+reasoning, while
  // kilo/openrouter say 262144/235929 text-only without reasoning.
  "kilo-gateway/kwaipilot/kat-coder-pro-v2.5:free": "conflict",
  "cline/kwaipilot/kat-coder-pro": "conflict", // v1 vs v2/v2.5, same split

  // Image-generation endpoints (registry kind: "image"); the NON_CHAT regex simply
  // has no name to match on, so they fall through to the chat bucket. Asserted
  // below to really carry a media kind.
  "sensenova/sensenova-u1.5-lite": "media",
  "sensenova/sensenova-u1-fast": "media",
  "venice/venice-sd35": "media",
};

// Multimodal-looking ids whose resolved value is knowingly disputed. nvidia
// (first-party) + deepinfra / crusoe / kilo / openrouter report the nano-omni as
// text+image+video+audio; vultr and requesty report text-only. It currently
// inherits the text-only *nemotron* pattern and is left alone deliberately.
export const DISPUTED = new Set(["tokenrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"]);

export function audit() {
  const rows = CHAT_MODELS.map((m) => ({ ...m, ...resolveStep(m.provider, m.id), caps: getCapabilitiesForModel(m.provider, m.id) }));
  const key = (r) => `${r.provider}/${r.id}`;

  const floor = rows.filter((r) => r.step === "floor");
  const floorUnlisted = floor.filter((r) => !(key(r) in ALLOWLIST));
  const staleAllowlist = Object.keys(ALLOWLIST).filter((k) => !floor.some((r) => key(r) === k));
  const wrongVision = rows.filter((r) => VISION_NAME.test(r.id) && r.caps.vision === false && !DISPUTED.has(key(r)));
  const wrongImageOut = rows.filter((r) => (IMAGE_NAME.test(r.id) ? r.caps.imageOutput !== true : false));
  const badMediaClaim = Object.entries(ALLOWLIST)
    .filter(([, reason]) => reason === "media")
    .filter(([k]) => CHAT_MODELS.find((m) => `${m.provider}/${m.id}` === k)?.kind !== "image");

  // A provider row keyed by a vendor-prefixed id must be compared after the same
  // baseModel strip the resolver applies, or every prefixed row looks dead.
  const dead = [];
  for (const [provider, caps] of Object.entries(PROVIDER_CAPABILITIES)) {
    const entry = REGISTRY.find((e) => e.id === provider);
    if (!entry) continue;
    const offered = new Set();
    for (const m of entry.models || []) {
      const id = typeof m === "string" ? m : m.id;
      if (!id) continue;
      offered.add(id);
      offered.add(id.includes("/") ? id.split("/").pop() : id);
    }
    const keys = Object.keys(caps).filter((k) => !offered.has(k));
    if (keys.length) dead.push({ provider, keys });
  }

  const steps = {};
  for (const r of rows) steps[r.step] = (steps[r.step] || 0) + 1;

  return { rows, steps, floor, floorUnlisted, staleAllowlist, wrongVision, wrongImageOut, badMediaClaim, dead };
}

function main() {
  const { rows, steps, floor, floorUnlisted, staleAllowlist, wrongVision, wrongImageOut, badMediaClaim, dead } = audit();
  const byProvider = (list) => {
    const out = {};
    for (const r of list) (out[r.provider] ||= []).push(r.id);
    return Object.entries(out).sort((a, b) => b[1].length - a[1].length);
  };

  console.log(`registry: ${REGISTRY.length} providers, ${ALL_MODELS.length} models, ${CHAT_MODELS.length} chat models`);
  console.log(`resolution: ${Object.entries(steps).map(([k, v]) => `${k} ${v}`).join(" · ")}`);

  console.log(`\n## floor (no declaration anywhere) — ${floor.length}`);
  for (const [provider, ids] of byProvider(floor)) {
    console.log(`  ${provider} (${ids.length}): ${ids.map((id) => {
      const reason = ALLOWLIST[`${provider}/${id}`];
      return reason ? `${id} [${reason}]` : `${id} ❌`;
    }).join(", ")}`);
  }

  console.log(`\n## multimodal id resolving to vision:false — ${wrongVision.length}`);
  for (const r of wrongVision) console.log(`  ❌ ${r.provider}/${r.id} [${r.step}:${r.key}]`);
  if (DISPUTED.size) console.log(`  (knowingly disputed, not counted: ${[...DISPUTED].join(", ")})`);

  console.log(`\n## image-output id without imageOutput:true — ${wrongImageOut.length}`);
  for (const r of wrongImageOut) console.log(`  ❌ ${r.provider}/${r.id} vision=${r.caps.vision}`);

  console.log(`\n## dead provider rows — ${dead.length}`);
  for (const d of dead) console.log(`  ${d.provider}: ${d.keys.join(", ")}`);

  const problems = [
    ...floorUnlisted.map((r) => `floor not on the allowlist: ${r.provider}/${r.id}`),
    ...staleAllowlist.map((k) => `stale allowlist entry (model resolved elsewhere): ${k}`),
    ...wrongVision.map((r) => `multimodal id resolves to vision:false: ${r.provider}/${r.id}`),
    ...wrongImageOut.map((r) => `image id without imageOutput: ${r.provider}/${r.id}`),
    ...badMediaClaim.map(([k]) => `allowlisted as media but registry kind is not image: ${k}`),
    ...dead.flatMap((d) => d.keys.map((k) => `dead provider row: ${d.provider}/${k}`)),
  ];
  console.log(`\n${problems.length === 0 ? "✅ no invariant broken" : `❌ ${problems.length} problem(s)`}`);
  for (const p of problems) console.log(`  - ${p}`);

  if (process.argv.includes("--check") && problems.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
