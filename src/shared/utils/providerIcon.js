// Provider icon paths under /public/providers.
// Alias related brands; session-cache 404s so one miss never spams again.

const ICON_ALIASES = {
  "perplexity-agent": "perplexity",
  "gitlab-duo": "gitlab",
  "vercel-ai-gateway": "vercel",
  "b.ai": "bai",
  "b-ai": "bai",
  "siliconflow-cn": "siliconflow",
  "longcat-intl": "longcat",
  "stepfun-cn": "stepfun",
  "stepfun-plan": "stepfun",
  "stepfun-plan-cn": "stepfun",
  "step-cn": "stepfun",
  "stepp-cn": "stepfun",
  "stepp": "stepfun",
  "step": "stepfun",
  "sfp-cn": "stepfun",
  "sfp": "stepfun",
  "sfpcn": "stepfun",
  "sf-cn": "stepfun",
  "sfcn": "stepfun",
  "sf": "stepfun",
  "step-plan-cn": "stepfun",
  "step-plan": "stepfun",
};

// Providers whose asset ships as SVG (everything else is .png).
const ICON_EXTENSIONS = {
  bai: ".svg",
};

// Runtime only — first 404 remembers id for the whole session
const failedIds = new Set();

function normalizeId(providerId) {
  if (!providerId || typeof providerId !== "string") return "";
  return providerId.trim().toLowerCase();
}

/** Resolve icon file id (after alias). Empty if previously failed this session. */
export function resolveProviderIconId(providerId) {
  const id = normalizeId(providerId);
  if (!id) return "";
  if (failedIds.has(id)) return "";
  const aliased = ICON_ALIASES[id] || id;
  if (failedIds.has(aliased)) return "";
  return aliased;
}

/** `/providers/{id}.png` (or .svg per ICON_EXTENSIONS) or null when previously failed. */
export function getProviderIconSrc(providerId) {
  const id = resolveProviderIconId(providerId);
  if (!id) return null;
  return `/providers/${id}${ICON_EXTENSIONS[id] || ".png"}`;
}

/** Call from img onError so later mounts skip the request. */
export function markProviderIconMissing(providerId) {
  const id = normalizeId(providerId);
  if (id) failedIds.add(id);
  const aliased = ICON_ALIASES[id];
  if (aliased) failedIds.add(aliased);
}
