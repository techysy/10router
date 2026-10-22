import { describe, it, expect, vi } from "vitest";

// Issue #73 — combo `router` strategy decision core. The router is advisory:
// a decision model (System One lane) picks which combo member answers; any
// failure mode (unknown model, no credentials, decision error, timeout,
// off-catalog answer) must degrade to the normal fallback order, never 4xx.

const mockAuth = {
  getProviderCredentials: vi.fn(),
  clearAccountError: vi.fn(async () => {}),
};
const mockModel = { getModelInfo: vi.fn() };
const mockCore = { handleSystemoneCore: vi.fn() };
const mockUsage = {
  saveRequestUsage: vi.fn(async () => {}),
  // health lookup goes through the same shim; default to no traffic data
  getUsageDashboard: vi.fn(async () => ({ models: [] })),
};

vi.mock("../../src/sse/services/auth.js", () => mockAuth);
vi.mock("../../src/sse/services/model.js", () => mockModel);
vi.mock("open-sse/handlers/systemoneCore.js", () => mockCore);
vi.mock("@/lib/usageDb.js", () => mockUsage);

const {
  buildRouterDecisionPayload,
  parseRouterDecisionResult,
  guardRouterPick,
  FLAKY_HEALTH_THRESHOLD,
} = await import("../../open-sse/services/combo/router.js");
const { runRouterDecision } = await import("../../src/sse/handlers/comboRouter.js");

const CANDIDATES = ["gemini/gemini-2.5-pro", "claude/claude-sonnet-4.5", "gpt/gpt-5.2"];

function chatBody(overrides = {}) {
  return {
    messages: [
      { role: "user", content: "fix this screenshot-based bug report" },
    ],
    stream: true,
    ...overrides,
  };
}

