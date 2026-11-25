// Trae 文本工具协议（traeToolProtocol.js, #108）—— 注入/出口恢复/历史透传三层，
// 协议参照 trae2api-hub（shuishuipingan）三层方案。守卫规则：marker 检出 +
// JSON 合法 + 名字 ∈ 声明集合，任一不满足 fail-open 原文透传。
import { describe, it, expect } from "vitest";

import {
  TRAE_TOOL_BEGIN,
  TRAE_TOOL_END,
  buildTraeToolPrompt,
  serializeTraeToolHistory,
  parseTraeToolCalls,
  TraeToolCallStreamRecover,
} from "../../open-sse/executors/traeToolProtocol.js";

const TOOLS = [
  { type: "function", function: { name: "10R_Search", description: "搜索本机索引", parameters: { type: "object", properties: { q: { type: "string" } } } } },
  { type: "function", function: { name: "read_file", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } } },
];
const NAMES = new Set(["10R_Search", "read_file"]);

const call = (name, params) => `${TRAE_TOOL_BEGIN}${JSON.stringify([{ name, parameters: params }])}${TRAE_TOOL_END}`;

describe("buildTraeToolPrompt", () => {
  it("注入块含完整 schema + 调用格式声明 + allowedNames", () => {
    const { prompt, allowedNames } = buildTraeToolPrompt(TOOLS);
    expect(prompt).toContain("10R_Search");
    expect(prompt).toContain('"parameters"');           // 完整 schema
    expect(prompt).toContain(TRAE_TOOL_BEGIN);          // 格式声明
    expect(allowedNames.has("10R_Search")).toBe(true);
    expect(allowedNames.size).toBe(2);
  });
  it("无 tools → 空 prompt", () => {
    const { prompt } = buildTraeToolPrompt([]);
    expect(prompt).toBe("");
  });
});

describe("parseTraeToolCalls（非流式出口恢复）", () => {
  it("正文 + marker 块 → 干净正文 + 结构化 calls", () => {
    const r = parseTraeToolCalls(`我先搜一下。\n${call("10R_Search", { q: "AI 新闻" })}`, NAMES);
    expect(r.content).toContain("我先搜一下");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].function.name).toBe("10R_Search");
    expect(JSON.parse(r.calls[0].function.arguments)).toEqual({ q: "AI 新闻" });
    expect(r.calls[0].id).toMatch(/^call_/);
  });

  it("纯 marker 块（无正文）→ content 为空白、calls 完整", () => {
    const r = parseTraeToolCalls(call("read_file", { path: "F:/x" }), NAMES);
    expect(r.content.trim()).toBe("");
    expect(r.calls[0].function.name).toBe("read_file");
  });

  // 守卫三连：fail-open 原文透传
  it("名字不在声明集合 → 原文透传（fail-open）", () => {
    const bad = call("hack_tool", {});
    const r = parseTraeToolCalls(`text ${bad}`, NAMES);
    expect(r.calls).toHaveLength(0);
    expect(r.content).toContain(bad);
  });
  it("坏 JSON → 原文透传", () => {
    const bad = `${TRAE_TOOL_BEGIN}[{name:x}]${TRAE_TOOL_END}`;
    const r = parseTraeToolCalls(`text ${bad}`, NAMES);
    expect(r.calls).toHaveLength(0);
    expect(r.content).toContain(bad);
  });
  it("未闭合 marker → 原文透传", () => {
    const unclosed = `${TRAE_TOOL_BEGIN}[{"name":"10R_Search","parameters":{}}]`;
    const r = parseTraeToolCalls(`text ${unclosed}`, NAMES);
    expect(r.calls).toHaveLength(0);
    expect(r.content).toContain(unclosed);
  });
  it("正文里『讨论 marker』不误判（无完整块）", () => {
    const r = parseTraeToolCalls("你可以用 <|FunctionCallBegin|> 的格式调用工具", NAMES);
    expect(r.calls).toHaveLength(0);
    expect(r.content).toContain("FunctionCallBegin");
  });
});

