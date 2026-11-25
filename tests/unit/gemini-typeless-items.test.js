// Regression: a type-less, items-only tool parameter schema (legal "array of X"
// shorthand) used to be gutted by enforceTypeConstraints — items deleted, node
// left as {} — and addPlaceholders had already run, so Antigravity rejected the
// empty schema with 400. ensureObjectType now claims type:"array" first.
import { describe, it, expect } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

describe("cleanJSONSchemaForAntigravity — type-less items-only schema", () => {
  it("keeps items and lands as a valid array schema instead of an empty {}", () => {
    const out = cleanJSONSchemaForAntigravity({ items: { type: "string" } });
    expect(out.type).toBe("array");
    expect(out.items).toEqual({ type: "string" });
  });

  it("nested items-only schemas survive inside properties too", () => {
    const out = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        tags: { items: { type: "string" } },
      },
      required: ["tags"],
    });
    const tags = out.properties.tags;
    expect(tags.type).toBe("array");
    expect(tags.items).toEqual({ type: "string" });
  });

  it("a truly empty schema still gets the placeholder object (existing behavior)", () => {
    const out = cleanJSONSchemaForAntigravity({});
    expect(out.type).toBe("object");
    expect(out.properties.reason).toBeTruthy();
  });
});
