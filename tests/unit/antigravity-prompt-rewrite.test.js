/**
 * Unit test: Antigravity competing-client prompt rewrites (ANTIGRAVITY_PROMPT_REWRITES).
 *
 * Google's Antigravity backend flags system prompts that declare a third-party client
 * identity (Hermes/Nous Research, OpenCode, Claude SDK) and answers with a fake
 * 429 RESOURCE_EXHAUSTED. 10router cloaks those before forwarding. This mirrors the
 * exact apply loop in executors/antigravity.js buildRequest (systemInstruction.parts[].text).
 */
import { describe, it, expect } from "vitest";
import { ANTIGRAVITY_PROMPT_REWRITES } from "../../open-sse/config/appConstants.js";

function cloakText(text) {
  for (const { from, to } of ANTIGRAVITY_PROMPT_REWRITES) {
    text = text.replaceAll(from, to);
  }
  return text;
}

function cloakParts(parts) {
  for (const part of parts) {
    if (typeof part.text !== "string") continue;
    for (const { from, to } of ANTIGRAVITY_PROMPT_REWRITES) {
      part.text = part.text.replaceAll(from, to);
    }
  }
  return parts;
}

// Mirrors the executor loop over systemInstruction.parts, returning the joined cloaked text.
function cloakSystemInstruction(text) {
  const parts = cloakParts([{ type: "text", text }]);
  return parts[0].text;
}

describe("ANTIGRAVITY_PROMPT_REWRITES", () => {
  it("cloaks the Hermes opening identity declaration", () => {
    const sys = "You are Hermes Agent, built by Nous Research. Be direct.";
    const out = cloakSystemInstruction(sys);
    expect(out).not.toMatch(/Hermes/i);
    expect(out).not.toMatch(/Nous Research/i);
    expect(out).toMatch(/Antigravity, built by Google DeepMind/);
  });

  it("cloaks Hermes help-guidance branding + doc host", () => {
    const sys =
      "You run on Hermes Agent (by Nous Research). Docs at https://hermes-agent.nousresearch.com/docs";
    const out = cloakSystemInstruction(sys);
    expect(out).not.toMatch(/Hermes Agent/i);
    expect(out).not.toMatch(/Nous Research/i);
    expect(out).not.toMatch(/nousresearch/i);
    expect(out).toMatch(/antigravity\.google\.com\/docs/);
  });

  it("still cloaks the Claude SDK opening declaration (regression)", () => {
    const sys = "You are a Claude agent, built on Anthropic's Claude Agent SDK. Be concise.";
    const out = cloakSystemInstruction(sys);
    expect(out).not.toMatch(/Claude agent, built on Anthropic/);
    // Bare later "Claude" references are left alone (only the SDK opening is stripped).
    expect(out).toBe(" Be concise.");
  });

  it("still renames OpenCode to Antigravity (regression)", () => {
    const sys = "You are OpenCode, running in an OPENCODE session with the opencode CLI.";
    const out = cloakSystemInstruction(sys);
    expect(out).toMatch(/You are Antigravity, running in an ANTIGRAVITY session with the antigravity CLI\./);
  });

  it("leaves non-brand content intact", () => {
    const sys = "Help the user write clean, efficient code. Keep replies brief.";
    expect(cloakSystemInstruction(sys)).toBe(sys);
  });
});
