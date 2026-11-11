// 展示层模型名映射：qoder/qoder-cn 的内部代号（kmodel_latest 等）在统计/健康度
// 视图里应显示为真实产品名，而请求链路仍使用原始 id（映射只服务展示，见
// src/shared/utils/modelDisplayName.js）。
import { describe, it, expect } from "vitest";
import { modelDisplayName } from "@/shared/utils/modelDisplayName.js";

describe("modelDisplayName", () => {
  it("maps qoder codenames to real product names", () => {
    expect(modelDisplayName("qoder-cn", "kmodel_latest")).toBe("Kimi-K3.1-Pro");
    expect(modelDisplayName("qoder", "kmodel_latest")).toBe("Kimi-K3.1-Pro");
    // lmodel（QoDuck）2026-11-11 转正 Qwen4-Max-Preview 且旧 key 上游下线
    // （实测 400）——双区注册表均撤行，无注册行时回落原 id（约定行为）。
    expect(modelDisplayName("qdc", "lmodel")).toBe("lmodel");
    expect(modelDisplayName("qoder", "lmodel")).toBe("lmodel");
    expect(modelDisplayName("qoder-cn", "qmodel_latest")).toBe("Qwen4-Max-Preview");
    expect(modelDisplayName("qoder", "qmodel_latest")).toBe("Qwen4-Max-Preview");
    expect(modelDisplayName("qoder", "dfmodel")).toBe("DeepSeek-V4.1-Flash 1017");
  });

  it("passes through ids that need no mapping", () => {
    expect(modelDisplayName("minimax-code", "MiniMax-M3.1-Flash")).toBe("MiniMax M3.1 Flash");
    expect(modelDisplayName("qoder-cn", "auto")).toBe("Auto");
    expect(modelDisplayName("some-custom-node", "gpt-5.5")).toBe("gpt-5.5");
  });

  it("is null/empty-safe and never throws", () => {
    expect(modelDisplayName(null, "kmodel_latest")).toBe("kmodel_latest");
    expect(modelDisplayName("qoder-cn", "")).toBe("");
    expect(modelDisplayName("qoder-cn", null)).toBe("");
    expect(modelDisplayName(undefined, undefined)).toBe("");
  });
});
