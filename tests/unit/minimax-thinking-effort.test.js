// MiniMax M3.1-Flash 的思考深度透传（官方客户端档位
// default/low/medium/high/xhigh/max,无 off）与 M3 的开/关切换。
// 线格式实测:thinking.effort 附加在 adaptive 形态里,CreditDaddy MiniMax
// 网关 200 接受;不认识该字段的旧上游静默忽略。
// 2026-11-25：`-Preview` 已从三条 minimax-code 线下架，主用例改钉正式 id；
// 最后一条保留旧 id 同形状，钉住「存量请求仍能拿到档位透传」——能力行是有意留的。
import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const M31 = "MiniMax-M3.1-Flash";

describe("applyThinking (minimax): M3.1 effort passthrough / M3 toggle", () => {
  it("M3.1: budget level maps to thinking.effort on the adaptive shape", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 98304 } };
    applyThinking(FORMATS.CLAUDE, M31, body, "minimax");
    expect(body.thinking).toEqual({ type: "adaptive", effort: "max" });
  });

  it("M3.1: mid budgets map to mid levels", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 8000 } };
    applyThinking(FORMATS.CLAUDE, M31, body, "minimax");
    // budgetToLevel: ≤16384 → medium
    expect(body.thinking).toEqual({ type: "adaptive", effort: "medium" });
  });

  it("M3.1: canDisable=false clamps none to adaptive default (no effort key)", () => {
    const body = { thinking: { type: "disabled" } };
    applyThinking(FORMATS.CLAUDE, M31, body, "minimax");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.thinking.effort).toBeUndefined();
  });

  it("下架的 -Preview id 走同一套档位透传（能力行有意保留）", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 98304 } };
    applyThinking(FORMATS.CLAUDE, "MiniMax-M3.1-Flash-Preview", body, "minimax");
    expect(body.thinking).toEqual({ type: "adaptive", effort: "max" });
  });

  it("M3: client toggle off → thinking disabled (canDisable true)", () => {
    const body = { thinking: { type: "disabled" } };
    applyThinking(FORMATS.CLAUDE, "MiniMax-M3", body, "minimax");
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("M3: toggle on → plain adaptive (no effort key; M3 client has no levels)", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 98304 } };
    applyThinking(FORMATS.CLAUDE, "MiniMax-M3", body, "minimax");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.thinking.effort).toBeUndefined();
  });
});
