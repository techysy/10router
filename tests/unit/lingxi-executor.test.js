import { describe, expect, it } from "vitest";
import {
  flattenMessages,
  resolveUpstreamFields,
  normalizeCookie,
  parseLingxiSseFrame,
  readLingxiEvents,
  __test__,
} from "../../open-sse/executors/lingxi.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";

const { AUTH_RESULTS, PLAN_MODELS } = __test__;

describe("lingxi registry entry", () => {
  it("is registered in the provider registry with webCookie category", () => {
    const entry = REGISTRY.find((p) => p.id === "lingxi");
    expect(entry).toBeTruthy();
    expect(entry.category).toBe("webCookie");
    expect(entry.authType).toBe("cookie");
    expect(entry.transport.baseUrl).toContain("/solution/api/aigc/v3/assistant/sessions");
  });

  it("exposes the plans-endpoint model ids (passthrough)", () => {
    const entry = REGISTRY.find((p) => p.id === "lingxi");
    const ids = entry.models.map((m) => m.id);
    expect(ids).toContain("auto");
    expect(ids).toContain("deepseek-v4.1-flash");
    expect(ids).toContain("qwen3.8_flash");
    expect(ids).toContain("kimi-k3");
    expect(ids).toContain("plan_pro");
    expect(ids).toContain("plan_max");
  });

  it("is resolvable through PROVIDER_MODELS alias routing", () => {
    const models = PROVIDER_MODELS["lingxi"] || PROVIDER_MODELS["lx"];
    expect(models?.length).toBeGreaterThan(0);
  });
});

describe("lingxi executor registration", () => {
  it("has a specialized executor (not DefaultExecutor fallback)", () => {
    expect(hasSpecializedExecutor("lingxi")).toBe(true);
    const e = getExecutor("lingxi");
    expect(e.constructor.name).toBe("LingxiExecutor");
    // alias
    expect(getExecutor("lx").constructor.name).toBe("LingxiExecutor");
  });
});

describe("lingxi flattenMessages", () => {
  it("passes a single user message through verbatim", () => {
    expect(flattenMessages([{ role: "user", content: "你好" }])).toBe("你好");
  });

  it("flattens array content to text parts", () => {
    const q = flattenMessages([
      { role: "user", content: [{ type: "text", text: "part1" }, { type: "image_url", image_url: {} }, { type: "text", text: "part2" }] },
    ]);
    expect(q).toBe("part1\npart2");
  });

  it("prepends system + history turns as role-prefixed context, last user turn verbatim", () => {
    const q = flattenMessages([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "final ask" },
    ]);
    expect(q).toBe("system: be terse\n\nuser: hi\n\nassistant: hello\n\nfinal ask");
  });

  it("treats developer as system", () => {
    const q = flattenMessages([
      { role: "developer", content: "rules" },
      { role: "user", content: "q" },
    ]);
    expect(q).toBe("system: rules\n\nq");
  });

  it("drops empty messages", () => {
    const q = flattenMessages([
      { role: "user", content: "  " },
      { role: "assistant", content: [{ type: "text", text: "" }] },
      { role: "user", content: "real" },
    ]);
    expect(q).toBe("real");
  });

  it("returns empty string for missing messages", () => {
    expect(flattenMessages(undefined)).toBe("");
    expect(flattenMessages([])).toBe("");
  });
});

describe("lingxi resolveUpstreamFields", () => {
  it("auto model sends no expect_model", () => {
    const f = resolveUpstreamFields("auto", {});
    expect(f.expect_model).toBeUndefined();
    expect(f.current_mode).toBeUndefined();
  });

  it("maps regular model ids to expect_model without plan mode", () => {
    const f = resolveUpstreamFields("kimi-k3", {});
    expect(f.expect_model).toBe("kimi-k3");
    expect(f.current_mode).toBeUndefined();
  });

  it("switches plan_pro/plan_max into plan mode", () => {
    for (const m of ["plan_pro", "plan_max"]) {
      const f = resolveUpstreamFields(m, {});
      expect(f.expect_model).toBe(m);
      expect(f.current_mode).toBe("plan");
    }
    expect(PLAN_MODELS.size).toBe(2);
  });

  it("honors explicit thinking param when valid", () => {
    expect(resolveUpstreamFields("auto", { thinking: "enabled" }).thinking).toBe("enabled");
    expect(resolveUpstreamFields("auto", { thinking: "disabled" }).thinking).toBe("disabled");
    expect(resolveUpstreamFields("auto", { thinking: "auto" }).thinking).toBe("auto");
    // invalid values fall through to reasoning_effort mapping
    expect(resolveUpstreamFields("auto", { thinking: "bogus" }).thinking).toBe("disabled");
  });

  it("maps reasoning_effort to thinking on/off", () => {
    expect(resolveUpstreamFields("auto", { reasoning_effort: "high" }).thinking).toBe("enabled");
    expect(resolveUpstreamFields("auto", { reasoning_effort: "none" }).thinking).toBe("disabled");
    expect(resolveUpstreamFields("auto", { reasoning_effort: "minimal" }).thinking).toBe("disabled");
    expect(resolveUpstreamFields("auto", {}).thinking).toBe("disabled");
  });
});

