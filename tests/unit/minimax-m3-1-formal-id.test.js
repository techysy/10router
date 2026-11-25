import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import code from "../../open-sse/providers/registry/minimax-code.js";
import codeGlobal from "../../open-sse/providers/registry/minimax-code-global.js";
import free from "../../open-sse/providers/registry/minimax-free.js";

/**
 * Issue #70 / #71：MiniMax M3.1 Flash 正式 id（去掉 -Preview）必须
 *   1. 出现在三条 minimax-code 线里（否则 /v1/models 看不见）；
 *   2. 有精确能力行，不得落 `*minimax-m3*` 家族兜底——否则
 *      videoInput 被丢（视频块静默剥离）、maxOutput 从 512000 压到 131072、
 *      thinkingCanDisable 语义错位，且全程没有任何报错。
 *
 * 2026-11-25（用户口径）：`-Preview` 的过渡保留期结束，三条线**都已下架**该行——
 * 这里同时钉住「已下架」这个形状，别再把它加回目录。能力行**故意保留**（见下面
 * 那组用例）：注册表不是请求闸，存量组合 / modelLock 里写过旧 id 的请求仍会带着
 * 它进能力查表，删行就落家族兜底，静默剥视频 + 夹输出。
 */
const FORMAL = "MiniMax-M3.1-Flash";
const PREVIEW = "MiniMax-M3.1-Flash-Preview";

describe("MiniMax M3.1 Flash 正式 id", () => {
  it("三条 minimax-code 线都登记了正式 id", () => {
    for (const [name, entry] of [["minimax-code", code], ["minimax-code-global", codeGlobal], ["minimax-free", free]]) {
      const ids = entry.models.map((m) => m.id);
      expect(ids, name).toContain(FORMAL);
    }
  });

  it("preview id 已从三条线下架，不再出现在目录里", () => {
    for (const [name, entry] of [["minimax-code", code], ["minimax-code-global", codeGlobal], ["minimax-free", free]]) {
      const ids = entry.models.map((m) => m.id);
      expect(ids, name).not.toContain(PREVIEW);
    }
  });

  it("正式 id 命中精确能力行", () => {
    const caps = getCapabilitiesForModel("minimax-code", FORMAL);
    expect(caps).toMatchObject({
      vision: true,
      videoInput: true,
      reasoning: true,
      thinkingCanDisable: false,
      contextWindow: 1000000,
      maxOutput: 512000,
    });
  });

  it("下架后的 preview id 仍不落家族兜底（存量请求兜底，能力行有意保留）", () => {
    const caps = getCapabilitiesForModel("minimax-code", PREVIEW);
    expect(caps).toEqual(getCapabilitiesForModel("minimax-code", FORMAL));
    expect(caps.maxOutput).not.toBe(131072);
    expect(caps.videoInput).toBe(true);
  });

  it("不会落到 *minimax-m3* 家族兜底（maxOutput 不得被压到 131072）", () => {
    const caps = getCapabilitiesForModel("minimax-code", FORMAL);
    expect(caps.maxOutput).not.toBe(131072);
    expect(caps.videoInput).toBe(true);
  });

  it("下架不等于请求闸：未登记 id 原样透传给上游", async () => {
    // 这条钉的是「存量连接会看到什么」：getModelUpstreamId 对不在目录里的 id
    // 不做替换、也不报错，所以上游收到的是原样的 -Preview，由上游回模型不存在
    // ——不是被我们静默改写成正式 id（那会让用户以为还在用预览版）。
    const { getModelUpstreamId } = await import("../../open-sse/config/providerModels.js");
    expect(getModelUpstreamId("minimax-code", PREVIEW)).toBe(PREVIEW);
    expect(getModelUpstreamId("minimax-code", FORMAL)).toBe(FORMAL);
  });
});

describe("TokenRouter 的 M3.1 拼写", () => {
  it("种子表含命名空间形态与 :free 变体，且没有上游不存在的裸 id", async () => {
    // 2026-10-19 用账号 Key 拉 TokenRouter /v1/models（163 条）核对：
    // 只有 `minimax/minimax-m3.1-flash` 与 `minimax/minimax-m3.1-flash:free`，
    // 裸 `MiniMax-M3.1-Flash` 并不存在——登记它会给出一个永远 404 的选项。
    const tr = (await import("../../open-sse/providers/registry/tokenrouter.js")).default;
    const ids = tr.models.map((m) => m.id);
    expect(ids).toContain("minimax/minimax-m3.1-flash");
    expect(ids).toContain("minimax/minimax-m3.1-flash:free");
    expect(ids).not.toContain("MiniMax-M3.1-Flash");
  });

  it("命名空间小写拼写同样不落家族兜底", () => {
    const caps = getCapabilitiesForModel("tokenrouter", "minimax/minimax-m3.1-flash");
    expect(caps).toMatchObject({ videoInput: true, maxOutput: 512000, contextWindow: 1000000 });
  });
});
