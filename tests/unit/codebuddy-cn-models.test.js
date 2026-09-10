import { describe, expect, it } from "vitest";
import cn from "../../open-sse/providers/registry/codebuddy-cn.js";
import intl from "../../open-sse/providers/registry/codebuddy-intl.js";

// Models CodeBuddy *international* (codebuddy.ai) resells. copilot.tencent.com
// never published them, and open-sse/providers/capabilities.js has no
// "codebuddy-cn" entry for any of them. They were once copied into the CN
// registry by mistake (53c255b7) — keep them out.
const INTL_ONLY_FAMILY = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gemini-3.5-flash",
];

describe("CodeBuddy CN static model catalog", () => {
  it("lists exactly the models copilot.tencent.com publishes", () => {
    expect(cn.models.map((model) => model.id)).toEqual([
      "glm-5.2",
      "glm-5.1",
      "glm-5v-turbo",
      "minimax-m3",
      "kimi-k2.7",
      "kimi-k2.6",
      "hy3",
      "hy4-preview",
      "glm-5.3",
      "glm-5.3-flash",
      "kimi-k3",
      "kimi-k3-1",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
  });

  it("does not carry the intl-only GPT/Gemini family", () => {
    const cnIds = cn.models.map((model) => model.id);
    const intlIds = intl.models.map((model) => model.id);
    for (const id of INTL_ONLY_FAMILY) {
      expect(cnIds).not.toContain(id);
      expect(intlIds).toContain(id);
    }
  });
});
