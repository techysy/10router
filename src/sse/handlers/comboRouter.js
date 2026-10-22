// Combo `router` strategy orchestration (issue #73).
//
// One System One decision call picks WHICH member answers, then the chosen
// member runs the normal chat pipeline. Every failure mode degrades to the
// untouched fallback order — the extra call must never take availability down
// with it (无决策模型可用时静默降级, per the issue's acceptance list).
//
// The pure payload/parse/guard core lives engine-side in
// open-sse/services/combo/router.js; this file only drives the decision
// through the same lane handleSystemone uses.

import { getProviderCredentials, clearAccountError } from "../services/auth.js";
import { getModelInfo } from "../services/model.js";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import {
  buildRouterDecisionPayload,
  parseRouterDecisionResult,
  parseRouterDecisionMeta,
  guardRouterPick,
} from "open-sse/services/combo/router.js";
import * as log from "../utils/logger.js";

// Member capability cards for the decision `state`: resolved caps + context
// when the catalog knows the id, bare id otherwise. Fail-open per member — a
// model we cannot resolve still participates as a plain option.
async function resolveMemberCaps(memberId) {
  try {
    const info = await getModelInfo(memberId);
    if (!info?.provider) return null;
    const caps = getCapabilitiesForModel(info.provider, info.model);
    if (!caps) return null;
    return {
      name: info.model,
      provider: info.provider,
      model: info.model,
      vision: !!caps.vision,
      tools: !!caps.tools,
      pdf: !!caps.pdf,
      search: !!caps.search,
      contextWindow: caps.contextWindow || 0,
    };
  } catch {
    return null;
  }
}

// Live 7d health from the usage dashboard (same rows the Node Health page
// shows), keyed by provider|model. Fail-open + snapshot read: a slow or
// broken DB never blocks the decision — members without data simply render
// "no recent traffic data" on their card. Memoized per process (the dashboard
// query is heavier than the decision itself); 60s TTL keeps it fresh enough.
let healthCache = { at: 0, byKey: new Map() };
const HEALTH_TTL_MS = 60_000;
async function resolveMemberHealth(candidates) {
  if (Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.byKey;
  try {
    const { getUsageDashboard } = await import("../../lib/usageDb.js");
    const dash = await getUsageDashboard({ minRequests: 10 });
    const byKey = new Map();
    for (const m of dash.models || []) {
      byKey.set(`${m.provider}|${m.model}`, { health: m.score, successRate: m.successRate });
    }
    healthCache = { at: Date.now(), byKey };
  } catch {
    // stale cache is better than nothing; otherwise cold
  }
  return healthCache.byKey;
}

// The decision is best-effort by contract: any throw, timeout, non-success,
// or off-catalog answer becomes null so the caller proceeds with the normal
// fallback rotation. Never let the router lane answer 4xx for a combo request.
//
// The decision sits in front of the member's first token, so it runs under
// its own tight budget (env: COMBO_ROUTER_DECISION_TIMEOUT_MS, default 8s) —
// much shorter than the upstream FETCH_CONNECT_TIMEOUT_MS. A slow decision is
// a fallback, not a stalled combo.
const DECISION_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.COMBO_ROUTER_DECISION_TIMEOUT_MS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
})();

function withDecisionTimeout(promise) {
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), DECISION_TIMEOUT_MS);
  });
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer));
}

// Exported entry: the race above turns a hung decision into a null → fallback.
export function runRouterDecision(opts) {
  return withDecisionTimeout(decisionOnce(opts));
}

async function decisionOnce({ routerModel, body, candidates, logTag = "COMBO", apiKey = null, endpoint = "/v1/chat/completions" }) {
  try {
    if (!routerModel || !candidates?.length) return null;

    const modelInfo = await getModelInfo(routerModel);
    if (!modelInfo?.provider) {
      log.warn(logTag, `router: unknown routerModel '${routerModel}', using fallback order`);
      return null;
    }

    // Resolve per-member cards before building the payload (async here, the
    // builder stays a pure sync function over the resolver result). Live 7d
    // health rides along on each card when this instance has traffic for it.
    const healthByKey = await resolveMemberHealth(candidates);
    const capsMap = new Map();
    for (const m of candidates) {
      const card = (await resolveMemberCaps(m)) || {};
      const health = card.provider ? healthByKey.get(`${card.provider}|${card.model}`) : null;
      capsMap.set(m, health ? { ...card, ...health } : card);
    }
    const payload = buildRouterDecisionPayload(body, candidates, (id) => capsMap.get(id) || null);
    const decisionBody = { ...payload, model: `${modelInfo.provider}/${modelInfo.model}` };

    const credentials = await getProviderCredentials(modelInfo.provider, new Set(), modelInfo.model);
    if (!credentials || credentials.allRateLimited) {
      log.warn(logTag, `router: no usable credentials for ${routerModel}, using fallback order`);
      return null;
    }

    const result = await handleSystemoneCore({
      body: decisionBody,
      modelInfo: { provider: modelInfo.provider, model: modelInfo.model },
      credentials,
      log,
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, modelInfo.model);
      },
    });

    if (!result?.success) {
      log.warn(logTag, `router: decision failed (${result?.status}: ${result?.error || "unknown"}), using fallback order`);
      return null;
    }

    const decisionJson = await result.response.json().catch(() => null);

    // The decision is a real upstream call — put it in the usage ledger so the
    // "+1 call per request" cost of the router lane is visible in the same
    // places every other spend is (issue #73, design point 4).
    if (result.usage) {
      saveRequestUsage({
        provider: modelInfo.provider,
        model: modelInfo.model,
        connectionId: credentials.connectionId,
        apiKey,
        endpoint,
        tokens: {
          ...result.usage,
          total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
        },
        status: "success",
      }).catch(() => {});
    }

    const picked = parseRouterDecisionResult(decisionJson);
    const guarded = guardRouterPick(picked, candidates);
    if (!guarded) {
      log.warn(logTag, `router: decision picked '${picked ?? "(unparsable)"}' outside the candidate set, using fallback order`);
      return null;
    }

    // Confidence + runner-up are logging-only: "→ A" alone cannot tell a
    // 0.98 certainty from a 0.34 coin-flip, and a combo's picks being unstable
    // is exactly what you look for when tuning one. A missing meta block never
    // changes the outcome.
    const meta = parseRouterDecisionMeta(decisionJson);
    let detail = "";
    if (meta) {
      const parts = [];
      if (meta.confidence != null) parts.push(`conf ${meta.confidence.toFixed(2)}`);
      if (meta.runnerUp) {
        parts.push(`next ${meta.runnerUp}${meta.runnerUpP != null ? ` ${meta.runnerUpP.toFixed(2)}` : ""}`);
      }
      if (parts.length) detail = ` (${parts.join(", ")})`;
    }
    log.info(logTag, `router: ${routerModel} → ${guarded} of ${candidates.length} candidates${detail}`);
    return guarded;
  } catch (e) {
    // Router is advisory — swallow everything (including JSON read failures).
    log.warn(logTag, `router: decision errored (${e?.message || e}), using fallback order`);
    return null;
  }
}
