// Trae #109 修复回归：GLM-5.3-FlashX 4001 降级链 + 豆包系 SOLO 归位。
// 上游 chat_v3 的 ConfigName 目录是社区人工校对的静态表，新模型可能未进表
// （实测 GLM-5.3-FlashX 报 4001 config item is empty）；豆包系走 chat 通道
// 上游仍回落云端沙箱（#58 As-Designed），显式归位 solo_agent_remote。
import { describe, it, expect, vi } from "vitest";
import TraeExecutor, {
  degradeTraeConfigName,
  isSoloAgentMode,
  canonicalTraeModel,
} from "../../open-sse/executors/trae.js";

describe("Trae 4001 config degrade chain (#109)", () => {
  it("GLM-5.3-FlashX degrades to GLM-5.3-Flash (family flash tier)", () => {
    expect(degradeTraeConfigName("GLM-5.3-FlashX")).toBe("GLM-5.3-Flash");
  });

  it("degrade targets are always known catalog names", () => {
    for (const [from, to] of Object.entries({
      "GLM-5.3-FlashX": "GLM-5.3-Flash",
      "Doubao-Seed-2.1-Turbo": "Doubao-Seed-2.1-Pro",
      "DeepSeek-V4-Pro-Official": "DeepSeek-V4-Pro",
    })) {
      expect(degradeTraeConfigName(from)).toBe(to);
      // 终态必须落在已知名上（不为 null，或 null 即表内已知名本身）
      if (to) expect(canonicalTraeModel(to.toLowerCase())).toBe(to);
    }
  });

  it("known catalog models degrade to null (no needless retry)", () => {
    expect(degradeTraeConfigName("GLM-5.3-Flash")).toBeNull();
    expect(degradeTraeConfigName("GLM-5.3")).toBeNull();
    expect(degradeTraeConfigName("Doubao-Seed-Code")).toBeNull();
  });

  it("unknown models and auto return null (abort degrade)", () => {
    expect(degradeTraeConfigName("Unknown-xyz")).toBeNull();
    expect(degradeTraeConfigName("auto")).toBeNull();
    expect(degradeTraeConfigName("")).toBeNull();
    expect(degradeTraeConfigName(null)).toBeNull();
  });

  it("createSession retries with degraded ConfigName on 4001", async () => {
    const exec = new TraeExecutor("trae-cn");
    let calls = [];
    // 只 mock 实例的 createSessionOnBase（createSession 内部 this 调用），不动 fetch
    exec.createSessionOnBase = vi.fn(async (base, headers, query, model, psd, signal, configNameOverride) => {
      const used = configNameOverride ?? canonicalTraeModel(model);
      calls.push(used);
      if (used === "GLM-5.3-FlashX") {
        throw new Error('Trae create_session: {"code":4001,"message":"config item is empty for config opt: ..."}');
      }
      return { sessionId: "s-1", messageId: "m-1" };
    });
    const session = await exec.createSession({}, "query", "glm-5.3-flashx", {});
    expect(calls).toEqual(["GLM-5.3-FlashX", "GLM-5.3-Flash"]);
    expect(session.sessionId).toBe("s-1");
    expect(session.modelName).toBe("GLM-5.3-Flash");
  });

  it("non-4001 errors abort the degrade chain immediately", async () => {
    const exec = new TraeExecutor("trae-cn");
    let calls = [];
    exec.createSessionOnBase = vi.fn(async (base, headers, query, model, psd, signal, configNameOverride) => {
      calls.push(configNameOverride ?? canonicalTraeModel(model));
      throw new Error("[500] upstream boom");
    });
    await expect(exec.createSession({}, "query", "glm-5.3-flashx", {})).rejects.toThrow("upstream boom");
    expect(calls).toEqual(["GLM-5.3-FlashX"]);
  });
});

describe("Trae doubao-* routes to SOLO sandbox (#109, As-Designed #58)", () => {
  it.each(["doubao-seed-code", "Doubao-Seed-2.1-Pro", "doubao-seed-evolving"])(
    "%s is flagged solo",
    (model) => expect(isSoloAgentMode(model)).toBe(true),
  );

  it.each(["glm-5.3-flashx", "kimi-k3.1-pro", "deepseek-v4-flash", "solo", "my-solo-task"])(
    "%s solo flag unchanged",
    (model) => expect(isSoloAgentMode(model)).toBe(model.includes("solo") || model.startsWith("agent-")),
  );

  it("createSessionOnBase body routes doubao to solo_agent_remote/remote", async () => {
    const mod = await import("../../open-sse/utils/proxyFetch.js");
    let captured;
    vi.spyOn(mod, "proxyAwareFetch").mockImplementation(async (url, init) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ code: 0, data: { chat_session_id: "s", message_id: "m" } }), { status: 200 });
    });
    const exec = new TraeExecutor("trae-cn");
    exec.commonParams = () => "{}";
    await exec.createSessionOnBase("https://x", {}, "q", "doubao-seed-code", {}, undefined);
    expect(captured.initial_message.agent_type).toBe("solo_agent_remote");
    expect(captured.env).toBe("remote");
    vi.restoreAllMocks();
  });
});
