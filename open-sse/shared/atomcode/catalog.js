// AtomCode model catalogue — two pools behind one account.
//
// A pool (CodingPlan): the plan's own models. The upstream `/v1/models` list
// does NOT advertise them, but they answer on the same gateway. Tier-dependent
// (`models-v2?plan_type=`), so this is the 2026-10-01 Max/Lite snapshot from
// our Rust provider's fallback table plus the Go reference's measured extras.
//
// B pool (AI Hub): public models on a separate monthly token quota. These are
// what `/v1/models` lists. Both pools share the OAuth bearer and the gateway.
//
// The registry needs a static seed (there is no unauthenticated catalogue
// endpoint), so the merge below is what users pick from. `mergeAtomcodeModels`
// stays pure so the union can be tested with fixtures.

export const ATOMCODE_CODING_PLAN_MODELS = [
  {
    id: "glm5.3-flash",
    name: "GLM-5.3-Flash",
    vision: true,
    reasoning: true,
    contextWindow: 512000,
  },
  {
    id: "qwen3.8-27b",
    name: "Qwen3.8-27B",
    vision: true,
    reasoning: true,
    contextWindow: 262144,
  },
  {
    // models-v2 stopped listing it, but the gateway still answers (measured
    // 2026-10-01: 200 with real content, 1M context, vision).
    id: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash",
    vision: true,
    reasoning: true,
    contextWindow: 1000000,
  },
];

export const ATOMCODE_AI_HUB_MODELS = [
  {
    id: "deepseek-ai/DeepSeek-V4-Flash",
    name: "DeepSeek-V4-Flash (AI Hub)",
    pool: "ai-hub",
  },
  {
    id: "zai-org/GLM-5.1",
    name: "GLM-5.1 (AI Hub)",
    pool: "ai-hub",
  },
  {
    id: "Qwen/Qwen3-32B",
    name: "Qwen3-32B (AI Hub)",
    pool: "ai-hub",
  },
  {
    id: "Qwen/Qwen3-30B-A3B-Thinking-2507",
    name: "Qwen3-30B-A3B-Thinking-2507 (AI Hub)",
    pool: "ai-hub",
  },
  {
    id: "Qwen/Qwen3-30B-A3B-Instruct-2507",
    name: "Qwen3-30B-A3B-Instruct-2507 (AI Hub)",
    pool: "ai-hub",
  },
  {
    // The only B-pool model the relay notes as visual; the others carry no
    // published capability, so we do not guess.
    id: "Qwen/Qwen2.5-VL-72B",
    name: "Qwen2.5-VL-72B (AI Hub)",
    vision: true,
    pool: "ai-hub",
  },
];

/**
 * Union of the two pools. CodingPlan entries win on duplicate ids (they carry
 * measured capability metadata); AI Hub accepts either an array or an OpenAI
 * `/v1/models` envelope.
 */
export function mergeAtomcodeModels({ codingPlan = [], aiHub = [] } = {}) {
  const byId = new Map();
  for (const model of codingPlan) {
    if (model && typeof model.id === "string" && model.id.trim() && !byId.has(model.id)) {
      byId.set(model.id, { ...model, pool: model.pool || "codingplan" });
    }
  }
  const hub = Array.isArray(aiHub) ? aiHub : Array.isArray(aiHub?.data) ? aiHub.data : [];
  for (const model of hub) {
    if (model && typeof model.id === "string" && model.id.trim() && !byId.has(model.id)) {
      byId.set(model.id, { ...model, pool: model.pool || "ai-hub" });
    }
  }
  return [...byId.values()];
}

export const ATOMCODE_MODELS = mergeAtomcodeModels({
  codingPlan: ATOMCODE_CODING_PLAN_MODELS,
  aiHub: ATOMCODE_AI_HUB_MODELS,
});

const DISPLAY_TO_ID = new Map(
  ATOMCODE_MODELS.map((model) => [String(model.name || "").trim().toLowerCase(), model.id])
);
const IDS = new Set(ATOMCODE_MODELS.map((model) => model.id));

/**
 * Resolve a client-supplied model name to the id the gateway answers to.
 *
 * Clients may send the published display name (`GLM-5.3-Flash`), the gateway
 * id (`glm5.3-flash`), an `atomcode/<id>` prefix, or a per-account prefix
 * (`<account>/<id>`). B-pool ids themselves contain `/` (`Qwen/Qwen3-32B`),
 * so a slash is only stripped when the remainder is a known model.
 * Unknown names are returned unchanged — guessing is how a naming bug turns
 * into an opaque `200 参数错误`.
 */
export function resolveAtomcodeModelId(requested) {
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) return raw;

  const directId = IDS.has(raw) ? raw : null;
  if (directId) return directId;

  const byDisplay = DISPLAY_TO_ID.get(raw.toLowerCase());
  if (byDisplay) return byDisplay;

  if (raw.startsWith("atomcode/")) {
    const rest = raw.slice("atomcode/".length).trim();
    if (rest) return resolveAtomcodeModelId(rest);
  }

  const slash = raw.indexOf("/");
  if (slash > 0) {
    const rest = raw.slice(slash + 1).trim();
    if (rest && (IDS.has(rest) || DISPLAY_TO_ID.has(rest.toLowerCase()))) {
      return resolveAtomcodeModelId(rest);
    }
  }

  return raw;
}

export function atomcodeModelIsKnown(id) {
  return IDS.has(id);
}
