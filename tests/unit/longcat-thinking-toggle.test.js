// LongCat 思考开关：官方 API 是 thinking {type: enabled|disabled}（2026-11
//《模型参数参考》），而 reasoning_effort 被上游静默忽略——客户端"关思考"此前
// 从未生效（reasoning_effort:"none" 原样透传，上游不认识）。修法走
// thinkingUnified 的 longcat 分支 + 注册表 provider 级 thinkingFormat 声明
// （providerFmt 优先于 caps 行的 "openai"，转售商不受影响）。
import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("applyThinking (longcat): official thinking {type} switch", () => {
  it("off → thinking disabled, reasoning_effort stripped", () => {
    const body = { reasoning_effort: "none" };
    applyThinking(FORMATS.OPENAI, "LongCat-2.5", body, "longcat");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("on (level) → plain enabled; level has no wire shape yet", () => {
    const body = { reasoning_effort: "high" };
    applyThinking(FORMATS.OPENAI, "LongCat-2.5", body, "longcat");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking.budget_tokens).toBeUndefined();
  });

  it("claude-format client off → disabled on the openai wire", () => {
    const body = { thinking: { type: "disabled" } };
    applyThinking(FORMATS.OPENAI, "LongCat-2.5", body, "longcat");
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("provider-level thinkingFormat overrides the caps row's openai", () => {
    // Provider fmt wins over the global caps rows ("openai") — only first-party
    // longcat / longcat-intl switch shape; resellers keep reasoning_effort.
    const body = { reasoning_effort: "none" };
    applyThinking(FORMATS.OPENAI, "LongCat-2.5", body, "longcat-intl");
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});
