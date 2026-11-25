#!/usr/bin/env node
/**
 * Pricing coverage audit — mirrors scripts/audit-capabilities.mjs.
 *
 * Why: the 2026-09 pricing review found a whole provider family (StepFun LLMs)
 * and every new Qwen flagship silently priced at $0 or, worse, wildcard-priced
 * at a cheaper generation (qwen3.8-max resolving through a generic pattern at
 * coder-flash rates). Nothing in the suite notices a MISSING price the way
 * capability-floor notices a missing window — the dashboard just shows $0.
 *
 * Gate (exit 1):
 *   [A] LLM-kind registry models with NO pricing at all (unless in an explicit,
 *       commented exemption below — exemptions are channel-alias/free-plan cases
 *       where USD token pricing genuinely does not apply).
 *   [B] The hard half: text models priced ONLY through a wildcard pattern while
 *       the pattern's price differs from a known official rate — impossible to
 *       detect offline. So [B] is report-only: every wildcard-hit LLM is listed
 *       for a human to reconcile against the provider's pricing page.
 *
 * The exemption tables and `classify` are exported: scripts/sync-modelsdev.mjs
 * reuses them so a models.dev cross-check never proposes a price for a channel
 * this audit deliberately leaves unpriced.
 *
 * Usage: node scripts/audit-pricing.mjs [--check]
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getPricingForModel, PROVIDER_PRICING, MODEL_PRICING, PATTERN_PRICING, matchPattern,
} from "../open-sse/providers/pricing.js";

// Not USD-per-token priced: credit/free-plan aggregator channels + pure media
// vendors whose registries carry no per-entry kind field (elevenlabs=TTS,
// jina-ai=embeddings, polly/playht/inworld=TTS, agnes-ai=image).
export const EXEMPT_PROVIDERS = new Set([
  "opencode-go", "qoder", "qoder-cn", "kilo-gateway",        // credit plans
  "codebuddy-intl", "codebuddy-cn",                          // credit multipliers, no USD rate sheet
  "ollama", "lmstudio", "vllm",                              // local, free
  "cloudflare-ai", "github", "bazaarlink", "opencode", "iflow", // free tiers
  "cline", "clinepass", "cursor", "windsurf", "devin-cli", "commandcode", // subscription/credit plans
  "elevenlabs", "jina-ai", "aws-polly", "playht", "inworld", "agnes-ai", "agnes-ai-cn", // media-only vendors
  "junie",                                                   // JetBrains 免费车道（Junie Lite，免费按 0 计费）
  "xiaohuanxiong",                                           // 小浣熊按积分计费（任务/邀请发放），无 USD rate sheet
  "orcaterm",                                                // OrcaTerm 腾讯云账号车道（模型目录随账号，无 USD rate sheet）
]);
// Registry `category` is the ACCESS kind (apikey/oauth/…), not modality — but
// freeTier really does mean "no USD rate sheet" → provider-wide exemption.
export const FREE_TIER_CATEGORY = "freeTier";
// Real model ids that exist per modality-tier or alias and cannot be flattened
// into {input,output} honestly. Keep short; each entry needs a reason.
export const EXEMPT_MODELS = new Map([
  ["qwen3.5-omni-plus", "per-modality pricing (text/audio in/out differ) — flat table would mislead"],
  ["qwen3.8-omni-flash", "per-modality pricing"],
  ["qwen3.8-flash-next", "opencode-go alias, no official rate sheet entry"],
]);

export function classify(provider, model) {
  if (provider && PROVIDER_PRICING[provider]?.[model]) return { kind: "provider" };
  const base = model.includes("/") ? model.split("/").pop() : model;
  if (MODEL_PRICING[model] || MODEL_PRICING[base]) return { kind: "exact" };
  for (const { pattern } of PATTERN_PRICING) {
    if (pattern && (matchPattern(pattern, base) || matchPattern(pattern, model))) return { kind: "pattern", pattern };
  }
  return { kind: "none" };
}

/** Every LLM-kind registry row as {provider, model, kind}, exemptions applied. */
export function registryLlmRows() {
  const dir = new URL("../open-sse/providers/registry/", import.meta.url);
  const rows = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js") && x !== "index.js")) {
    const provider = f.replace(/\.js$/, "");
    if (EXEMPT_PROVIDERS.has(provider)) continue;
    const text = readFileSync(new URL(f, dir), "utf8");
    const catm = text.match(/\bcategory:\s*"([^"]+)"/);
    if (catm && catm[1] === FREE_TIER_CATEGORY) continue; // free hosted — no USD sheet
    const start = text.indexOf("models: [");
    if (start === -1) continue;
    const end = text.indexOf("\n  ],", start);
    const block = text.slice(start, end === -1 ? start + 20000 : end);
    // per-object scan: kind may live on a different line than id (multi-line
    // entries), so match whole objects, not single lines.
    for (const obj of block.matchAll(/\{[^{}]*\}/g)) {
      const mid = obj[0].match(/\bid:\s*"([^"]+)"/);
      if (!mid) continue;
      const kindm = obj[0].match(/\bkind:\s*"([^"]+)"/);
      rows.push({ provider, model: mid[1], kind: kindm ? kindm[1] : "llm" });
    }
    // bare-string entries ("id",) — object-less rows are always chat/LLM ids
    const withoutObjects = block.replace(/\{[^{}]*\}/g, "");
    for (const m of withoutObjects.matchAll(/^\s{4,8}"([^"]+)",\s*(?:\/\/.*)?$/gm)) {
      rows.push({ provider, model: m[1], kind: "llm" });
    }
  }
  return rows.filter((r) => r.kind === "llm" || !r.kind);
}

function main() {
  const llms = registryLlmRows();
  const noPrice = [];
  const viaPattern = [];
  for (const r of llms) {
    if (EXEMPT_PROVIDERS.has(r.provider)) continue;
    if (EXEMPT_MODELS.has(r.model)) continue;
    const c = classify(r.provider, r.model);
    if (c.kind === "none") noPrice.push(`${r.model}  [${r.provider}]`);
    else if (c.kind === "pattern") viaPattern.push(`${r.model}  [${r.provider}]  <- ${c.pattern}`);
  }
  const dedupe = (a) => [...new Map(a.map((x) => [x.split("  ")[0], x])).values()].sort();

  console.log(`LLM rows checked: ${llms.length} (unique ids: ${new Set(llms.map((r) => r.model)).size})`);
  console.log(`\n[A] NO PRICING (${dedupe(noPrice).length}) — gate:`);
  for (const x of dedupe(noPrice)) console.log("  " + x);
  console.log(`\n[B] wildcard-only (${dedupe(viaPattern).length}) — report only, reconcile with official sheets:`);
  for (const x of dedupe(viaPattern)) console.log("  " + x);

  if (process.argv.includes("--check") && dedupe(noPrice).length) {
    console.log("\n❌ pricing invariant broken");
    process.exit(1);
  }
  if (!dedupe(noPrice).length) console.log("\n✅ no unpriced LLM models outside the exemption list");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
