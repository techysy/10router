import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleChat, getResponseSnapshot, saveResponseSnapshot } = vi.hoisted(() => ({
  handleChat: vi.fn(),
  getResponseSnapshot: vi.fn(),
  saveResponseSnapshot: vi.fn(),
}));

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat }));
vi.mock("@/lib/db/repos/responsesStoreRepo.js", () => ({
  getResponseSnapshot,
  saveResponseSnapshot,
}));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn(async () => {}) }));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (req) => req.headers.get("authorization")?.slice(7) || null,
  isValidApiKey: async (key) => key === "sk-responses-store-test",
}));

const { POST } = await import("../../src/app/api/v1/responses/route.js");

const API_KEY = "sk-responses-store-test";
const URL = "http://localhost/v1/responses";
const headers = { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" };
const firstRequest = {
  model: "cbcn/glm-5.2",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "List source files" }] }],
  tools: [{ type: "function", name: "exec", description: "Run command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
};
const firstCompleted = {
  id: "resp_first",
  object: "response",
  status: "completed",
  output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "exec", arguments: '{"cmd":"ls src"}' }],
};
const toolResultAndNextMessage = [
  { type: "function_call_output", call_id: "call_1", output: "src/a.js\nsrc/b.js" },
  { type: "message", role: "user", content: [{ type: "input_text", text: "Now count them." }] },
];

