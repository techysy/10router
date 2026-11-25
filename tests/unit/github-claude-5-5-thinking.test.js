import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";

// GitHub Copilot (and Kiro / Token Harbor) list Claude 5.5 models with dotted ids
// ("claude-opus-5.5"), while the Anthropic rows that carry the 5.5 thinking rules use
// dashed ids ("claude-opus-5-5"). The dotted ids fell back to the generic *claude*opus-5*
// pattern, so a thinking-off request reached Copilot's /v1/messages shim as
// thinking.type "disabled" and came back 400:
//   Opus 5.5:   "thinking.type.disabled" is not supported for this model.
//   Sonnet 5.5: To turn thinking off on this model, send "thinking": {"type": "between_tools"} ...
// Claude Code's auto-mode permission classifier sends exactly that request
// (non-streaming, thinking disabled), so every Bash call was held back.

function viaGithub(model, body) {
  const openai = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, model, structuredClone(body), body.stream ?? true, null, "github");
  delete openai._toolNameMap;
  delete openai._customToolNames;
  openai.model = model;
  const claude = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, model, openai, true, null, "github");
  delete claude._toolNameMap;
  return claude;
}

const classifierRequest = {
  max_tokens: 4096,
  stream: false,
  thinking: { type: "disabled" },
  system: [{ type: "text", text: "You are a security monitor." }],
  messages: [{ role: "user", content: "Evaluate the last action." }],
};

const mainLoopRequest = {
  max_tokens: 32000,
  stream: true,
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort: "high" },
  tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
  messages: [{ role: "user", content: "list files" }],
};

describe("Claude 5.5 dotted ids share the dashed-id thinking rules", () => {
  for (const provider of ["github", "kiro", "tokenharbor"]) {
    it(`${provider}/claude-opus-5.5 cannot disable thinking and rejects forced tools`, () => {
      expect(getCapabilitiesForModel(provider, "claude-opus-5.5")).toMatchObject({
        thinkingFormat: "claude-adaptive",
        thinkingCanDisable: false,
        forcedToolChoice: false,
      });
      expect(getThinkingLevels(provider, "claude-opus-5.5")).not.toContain("none");
    });
  }

  it("github/claude-sonnet-5.5 turns thinking off with between_tools", () => {
    expect(getCapabilitiesForModel("github", "claude-sonnet-5.5")).toMatchObject({
      thinkingFormat: "claude-adaptive",
      thinkingOffType: "between_tools",
      forcedToolChoice: false,
    });
  });
});

describe("GitHub Copilot /v1/messages request shape for Claude 5.5", () => {
  it("Opus 5.5: a thinking-off request never sends thinking.type disabled", () => {
    const out = viaGithub("claude-opus-5.5", classifierRequest);
    expect(out.thinking).toBeUndefined();
    expect(out.output_config).toEqual({ effort: "low" });
  });

  it("Opus 5.5: the main agent loop keeps adaptive thinking, display and effort", () => {
    const out = viaGithub("claude-opus-5.5", mainLoopRequest);
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("Sonnet 5.5: a thinking-off request sends between_tools", () => {
    const out = viaGithub("claude-sonnet-5.5", classifierRequest);
    expect(out.thinking).toEqual({ type: "between_tools" });
  });

  it("Sonnet 5.5: the main agent loop keeps adaptive thinking", () => {
    const out = viaGithub("claude-sonnet-5.5", mainLoopRequest);
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("Haiku 5.5: the main agent loop sends adaptive thinking with effort, never a budget", () => {
    const out = viaGithub("claude-haiku-5.5", mainLoopRequest);
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "high" });
  });
});

describe("Always-on adaptive models keep a requested thinking display", () => {
  const summarized = { mode: "level", level: "high", display: "summarized" };

  it("Claude keeps the adaptive switch to carry the display", () => {
    const body = applyThinking("claude", "claude-fable-5-1", { messages: [] }, "claude", summarized);
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("Claude without a requested display still sends effort only", () => {
    const body = applyThinking("claude", "claude-opus-5-5", { messages: [] }, "claude", { mode: "level", level: "high" });
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("non-Claude always-on models keep the effort-only wire shape", () => {
    const body = applyThinking("claude", "MiniMax-M3.1-Flash-Preview", { messages: [] }, "minimax-code", summarized);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toEqual({ effort: "high" });
  });
});
