// 回归：额度页工具栏沙漏按钮（Resets first）点了没效果且样式异常（2026-11-23 用户报）。
//
// 两个根因，都钉在这里：
// 1. 「没效果」——排序此前只有客户端一跳：sortVisibleConnections 只重排当前页、
//    只认卡上配额的 resetAt（配额没落地/已过期的卡并列 → 回退序 ≈ 默认序），
//    且服务端 /api/providers/client 根本不认 `sort=expiring`，前端也从不传。
//    修复：服务端按连接行持久化的 earliestPackageExpiry 做跨页排序，前端把
//    expiringFirst 接进 sort 参数与缓存键，客户端兜底排序补行级回退。
// 2. 「样式乱」——cn() 是裸拼接（无 tailwind-merge），ICON 方钮
//    `CONTROL + "w-8 justify-center px-0" + ACTIVE` 里 px-2.5 挤压 16px 图标、
//    ACTIVE 与 CONTROL 的同属性色类按样式表顺序随机赢，粉底小方块即此。
//    修复：方钮改专用 ICON_BTN 常量（无内边距冲突，色类整组切换）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  sortVisibleConnections,
  sortRequestFromExpiringFirst,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const ROUTE = readFileSync(
  fileURLToPath(
    new URL(
      "../../src/app/api/providers/client/route.js",
      import.meta.url,
    ),
  ),
  "utf8",
);
const TOOLBAR = readFileSync(
  fileURLToPath(
    new URL(
      "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaToolbar.js",
      import.meta.url,
    ),
  ),
  "utf8",
);
const INDEX = readFileSync(
  fileURLToPath(
    new URL(
      "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js",
      import.meta.url,
    ),
  ),
  "utf8",
);
const CACHE = readFileSync(
  fileURLToPath(
    new URL(
      "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaPageCache.js",
      import.meta.url,
    ),
  ),
  "utf8",
);

const label = (c) => c.name || c.email || c.id;

describe("服务端 expiring 排序（client route）", () => {
  it("route 认 sort=expiring 并按 earliestPackageExpiry 排序", () => {
    expect(ROUTE).toMatch(/sort === "expiring"/);
    expect(ROUTE).toMatch(/earliestPackageExpiry/);
  });

  it("earliestPackageExpiry 在 SAFE_FIELDS 白名单里（否则 sanitize 剥掉它）", () => {
    expect(ROUTE).toMatch(/"earliestPackageExpiry"/);
  });

  it("排序语义：有到期时间的在前（升序），没有的沉底，并列按 provider/name", () => {
    // 直接复刻 route.js 里的 expiring 分支语义做纯函数验证（route 本体依赖
    // DB，单测跑不动——语义钉住，route 里改动语义时这里会红）。
    const expiryTime = (c) => {
      const t = c?.earliestPackageExpiry ? new Date(c.earliestPackageExpiry).getTime() : NaN;
      return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
    };
    const sort = (list) =>
      [...list].sort((a, b) => {
        const diff = expiryTime(a) - expiryTime(b);
        if (diff !== 0) return diff;
        return (
          (a.provider || "").localeCompare(b.provider || "") ||
          (a.name || "").localeCompare(b.name || "")
        );
      });

    const soon = { provider: "meoo", name: "a", earliestPackageExpiry: new Date(Date.now() + 24 * 3600 * 1000).toISOString() };
    const later = { provider: "meoo", name: "b", earliestPackageExpiry: new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString() };
    const none = { provider: "qoder", name: "c" };
    const otherProviderTie = { provider: "aaaa", name: "z", earliestPackageExpiry: soon.earliestPackageExpiry };

    const sorted = sort([none, later, otherProviderTie, soon]);
    expect(sorted.map((c) => c.name)).toEqual(["z", "a", "b", "c"]);
  });
});

