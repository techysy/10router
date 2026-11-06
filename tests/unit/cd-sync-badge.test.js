import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasCdSyncBadge,
  isCdSyncedConnection,
  cdSyncBadgeTitleKey,
} from "@/shared/utils/cdSyncBadge";

// CD Sync 徽章的单一事实源——ConnectionRow 与 ProviderLimits 都从这里取
// 白名单与旗标判定，此前两处手抄曾漂移（loomy 只加了一边）。
describe("cd sync badge", () => {
  it("gates the badge to CD-syncable providers", () => {
    for (const p of [
      "qoder",
      "qoder-cn",
      "codebuddy-cn",
      "codebuddy-intl",
      "loomy",
      "minimax-code",
      "minimax-code-global",
    ]) {
      expect(hasCdSyncBadge(p), p).toBe(true);
    }
    for (const p of ["tokenharbor", "claude", "minimax", "minimax-free", "xiaomi-mimo", ""]) {
      expect(hasCdSyncBadge(p), JSON.stringify(p)).toBe(false);
    }
    expect(hasCdSyncBadge(undefined)).toBe(false);
    expect(hasCdSyncBadge(null)).toBe(false);
  });

  it("treats both CreditDaddy markers as synced", () => {
    expect(isCdSyncedConnection({ providerSpecificData: { creditDaddyWebSession: { cookie: "x" } } })).toBe(true);
    expect(isCdSyncedConnection({ providerSpecificData: { creditDaddySync: true } })).toBe(true);
    expect(isCdSyncedConnection({ providerSpecificData: {} })).toBe(false);
    expect(isCdSyncedConnection({})).toBe(false);
    expect(isCdSyncedConnection(null)).toBe(false);
  });

  it("title precedence: web session > sync flag > native label", () => {
    expect(
      cdSyncBadgeTitleKey({ provider: "qoder", providerSpecificData: { creditDaddyWebSession: {}, creditDaddySync: true } })
    ).toBe("Synced via CreditDaddy web session (issue feedback goes to CreditDaddy)");
    expect(
      cdSyncBadgeTitleKey({ provider: "loomy", providerSpecificData: { creditDaddySync: true } })
    ).toBe("Synced from CreditDaddy (issue feedback goes to CreditDaddy)");
  });

  it("native labels resolve per provider (minimax pair lands their own keys)", () => {
    for (const [provider, key] of [
      ["qoder", "Native Qoder authorization"],
      ["qoder-cn", "Native Qoder authorization"],
      ["codebuddy-cn", "Native CodeBuddy authorization"],
      ["codebuddy-intl", "Native CodeBuddy authorization"],
      ["loomy", "Native Loomy authorization"],
      ["minimax-code", "Native MiniMax Code authorization"],
      ["minimax-code-global", "Native MiniMax Code (Global) authorization"],
    ]) {
      expect(cdSyncBadgeTitleKey({ provider, providerSpecificData: {} }), provider).toBe(key);
    }
  });

  it("native label keys exist in both zh literal files (en is key-identical)", () => {
    const keys = [
      "Native Qoder authorization",
      "Native Loomy authorization",
      "Native CodeBuddy authorization",
      "Native MiniMax Code authorization",
      "Native MiniMax Code (Global) authorization",
    ];
    for (const locale of ["zh-CN", "zh-TW"]) {
      const map = JSON.parse(
        readFileSync(resolve(__dirname, "../../public/i18n/literals", `${locale}.json`), "utf8")
      );
      for (const key of keys) {
        expect(map[key], `${locale}: ${key}`).toBeTypeOf("string");
      }
    }
  });
});
