/**
 * 「轮询 — 按会话」策略名与新旧悬停说明的 i18n 覆盖闸。
 *
 * 背景（用户 2026-11-28）：i18n 要补，**鼠标悬停的说明以前没有加**。
 * runtime 的 DOM walker 只扫文本节点、**不扫属性**（src/i18n/runtime.js 的
 * issue #154 注释），所以 Select 的 title 必须在 JSX 里显式 translate()——
 * 本文件同时钉住这条契约，防止有人把 title 写回裸英文。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const literalDir = resolve(root, "public/i18n/literals");

// Source strings as they appear in RoutingStrategySelect.js / 设置页.
const REQUIRED_KEYS = [
  "Round Robin — by time",
  "Round Robin — by request count",
  "Round Robin — by session",
  "Rotate combo members after an idle window or at the request limit.",
  "Keep the same account for the configured number of consecutive requests, then rotate to the next available account.",
  "New sessions rotate; each session keeps its last successful choice for up to 30 idle minutes. If that choice is unavailable, the next success takes over. Requests without a session use the ordinary rotation.",
  "Account routing",
  "Combo routing",
];

const locales = readdirSync(literalDir).filter((f) => f.endsWith(".json"));

describe("轮询策略 i18n 覆盖", () => {
  it.each(locales.map((f) => [f]))("%s 登记全部策略名与悬停说明", (file) => {
    const data = JSON.parse(readFileSync(resolve(literalDir, file), "utf8"));
    for (const key of REQUIRED_KEYS) {
      expect(data, `${file} 缺词条: ${key}`).toHaveProperty(key);
      expect(typeof data[key]).toBe("string");
      expect(data[key].trim().length, `${file} 空词条: ${key}`).toBeGreaterThan(0);
    }
  });

  it("zh-CN / zh-TW 给出真实译文而不是原样英文", () => {
    for (const file of ["zh-CN.json", "zh-TW.json"]) {
      const data = JSON.parse(readFileSync(resolve(literalDir, file), "utf8"));
      for (const key of REQUIRED_KEYS) {
        expect(data[key], `${file} 未翻译: ${key}`).not.toBe(key);
      }
    }
    expect(JSON.parse(readFileSync(resolve(literalDir, "zh-CN.json"), "utf8"))["Round Robin — by session"]).toBe("轮询 — 按会话");
  });

  it("三个策略名互不相同（旧项不得和新项同名造成误选）", () => {
    const data = JSON.parse(readFileSync(resolve(literalDir, "zh-CN.json"), "utf8"));
    const labels = ["Round Robin — by time", "Round Robin — by request count", "Round Robin — by session"].map((k) => data[k]);
    expect(new Set(labels).size).toBe(3);
  });
});

describe("悬停说明真的接到属性上（属性不会被 DOM walker 翻译）", () => {
  const src = readFileSync(resolve(root, "src/shared/components/RoutingStrategySelect.js"), "utf8");

  it("title 走 translate()", () => {
    expect(src).toMatch(/title=\{title \|\| \(help \? translate\(help\)/);
  });

  it("选项文案走 translate()", () => {
    expect(src).toMatch(/translate\(legacy\.label\)/);
    expect(src).toMatch(/translate\(SESSION\.label\)/);
  });

  it("监听语言切换重渲染（否则切语言后 title 停在旧语言）", () => {
    expect(src).toMatch(/onLocaleChange/);
  });

  it("旧 round-robin 存值不改：新增项是独立 value", () => {
    const cfg = readFileSync(resolve(root, "open-sse/config/routingStrategies.js"), "utf8");
    expect(cfg).toMatch(/export const ROUND_ROBIN = "round-robin"/);
    expect(cfg).toMatch(/export const SESSION_ROUND_ROBIN = "session-round-robin"/);
  });
});