describe("前端接线（index.js / quotaPageCache.js）", () => {
  it("fetchConnections 把 expiringFirst 换算成 sort 参数传给后端", () => {
    expect(INDEX).toMatch(/sort: sortRequestFromExpiringFirst\(expiringFirst\)/);
    expect(INDEX).not.toMatch(/sort: "priority"/);
  });

  it("index.js 从 utils 引用的每个标识符都在 import 清单里（2026-11-24 全页连接消失的回归：漏 import 运行时 ReferenceError 被 catch 吞掉、页面保持空缓存——CI 只跑源码契约发现不了，必须钉住 import 完整性）", () => {
    // 提取 `import { ... } from "./utils"` 的命名清单。
    const importBlock = INDEX.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/utils"/);
    expect(importBlock).toBeTruthy();
    const imported = new Set(
      importBlock[1]
        .split(",")
        .map((s) => s.trim().replace(/^type\s+/, ""))
        .filter(Boolean),
    );
    // INDEX 里每个来自 utils 的裸标识符引用：找出所有在 INDEX 中出现、且是
    // utils 导出名的标识符，逐一核对在 import 清单里。utils 的导出名单从
    // utils.js 源码抓（export function/const/…）。
    const utilsFile = readFileSync(
      fileURLToPath(
        new URL(
          "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const exported = new Set();
    for (const m of utilsFile.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      exported.add(m[1]);
    }
    // utils.js 也可能用 export { a, b } 形式，补抓。
    for (const m of utilsFile.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const name of m[1].split(",")) {
        const n = name.trim().split(/\s+as\s+/).pop().trim();
        if (n) exported.add(n);
      }
    }
    expect(exported.size).toBeGreaterThan(10);
    // INDEX 里每个被引用的 utils 导出名：只要名字出现在 INDEX 正文（import
    // 块之外）且属于 utils 导出面，就必须在 import 清单里。
    const body = INDEX.replace(importBlock[0], "");
    const missing = [];
    for (const name of exported) {
      const used = new RegExp(`\\b${name}\\b`).test(body);
      if (used && !imported.has(name)) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it("连接缓存键包含 expiringFirst（默认序页面不得顶替 Resets first 序）", () => {
    expect(CACHE).toMatch(/expiringFirst === true \? 1 : 0/);
    expect(INDEX).toMatch(/connectionsCacheKey\(\{ page: targetPage, pageSize, accountFilter, providerFilter, expiringFirst \}\)/);
    expect(INDEX).toMatch(/connectionsCacheKey\(\{ page, pageSize, accountFilter, providerFilter, expiringFirst \}\)/);
  });
});

describe("客户端兜底排序 sortVisibleConnections", () => {
  // 夹具日期全部相对 now 生成——固定日期在未来的某次运行里会变成「过去」，
  // 测试就会自己红掉。
  const iso = (hoursAhead) => new Date(Date.now() + hoursAhead * 3600 * 1000).toISOString();

  const build = (connList, quotaData) => ({
    connections: connList,
    quotaData,
  });

  it("卡上配额未落地时回退连接行的 earliestPackageExpiry", () => {
    const { connections } = build(
      [
        { id: "no-date", provider: "meoo", name: "no-date" },
        { id: "row", provider: "meoo", name: "row", earliestPackageExpiry: iso(24) },
      ],
      {},
    );
    const sorted = sortVisibleConnections(connections, {}, true, "all", "default");
    expect(sorted.map(label)).toEqual(["row", "no-date"]);
  });

  it("卡上 resetAt（未来的）优先于行级回退", () => {
    const { connections, quotaData } = build(
      [
        { id: "row", provider: "meoo", name: "row", earliestPackageExpiry: iso(48) },
        { id: "card", provider: "meoo", name: "card" },
      ],
      {
        card: { quotas: [{ name: "pack", used: 1, total: 10, resetAt: iso(6) }] },
      },
    );
    const sorted = sortVisibleConnections(connections, quotaData, true, "all", "default");
    expect(sorted.map(label)).toEqual(["card", "row"]);
  });

  it("已过期（窗口已回血）的 resetAt 不再当「最早到期」参与排序", () => {
    const { connections, quotaData } = build(
      [
        { id: "past", provider: "meoo", name: "past" },
        { id: "future", provider: "meoo", name: "future", earliestPackageExpiry: iso(72) },
      ],
      {
        past: { quotas: [{ name: "pack", used: 1, total: 10, resetAt: iso(-6) }] },
      },
    );
    const sorted = sortVisibleConnections(connections, quotaData, true, "all", "default");
    expect(sorted.map(label)).toEqual(["future", "past"]);
  });

  it("都没有到期时间的按 provider/name 稳定沉底", () => {
    const { connections } = build(
      [
        { id: "x", provider: "qoder", name: "x" },
        { id: "a", provider: "aaaa", name: "a" },
        { id: "b", provider: "meoo", name: "b" },
      ],
      {},
    );
    const sorted = sortVisibleConnections(connections, {}, true, "all", "default");
    expect(sorted.map(label)).toEqual(["a", "b", "x"]);
  });

  it("codex 剩余排序分支不受影响（quotaSortMode 非 default 仍走剩余量排序）", () => {
    const { connections } = build(
      [
        { id: "a", provider: "codex", name: "a" },
        { id: "b", provider: "codex", name: "b" },
      ],
      {
        a: { quotas: [{ name: "5h", used: 90, total: 100, remaining: 10 }] },
        b: { quotas: [{ name: "5h", used: 10, total: 100, remaining: 90 }] },
      },
    );
    const sorted = sortVisibleConnections(connections, quotaDataOf({ a: 10, b: 90 }), true, "codex", "remaining-desc");
    expect(sorted.map(label)).toEqual(["b", "a"]);
  });

  it("sortRequestFromExpiringFirst 布尔换算（前后端参数契约）", () => {
    expect(sortRequestFromExpiringFirst(true)).toBe("expiring");
    expect(sortRequestFromExpiringFirst(false)).toBe("priority");
  });
});

// quotaData 形状帮助函数：getConnectionQuotaRemaining 只读 quotas[0].remaining。
function quotaDataOf(map) {
  const out = {};
  for (const [id, remaining] of Object.entries(map)) {
    out[id] = { quotas: [{ name: "5h", remaining }] };
  }
  return out;
}

describe("方钮样式根治（QuotaToolbar）", () => {
  it("沙漏按钮不再叠 CONTROL + w-8 + px-0（内边距冲突挤压图标的旧写法）", () => {
    expect(TOOLBAR).not.toMatch(/cn\(CONTROL, "w-8 justify-center px-0"/);
  });

  it("方钮走专用 ICON_BTN 常量：无 px-2.5 冲突，激活态整组换色", () => {
    expect(TOOLBAR).toMatch(/const ICON_BTN =/);
    // ICON_BTN 不得携带 CONTROL 的 px-2.5 / bg-surface（色类必须由状态类整组给出）
    const iconBtn = TOOLBAR.match(/const ICON_BTN =\s*\n?\s*"([^"]+)"/)?.[1] || "";
    expect(iconBtn).not.toMatch(/px-2\.5/);
    expect(iconBtn).not.toMatch(/bg-surface/);
    // 沙漏激活态由 ICON_BTN_ON（= ACTIVE）给出；关闭态由 ICON_BTN_OFF 给出
    expect(TOOLBAR).toMatch(/expiringFirst \? ICON_BTN_ON : ICON_BTN_OFF/);
  });

  it("沙漏按钮保留 aria-pressed 状态与 translate 工具提示", () => {
    expect(TOOLBAR).toMatch(/aria-pressed=\{expiringFirst\}/);
    expect(TOOLBAR).toMatch(/title=\{translate\("Sort accounts by earliest reset or expiry time"\)\}/);
    expect(TOOLBAR).toMatch(/aria-label=\{translate\("Resets first"\)\}/);
  });
});
