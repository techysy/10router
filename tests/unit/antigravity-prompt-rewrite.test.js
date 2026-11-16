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
    // The identity opener normalizes to a neutral assistant line (upstream
    // a61fc6a0): Google's backend flags competitor branding on ANY wording,
    // so the whole sentence goes, not a brand-for-brand rename.
    expect(out).toBe("You are an AI assistant. Be direct.");
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

  it("cloaks the Codex CLI opening identity declaration (2026-11-16 blocklist)", () => {
    // Exact opener from Codex CLI / open-sse/config/codexInstructions.js
    const sys = "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer. Be direct.";
    const out = cloakSystemInstruction(sys);
    expect(out).not.toMatch(/Codex/);
    expect(out).not.toMatch(/GPT-5/);
    expect(out).toBe("You are an AI assistant running as a coding agent in the Antigravity CLI on the user's computer. Be direct.");
  });

  it("cloaks variant Codex openers (no lineage suffix, harness-only form)", () => {
    const out1 = cloakSystemInstruction("You are Codex. You are running as a coding agent in Codex CLI.");
    expect(out1).not.toMatch(/Codex/i);
    expect(out1).toBe("You are an AI assistant running as a coding agent in the Antigravity CLI on the user's computer.");
    // Older builds drop the "on a user's computer" tail
    const out2 = cloakSystemInstruction("You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI.");
    expect(out2).toBe("You are an AI assistant running as a coding agent in the Antigravity CLI on the user's computer.");
  });

  it("renames residual Codex harness sections case-preserving (no opener match)", () => {
    const sys = "## Codex CLI harness, sandboxing, and approvals\nThe Codex CLI harness supports several configurations. Run codex exec to retry.";
    const out = cloakSystemInstruction(sys);
    expect(out).toBe("## Antigravity CLI harness, sandboxing, and approvals\nThe Antigravity CLI harness supports several configurations. Run antigravity exec to retry.");
  });

  it("cloaks the pi opening identity declaration (identity-sentence only)", () => {
    // Exact opener from earendil-works/pi packages/coding-agent/src/core/system-prompt.ts
    const sys = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files.";
    const out = cloakSystemInstruction(sys);
    expect(out).not.toMatch(/inside pi/i);
    expect(out).toBe("You are an AI assistant. Help users inspect files.");
  });

  it("pi variant without the harness clause also normalizes", () => {
    const out = cloakSystemInstruction("You are a coding assistant running inside pi. Be concise.");
    expect(out).toBe("You are an AI assistant. Be concise.");
  });

  it("does NOT rename bare pi words (API/pip/prose collisions stay intact)", () => {
    const sys = "Call the REST API endpoint, then pip install the package. Pi day is March 14. API keys stay secret.";
    const out = cloakSystemInstruction(sys);
    expect(out).toBe(sys);
  });

  it("leaves non-brand content intact", () => {
    const sys = "Help the user write clean, efficient code. Keep replies brief.";
    expect(cloakSystemInstruction(sys)).toBe(sys);
  });
});