describe("lingxi normalizeCookie", () => {
  it("passes a raw Cookie header through", () => {
    expect(normalizeCookie("wps_sid=abc; kso_sid=def")).toBe("wps_sid=abc; kso_sid=def");
  });

  it("converts exported cookies JSON array to a header", () => {
    expect(normalizeCookie('[{"name":"wps_sid","value":"abc"},{"name":"uid","value":"123"}]')).toBe(
      "wps_sid=abc; uid=123",
    );
  });

  it("returns empty for falsy input", () => {
    expect(normalizeCookie("")).toBe("");
    expect(normalizeCookie(null)).toBe("");
  });
});

describe("lingxi SSE frame parsing", () => {
  it("parses event + JSON data", () => {
    const f = parseLingxiSseFrame('event:execution\ndata:{"type":"text","data":"hi"}');
    expect(f.event).toBe("execution");
    expect(f.data).toEqual({ type: "text", data: "hi" });
  });

  it("parses aigc finish frame with empty data", () => {
    const f = parseLingxiSseFrame("event:finish\ndata:");
    expect(f.event).toBe("finish");
    expect(f.data).toBeNull();
  });

  it("joins multi-line data before parsing", () => {
    // data lines are concatenated with "\n" first, then JSON-parsed —
    // a frame split mid-object across two data: lines still parses
    const f = parseLingxiSseFrame('event:execution\ndata:{"a":\ndata:1}');
    expect(f.event).toBe("execution");
    expect(f.data).toEqual({ a: 1 });
    expect(f.raw).toBe('{"a":\n1}');
  });
});

describe("lingxi SSE event stream", () => {
  function sseBody(frames) {
    return new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(frames.join("\n\n")));
        c.close();
      },
    });
  }

  async function collect(body, signal) {
    const out = [];
    for await (const ev of readLingxiEvents(body, signal)) out.push(ev);
    return out;
  }

  it("extracts content deltas from type:text frames", async () => {
    const events = await collect(
      sseBody([
        'event:execution\ndata:{"type":"user","data":{}}',
        'event:execution\ndata:{"type":"text_start","data":""}',
        'event:execution\ndata:{"type":"text","data":"你"}',
        'event:execution\ndata:{"type":"text","data":"好"}',
        'event:execution\ndata:{"type":"text_end","data":""}',
        'event:aigc\ndata:{"type":"end","data":null}',
        "event:finish\ndata:",
      ]),
    );
    const deltas = events.filter((e) => e.delta).map((e) => e.delta);
    expect(deltas.join("")).toBe("你好");
    expect(events.some((e) => e.done)).toBe(true);
  });

  it("extracts reasoning from type:reasoning frames (data.text)", async () => {
    const events = await collect(
      sseBody([
        'event:execution\ndata:{"type":"reasoning","data":{"text":"think part 1","reasoning_time":0}}',
        'event:execution\ndata:{"type":"reasoning","data":{"text":"think part 2","reasoning_time":0}}',
        'event:execution\ndata:{"type":"text","data":"answer"}',
        'event:aigc\ndata:{"type":"end","data":null}',
      ]),
    );
    expect(events.filter((e) => e.reasoning).map((e) => e.reasoning).join("")).toBe("think part 1think part 2");
    expect(events.find((e) => e.delta)?.delta).toBe("answer");
  });

  it("surfaces in-stream auth errors as error events with result", async () => {
    const events = await collect(
      sseBody([
        'event:error\ndata:{"hint":"用户无权限","msg":"服务异常","result":"UserUnauthorized"}',
        "event:finish\ndata:",
      ]),
    );
    const err = events.find((e) => e.error);
    expect(err).toBeTruthy();
    expect(err.error.result).toBe("UserUnauthorized");
    expect(AUTH_RESULTS.has(err.error.result)).toBe(true);
    expect(events.some((e) => e.done)).toBe(true);
  });

  it("treats non-auth error frames as generic errors and keeps going", async () => {
    const events = await collect(
      sseBody([
        'event:error\ndata:{"hint":"审核未通过","result":"AuditFailed"}',
        'event:execution\ndata:{"type":"text","data":"partial"}',
        "event:finish\ndata:",
      ]),
    );
    expect(events.find((e) => e.error)?.error.result).toBe("AuditFailed");
    expect(AUTH_RESULTS.has("AuditFailed")).toBe(false);
    expect(events.find((e) => e.delta)?.delta).toBe("partial");
  });

  it("swallows progress chatter (websearch/recommend)", async () => {
    const events = await collect(
      sseBody([
        'event:execution\ndata:{"type":"websearch_start","data":""}',
        'event:execution\ndata:{"type":"websearch","data":{"url":"https://x"}}',
        'event:execution\ndata:{"type":"websearch_end","data":{}}',
        'event:execution\ndata:{"type":"recommend_start","data":""}',
        'event:execution\ndata:{"type":"recommend","data":"[\\"a\\"]"}',
        'event:execution\ndata:{"type":"recommend_end","data":null}',
        'event:execution\ndata:{"type":"text","data":"ok"}',
        "event:finish\ndata:",
      ]),
    );
    expect(events.filter((e) => e.delta).map((e) => e.delta).join("")).toBe("ok");
    expect(events.every((e) => !e.error)).toBe(true);
  });

  it("handles frames split across chunk boundaries", async () => {
    const enc = new TextEncoder();
    const full = 'event:execution\ndata:{"type":"text","data":"split-delta"}\n\nevent:finish\ndata:\n\n';
    const half = Math.floor(full.length / 2);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(full.slice(0, half)));
        c.enqueue(enc.encode(full.slice(half)));
        c.close();
      },
    });
    const events = await collect(body);
    expect(events.find((e) => e.delta)?.delta).toBe("split-delta");
    expect(events.some((e) => e.done)).toBe(true);
  });
});
