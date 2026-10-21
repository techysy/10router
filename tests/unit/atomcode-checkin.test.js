/**
 * AtomCode check-in = CodingPlan claim.
 *
 * Pins the cascade contract (Max -> Pro -> Lite, stop on duplicate/success),
 * the already/no-activity outcomes, the failure codes, and the per-account
 * lock + same-day idempotency memo. No network: `ctx.fetch` is injected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import adapter, {
  __resetAtomcodeCheckinState,
  cascadeClaim,
  classifyTierResponse,
  isNotYetClaimable,
  planFromStatus,
  runAtomcodeCheckin,
} from "../../src/sse/services/checkin/providers/atomcode.js";

const DAY = "2026-10-20";
const conn = { id: "c-atom-1", provider: "atomcode", accessToken: "at-secret", isActive: true };

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const activeStatus = () => ({
  codingplan_free: {
    plan_name: "CodingPlan Lite-体验版",
    expires_at: "2026-11-08 12:00:00",
    remaining_days: 19,
    total_days: 30,
  },
});

const pendingStatus = () => ({
  codingplan_free: { plan_name: "CodingPlan Lite-体验版", expires_at: "", remaining_days: 0 },
});

const claim = (body, status = 200) => response(body, status);
const refused = (message) => claim({ success: false, duplicate: false, message });
const granted = (message = "领取成功") => claim({ success: true, duplicate: false, message });

beforeEach(() => {
  __resetAtomcodeCheckinState();
});

describe("planFromStatus / classifyTierResponse", () => {
  it("treats an expiry or remaining days as active, empty expiry as pending", () => {
    expect(planFromStatus(activeStatus()).active).toBe(true);
    expect(planFromStatus(pendingStatus()).active).toBe(false);
    expect(planFromStatus({}).active).toBe(false);
    expect(planFromStatus({ codingplan_free: { remaining_days: 3 } }).active).toBe(true);
  });

  it("checks duplicate before success (duplicate is success semantics)", () => {
    expect(classifyTierResponse({ success: false, duplicate: true, message: "已领取" }).kind).toBe("already");
    expect(classifyTierResponse({ success: true, duplicate: false }).kind).toBe("granted");
    expect(classifyTierResponse({ success: false, duplicate: false, message: "x" }).kind).toBe("refused");
    // Duplicate wins even if both flags are set.
    expect(classifyTierResponse({ success: true, duplicate: true }).kind).toBe("already");
  });

  it("recognises the not-yet copy", () => {
    expect(isNotYetClaimable("未到领取时间，请稍后重试")).toBe(true);
    expect(isNotYetClaimable("名额已满")).toBe(false);
  });
});

describe("cascadeClaim", () => {
  it("stops on duplicate and does not fall through to a lower tier", async () => {
    const tiers = [];
    const out = await cascadeClaim({
      claimTier: async (tier) => {
        tiers.push(tier);
        if (tier === "Max") return { ok: true, status: 200, payload: { success: false, duplicate: false, message: "暂无有效合入 PR" } };
        return { ok: true, status: 200, payload: { success: false, duplicate: true, message: "已领取", plan_name: "CodingPlan Pro" } };
      },
    });
    expect(tiers).toEqual(["Max", "Pro"]);
    expect(out.outcome).toBe("already");
    expect(out.code).toBe("already-held");
    expect(out.tier).toBe("Pro");
    expect(out.planName).toBe("CodingPlan Pro");
  });

  it("stops on success", async () => {
    const out = await cascadeClaim({
      claimTier: async () => ({ ok: true, status: 200, payload: { success: true, duplicate: false, message: "领取成功" } }),
    });
    expect(out.outcome).toBe("ok");
    expect(out.tier).toBe("Max");
  });

  it("aborts the cascade on a transport/HTTP failure", async () => {
    const tiers = [];
    const out = await cascadeClaim({
      claimTier: async (tier) => {
        tiers.push(tier);
        return { ok: false, status: 500 };
      },
    });
    expect(tiers).toEqual(["Max"]);
    expect(out).toMatchObject({ outcome: "failed", code: "http-500" });
  });

  it("maps 401/429 to needs-reauth/limited", async () => {
    const auth = await cascadeClaim({ claimTier: async () => ({ ok: false, status: 401 }) });
    expect(auth).toMatchObject({ outcome: "needs-reauth", code: "auth" });
    const limited = await cascadeClaim({ claimTier: async () => ({ ok: false, status: 429 }) });
    expect(limited).toMatchObject({ outcome: "limited", code: "rate-limited" });
  });
});

describe("runAtomcodeCheckin", () => {
  it("reports already from an active plan without touching claim-v2", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(activeStatus()));
    const out = await runAtomcodeCheckin(conn, { fetch: fetchMock });

    expect(out.status).toBe("already");
    expect(out.code).toBe("plan-active");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/coding-plan/status-v2");
  });

  it("claims Max and verifies the delivered days", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(pendingStatus()))
      .mockResolvedValueOnce(granted())
      .mockResolvedValueOnce(response(activeStatus()));

    const out = await runAtomcodeCheckin(conn, { fetch: fetchMock });

    expect(out.status).toBe("ok");
    expect(out.code).toBe("claimed");
    expect(out.amount).toBe(30);
    expect(out.unit).toBe("天");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, init] = fetchMock.mock.calls[1];
    expect(JSON.parse(init.body)).toEqual({ plan_type: "Max" });
  });

  it("reports no-activity when every tier says the window is not open", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(pendingStatus()))
      .mockResolvedValueOnce(refused("暂无有效合入 PR，暂不可领取 Max 套餐"))
      .mockResolvedValueOnce(refused("未到领取时间，请稍后重试"))
      .mockResolvedValueOnce(refused("未到领取时间，请稍后重试"));

    const out = await runAtomcodeCheckin(conn, { fetch: fetchMock });

    expect(out.status).toBe("no-activity");
    expect(out.code).toBe("not-yet");
    expect(out.message).toContain("未到领取时间");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reports needs-reauth on 401 and never claims", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ message: "401 Unauthorized" }, 401));
    const out = await runAtomcodeCheckin(conn, { fetch: fetchMock });
    expect(out.status).toBe("needs-reauth");
    expect(out.code).toBe("auth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a 5xx claim failure to http-500 and stops", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(pendingStatus()))
      .mockResolvedValueOnce(response({ message: "boom" }, 500));

    const out = await runAtomcodeCheckin(conn, { fetch: fetchMock });

    expect(out.status).toBe("failed");
    expect(out.code).toBe("http-500");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("adapter run", () => {
  it("memoizes a successful claim and reports the second same-day run as already", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(pendingStatus()))
      .mockResolvedValueOnce(granted())
      .mockResolvedValueOnce(response(activeStatus()));

    const first = await adapter.run(conn, { today: DAY, fetch: fetchMock });
    expect(first.status).toBe("ok");

    const second = await adapter.run(conn, { today: DAY, fetch: fetchMock });
    expect(second.status).toBe("already");
    expect(second.code).toBe("idempotent-memo");
    expect(fetchMock).toHaveBeenCalledTimes(3); // no extra upstream calls

    // A different day is a fresh probe.
    await adapter.run(conn, { today: "2026-10-21", fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("holds a per-account running lock", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return response(activeStatus());
    });

    const running = adapter.run(conn, { today: DAY, fetch: fetchMock });
    await Promise.resolve();

    const second = await adapter.run(conn, { today: DAY, fetch: fetchMock });
    expect(second.status).toBe("limited");
    expect(second.code).toBe("in-progress");

    release();
    const first = await running;
    expect(first.status).toBe("already");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
