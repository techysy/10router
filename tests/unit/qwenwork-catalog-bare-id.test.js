/**
 * QwenWork catalog route emits BARE model ids (2026-11-23 user report
 * 「数据完全是乱的」).
 *
 * /api/providers/[id]/models used to prefix qwenwork rows with the provider
 * id ("qwenwork/qwen4-max"). The provider page replaces its model list
 * wholesale with those rows (liveCatalogOnly) and then composes
 * `${alias}/${id}` for display/routing — producing double-prefixed values
 * ("qw/qwenwork/qwen4-max") that no resolver understands. Qoder keeps
 * prefixed ids because its page joins live rows back onto static ones by
 * bare key (mergeQoderLivePricing); QwenWork has no such join.
 *
 * Source guards pin: the route emits m.id verbatim, the combo picker strip
 * tolerates BOTH shapes (bare and legacy-prefixed), and the provider-page
 * import strips qwenwork(-cn)/ prefixes alongside the qoder ones.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const routeSrc = readFileSync(abs("src/app/api/providers/[id]/models/route.js"), "utf8");
const modalSrc = readFileSync(abs("src/shared/components/ModelSelectModal.js"), "utf8");
const pageSrc = readFileSync(abs("src/app/(dashboard)/dashboard/providers/[id]/page.js"), "utf8");

describe("QwenWork catalog route bare-id contract", () => {
  it("emits live ids verbatim — no provider-prefix interpolation", () => {
    const resolverBody = routeSrc.slice(
      routeSrc.indexOf("const resolveQwenWorkCatalog"),
      routeSrc.indexOf("const PROVIDER_MODELS_CONFIG")
    );
    expect(resolverBody).toContain("id: m.id");
    expect(resolverBody).not.toMatch(/id:\s*`\$\{connection\.provider\}\/\$\{m\.id\}`/);
  });

  it("documents why qoder keeps its prefix but qwenwork must not", () => {
    expect(routeSrc).toContain("mergeQoderLivePricing joins by bare key");
    expect(routeSrc).toContain("liveCatalogOnly");
  });

  it("combo picker strips the legacy provider prefix and composes the alias value", () => {
    expect(modalSrc).toMatch(/const livePrefix = `\$\{providerId\}\/`/);
    expect(modalSrc).toMatch(/m\.id\.startsWith\(livePrefix\)/);
    expect(modalSrc).toMatch(/value:\s*`\$\{alias\}\/\$\{modelKey\}`/);
  });

  it("provider-page import strips qoder AND qwenwork prefixes", () => {
    expect(pageSrc).toContain('replace(/^(?:qoder(-cn)?|qwenwork(-cn)?)\\//, "")');
  });
});
