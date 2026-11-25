import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const src = readFileSync(abs("src/shared/components/ModelSelectModal.js"), "utf8");

describe("ModelSelectModal connected providers filter", () => {
  it("initializes onlyConnected state with default true and localStorage persistence", () => {
    expect(src).toContain("onlyConnected");
    expect(src).toContain("modelSelectOnlyConnected");
  });

  it("filters out unconnected groups when onlyConnected is true", () => {
    expect(src).toMatch(/if\s*\(\s*onlyConnected\s*&&\s*!group\.isConnected\s*\)\s*return/);
  });

  it("renders checkbox with translated 'Connected providers only' label", () => {
    expect(src).toContain('translate("Connected providers only")');
    expect(src).toContain('type="checkbox"');
    expect(src).toContain("checked={onlyConnected}");
  });

  it("records isConnected flag on all groups including passthrough and custom providers", () => {
    expect(src).toContain("isConnected,");
  });

  it("excludes hidden no-auth providers (e.g. devin-cli) when unconfigured", () => {
    expect(src).toContain("FREE_PROVIDERS[id].noAuth && !FREE_PROVIDERS[id].hidden");
    expect(src).toContain("if (providerInfo.hidden && !activeConnectionIds.includes(providerId)) return;");
  });
});
