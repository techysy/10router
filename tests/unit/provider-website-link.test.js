// 配额跟踪器卡片的图标跳转(体验优化):图标点击 → 仪表盘内该供应商的
// 管理详情页(/dashboard/providers/[id])。官网/控制台外链保留在详情页头部
// (Web console / Get API Key / Sign up),不在配额卡片重复出口 — 用户先看
// 账号/模型管理,需要官方资源时从详情页一步跳出(2026-11-17 用户定版)。
// 本文件三面守卫:
//   1) getProviderPagePath 纯函数(id / 别名 / 兼容节点 / 未知 provider);
//   2) 覆盖性:每个 features.usage 的 provider(配额卡片只会出现它们)都有
//      仪表盘详情页可跳,详情页头部的官网外链(getProviderWebsite,同一注册
//      表回退链)也逐一可解析 — 注册表侧漏配/错删会在这里变红;
//   3) 接线形状:index.js 确实把图标包进 <Link href=/dashboard/providers/...>
//      (React 组件按仓库约定用源码断言守卫,见 disabled-models-ux.test.js:9)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getProviderPagePath,
  getProviderWebsite,
  USAGE_SUPPORTED_PROVIDERS,
} from "@/shared/constants/providers";

const rootDir = resolve(__dirname, "../..");
const read = (rel) => readFileSync(resolve(rootDir, rel), "utf8");

describe("getProviderPagePath resolves the in-dashboard detail page", () => {
  it("resolves by provider id and by alias alike", () => {
    expect(getProviderPagePath("claude")).toBe("/dashboard/providers/claude");
    // cc 是 claude 的 uiAlias,与 resolveProviderId 同一归一口径
    expect(getProviderPagePath("cc")).toBe("/dashboard/providers/claude");
  });

  it("links compatible nodes to their own detail page (providerNode route)", () => {
    expect(getProviderPagePath("openai-compatible-1234")).toBe(
      "/dashboard/providers/openai-compatible-1234"
    );
    expect(getProviderPagePath("anthropic-compatible-x")).toBe(
      "/dashboard/providers/anthropic-compatible-x"
    );
  });

  it("returns null for unknown providers instead of linking to a not-found page", () => {
    expect(getProviderPagePath("totally-unknown-provider")).toBeNull();
    expect(getProviderPagePath("")).toBeNull();
    expect(getProviderPagePath(undefined)).toBeNull();
  });
});

describe("every quota-card provider has a page to jump to (and an official site on it)", () => {
  // 配额卡片只渲染 features.usage 的 provider(USAGE_SUPPORTED_PROVIDERS 与
  // index.js 的过滤同源)。它们必须全部能解析出详情页路径;详情页头部外链的
  // URL 回退链(getProviderWebsite)也要逐一可解析,否则详情页给不出
  // 「Web console / Get API Key」跳转。
  it("all usage providers resolve to an in-dashboard detail page", () => {
    const unresolvable = USAGE_SUPPORTED_PROVIDERS.filter((id) => !getProviderPagePath(id));
    expect(unresolvable).toEqual([]);
  });

  it("all usage providers still resolve an official site for the detail-page console link", () => {
    const unresolvable = USAGE_SUPPORTED_PROVIDERS.filter((id) => {
      const url = getProviderWebsite(id);
      return !url || !/^https?:\/\//.test(url);
    });
    expect(unresolvable).toEqual([]);
  });

  it("the usage set is non-empty and covers the registry ids the UI shows", () => {
    expect(USAGE_SUPPORTED_PROVIDERS.length).toBeGreaterThan(10);
    // 抽查几个卡片常客
    for (const id of ["qoder", "kimi", "codex", "claude", "github"]) {
      expect(USAGE_SUPPORTED_PROVIDERS).toContain(id);
      expect(getProviderPagePath(id)).toBe(`/dashboard/providers/${id}`);
      expect(getProviderWebsite(id)).toMatch(/^https:\/\//);
    }
  });
});

describe("ProviderLimits card wires the icon to the in-dashboard detail page", () => {
  const src = read("src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js");

  it("imports the resolver and computes per-card path", () => {
    expect(src).toMatch(/import \{ USAGE_SUPPORTED_PROVIDERS, getProviderPagePath \} from "@\/shared\/constants\/providers"/);
    expect(src).toContain("const providerPagePath = getProviderPagePath(conn.provider);");
  });

  it("renders an in-app Link when the page resolves, plain icon otherwise", () => {
    expect(src).toContain("href={providerPagePath}");
    // 无详情页时退回纯 <div>,不渲染假链接(图标块是 IIFE,favicon 兜底在其内)
    const fallbackMatch = src.match(
      /return \(\s*<div className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center overflow-hidden">\s*\{iconEl\}/
    );
    expect(fallbackMatch, "providerPagePath 为 null 时应渲染不可点的纯图标").not.toBeNull();
    // 旧官网跳转必须退场:图标不再链 <a href={providerWebsite} target=_blank>
    expect(src).not.toContain("href={providerWebsite}");
    expect(src).not.toContain('translate("Open provider site")');
  });

  it("tooltip string passes through translate (i18n runtime)", () => {
    expect(src).toContain('translate("Open provider page")');
  });
});
