// 配额跟踪器卡片的图标跳转(体验优化):图标点击打开供应商官网/控制台。
// URL 的唯一真相源是注册表 display.website / notice.* ——与 providers/[id]
// 详情页同一回退链,不在 UI 侧维护第二份映射表。
// 本文件三面守卫:
//   1) getProviderWebsite 纯函数(id / 别名 / 回退链 / 无 URL / 未知 provider);
//   2) 覆盖性:每个 features.usage 的 provider(配额卡片只会出现它们)都能解析
//      出 http(s) URL — 新增 usage provider 忘配 website 会在这里变红,而不是
//      让用户看到不可点的图标;
//   3) 接线形状:index.js 确实把图标包进 <a target=_blank rel=noopener>
//      (React 组件按仓库约定用源码断言守卫,见 disabled-models-ux.test.js:9)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getProviderWebsite, USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";

const rootDir = resolve(__dirname, "../..");
const read = (rel) => readFileSync(resolve(rootDir, rel), "utf8");

describe("getProviderWebsite resolves from the registry", () => {
  it("resolves by provider id and by alias alike", () => {
    expect(getProviderWebsite("claude")).toBe("https://claude.ai");
    // cc 是 claude 的 uiAlias,与 resolveProviderId 同一归一口径
    expect(getProviderWebsite("cc")).toBe("https://claude.ai");
  });

  it("follows the detail-page fallback chain (webUrl > apiKeyUrl > signupUrl > website)", () => {
    // qoder 同时有 website 与 notice.signupUrl(同值);验证 notice 优先序不炸即可
    expect(getProviderWebsite("qoder")).toMatch(/^https:\/\//);
  });

  it("returns null for unknown providers (custom connections) instead of throwing", () => {
    expect(getProviderWebsite("openai-compatible-1234")).toBeNull();
    expect(getProviderWebsite("")).toBeNull();
    expect(getProviderWebsite(undefined)).toBeNull();
  });
});

describe("every quota-card provider has a jump target", () => {
  // 配额卡片只渲染 features.usage 的 provider(USAGE_SUPPORTED_PROVIDERS 与
  // index.js 的过滤同源)。它们必须全部能解析出 URL — 否则图标不可点,体验
  // 一致性静默破洞。注册表侧新增 usage provider 没配 website 会在这里红。
  it("all usage providers resolve to an http(s) URL", () => {
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
      expect(getProviderWebsite(id)).toMatch(/^https:\/\//);
    }
  });
});

describe("ProviderLimits card wires the icon to the website", () => {
  const src = read("src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js");

  it("imports the resolver and computes per-card URL", () => {
    expect(src).toMatch(/import \{ USAGE_SUPPORTED_PROVIDERS, getProviderWebsite \} from "@\/shared\/constants\/providers"/);
    expect(src).toContain("const providerWebsite = getProviderWebsite(conn.provider);");
  });

  it("renders a safe external link when a URL resolves, plain icon otherwise", () => {
    expect(src).toContain("href={providerWebsite}");
    expect(src).toContain('target="_blank"');
    expect(src).toContain('rel="noopener noreferrer"');
    // 无 URL 时退回纯 <div>,不渲染假链接
    const fallbackMatch = src.match(
      /: \(\s*<div className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center overflow-hidden">\s*<ProviderIcon/
    );
    expect(fallbackMatch, "providerWebsite 为 null 时应渲染不可点的纯图标").not.toBeNull();
  });

  it("tooltip string passes through translate (i18n runtime)", () => {
    expect(src).toContain('translate("Open provider site")');
  });
});
