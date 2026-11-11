// Trae 执行器：直连非沙箱通道（agent_type: "chat", env: "local"）与 SOLO 沙箱通道（solo_agent_remote）
// 1. 普通模型默认走非沙箱通道，不开云端沙箱容器；
// 2. 显式包含 solo/work/agent- 的请求走 SOLO 沙箱通道；
// 3. 模型名大小写别名规范化（避免服务端 4001 config empty 报错）；
// 4. 事件流中同时兼容 plan_item.thought / data.content / data.delta.content / data.text。
import { describe, it, expect, vi, beforeEach } from "vitest";

const { proxyFetchMock } = vi.hoisted(() => ({ proxyFetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => proxyFetchMock(...args) }));

describe("TraeExecutor: direct non-sandbox channel & model canonicalization", () => {
  beforeEach(() => proxyFetchMock.mockReset());

  it("canonicalizes model names to server-required TitleCase/PascalCase", async () => {
    const { canonicalTraeModel } = await import("../../open-sse/executors/trae.js");
    expect(canonicalTraeModel("doubao-seed-code")).toBe("Doubao-Seed-Code");
    expect(canonicalTraeModel("Doubao-Seed-Code")).toBe("Doubao-Seed-Code");
    expect(canonicalTraeModel("doubao-seed-2.1-turbo")).toBe("Doubao-Seed-2.1-Turbo");
    expect(canonicalTraeModel("deepseek-v4.1-flash")).toBe("DeepSeek-V4-Flash");
    expect(canonicalTraeModel("deepseek-v4-pro")).toBe("DeepSeek-V4-Pro");
    expect(canonicalTraeModel("kimi-k3.1-pro")).toBe("Kimi-K3.1-Pro");
    expect(canonicalTraeModel("minimax-m3.1-flash")).toBe("MiniMax-M3.1-Flash");
    expect(canonicalTraeModel("glm-5.3-flashx")).toBe("GLM-5.3-FlashX");
    expect(canonicalTraeModel("unknown-model")).toBe("unknown-model");
  });

  it("identifies solo agent sandbox mode vs direct chat mode", async () => {
    const { isSoloAgentMode } = await import("../../open-sse/executors/trae.js");
    expect(isSoloAgentMode("work")).toBe(true);
    expect(isSoloAgentMode("solo-work")).toBe(true);
    expect(isSoloAgentMode("solo-agent")).toBe(true);
    expect(isSoloAgentMode("agent-task")).toBe(true);
    expect(isSoloAgentMode("Doubao-Seed-Code")).toBe(false);
    expect(isSoloAgentMode("doubao-seed-code")).toBe(false);
    expect(isSoloAgentMode("deepseek-v4.1-flash")).toBe(false);
  });

  it("creates direct non-sandbox session (agent_type: chat, env: local) for standard models", async () => {
    const { default: TraeExecutor } = await import("../../open-sse/executors/trae.js");
    const executor = new TraeExecutor("trae-cn");
    let capturedBody = null;

    proxyFetchMock.mockImplementation(async (url, options) => {
      capturedBody = JSON.parse(options?.body || "{}");
      return new Response(JSON.stringify({
        code: 0,
        data: { chat_session_id: "test-sess", message_id: "test-msg" }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const headers = { Authorization: "test" };
    await executor.createSessionOnBase("https://example.com", headers, "[]", "doubao-seed-code", {});

    expect(capturedBody).toBeDefined();
    expect(capturedBody.initial_message.model_name).toBe("Doubao-Seed-Code");
    expect(capturedBody.initial_message.agent_type).toBe("chat");
    expect(capturedBody.env).toBe("local");
  });

  it("keeps SOLO sandbox session (agent_type: solo_agent_remote, env: remote) for solo/work modes", async () => {
    const { default: TraeExecutor } = await import("../../open-sse/executors/trae.js");
    const executor = new TraeExecutor("trae-cn");
    let capturedBody = null;

    proxyFetchMock.mockImplementation(async (url, options) => {
      capturedBody = JSON.parse(options?.body || "{}");
      return new Response(JSON.stringify({
        code: 0,
        data: { chat_session_id: "test-sess", message_id: "test-msg" }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const headers = { Authorization: "test" };
    await executor.createSessionOnBase("https://example.com", headers, "[]", "work", {});

    expect(capturedBody).toBeDefined();
    expect(capturedBody.initial_message.agent_type).toBe("solo_agent_remote");
    expect(capturedBody.env).toBe("remote");
  });
});
