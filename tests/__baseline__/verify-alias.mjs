// Verify alias resolution is byte-for-byte stable (both directions, all sources).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { PROVIDER_ID_TO_ALIAS, PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const snapPath = join(here, "alias-baseline.json");

// Tokens kept on probe even if no registry entry claims them any more, so that
// DELETING a spelling shows up as `x: owner -> x` instead of vanishing from the
// probe set and going unnoticed.
const HISTORICAL_TOKENS = [
  "cc","cx","gc","qw","if","ag","gh","kr","cu","kc","kmc","cl","oc","ocg","qd","qoder","qdc","qoder-cn",
  "el","openai","vercel","vercel-ai-gateway","anthropic","gemini","openrouter","glm","kimi",
  "minimax","minimax-cn","hf","huggingface","ds","deepseek","cmc","commandcode","groq","xai",
  "mistral","pplx","perplexity","together","fireworks","cerebras","cohere","nvidia","nebius",
  "siliconflow","hyp","hyperbolic","dg","deepgram","aai","assemblyai","nb","nanobanana","ch",
  "chutes","ark","volcengine-ark","byteplus","bpm","cursor","vx","vertex","vxp","vertex-partner",
  "gw","grok-web","gcli","gb","grok-build","grok-cli","pw","perplexity-web","mimo","xiaomi-mimo",
  "xmtp","xiaomi-tokenplan","cf",
  "cloudflare-ai","fal","fal-ai","stability","stability-ai","bfl","black-forest-labs","recraft",
  "topaz","runway","runwayml","jina","jina-ai","polly","aws-polly","bb","blackbox",
  "af","airforce","api-airforce","llm7","llm-7","samba","sambanova","bm","bluesminds",
  "bzl","bazaarlink","kgw","kilo-gateway","hunyuan","tencent","qianfan","baidu","ernie",
  "dv","devin","devin-cli","morph","morphllm",
  "muse","muse-ai","meta-model-api","muse-code","muse-subscription",
  "tokenbom","agnes-ai","agnes-ai-cn","drex","ocz","v1m","systemone","jev",
  "step","stepfun","stepfun-cn","stepfun-plan","stepfun-plan-cn",
  "step-cn","stepp-cn","stepp","sfp-cn","sfp","sfpcn","sf-cn","sfcn","step-plan","step-plan-cn","sf",
];

// Probe every spelling a provider actually publishes (id/alias/uiAlias/aliases)
// plus the historical tokens above. This used to be a hand-written list only,
// which is why the `tr` and `mmf` collisions were invisible here: neither
// spelling was on it, so the gate never saw their resolution change. Deriving
// from the registry means a new provider's spellings are covered the moment it
// lands, with nothing to remember to update.
const ALIAS_TOKENS = [
  ...new Set([
    ...REGISTRY.flatMap((p) =>
      [p.id, p.alias, p.uiAlias, ...(Array.isArray(p.aliases) ? p.aliases : [])].filter(Boolean)
    ),
    ...HISTORICAL_TOKENS,
  ]),
].sort();

// Sort idToAlias by key — runtime accesses by key, order is irrelevant (content-based)
const sortedIdToAlias = Object.fromEntries(
  Object.keys(PROVIDER_ID_TO_ALIAS).sort().map(k => [k, PROVIDER_ID_TO_ALIAS[k]])
);
const resolved = {
  aliasToId: Object.fromEntries(ALIAS_TOKENS.map(a => [a, resolveProviderAlias(a)])),
  idToAlias: sortedIdToAlias,
  modelKeys: Object.keys(PROVIDER_MODELS).sort(),
};
const current = JSON.parse(JSON.stringify(resolved));

if (process.argv[2] === "--snapshot") {
  writeFileSync(snapPath, JSON.stringify(current, null, 2));
  console.log(`Snapshot alias resolution → ${snapPath}`);
  process.exit(0);
}
if (!existsSync(snapPath)) { console.error("No baseline. Run --snapshot first."); process.exit(1); }
const baseline = JSON.parse(readFileSync(snapPath, "utf8"));
if (JSON.stringify(baseline) === JSON.stringify(current)) {
  console.log(`✅ Alias resolution byte-for-byte equal (${ALIAS_TOKENS.length} tokens).`);
  process.exit(0);
}
// Diff
for (const a of ALIAS_TOKENS) {
  if (baseline.aliasToId[a] !== current.aliasToId[a]) {
    console.error(`~ alias ${a}: ${baseline.aliasToId[a]} -> ${current.aliasToId[a]}`);
  }
}
if (JSON.stringify(baseline.idToAlias) !== JSON.stringify(current.idToAlias)) console.error("~ idToAlias changed");
if (JSON.stringify(baseline.modelKeys) !== JSON.stringify(current.modelKeys)) console.error("~ modelKeys changed");
process.exit(1);
