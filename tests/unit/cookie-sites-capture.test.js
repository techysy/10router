/**
 * 会话池 capture/clear 路由（#150）单测
 *
 * Covers:
 *  - capture：同槽同账号键 → 更新该行；异槽 → 新建行；空槽兜底建行
 *  - capture：未知站点 404 / 空 cookie 400 / 缺 CLI token 401
 *  - clear：命中槽删除 / 空槽 ok+deleted:false
 *
 * 路由模块按 Next route handler 形态直接调用（mock db + registry 动态导入）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const dbState = {
  connections: [],
  created: [],
  updated: [],
  deleted: [],
};

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: vi.fn(async ({ provider } = {}) =>
    dbState.connections.filter((c) => !provider || c.provider === provider)
  ),
  updateProviderConnection: vi.fn(async (id, patch) => {
    dbState.updated.push({ id, patch });
    const row = dbState.connections.find((c) => c.id === id);
    if (row) Object.assign(row, patch);
    return row;
  }),
  deleteProviderConnection: vi.fn(async (id) => {
    dbState.deleted.push(id);
    dbState.connections = dbState.connections.filter((c) => c.id !== id);
  }),
  createProviderConnection: vi.fn(async (data) => {
    const row = { id: `new-${dbState.created.length + 1}`, ...data };
    dbState.created.push(row);
    dbState.connections.push(row);
    return row;
  }),
}));

const { POST, DELETE } = await import("@/app/api/cookie-sites/[id]/route.js");

function req(method, { body, slot } = {}) {
  const headers = new Headers({ "x-10r-cli-token": "tok" });
  const url = `http://local/api/cookie-sites/lingxi${slot ? `?slot=${slot}` : ""}`;
  return new Request(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ctx = (id = "lingxi") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  dbState.connections = [];
  dbState.created = [];
  dbState.updated = [];
  dbState.deleted = [];
});

describe("POST capture", () => {
  it("未知站点 → 404", async () => {
    const res = await POST(req("POST", { body: { slot: 1, cookie: "c" } }), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("空 cookie → 400", async () => {
    const res = await POST(req("POST", { body: { slot: 1, cookie: "  " } }), ctx());
    expect(res.status).toBe(400);
  });

  it("缺 CLI token → 401", async () => {
    const bare = new Request("http://local/api/cookie-sites/lingxi", {
      method: "POST",
      body: JSON.stringify({ slot: 1, cookie: "c" }),
    });
    const res = await POST(bare, ctx());
    expect(res.status).toBe(401);
  });

  it("空槽 → 新建行并标 cookieSlot", async () => {
    const res = await POST(req("POST", { body: { slot: 3, cookie: "ck-1" } }), ctx());
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.created).toBe(true);
    expect(data.slot).toBe(3);
    expect(dbState.created).toHaveLength(1);
    expect(dbState.created[0].provider).toBe("lingxi");
    expect(dbState.created[0].providerSpecificData.cookieSlot).toBe(3);
  });

  it("同槽再上报（无账号键可辨）→ 更新该槽唯一行", async () => {
    await POST(req("POST", { body: { slot: 2, cookie: "ck-a" } }), ctx());
    const res = await POST(req("POST", { body: { slot: 2, cookie: "ck-b" } }), ctx());
    const data = await res.json();
    expect(data.updated).toBe(true);
    expect(dbState.created).toHaveLength(1);
    expect(dbState.updated).toHaveLength(1);
    expect(dbState.updated[0].patch.apiKey).toBe("ck-b");
    expect(dbState.updated[0].patch.providerSpecificData.cookieSlot).toBe(2);
  });

  it("异槽上报 → 分行（不污染其他槽）", async () => {
    await POST(req("POST", { body: { slot: 1, cookie: "ck-1" } }), ctx());
    await POST(req("POST", { body: { slot: 2, cookie: "ck-2" } }), ctx());
    expect(dbState.created).toHaveLength(2);
    expect(dbState.created[0].providerSpecificData.cookieSlot).toBe(1);
    expect(dbState.created[1].providerSpecificData.cookieSlot).toBe(2);
  });

  it("slot 越界收敛到 1-9", async () => {
    const res = await POST(req("POST", { body: { slot: 99, cookie: "ck-x" } }), ctx());
    const data = await res.json();
    expect(data.slot).toBe(9);
    const res2 = await POST(req("POST", { body: { slot: 0, cookie: "ck-y" } }), ctx());
    const data2 = await res2.json();
    expect(data2.slot).toBe(1);
  });
});

describe("DELETE clear", () => {
  it("命中槽 → 删除该行", async () => {
    await POST(req("POST", { body: { slot: 1, cookie: "ck-1" } }), ctx());
    await POST(req("POST", { body: { slot: 2, cookie: "ck-2" } }), ctx());
    const res = await DELETE(req("DELETE", { slot: 1 }), ctx());
    const data = await res.json();
    expect(data.deleted).toBe(true);
    expect(dbState.deleted).toHaveLength(1);
    expect(dbState.connections.find((c) => c.apiKey === "ck-2")).toBeTruthy();
    expect(dbState.connections.find((c) => c.apiKey === "ck-1")).toBeFalsy();
  });

  it("空槽 → ok 但不删", async () => {
    const res = await DELETE(req("DELETE", { slot: 5 }), ctx());
    const data = await res.json();
    expect(data.deleted).toBe(false);
    expect(dbState.deleted).toHaveLength(0);
  });
});
