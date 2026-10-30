// Combo 条目软禁用（issue #91 方案 A）：旁挂 disabledModels 清单。
// 钉三层契约：
//   1. 纯函数 filterDisabledComboModels（combo.js 调度展开入口）
//   2. SQLite 持久化（migration 007 加列 + combosRepo 读写 + PUT 缺省保护）
//   3. DB 直读展开入口 getComboModels（model.js，chat/image 走它）
// plus 两个 UI 形状钉（两个 ComboFormModal 都接了 Toggle 并随 save 提交）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import { filterDisabledComboModels } from "../../open-sse/services/combo.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-combo-disable-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  // driver 没有 close 导出：Windows 下连接持有文件锁，rm 会 EBUSY。
  // 临时目录留在 %TEMP% 由 OS 清理，不值得为此给 driver 加 close 面。
  try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* EBUSY tolerated */ }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("filterDisabledComboModels (调度展开过滤)", () => {
  it("filters disabled entries while preserving order of the rest", () => {
    const models = ["zcode-free/glm", "cbai/glm", "cbcn/glm"];
    expect(filterDisabledComboModels(models, ["zcode-free/glm"]))
      .toEqual(["cbai/glm", "cbcn/glm"]);
  });

  it("returns models unchanged when disabledModels is absent/empty/not-an-array", () => {
    const models = ["a/x", "b/y"];
    expect(filterDisabledComboModels(models, null)).toBe(models);
    expect(filterDisabledComboModels(models, undefined)).toBe(models);
    expect(filterDisabledComboModels(models, [])).toBe(models);
    expect(filterDisabledComboModels(models, "b/y")).toBe(models); // 容错：非数组原样返回
  });

  it("returns empty array when everything is disabled (上层报无可用模型，不静默打禁用渠道)", () => {
    const models = ["a/x", "b/y"];
    expect(filterDisabledComboModels(models, ["a/x", "b/y"])).toEqual([]);
  });

  it("is tolerant of duplicates and non-member disabled ids", () => {
    expect(filterDisabledComboModels(["a/x"], ["a/x", "ghost/z"])).toEqual([]);
  });
});

describe("SQLite persistence (migration 007 + combosRepo)", () => {
  it("creates a combo with disabledModels and reads it back", async () => {
    const created = await db.createCombo({
      name: "router-test-a",
      models: ["zcode-free/glm", "cbai/glm"],
      disabledModels: ["zcode-free/glm"],
    });
    expect(created.disabledModels).toEqual(["zcode-free/glm"]);

    const fetched = await db.getComboByName("router-test-a");
    expect(fetched.models).toEqual(["zcode-free/glm", "cbai/glm"]); // models 保序不动
    expect(fetched.disabledModels).toEqual(["zcode-free/glm"]);
  });

  it("defaults disabledModels to [] on legacy-style create without the field", async () => {
    const created = await db.createCombo({ name: "router-test-b", models: ["cbai/glm"] });
    expect(created.disabledModels).toEqual([]);
  });

  it("updateCombo persists a new disabledModels list (toggle off → on)", async () => {
    const created = await db.createCombo({
      name: "router-test-c",
      models: ["a/x", "b/y", "c/z"],
      disabledModels: ["a/x"],
    });
    const updated = await db.updateCombo(created.id, { disabledModels: ["a/x", "c/z"] });
    expect(updated.disabledModels).toEqual(["a/x", "c/z"]);
    expect(updated.models).toEqual(["a/x", "b/y", "c/z"]); // 排序位从未被动过
  });

  it("updateCombo WITHOUT disabledModels in the body keeps stored values (PUT 缺省保护)", async () => {
    const created = await db.createCombo({
      name: "router-test-d",
      models: ["a/x", "b/y"],
      disabledModels: ["b/y"],
    });
    // 组合改名/排序等其它 UI 写路径不带 disabledModels——不能被抹掉
    const updated = await db.updateCombo(created.id, { models: ["b/y", "a/x"] });
    expect(updated.models).toEqual(["b/y", "a/x"]);
    expect(updated.disabledModels).toEqual(["b/y"]);
  });

  it("round-trips through the expand entry (getComboModels) — the chat/image path", async () => {
    await db.createCombo({
      name: "router-test-e",
      models: ["zcode-free/glm", "cbai/glm"],
      disabledModels: ["zcode-free/glm"],
    });
    const { getComboModels } = await import("@/sse/services/model.js");
    expect(await getComboModels("router-test-e")).toEqual(["cbai/glm"]);
    expect(await getComboModels("router-test-a")).toEqual(["cbai/glm"]);
  });
});

describe("UI wiring pins (两个 ComboFormModal 都接了 Toggle)", () => {
  const read = (rel) => fs.readFileSync(path.resolve(__dirname, "../..", rel), "utf8");

  it("shared ComboFormModal renders the toggle and submits disabledModels", () => {
    const src = read("src/shared/components/ComboFormModal.js");
    expect(src).toContain("onToggleDisabled");
    expect(src).toContain("disabledModels");
    expect(src).toContain("toggle_off"); // 置灰图标
    expect(src).toContain("line-through"); // 禁用条目视觉
  });

  it("combos page (draggable variant) renders the toggle and submits disabledModels", () => {
    const src = read("src/app/(dashboard)/dashboard/combos/page.js");
    expect(src).toContain("onToggleDisabled");
    expect(src).toContain("disabledModels");
    expect(src).toContain("toggle_off");
  });

  it("combos POST route accepts disabledModels (PUT 已自然透传)", () => {
    const src = read("src/app/api/combos/route.js");
    expect(src).toContain("disabledModels");
  });
});
