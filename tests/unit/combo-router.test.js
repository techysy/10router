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
const mockLog = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const mockUsage = {
  saveRequestUsage: vi.fn(async () => {}),
  // health lookup goes through the same shim; default to no traffic data
  getUsageDashboard: vi.fn(async () => ({ models: [] })),
};

vi.mock("../../src/sse/services/auth.js", () => mockAuth);
vi.mock("../../src/sse/services/model.js", () => mockModel);
vi.mock("open-sse/handlers/systemoneCore.js", () => mockCore);
vi.mock("../../src/sse/utils/logger.js", () => mockLog);
vi.mock("@/lib/usageDb.js", () => mockUsage);

const {
  buildRouterDecisionPayload,
  parseRouterDecisionResult,
  parseRouterDecisionMeta,
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

describe("parseRouterDecisionMeta (logging only)", () => {
  it("reads confidence and the best alternative from a real drex choice answer", () => {
    const meta = parseRouterDecisionMeta({
      answers: {
        pick_model: {
          type: "choice",
          choice: "cbai/deepseek-v4.1-flash",
          confidence: 0.98,
          probabilities: {
            "cbai/deepseek-v4.1-flash": 0.98,
            "cbcn/deepseek-v4.1-flash": 0.015,
            "ag/gemini-3.8-flash-high": 0.005,
          },
        },
      },
    });
    expect(meta.confidence).toBeCloseTo(0.98, 5);
    // runner-up is the best NON-chosen label, never the chosen one
    expect(meta.runnerUp).toBe("cbcn/deepseek-v4.1-flash");
    expect(meta.runnerUpP).toBeCloseTo(0.015, 5);
  });

  it("a near-tie is visible: runner-up carries the competing mass", () => {
    const meta = parseRouterDecisionMeta({
      answers: { pick_model: { type: "choice", choice: "A", confidence: 0.52, probabilities: { A: 0.52, B: 0.41 } } },
    });
    expect(meta.confidence).toBeCloseTo(0.52, 5);
    expect(meta.runnerUp).toBe("B");
    expect(meta.runnerUpP).toBeCloseTo(0.41, 5);
  });

  it("degrades gracefully: no probabilities, no confidence, or junk shape → null / partial", () => {
    // confidence only
    expect(parseRouterDecisionMeta({
      answers: { pick_model: { choice: "A", confidence: 0.7 } },
    })).toEqual({ confidence: 0.7, runnerUp: null, runnerUpP: null });
    // probabilities only
    expect(parseRouterDecisionMeta({
      answers: { pick_model: { choice: "A", probabilities: { A: 0.6, B: 0.4 } } },
    })).toEqual({ confidence: null, runnerUp: "B", runnerUpP: 0.4 });
    // nothing usable
    expect(parseRouterDecisionMeta(null)).toBeNull();
    expect(parseRouterDecisionMeta({ answers: { pick_model: "A" } })).toBeNull();
    expect(parseRouterDecisionMeta({ answers: { pick_model: { choice: "A" } } })).toBeNull();
    // non-finite numbers are ignored, not rendered as NaN
    expect(parseRouterDecisionMeta({
      answers: { pick_model: { choice: "A", confidence: "high", probabilities: { A: 0.5, B: "lots" } } },
    })).toBeNull();
  });

  it("never changes the pick itself", () => {
    const resp = {
      answers: { pick_model: { choice: "B", confidence: 0.4, probabilities: { A: 0.6, B: 0.4 } } },
    };
    expect(parseRouterDecisionResult(resp)).toBe("B");
    expect(parseRouterDecisionMeta(resp).runnerUp).toBe("A");
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

  it("the decision log line carries confidence and the runner-up", async () => {
    // Earlier cases call vi.resetModules() (the env-timeout test re-imports
    // comboRouter to pick up COMBO_ROUTER_DECISION_TIMEOUT_MS), which leaves a
    // SECOND module instance holding its own health cache and its own logger
    // binding. Re-import here so this case asserts against the instance it
    // actually drives — otherwise the mocked logger never sees the line and
    // the failure looks like a missing feature.
    vi.resetModules();
    const { runRouterDecision: runFresh } = await import("../../src/sse/handlers/comboRouter.js");
    // mockLog is module-level and earlier cases already logged through it —
    // clear first, or `find` below picks up a stale line without the detail.
    const info = vi.spyOn(mockLog, "info");
    info.mockClear();
    mockModel.getModelInfo.mockImplementation(async (m) =>
      m === "drex/drex-v1.5" ? { provider: "drex", model: "drex-v1.5" } : { provider: m.split("/")[0], model: m.split("/").slice(1).join("/") }
    );
    mockAuth.getProviderCredentials.mockResolvedValue({ connectionId: "c1", accessToken: "t" });
    mockCore.handleSystemoneCore.mockResolvedValue({
      success: true,
      usage: null,
      response: new Response(JSON.stringify({
        answers: {
          pick_model: {
            type: "choice",
            choice: "claude/claude-sonnet-4.5",
            confidence: 0.52,
            probabilities: { "claude/claude-sonnet-4.5": 0.52, "gpt/gpt-5.2": 0.41 },
          },
        },
      })),
    });

    await runFresh({ routerModel: "drex/drex-v1.5", body: chatBody(), candidates: CANDIDATES });

    const line = info.mock.calls.map((c) => c[1]).find((s) => String(s).startsWith("router: drex/drex-v1.5 →"));
    expect(line).toContain("of 3 candidates");
    expect(line).toContain("conf 0.52");
    expect(line).toContain("next gpt/gpt-5.2 0.41");
    info.mockRestore();
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
