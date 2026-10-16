import { describe, it, expect } from "vitest";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

describe("Gemini duplicate tool_call_id deduplication", () => {
  it("deduplicates identical tool_call_id across tool_calls and aligns with functionResponses", () => {
    const body = {
      model: "gemini-2.5-flash",
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_123", type: "function", function: { name: "get_weather", arguments: '{"city":"Beijing"}' } },
            { id: "call_123", type: "function", function: { name: "get_weather", arguments: '{"city":"Shanghai"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_123", content: "20C Sunny" },
        { role: "tool", tool_call_id: "call_123", content: "22C Rainy" },
      ],
    };

    const req = openaiToGeminiRequest("gemini-2.5-flash", body, true);
    expect(req.contents).toBeDefined();

    // Model turn with function calls
    const modelTurn = req.contents.find((c) => c.role === "model");
    expect(modelTurn).toBeDefined();
    const calls = modelTurn.parts.filter((p) => p.functionCall);
    expect(calls).toHaveLength(2);
    expect(calls[0].functionCall.id).toBe("call_123");
    expect(calls[1].functionCall.id).toBe("call_123_dup1");

    // User turn with function responses
    const responseTurn = req.contents[req.contents.indexOf(modelTurn) + 1];
    expect(responseTurn.role).toBe("user");
    const resps = responseTurn.parts.filter((p) => p.functionResponse);
    expect(resps).toHaveLength(2);
    expect(resps[0].functionResponse.id).toBe("call_123");
    expect(resps[0].functionResponse.response.result.result).toBe("20C Sunny");
    expect(resps[1].functionResponse.id).toBe("call_123_dup1");
    expect(resps[1].functionResponse.response.result.result).toBe("22C Rainy");
  });

  it("preserves correct tool name in functionResponse when identical tool_call_id is reused for different tools", () => {
    const body = {
      model: "gemini-2.5-flash",
      messages: [
        { role: "user", content: "Step 1" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_reuse", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_reuse", content: "file data" },
        { role: "user", content: "Step 2" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_reuse", type: "function", function: { name: "patch_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_reuse", content: "patch ok" },
      ],
    };

    const req = openaiToGeminiRequest("gemini-2.5-flash", body, true);
    expect(req.contents).toBeDefined();

    const modelTurns = req.contents.filter((c) => c.role === "model");
    expect(modelTurns).toHaveLength(2);

    const responseTurns = req.contents.filter((c) => c.role === "user" && c.parts.some((p) => p.functionResponse));
    expect(responseTurns).toHaveLength(2);

    // Turn 1: functionCall & functionResponse must both have name "read_file"
    expect(modelTurns[0].parts[0].functionCall.name).toBe("read_file");
    expect(responseTurns[0].parts[0].functionResponse.name).toBe("read_file");
    expect(responseTurns[0].parts[0].functionResponse.id).toBe("call_reuse");

    // Turn 2: functionCall & functionResponse must both have name "patch_file" (and id call_reuse_dup1)
    expect(modelTurns[1].parts[0].functionCall.name).toBe("patch_file");
    expect(responseTurns[1].parts[0].functionResponse.name).toBe("patch_file");
    expect(responseTurns[1].parts[0].functionResponse.id).toBe("call_reuse_dup1");
  });
});