function request(body, extraHeaders = {}, signal) {
  return new Request(URL, {
    method: "POST",
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function completedResponse(id, output = [{ type: "message", id: "msg_2", role: "assistant", content: [{ type: "output_text", text: "There are two." }] }]) {
  return Response.json({ id, object: "response", status: "completed", output });
}

function sseResponse(id, output = firstCompleted.output) {
  const events = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } })}\n\n`,
    ...output.map((item, index) => `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item })}\n\n`),
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id, object: "response", status: "completed", output } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(events);
      // Split inside JSON so stream capture must handle arbitrary chunk boundaries.
      controller.enqueue(bytes.slice(0, 31));
      controller.enqueue(bytes.slice(31, 107));
      controller.enqueue(bytes.slice(107));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

const secondTurnOutput = [
  { type: "function_call", id: "fc_9", call_id: "call_9", name: "exec", arguments: '{"cmd":"ls src | wc -l"}' },
];

const forwardedBodies = [];

beforeEach(() => {
  vi.resetAllMocks();
  forwardedBodies.length = 0;
  getResponseSnapshot.mockResolvedValue(null);
  saveResponseSnapshot.mockResolvedValue(undefined);
  handleChat.mockImplementation(async (req) => {
    const body = await req.json();
    forwardedBodies.push(body);
    if (body.stream === true) return sseResponse("resp_stream");
    return forwardedBodies.length === 1 ? completedResponse("resp_first", firstCompleted.output) : completedResponse("resp_second");
  });
});

describe("POST /v1/responses stored continuation", () => {
  it("stores completed JSON response and replays input + tool call + tool result on the next turn", async () => {
    const first = await POST(request(firstRequest));
    expect(first.status).toBe(200);
    expect(saveResponseSnapshot).toHaveBeenCalledTimes(1);

    const [savedId, savedCaller, firstSnapshot] = saveResponseSnapshot.mock.calls[0];
    expect(savedId).toBe("resp_first");
    expect(savedCaller).toBeTruthy();
    expect(firstSnapshot.history).toEqual([...firstRequest.input, ...firstCompleted.output]);
    expect(firstSnapshot.tools).toEqual(firstRequest.tools);

    getResponseSnapshot.mockResolvedValueOnce(firstSnapshot);
    const second = await POST(request({
      model: firstRequest.model,
      previous_response_id: savedId,
      input: toolResultAndNextMessage,
    }));
    expect(second.status).toBe(200);

    const translatedBody = forwardedBodies[1];
    expect(translatedBody.input).toEqual([
      ...firstSnapshot.history,
      ...toolResultAndNextMessage,
    ]);
    // The client may omit session tools on later turns; they remain available.
    expect(translatedBody.tools).toEqual(firstRequest.tools);
  });

  it("keeps the previous response history and new tool results on the streaming path", async () => {
    getResponseSnapshot.mockResolvedValueOnce({
      history: [...firstRequest.input, ...firstCompleted.output],
      tools: firstRequest.tools,
      instructions: "Keep using tools.",
    });
    const response = await POST(request({
      model: firstRequest.model,
      previous_response_id: "resp_first",
      input: toolResultAndNextMessage,
      stream: true,
    }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const forwarded = forwardedBodies[0];
    expect(forwarded.input).toEqual([...firstRequest.input, ...firstCompleted.output, ...toolResultAndNextMessage]);
    const output = await response.text();
    expect(output).toContain("response.completed");
    expect(saveResponseSnapshot).toHaveBeenCalledTimes(1);
    expect(saveResponseSnapshot.mock.calls[0][0]).toBe("resp_stream");
    expect(saveResponseSnapshot.mock.calls[0][2].history).toEqual([
      ...firstRequest.input,
      ...firstCompleted.output,
      ...toolResultAndNextMessage,
      ...firstCompleted.output,
    ]);
  });

  it("consumes previous_response_id instead of forwarding our own id upstream", async () => {
    getResponseSnapshot.mockResolvedValueOnce({
      history: [...firstRequest.input, ...firstCompleted.output],
      tools: firstRequest.tools,
    });
    await POST(request({
      model: firstRequest.model,
      previous_response_id: "resp_first",
      input: toolResultAndNextMessage,
    }));

    // A native Responses upstream would 404 on an id it never issued.
    expect(forwardedBodies[0].previous_response_id).toBeUndefined();
  });

  it("keeps a new turn that repeats the first stored item", async () => {
    // The client sent ONLY the new turn, but that turn happens to be identical to
    // the conversation's first message. Matching it against the start of history
    // would drop the turn the user just asked for.
    const repeated = firstRequest.input[0];
    getResponseSnapshot.mockResolvedValueOnce({
      history: [repeated, ...firstCompleted.output],
      tools: firstRequest.tools,
    });
    await POST(request({ model: firstRequest.model, previous_response_id: "resp_first", input: [repeated] }));

    expect(forwardedBodies[0].input).toEqual([repeated, ...firstCompleted.output, repeated]);
  });

  it("recognises a transcript replay whose items lost their server ids", async () => {
    // Stored history is our `response.output`: the tool call carries `id: "fc_1"`.
    // When the client replays the transcript it sends the same call WITHOUT that
    // id. A byte-for-byte compare would miss the replay and prepend the stored
    // history again — the whole conversation twice.
    const replayedCall = { type: "function_call", call_id: "call_1", name: "exec", arguments: '{"cmd":"ls src"}' };
    expect(replayedCall.id).toBeUndefined();
    getResponseSnapshot.mockResolvedValueOnce({
      history: [...firstRequest.input, ...firstCompleted.output],
      tools: firstRequest.tools,
    });
    await POST(request({
      model: firstRequest.model,
      previous_response_id: "resp_first",
      input: [...firstRequest.input, replayedCall, ...toolResultAndNextMessage],
    }));

    expect(forwardedBodies[0].input).toEqual([...firstRequest.input, replayedCall, ...toolResultAndNextMessage]);
  });

  it("prepends stored history when the client sent only the new turn", async () => {
    getResponseSnapshot.mockResolvedValueOnce({
      history: [...firstRequest.input, ...firstCompleted.output],
      tools: firstRequest.tools,
    });
    await POST(request({ model: firstRequest.model, previous_response_id: "resp_first", input: toolResultAndNextMessage }));

    expect(forwardedBodies[0].input).toEqual([...firstRequest.input, ...firstCompleted.output, ...toolResultAndNextMessage]);
  });

  it("does not store a response when store is false", async () => {
    await POST(request({ ...firstRequest, store: false }));
    expect(saveResponseSnapshot).not.toHaveBeenCalled();
  });

  it("still resolves a continuation when store is false on the continuing turn", async () => {
    getResponseSnapshot.mockResolvedValueOnce({
      history: [...firstRequest.input, ...firstCompleted.output],
      tools: firstRequest.tools,
    });
    await POST(request({
      model: firstRequest.model,
      previous_response_id: "resp_first",
      input: toolResultAndNextMessage,
      store: false,
    }));

    expect(forwardedBodies[0].input).toEqual([...firstRequest.input, ...firstCompleted.output, ...toolResultAndNextMessage]);
    expect(saveResponseSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["expired", null],
    ["owned by another caller", null],
  ])("returns an explicit 400 and does not start upstream for a %s previous response", async (_label, snapshot) => {
    getResponseSnapshot.mockResolvedValueOnce(snapshot);
    const response = await POST(request({
      model: firstRequest.model,
      previous_response_id: "resp_unavailable",
      input: [{ type: "message", role: "user", content: "continue" }],
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error", code: "response_not_found" },
    });
    expect(handleChat).not.toHaveBeenCalled();
    expect(saveResponseSnapshot).not.toHaveBeenCalled();
  });

  it("does not persist when database storage fails, but still returns the model response", async () => {
    saveResponseSnapshot.mockRejectedValueOnce(new Error("disk full"));
    const response = await POST(request(firstRequest));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("completed");
  });

  it("forwards the caller's abort signal, so a disconnect still cancels upstream", async () => {
    const ctrl = new AbortController();
    // Keep the upstream response open until we abort, so the abort has a live
    // request to act on.
    handleChat.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n")); },
    }), { headers: { "content-type": "text/event-stream" } }));
    const response = await POST(request({ ...firstRequest, stream: true }, {}, ctrl.signal));

    const forwardedSignal = handleChat.mock.calls[0][0].signal;
    expect(forwardedSignal.aborted).toBe(false);
    ctrl.abort();
    expect(forwardedSignal.aborted).toBe(true);
    await response.body.cancel().catch(() => {});
  });

  it("does not forward a stale content-length after splicing history in", async () => {
    getResponseSnapshot.mockResolvedValueOnce({
      history: [...firstRequest.input, ...firstCompleted.output],
      tools: firstRequest.tools,
    });
    // The client declared the length of ITS body; ours is longer by the stored
    // history. A stale length would truncate what upstream reads.
    const smallBody = JSON.stringify({ model: firstRequest.model, previous_response_id: "resp_first", input: toolResultAndNextMessage });
    await POST(request({
      model: firstRequest.model,
      previous_response_id: "resp_first",
      input: toolResultAndNextMessage,
    }, { "content-length": String(Buffer.byteLength(smallBody)) }));

    const forwardedHeaders = handleChat.mock.calls[0][0].headers;
    expect(forwardedHeaders.get("content-length")).toBeNull();
    // Auth still reaches the gateway's own key check.
    expect(forwardedHeaders.get("authorization")).toBe(`Bearer ${API_KEY}`);
  });
});
