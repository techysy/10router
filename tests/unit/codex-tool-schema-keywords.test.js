import { describe, expect, it } from "vitest";
import {
  stripCodexUnsupportedKeywords,
  stripCodexUnsupportedPatterns,
  STRIP_KEYS,
} from "../../open-sse/utils/codexToolSchema.js";

// 2026-11-18, ZCode 77-tool 400: Codex 的 responses 校验器在 pattern 之外还拒
// 一批 JSON Schema 2020-12 关键字(用户清单来自真机 400 + AWS 手工 patch
// chunks/{5210,2380}.js 的同款列表;覆盖安装会冲掉手工 patch,故落到 dispatch
// 路径的清洗器)。$ref/$defs 保留(可正常解析);properties 的键是属性名,
// 不会被关键字清单误伤。

const ALL_KEYS = {
  type: "object",
  properties: {
    q: { type: "string", pattern: "^[a-z]+$" },
    flag: { uniqueItems: true, contains: { type: "string" } },
    arr: { type: "array", additionalItems: false, minContains: 1, maxContains: 3, contains: { type: "number" } },
    weird: { unevaluatedProperties: false, unevaluatedItems: false, propertyNames: { pattern: "^x" }, patternProperties: { "^x": {} } },
    dep: { dependentSchemas: {}, dependentRequired: ["a"] },
    ref: { $ref: "#/$defs/thing" },
    comment: { $comment: "why", $schema: "https://json-schema.org/draft/2020-12/schema" },
  },
  $defs: { thing: { type: "string", uniqueItems: true } },
  additionalItems: false,
};

describe("stripCodexUnsupportedKeywords — ZCode 77-tool 400 修复", () => {
  it("strips every keyword in the list, recursively through properties/items", () => {
    const stats = { removed: 0, removedKeys: 0 };
    const out = stripCodexUnsupportedKeywords(ALL_KEYS, stats);
    const walk = (n, acc = []) => {
      if (!n || typeof n !== "object") return acc;
      for (const [k, v] of Object.entries(n)) {
        acc.push(k);
        walk(v, acc);
      }
      return acc;
    };
    const keys = new Set(walk(out));
    for (const k of STRIP_KEYS) expect(keys.has(k), k).toBe(false);
    // 计数:flag 2 + arr 4 + weird 4 + dep 2 + comment 2 + 顶层 additionalItems 1
    // + $defs.thing.uniqueItems 1 = 16($defs 走普通递归,同样被剥)
    expect(stats.removedKeys).toBe(16);
  });

  it("keeps $ref / $defs and their contents", () => {
    const out = stripCodexUnsupportedKeywords(ALL_KEYS);
    expect(out.$defs).toBeDefined();
    expect(out.properties.ref.$ref).toBe("#/$defs/thing");
    expect(out.properties.ref.uniqueItems).toBeUndefined();
  });

  it("keeps properties keys intact even when they resemble keywords", () => {
    const out = stripCodexUnsupportedKeywords({
      properties: { contains: { type: "string" }, uniqueItems: { type: "boolean" } },
    });
    expect(out.properties.contains).toEqual({ type: "string" });
    expect(out.properties.uniqueItems).toEqual({ type: "boolean" });
  });

  it("returns the same reference for an already-clean schema (copy-on-write)", () => {
    const clean = { type: "object", properties: { a: { type: "string" } } };
    expect(stripCodexUnsupportedKeywords(clean)).toBe(clean);
  });

  it("still strips unicode-escape patterns alongside keyword stripping", () => {
    // JS 源码 \\p = 字符串 \p(单反斜杠)= odd 个反斜杠 → Codex 校验器拒的形态。
    const stats = { removed: 0, removedKeys: 0 };
    const out = stripCodexUnsupportedKeywords(
      { properties: { p: { type: "string", pattern: "^(?!__.*__$)[^\\p{Cc}\\p{Cf}]{1,3}$", uniqueItems: true } } },
      stats,
    );
    expect(out.properties.p.pattern).toBeUndefined();
    expect(out.properties.p.uniqueItems).toBeUndefined();
    expect(stats.removed).toBe(1);
    expect(stats.removedKeys).toBe(1);
  });

  it("stripCodexUnsupportedPatterns now also strips keywords (legacy callers covered)", () => {
    const out = stripCodexUnsupportedPatterns({ properties: { a: { uniqueItems: true } } });
    expect(out.properties.a.uniqueItems).toBeUndefined();
  });
});