describe("TraeToolCallStreamRecover（流式状态机）", () => {
  const drain = (chunks) => {
    const rec = new TraeToolCallStreamRecover(NAMES);
    const out = [];
    for (const c of chunks) out.push(...rec.feed(c));
    out.push(...rec.flush());
    return out;
  };

  it("跨 delta 边界的 marker 前缀被 hold，正文与 calls 都完整", () => {
    const full = `思考中...\n${call("10R_Search", { q: "news" })} 完毕`;
    // 按 3 字符切——marker 一定跨边界
    const chunks = full.match(/.{1,3}/gs) || [];
    const out = drain(chunks);
    const content = out.filter((o) => o.content).map((o) => o.content).join("");
    expect(content).toContain("思考中...");
    expect(content).toContain("完毕");
    expect(content).not.toContain(TRAE_TOOL_BEGIN);
    const tc = out.filter((o) => o.tool_calls).flatMap((o) => o.tool_calls);
    expect(tc).toHaveLength(1);
    expect(tc[0].function.name).toBe("10R_Search");
    expect(tc[0].index).toBe(0);
  });

  it("两个连续调用 → index 0/1（多调用并行形态）", () => {
    const multi = `${TRAE_TOOL_BEGIN}${JSON.stringify([{ name: "10R_Search", parameters: { q: "a" } }, { name: "read_file", parameters: { path: "p" } }])}${TRAE_TOOL_END}`;
    const out = drain([multi]);
    const tc = out.filter((o) => o.tool_calls).flatMap((o) => o.tool_calls);
    expect(tc.map((c) => c.index)).toEqual([0, 1]);
    expect(tc.map((c) => c.function.name)).toEqual(["10R_Search", "read_file"]);
  });

  it("守卫：坏 JSON 在流式里也原样吐回", () => {
    const out = drain([`${TRAE_TOOL_BEGIN}not-json${TRAE_TOOL_END}`]);
    expect(out.some((o) => o.content && o.content.includes("not-json"))).toBe(true);
    expect(out.some((o) => o.tool_calls)).toBe(false);
  });

  it("flush 收尾：未闭合块吐回正文", () => {
    const rec = new TraeToolCallStreamRecover(NAMES);
    const out = [...rec.feed(`text ${TRAE_TOOL_BEGIN}[{"name":"10R_Search"`)];
    const fin = rec.flush();
    const all = [...out, ...fin].map((o) => o.content || "").join("");
    expect(all).toContain("text");
    expect(all).toContain(TRAE_TOOL_BEGIN);
  });

  it("空 allowedNames（无 tools 请求）→ 一切原样透传（零开销路径）", () => {
    const rec = new TraeToolCallStreamRecover(new Set());
    const src = call("10R_Search", {});
    const out = [...rec.feed(src), ...rec.flush()];
    const content = out.map((o) => o.content || "").join("");
    expect(content).toBe(src);
    expect(out.some((o) => o.tool_calls)).toBe(false);
  });
});

describe("serializeTraeToolHistory（多轮历史透传）", () => {
  it("assistant.tool_calls + tool 结果 → marker 形态回写", () => {
    const blocks = serializeTraeToolHistory([
      { role: "user", content: "搜新闻" },
      { role: "assistant", content: "好", tool_calls: [{ id: "call_1", type: "function", function: { name: "10R_Search", arguments: '{"q":"AI"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "搜索结果...很长的结果".repeat(60) },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("[Assistant]");
    expect(blocks[0]).toContain(TRAE_TOOL_BEGIN);
    expect(blocks[0]).toContain('"name":"10R_Search"');
    expect(blocks[0]).not.toContain('\\"name\\"');   // 参数不能二次转义
    expect(blocks[1]).toContain("[Tool Result call_1]");
    expect(blocks[1].length).toBeLessThanOrEqual(850);   // tool 结果截 800
  });

  it("普通消息不产出块", () => {
    const blocks = serializeTraeToolHistory([{ role: "user", content: "hi" }]);
    expect(blocks).toHaveLength(0);
  });
});
