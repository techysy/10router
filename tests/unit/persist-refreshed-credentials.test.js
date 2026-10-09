import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

const { persistRefreshedCredentials, CredentialPersistError, updateProviderCredentials } =
  await import("../../src/sse/services/tokenRefresh.js");

/**
 * A lost write of a rotated refresh token is catastrophic and silent: upstream
 * consumed the old token the moment it issued the new one, so the next request
 * that reads the DB sends a dead token and the whole session is revoked. The
 * "DB is newer" adoption guard cannot recover it — a lost write leaves the DB
 * older, not newer. That is what this file pins.
 */
describe("persistRefreshedCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateProviderConnection.mockResolvedValue(true);
    mocks.getProviderConnectionById.mockResolvedValue({ refreshToken: "rt-old" });
  });

  it("returns true when the write lands", async () => {
    await expect(
      persistRefreshedCredentials("c1", { accessToken: "at", refreshToken: "rt-2" })
    ).resolves.toBe(true);
    expect(mocks.updateProviderConnection).toHaveBeenCalledTimes(1);
  });

  it("warns and continues when the write fails and the refresh token did NOT rotate", async () => {
    // The stored token is still good — losing the write only costs a redundant
    // refresh later, so failing the request would be over-strict.
    mocks.updateProviderConnection.mockResolvedValue(false);
    mocks.getProviderConnectionById.mockResolvedValue({ refreshToken: "rt-same" });

    await expect(
      persistRefreshedCredentials("c1", { accessToken: "at", refreshToken: "rt-same" }, { provider: "p" })
    ).resolves.toBe(false);
  });

  it("throws CredentialPersistError when the write fails and the refresh token rotated", async () => {
    mocks.updateProviderConnection.mockResolvedValue(false);
    mocks.getProviderConnectionById.mockResolvedValue({ refreshToken: "rt-old" });

    await expect(
      persistRefreshedCredentials("c1", { accessToken: "at", refreshToken: "rt-NEW" }, { provider: "codex" })
    ).rejects.toThrow(CredentialPersistError);
  });

  it("throws when the write fails and the stored refresh token cannot be read", async () => {
    // Conservative: we cannot prove the DB still holds a usable token.
    mocks.updateProviderConnection.mockResolvedValue(false);
    mocks.getProviderConnectionById.mockResolvedValue(null);

    await expect(
      persistRefreshedCredentials("c1", { accessToken: "at", refreshToken: "rt-NEW" })
    ).rejects.toThrow(CredentialPersistError);
  });

  it("uses the caller's previousRefreshToken instead of re-reading the DB", async () => {
    mocks.updateProviderConnection.mockResolvedValue(false);

    await expect(
      persistRefreshedCredentials(
        "c1",
        { accessToken: "at", refreshToken: "rt-NEW" },
        { previousRefreshToken: "rt-OLD" }
      )
    ).rejects.toThrow(CredentialPersistError);
    expect(mocks.getProviderConnectionById).not.toHaveBeenCalled();
  });

  it("carries the full credential payload, not just the three fields the old copies kept", async () => {
    // The inlined handlers used to write only { accessToken, refreshToken,
    // providerSpecificData }, silently dropping lastRefreshAt / expiresAt.
    // lastRefreshAt is the key the "DB is newer" adoption guard compares on.
    mocks.updateProviderConnection.mockResolvedValue(true);
    await persistRefreshedCredentials(
      "c1",
      {
        accessToken: "at",
        refreshToken: "rt",
        idToken: "idt",
        lastRefreshAt: "2026-10-10T00:00:00.000Z",
        expiresAt: "2026-10-10T01:00:00.000Z",
        projectId: "proj",
        providerSpecificData: { copilotToken: "ct" },
      },
      { providerSpecificData: { keep: "me" } }
    );

    const updates = mocks.updateProviderConnection.mock.calls[0][1];
    expect(updates.lastRefreshAt).toBe("2026-10-10T00:00:00.000Z");
    expect(updates.idToken).toBe("idt");
    expect(updates.projectId).toBe("proj");
    // providerSpecificData is merged under the stored copy, never replaced.
    expect(updates.providerSpecificData).toEqual({ keep: "me", copilotToken: "ct" });
  });

  it("marks the connection active again on a successful write", async () => {
    mocks.updateProviderConnection.mockResolvedValue(true);
    await persistRefreshedCredentials("c1", { accessToken: "at" });
    expect(mocks.updateProviderConnection.mock.calls[0][1].testStatus).toBe("active");
  });
});

describe("updateProviderCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateProviderConnection.mockResolvedValue(true);
  });

  it("returns false instead of throwing when the DB layer rejects", async () => {
    mocks.updateProviderConnection.mockRejectedValue(new Error("disk full"));
    await expect(updateProviderCredentials("c1", { accessToken: "at" })).resolves.toBe(false);
  });
});
