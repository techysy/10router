// #98: 个人/免费/促销档 antigravity 账号的开户死循环。
// loadCodeAssist 无 cloudaicompanionProject 时，旧逻辑无条件 fallthrough 到
// onboardUser——消费级账号固定返回 done:true 且无 project_id → 每轮 token
// 刷新（~30 分钟）重放无效开户，被 Google 视为自动化滥用（Term #3 封禁诱因）。
// 修复：antigravity 直接返回官方消费级共享哨兵 aicode-consumers，跳过开户；
// tokenRefresh 补传 provider（旧调用漏参，短路分支永不触发）；
// ONBOARD_MAX_ATTEMPTS=0 允许真正关闭（|| 2 的 0 值兜底 bug）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { getProjectIdForConnection, invalidateProjectId } from "../../open-sse/services/projectId.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const AG_LOAD = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const AG_ONBOARD = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser";

describe("#98 antigravity consumer-tier project sentinel", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    invalidateProjectId("conn-98");
    delete process.env.ONBOARD_MAX_ATTEMPTS;
  });

  it("loadCodeAssist 无项目时返回 aicode-consumers，不调用 onboardUser", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      allowedTiers: [{ isDefault: true, id: "standard-tier" }],
      // 无 cloudaicompanionProject —— 消费级账号的形态
    }));

    const pid = await getProjectIdForConnection("conn-98", "token", "antigravity");

    expect(pid).toBe("aicode-consumers");
    // 只应有一次 loadCodeAssist 调用，零 onboardUser
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(AG_LOAD);
  });

  it("loadCodeAssist 返回独立项目的账号不受影响（仍用真实项目）", async () => {
    invalidateProjectId("conn-98-pro");
    fetchMock.mockResolvedValueOnce(jsonResponse({ cloudaicompanionProject: "proj-real-1" }));

    const pid = await getProjectIdForConnection("conn-98-pro", "token", "antigravity");

    expect(pid).toBe("proj-real-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ONBOARD_MAX_ATTEMPTS=0 时 onboardUser 不发任何请求（0 不被 || 兜回 2）", async () => {
    process.env.ONBOARD_MAX_ATTEMPTS = "0";
    invalidateProjectId("conn-98-zero");
    // gemini-cli provider 才会走 onboardUser 分支（antigravity 已短路）
    fetchMock.mockResolvedValue(jsonResponse({ allowedTiers: [{ isDefault: true, id: "legacy-tier" }] }));

    const pid = await getProjectIdForConnection("conn-98-zero", "token", "gemini-cli");

    expect(pid).toBeNull();
    // 1 次 loadCodeAssist；若 MAX_ATTEMPTS 仍是 2 会有 onboardUser 调用
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
