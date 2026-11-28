/**
 * 组合层「轮询 — 按会话」（session-round-robin）调度回归。
 *
 * 场景代号沿用需求口径：
 *   A1 新会话轮到下一可用成员，同会话粘住上次实际成功成员
 *   B1 空闲 30 分钟过期后重新轮转
 *   A2 工具续轮换 ID 仍按我们发出的调用 ID 续绑
 *   B2 粘住的成员失效/冷却让位，恢复后不抢回
 * 外加：无可靠会话标识回落现有空闲窗口、旧策略行为不变。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSessionScheduler, createRoutingIdentity, routingCaller } from "../../open-sse/services/sessionAffinity.js";
import { SESSION_ROUND_ROBIN } from "../../open-sse/config/routingStrategies.js";

const members = ["m1", "m2", "m3"];

function identity(sessionId, apiKey = "sk-caller", extra = {}) {
  return createRoutingIdentity(
    { metadata: { user_id: JSON.stringify({ session_id: sessionId }) }, ...extra },
    null,
    routingCaller(apiKey, null),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("A1 新会话轮转 / 同会话粘住", () => {
  it("同一会话重复请求粘住首个成员", () => {
    const s = createSessionScheduler();
    const id = identity("s1");
    const first = s.plan("combo", id, members);
    const picked = first.order[0];
    first.advance(picked);
    first.commit(picked, ["call_1"]);
    const second = s.plan("combo", id, members);
    expect(second.order[0]).toBe(picked);
  });

  it("同调用方的新会话轮到下一个成员", () => {
    const s = createSessionScheduler();
    const p1 = s.plan("combo", identity("s1"), members);
    p1.advance(p1.order[0]);
    p1.commit(p1.order[0], []);
    const p2 = s.plan("combo", identity("s2"), members);
    expect(p2.order[0]).not.toBe(p1.order[0]);
  });

  it("不同调用方各自独立绑定", () => {
    const s = createSessionScheduler();
    const a = s.plan("combo", identity("s1", "key-a"), members);
    a.advance(a.order[0]);
    a.commit(a.order[0]);
    const b = s.plan("combo", identity("s1", "key-b"), members);
    b.advance(b.order[0]);
    b.commit(b.order[0]);
    expect(a.order[0]).not.toBe(b.order[0]);
    const a2 = s.plan("combo", identity("s1", "key-a"), members);
    expect(a2.order[0]).toBe(a.order[0]);
  });
});

describe("B1 空闲过期", () => {
  it("超过 TTL 后绑定失效并轮转", () => {
    vi.useFakeTimers();
    try {
      const s = createSessionScheduler();
      const id = identity("s1");
      const p1 = s.plan("combo", id, members);
      p1.advance(p1.order[0]);
      p1.commit(p1.order[0], []);
      vi.advanceTimersByTime(31 * 60_000);
      const p2 = s.plan("combo", id, members);
      expect(p2.order[0]).not.toBe(p1.order[0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("A2 工具续轮", () => {
  it("带我们发出的调用 ID 的续轮换 ID 仍粘原会话", () => {
    const s = createSessionScheduler();
    const id = identity("s1");
    const p1 = s.plan("combo", id, members);
    p1.advance(p1.order[0]);
    p1.commit(p1.order[0], ["call_9"]);
    // 客户端每轮换会话 id，但携带我们发出的调用 id
    const cont = createRoutingIdentity(
      { messages: [{ role: "tool", tool_call_id: "call_9", content: "ok" }] },
      null,
      routingCaller("sk-caller", null),
    );
    expect(cont.session).toBeNull();
    const p2 = s.plan("combo", cont, members);
    expect(p2.order[0]).toBe(p1.order[0]);
  });

  it("引用两个会话的调用 ID 时拒绝猜测", () => {
    const s = createSessionScheduler();
    for (const sid of ["s1", "s2"]) {
      const p = s.plan("combo", identity(sid), members);
      p.advance(p.order[0]);
      p.commit(p.order[0], [`call_${sid}`]);
    }
    const mixed = createRoutingIdentity(
      { messages: [{ role: "tool", tool_call_id: "call_s1" }, { role: "tool", tool_call_id: "call_s2" }] },
      null,
      routingCaller("sk-caller", null),
    );
    expect(s.plan("combo", mixed, members)).toBeNull();
  });

  it("普通请求引用历史调用 ID 不算续轮", () => {
    const s = createSessionScheduler();
    const id = identity("s1");
    const p = s.plan("combo", id, members);
    p.advance(p.order[0]);
    p.commit(p.order[0], ["call_hist"]);
    const plain = createRoutingIdentity(
      { messages: [{ role: "user", content: "new question" }, { role: "assistant", content: [{ type: "tool_use", id: "call_hist" }] }] },
      null,
      routingCaller("sk-caller", null),
    );
    expect(s.plan("combo", plain, members)).toBeNull();
  });
});

describe("B2 失效让位 / 不抢回", () => {
  it("粘住的成员被移出后顺延，恢复不抢回", () => {
    const s = createSessionScheduler();
    const id = identity("s1");
    const p1 = s.plan("combo", id, members);
    p1.advance(p1.order[0]);
    p1.commit(p1.order[0], []);
    const bound = p1.order[0];
    // 成员冷却：从成员表里剔除
    const rest = members.filter((m) => m !== bound);
    const p2 = s.plan("combo", id, rest);
    expect(p2.order[0]).not.toBe(bound);
    p2.commit(p2.order[0], []);
    const replacement = p2.order[0];
    // 成员恢复：不抢回原成员
    const p3 = s.plan("combo", id, members);
    expect(p3.order[0]).toBe(replacement);
  });
});

describe("旧策略不变 / 回落", () => {
  it("无可靠会话标识返回 null（回落现有空闲窗口）", () => {
    const s = createSessionScheduler();
    expect(s.plan("combo", null, members)).toBeNull();
    const bare = createRoutingIdentity({ messages: [{ role: "user", content: "hi" }] }, null, routingCaller("sk-caller", null));
    expect(bare).toBeNull();
    expect(s.plan("combo", bare, members)).toBeNull();
  });

  it("user_id 不是会话形状时不当作会话", () => {
    const id = createRoutingIdentity({ metadata: { user_id: "alice@example.com" } }, null, routingCaller("sk", null));
    expect(id).toBeNull();
  });

  it("存量 round-robin 值不被误改", () => {
    expect(SESSION_ROUND_ROBIN).toBe("session-round-robin");
    expect(SESSION_ROUND_ROBIN).not.toBe("round-robin");
  });
});
