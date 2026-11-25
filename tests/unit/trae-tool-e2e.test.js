// #108 executor 级集成验收：mock SOLO SSE 流（模型按注入格式输出 marker），跑
// execute() 全链，断言客户端拿到的是结构化 tool_calls delta + finish_reason
// = tool_calls——SDK 客户端无需任何特殊处理即可消费。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { proxyFetchMock } = vi.hoisted(() => ({ proxyFetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => proxyFetchMock(...args) }));

// mock SOLO SSE 流：plan_item 增量输出（含 marker 块跨 chunk 切开）→ token_usage → done
function sseResponse(parts) {
  const events = [];
  let acc = "";
  for (const p of parts) {
    acc += p;
    events.push(`event: plan_item\ndata: ${JSON.stringify({ id: "pi1", thought: acc })}\n\n`);
  }
  events.push(`event: token_usage\ndata: ${JSON.stringify({ prompt_tokens: 100, completion_tokens: 50 })}\n\n`);
  events.push("event: done\ndata: {}\n\n");
  const body = events.join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const TOOLS = [
  { type: "function", function: { name: "10R_Search", description: "搜索本机索引", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } } },
];

describe("#108 executor 级集成 — mock SOLO 流", () => {
  beforeEach(() => proxyFetchMock.mockReset());

  it("流式：模型输出 marker → 客户端收到结构化 tool_calls delta + finish_reason=tool_calls", async () => {
    const { default: TraeExecutor } = await import("../../open-sse/executors/trae.js");
    const exec = new TraeExecutor("trae-cn");
    proxyFetchMock.mockImplementation(async (url, init) => {
      const u = String(url);
      // createSession（POST /chat_sessions）与 events（GET .../events）分别 mock——
      // events URL 也含 /chat_sessions，必须先判 /events。
      if (u.includes("/events")) {
        // events 流：marker 跨 chunk 切开（每个 chunk 切在 marker 中间）
        const marker = '<|FunctionCallBegin|>[{"name":"10R_Search","parameters":{"q":"AI 新闻"}}]<|FunctionCallEnd|>';
        const head = "让我搜索一下。";
        return sseResponse([head, marker, " 已完成。"]);
      }
      if (u.includes("/chat_sessions")) {
        return new Response(JSON.stringify({ code: 0, data: { chat_session_id: "s1", message_id: "m1" } }), { status: 200 });
      }
      // events 流：marker 跨 chunk 切开（每个 chunk 切在 marker 中间）
      const marker = '<|FunctionCallBegin|>[{"name":"10R_Search","parameters":{"q":"AI 新闻"}}]<|FunctionCallEnd|>';
      const head = "让我搜索一下。";
      return sseResponse([head, marker, " 已完成。"]);
    });

    const { response } = await exec.execute({
      model: "glm-5.3-flashx",
      stream: true,
      credentials: { accessToken: "jwt", providerSpecificData: { site: "cn", userId: "u-1" } },
      signal: undefined,
      body: {
        messages: [{ role: "user", content: "搜新闻" }],
        tools: TOOLS,
      },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    if (process.env.TRAE_E2E_DEBUG) {
      // eslint-disable-next-line no-console
      console.log("E2E-SSE-RAW " + text.slice(0, 1200));
    }
    const deltas = [];
    let finish = null;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const j = JSON.parse(line.slice(6));
      const d = j.choices?.[0]?.delta || {};
      if (d.tool_calls) deltas.push(...d.tool_calls);
      if (d.content) deltas.push({ content: d.content });
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
    }
    // 客户端视角：结构化 tool_calls 到手，正文不含任何 marker 残片
    const tcs = deltas.filter((d) => d.function);   // 展开 push 的是 tc 本体（有 function 字段）
    const content = deltas.filter((d) => d.content).map((d) => d.content).join("");
    expect(tcs).toHaveLength(1);
    expect(tcs[0].function.name).toBe("10R_Search");
    expect(JSON.parse(tcs[0].function.arguments)).toEqual({ q: "AI 新闻" });
    expect(finish).toBe("tool_calls");
    expect(content).toContain("让我搜索一下");
    expect(content).toContain("已完成");
    expect(content).not.toContain("FunctionCall");
    // 多轮自洽：下一轮请求的 query 里应带 marker 形态历史（③ 历史透传）——
    // 由 trae-tool-protocol.test.js 的 serializeTraeToolHistory 用例覆盖。
  });

  it("非流式：marker → message.tool_calls + finish_reason=tool_calls", async () => {
    const { default: TraeExecutor } = await import("../../open-sse/executors/trae.js");
    const exec = new TraeExecutor("trae-cn");
    proxyFetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/events")) {
        return sseResponse(["直接调用。", '<|FunctionCallBegin|>[{"name":"10R_Search","parameters":{"q":"x"}}]<|FunctionCallEnd|>']);
      }
      // events URL 也含 /chat_sessions，必须后判
      return new Response(JSON.stringify({ code: 0, data: { chat_session_id: "s1", message_id: "m1" } }), { status: 200 });
    });
    const { response } = await exec.execute({
      model: "glm-5.3-flashx",
      stream: false,
      credentials: { accessToken: "jwt", providerSpecificData: { site: "cn", userId: "u-1" } },
      signal: undefined,
      body: { messages: [{ role: "user", content: "搜" }], tools: TOOLS },
    });
    const j = await response.json();
    const msg = j.choices[0].message;
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].function.name).toBe("10R_Search");
    expect(j.choices[0].finish_reason).toBe("tool_calls");
    expect(msg.content).not.toContain("FunctionCall");
  });

  it("无 tools 请求：marker 免疫（守卫 fail-open），finish_reason=stop", async () => {
    const { default: TraeExecutor } = await import("../../open-sse/executors/trae.js");
    const exec = new TraeExecutor("trae-cn");
    const markerText = '<|FunctionCallBegin|>[{"name":"whatever"}]<|FunctionCallEnd|>';
    proxyFetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/events")) {
        return sseResponse(["模型正文提到 ", markerText, " 原样保留。"]);
      }
      return new Response(JSON.stringify({ code: 0, data: { chat_session_id: "s1", message_id: "m1" } }), { status: 200 });
    });
    const { response } = await exec.execute({
      model: "glm-5.3-flashx",
      stream: false,
      credentials: { accessToken: "jwt", providerSpecificData: { site: "cn", userId: "u-1" } },
      signal: undefined,
      body: { messages: [{ role: "user", content: "hi" }] },   // 无 tools
    });
    const j = await response.json();
    expect(j.choices[0].message.content).toContain(markerText);
    expect(j.choices[0].finish_reason).toBe("stop");
  });
});