describe("buildRouterDecisionPayload", () => {
  it("state carries the last user turn, streaming intent, and every candidate", () => {
    const { state, questions } = buildRouterDecisionPayload(chatBody(), CANDIDATES);
    expect(state).toContain("fix this screenshot-based bug report");
    expect(state).toContain("streaming");
    for (const c of CANDIDATES) expect(state).toContain(c);
    expect(questions.pick_model.type).toBe("choice");
    // Drex rejects `options` ("must be an object with options"); the answer
    // vocabulary is the KEY SET of `criteria`.
    expect(questions.pick_model.options).toBeUndefined();
    expect(Object.keys(questions.pick_model.criteria)).toEqual(CANDIDATES);
  });

  it("criteria keys stay unique when two ids share a 64-char prefix", () => {
    const long = "p/" + "x".repeat(80);
    const candidates = [`${long}a`, `${long}b`];
    const { questions } = buildRouterDecisionPayload(chatBody(), candidates);
    expect(Object.keys(questions.pick_model.criteria)).toEqual(candidates);
    // every label round-trips through the membership guard untouched
    for (const c of candidates) expect(guardRouterPick(c, candidates)).toBe(c);
  });

  it("tool intent is surfaced when tools are offered", () => {
    const body = chatBody({ tools: [{ function: { name: "web_search" } }], tool_choice: "auto" });
    const { state } = buildRouterDecisionPayload(body, CANDIDATES);
    expect(state).toContain("tool/function calling");
    expect(state).toContain("web_search");
  });

  it("member resolver enriches the card; missing resolver info degrades to bare id", () => {
    const resolver = (id) => id === CANDIDATES[0]
      ? { name: "Gemini 2.5 Pro", vision: true, contextWindow: 1048576 }
      : null;
    const { state } = buildRouterDecisionPayload(chatBody(), CANDIDATES, resolver);
    expect(state).toMatch(/gemini-2\.5-pro \(Gemini 2\.5 Pro, ~1049k ctx, vision\)/);
    expect(state).toContain("- claude/claude-sonnet-4.5 (claude/claude-sonnet-4.5)");
  });

  it("healthy members render no health attribute; cold members are not penalised", () => {
    // Health is an exclusion signal only: a healthy member and a member with
    // no traffic data must look identical on the card, so "no data" can never
    // read as "bad data" to the decision model.
    const resolver = (id) => {
      if (id === CANDIDATES[0]) return { name: "Gemini 2.5 Pro", vision: true, health: 91, successRate: 97 };
      if (id === CANDIDATES[1]) return { name: "Sonnet", tools: true }; // cold: no health at all
      return { name: "GPT", health: 85, successRate: 99 };
    };
    const { state } = buildRouterDecisionPayload(chatBody(), CANDIDATES, resolver);
    expect(state).not.toContain("91/100");
    expect(state).not.toContain("85/100");
    expect(state).not.toContain("recently flaky:");
    expect(state).toContain("- gemini/gemini-2.5-pro (Gemini 2.5 Pro, vision)");
    expect(state).toContain("- claude/claude-sonnet-4.5 (Sonnet, tools)");
  });

  it("a flaky member is marked; the mark carries the score and is the only health signal", () => {
    const resolver = (id) =>
      id === CANDIDATES[0] ? { name: "Gemini", health: 41, successRate: 62 } : { name: "Sonnet", tools: true };
    const { state } = buildRouterDecisionPayload(chatBody(), CANDIDATES, resolver);
    expect(state).toContain("[recently flaky: 41/100 over recent traffic, 62% success]");
    // the healthy/cold member stays unmarked: only one member line carries a mark
    expect(state.match(/\[recently flaky:/g)).toHaveLength(1);
  });

  it("the threshold boundary (70) is not marked", () => {
    const resolver = () => ({ name: "M", health: FLAKY_HEALTH_THRESHOLD, successRate: 80 });
    const { state } = buildRouterDecisionPayload(chatBody(), CANDIDATES, resolver);
    expect(state).not.toContain("[recently flaky:");
  });

  it("state states the decision rule: an unmarked member is not a penalty", () => {
    const { state } = buildRouterDecisionPayload(chatBody(), CANDIDATES);
    expect(state).toContain("absence of a mark is NOT a quality penalty");
    expect(state).toContain("[recently flaky] should be avoided when an equally capable unmarked member exists");
  });

  it("handles empty messages without throwing", () => {
    const { state } = buildRouterDecisionPayload({}, CANDIDATES);
    expect(state).toContain("(no text content in this turn)");
  });
});

describe("parseRouterDecisionResult", () => {
  it("reads the canonical answers.pick_model.choice shape", () => {
    expect(parseRouterDecisionResult({
      answers: { pick_model: { type: "choice", choice: "claude/claude-sonnet-4.5" } },
    })).toBe("claude/claude-sonnet-4.5");
  });

  it("reads string-array choices and {text} entries", () => {
    expect(parseRouterDecisionResult({
      answers: { pick_model: { choices: ["gpt/gpt-5.2"] } },
    })).toBe("gpt/gpt-5.2");
    expect(parseRouterDecisionResult({
      answers: { pick_model: { choices: [{ text: "gpt/gpt-5.2" }] } },
    })).toBe("gpt/gpt-5.2");
  });

  it("falls back to the first answer when pick_model key is absent", () => {
    expect(parseRouterDecisionResult({
      answers: { whatever: { type: "choice", choice: "gemini/gemini-2.5-pro" } },
    })).toBe("gemini/gemini-2.5-pro");
  });

  it("returns null on unusable payloads", () => {
    expect(parseRouterDecisionResult(null)).toBeNull();
    expect(parseRouterDecisionResult({ answers: {} })).toBeNull();
    expect(parseRouterDecisionResult({ answers: { pick_model: 42 } })).toBeNull();
  });
});

describe("guardRouterPick", () => {
  it("accepts exact member ids", () => {
    expect(guardRouterPick("claude/claude-sonnet-4.5", CANDIDATES)).toBe("claude/claude-sonnet-4.5");
  });

  it("accepts a unique bare-tail answer, rejects ambiguous or unknown", () => {
    expect(guardRouterPick("gpt-5.2", CANDIDATES)).toBe("gpt/gpt-5.2");
    expect(guardRouterPick("gemini-2.5-pro", ["gemini/gemini-2.5-pro", "other/gemini-2.5-pro"])).toBeNull();
    expect(guardRouterPick("not-a-member", CANDIDATES)).toBeNull();
    expect(guardRouterPick("", CANDIDATES)).toBeNull();
    expect(guardRouterPick(null, CANDIDATES)).toBeNull();
  });
});

describe("runRouterDecision (orchestrator)", () => {
  it("returns the guarded pick on a healthy decision", async () => {
    mockModel.getModelInfo.mockImplementation(async (m) =>
      m === "drex/drex-v1.5" ? { provider: "drex", model: "drex-v1.5" } : { provider: m.split("/")[0], model: m.split("/").slice(1).join("/") }
    );
    mockAuth.getProviderCredentials.mockResolvedValue({ connectionId: "c1", accessToken: "t" });
    mockCore.handleSystemoneCore.mockResolvedValue({
      success: true,
      usage: { prompt_tokens: 120, completion_tokens: 8 },
      response: new Response(JSON.stringify({
        answers: { pick_model: { type: "choice", choice: "claude/claude-sonnet-4.5" } },
      })),
    });

    const picked = await runRouterDecision({
      routerModel: "drex/drex-v1.5",
      body: chatBody(),
      candidates: CANDIDATES,
    });
    expect(picked).toBe("claude/claude-sonnet-4.5");
    // decision cost lands in the usage ledger (design point 4)
    expect(mockUsage.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "drex",
      tokens: expect.objectContaining({ total_tokens: 128 }),
    }));
  });

  it("degrades to null for: no routerModel, unknown model, no credentials, core failure, off-catalog answer", async () => {
    mockUsage.saveRequestUsage.mockClear();

    // no routerModel set
    expect(await runRouterDecision({ routerModel: "", body: chatBody(), candidates: CANDIDATES })).toBeNull();

    // routerModel resolves to nothing (empty getModelInfo result)
    mockModel.getModelInfo.mockResolvedValue({});
    expect(await runRouterDecision({ routerModel: "ghost/g-1", body: chatBody(), candidates: CANDIDATES })).toBeNull();

    // no usable credentials
    mockModel.getModelInfo.mockResolvedValue({ provider: "drex", model: "drex-v1.5" });
    mockAuth.getProviderCredentials.mockResolvedValue(null);
    expect(await runRouterDecision({ routerModel: "drex/drex-v1.5", body: chatBody(), candidates: CANDIDATES })).toBeNull();

    mockAuth.getProviderCredentials.mockResolvedValue({ connectionId: "c1", accessToken: "t" });
    mockCore.handleSystemoneCore.mockResolvedValue({ success: false, status: 502, error: "upstream down" });
    expect(await runRouterDecision({ routerModel: "drex/drex-v1.5", body: chatBody(), candidates: CANDIDATES })).toBeNull();

    mockCore.handleSystemoneCore.mockResolvedValue({
      success: true,
      usage: null,
      response: new Response(JSON.stringify({
        answers: { pick_model: { type: "choice", choice: "some-hallucinated-model" } },
      })),
    });
    expect(await runRouterDecision({ routerModel: "drex/drex-v1.5", body: chatBody(), candidates: CANDIDATES })).toBeNull();
  });

  it("a throwing core never propagates — router is advisory", async () => {
    mockModel.getModelInfo.mockResolvedValue({ provider: "drex", model: "drex-v1.5" });
    mockAuth.getProviderCredentials.mockResolvedValue({ connectionId: "c1", accessToken: "t" });
    mockCore.handleSystemoneCore.mockRejectedValue(new Error("socket exploded"));
    await expect(
      runRouterDecision({ routerModel: "drex/drex-v1.5", body: chatBody(), candidates: CANDIDATES }),
    ).resolves.toBeNull();
  });

  it("a hung decision times out to null (never waits on the caller)", async () => {
    process.env.COMBO_ROUTER_DECISION_TIMEOUT_MS = "150";
    // Re-import to pick up the env override at module scope.
    vi.resetModules();
    const mod = await import("../../src/sse/handlers/comboRouter.js");
    mockModel.getModelInfo.mockResolvedValue({ provider: "drex", model: "drex-v1.5" });
    mockAuth.getProviderCredentials.mockResolvedValue({ connectionId: "c1", accessToken: "t" });
    mockCore.handleSystemoneCore.mockReturnValue(new Promise(() => {})); // never settles
    const t0 = Date.now();
    const picked = await mod.runRouterDecision({ routerModel: "drex/drex-v1.5", body: chatBody(), candidates: CANDIDATES });
    expect(picked).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
    delete process.env.COMBO_ROUTER_DECISION_TIMEOUT_MS;
  });
});
