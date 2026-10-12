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
});
