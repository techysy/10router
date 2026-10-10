/**
 * Refresh-token 复用守卫（上游 v0.5.95, 0bc7f86e 的重实现）。
 *
 * OpenAI 每次刷新都轮换 refresh token，复用被轮换的旧 token 会吊销整个 session
 * （账号被整体登出）。本测试固定三处防线：
 * 1. 缩短的 refreshLeadMs（10 分钟，见 codex-registry-and-routing.test.js）；
 * 2. refreshAndUpdateCredentials 刷新前重读 DB 最新凭据，且不可恢复的刷新错误
 *    必须 throw，不得拿死 token 继续用；
 * 3. checkAndRefreshToken 发现 DB 里有更新 token 时直接采纳，而不是再刷一次。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(async () => true),
  getExecutor: vi.fn(),
  // open-sse tokenRefresh / oauthCredentialManager 的桩
  shouldRefreshCredentials: vi.fn(),
  refreshProviderCredentials: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: mocks.getExecutor,
}));

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(async () => null),
  invalidateProjectId: vi.fn(),
  removeConnection: vi.fn(),
}));

vi.mock("open-sse/services/tokenRefresh.js", async (importOriginal) => ({
  // 保留真实的 isUnrecoverableRefreshError（route.js 的防线依赖其真实分类逻辑），
  // 只把会触网/读时钟的部分钉成桩。
  ...(await importOriginal()),
  getRefreshLeadMs: vi.fn(() => 600000),
  refreshAccessToken: vi.fn(),
  refreshClaudeOAuthToken: vi.fn(),
  refreshGoogleToken: vi.fn(),
  refreshCodexToken: vi.fn(),
  refreshIflowToken: vi.fn(),
  refreshGitHubToken: vi.fn(),
  refreshCopilotToken: vi.fn(),
  refreshKiroToken: vi.fn(),
  getAccessToken: vi.fn(),
  refreshTokenByProvider: vi.fn(),
  formatProviderCredentials: vi.fn(),
  getAllAccessTokens: vi.fn(),
}));

vi.mock("open-sse/services/oauthCredentialManager.js", () => ({
  refreshProviderCredentials: mocks.refreshProviderCredentials,
  shouldRefreshCredentials: mocks.shouldRefreshCredentials,
}));

function codexExecutor(overrides = {}) {
  return {
    needsRefresh: vi.fn(() => true),
    refreshCredentials: vi.fn(async () => ({
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      expiresIn: 3600,
      lastRefreshAt: new Date().toISOString(),
    })),
    ...overrides,
  };
}

function codexConnection(overrides = {}) {
  return {
    id: "codex-conn-1",
    provider: "codex",
    authType: "oauth",
    accessToken: "stale-access",
    refreshToken: "stale-refresh",
    idToken: "id-token",
    expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    lastRefreshAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("refreshAndUpdateCredentials (usage route) — 刷新前重读 DB", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the freshly rotated tokens from the DB, not the caller's stale snapshot", async () => {
    const executor = codexExecutor();
    mocks.getExecutor.mockReturnValue(executor);
    const latest = codexConnection({
      refreshToken: "rotated-refresh",
      accessToken: "rotated-access",
      lastRefreshAt: "2026-10-01T00:00:00.000Z",
    });
    mocks.getProviderConnectionById.mockResolvedValue(latest);

    const { refreshAndUpdateCredentials } = await import(
      "../../src/app/api/usage/[connectionId]/route.js"
    );
    const result = await refreshAndUpdateCredentials(codexConnection(), false, { strictProxy: false });

    expect(mocks.getProviderConnectionById).toHaveBeenCalledWith("codex-conn-1");
    // 关键断言：executor 拿到的是 DB 里轮换后的 refresh token，不是快照里的旧值
    expect(executor.refreshCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "rotated-refresh", accessToken: "rotated-access" }),
      expect.anything(),
      { strictProxy: false }
    );
    expect(result.refreshed).toBe(true);
    // 刷新结果写回了 latest 连接
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "codex-conn-1",
      expect.objectContaining({ accessToken: "fresh-access", refreshToken: "fresh-refresh" })
    );
  });

  it("falls back to the passed connection when the DB lookup returns nothing", async () => {
    const executor = codexExecutor();
    mocks.getExecutor.mockReturnValue(executor);
    mocks.getProviderConnectionById.mockResolvedValue(null);

    const { refreshAndUpdateCredentials } = await import(
      "../../src/app/api/usage/[connectionId]/route.js"
    );
    await refreshAndUpdateCredentials(codexConnection(), false, { strictProxy: false });

    expect(executor.refreshCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "stale-refresh" }),
      expect.anything(),
      { strictProxy: false }
    );
  });

  it("throws on unrecoverable refresh errors instead of continuing with the dead token", async () => {
    mocks.getExecutor.mockReturnValue(
      codexExecutor({
        refreshCredentials: vi.fn(async () => ({ error: "invalid_grant" })),
      })
    );
    // DB 快照与调用方一致
    mocks.getProviderConnectionById.mockImplementation(async () => null);

    const { refreshAndUpdateCredentials } = await import(
      "../../src/app/api/usage/[connectionId]/route.js"
    );

    await expect(refreshAndUpdateCredentials(codexConnection()))
      .rejects.toThrow(/re-authorize/i);
    // 死 token 绝不落库 —— 但「待重新授权」的标记要落库（P2-11：仪表盘要能看见，
    // 轮换里也要摘掉）。断言写库内容里没有凭据字段，而不是断言完全没有写库。
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "codex-conn-1",
      expect.objectContaining({ testStatus: "needs-reauth" })
    );
    for (const [, updates] of mocks.updateProviderConnection.mock.calls) {
      expect(updates).not.toHaveProperty("accessToken");
      expect(updates).not.toHaveProperty("refreshToken");
    }
  });

  it("treats refresh_token_reused the same way (session already revoked)", async () => {
    mocks.getExecutor.mockReturnValue(
      codexExecutor({
        refreshCredentials: vi.fn(async () => ({ error: "refresh_token_reused" })),
      })
    );
    mocks.getProviderConnectionById.mockResolvedValue(null);

    const { refreshAndUpdateCredentials } = await import(
      "../../src/app/api/usage/[connectionId]/route.js"
    );

    await expect(refreshAndUpdateCredentials(codexConnection()))
      .rejects.toThrow(/re-authorize/i);
  });

  it("keeps the soft-fallback for recoverable null results when an access token exists", async () => {
    mocks.getExecutor.mockReturnValue(
      codexExecutor({ refreshCredentials: vi.fn(async () => null) })
    );
    mocks.getProviderConnectionById.mockResolvedValue(null);

    const { refreshAndUpdateCredentials } = await import(
      "../../src/app/api/usage/[connectionId]/route.js"
    );
    const result = await refreshAndUpdateCredentials(codexConnection());

    expect(result.refreshed).toBe(false);
  });
});

describe("checkAndRefreshToken (src/sse) — 采纳 DB 里更新的 token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adopts the newer DB token and refreshes with it instead of the stale snapshot", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      refreshToken: "rotated-refresh",
      accessToken: "rotated-access",
      expiresAt: "2026-10-01T12:00:00.000Z",
      lastRefreshAt: "2026-10-01T01:00:00.000Z",
    });
    mocks.shouldRefreshCredentials.mockReturnValue(true);
    mocks.refreshProviderCredentials.mockResolvedValue({
      accessToken: "next-access",
      refreshToken: "next-refresh",
      expiresIn: 3600,
      lastRefreshAt: "2026-10-01T02:00:00.000Z",
    });

    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    await checkAndRefreshToken("codex", {
      connectionId: "codex-conn-1",
      refreshToken: "stale-refresh",
      accessToken: "stale-access",
      lastRefreshAt: "2026-09-30T00:00:00.000Z",
    });

    // 关键断言：实际刷新用的是采纳后的 rotated token——不存在旧 token 复用
    expect(mocks.refreshProviderCredentials).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ refreshToken: "rotated-refresh", accessToken: "rotated-access" }),
      expect.anything()
    );
  });

  it("returns the adopted token without refreshing when nothing is due", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      refreshToken: "rotated-refresh",
      accessToken: "rotated-access",
      lastRefreshAt: "2026-10-01T01:00:00.000Z",
    });
    mocks.shouldRefreshCredentials.mockReturnValue(false);

    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    const result = await checkAndRefreshToken("codex", {
      connectionId: "codex-conn-1",
      refreshToken: "stale-refresh",
      providerSpecificData: {},
    });

    expect(mocks.refreshProviderCredentials).not.toHaveBeenCalled();
    expect(result.refreshToken).toBe("rotated-refresh");
    expect(result.accessToken).toBe("rotated-access");
  });

  it("ignores DB records that are not newer than the in-memory snapshot", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      refreshToken: "other-refresh",
      lastRefreshAt: "2026-09-29T00:00:00.000Z", // 比内存快照更旧
    });
    mocks.shouldRefreshCredentials.mockReturnValue(true);
    mocks.refreshProviderCredentials.mockResolvedValue(null);

    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    await checkAndRefreshToken("codex", {
      connectionId: "codex-conn-1",
      refreshToken: "stale-refresh",
      lastRefreshAt: "2026-09-30T00:00:00.000Z",
    });

    expect(mocks.refreshProviderCredentials).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ refreshToken: "stale-refresh" }),
      expect.anything()
    );
  });

  it("ignores DB records carrying the same refresh token", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      refreshToken: "stale-refresh", // 与内存一致，无需采纳
      lastRefreshAt: "2026-10-01T01:00:00.000Z",
    });
    mocks.shouldRefreshCredentials.mockReturnValue(true);
    mocks.refreshProviderCredentials.mockResolvedValue(null);

    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    await checkAndRefreshToken("codex", {
      connectionId: "codex-conn-1",
      refreshToken: "stale-refresh",
      lastRefreshAt: "2026-09-30T00:00:00.000Z",
    });

    expect(mocks.refreshProviderCredentials).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ refreshToken: "stale-refresh" }),
      expect.anything()
    );
  });

  it("fails open when the DB lookup rejects and still refreshes with the original creds", async () => {
    mocks.getProviderConnectionById.mockRejectedValue(new Error("db down"));
    mocks.shouldRefreshCredentials.mockReturnValue(true);
    mocks.refreshProviderCredentials.mockResolvedValue(null);

    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    await checkAndRefreshToken("codex", {
      connectionId: "codex-conn-1",
      refreshToken: "stale-refresh",
      lastRefreshAt: "2026-09-30T00:00:00.000Z",
    });

    expect(mocks.refreshProviderCredentials).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ refreshToken: "stale-refresh" }),
      expect.anything()
    );
  });

  it("never touches the DB when no connectionId is resolvable", async () => {
    mocks.shouldRefreshCredentials.mockReturnValue(false);

    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    const result = await checkAndRefreshToken("codex", { refreshToken: "rt" });

    expect(mocks.getProviderConnectionById).not.toHaveBeenCalled();
    expect(result.refreshToken).toBe("rt");
  });
});
