import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import capyRegistry from "open-sse/providers/registry/capy.js";
import commandCodeRegistry from "open-sse/providers/registry/commandcode.js";
import crowllmRegistry from "open-sse/providers/registry/crowllm.js";
import mimoDesktopRegistry from "open-sse/providers/registry/mimo-desktop.js";
import nousRegistry from "open-sse/providers/registry/nous.js";

const rootDir = resolve(__dirname, "../..");

describe("Provider Notice i18n", () => {
  const noticeKey = commandCodeRegistry.display?.notice?.text;

  it("CommandCode registry has a notice text", () => {
    expect(noticeKey).toBeTruthy();
    expect(noticeKey).toContain("Use your CommandCode CLI API key");
  });

  it("zh-CN dictionary contains the CommandCode notice translation", () => {
    const zhCN = JSON.parse(readFileSync(resolve(rootDir, "public/i18n/literals/zh-CN.json"), "utf8"));
    expect(zhCN[noticeKey]).toBeDefined();
    expect(zhCN[noticeKey]).toContain("使用来自 ~/.commandcode/auth.json");
    expect(zhCN[noticeKey]).toContain("user_");
  });

  it("zh-TW dictionary contains the CommandCode notice translation", () => {
    const zhTW = JSON.parse(readFileSync(resolve(rootDir, "public/i18n/literals/zh-TW.json"), "utf8"));
    expect(zhTW[noticeKey]).toBeDefined();
    expect(zhTW[noticeKey]).toContain("使用來自 ~/.commandcode/auth.json");
    expect(zhTW[noticeKey]).toContain("user_");
  });

  it("Provider detail page pipes notice.text through translate()", () => {
    const pageSource = readFileSync(
      resolve(rootDir, "src/app/(dashboard)/dashboard/providers/[id]/page.js"),
      "utf8",
    );
    // textLink（内联产品名链接）按译文分段，translate 仍作用于整条文本。
    expect(pageSource).toContain("translate(providerInfo.notice.text)");
    expect(pageSource).toContain('{translate("Get API Key →")}');
  });

  it("Media provider detail page pipes notice.text through translate()", () => {
    const pageSource = readFileSync(
      resolve(rootDir, "src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.js"),
      "utf8",
    );
    expect(pageSource).toContain("{translate(provider.notice.text)}");
    expect(pageSource).toContain('{translate("Get API Key →")}');
  });

  it("ProviderInfoCard component pipes noticeText through translate()", () => {
    const cardSource = readFileSync(
      resolve(rootDir, "src/shared/components/ProviderInfoCard.js"),
      "utf8",
    );
    expect(cardSource).toContain("{translate(noticeText)}");
  });
});

// The Desktop card's notice shipped without translations: the English text goes
// through translate() like every other notice, so a missing entry renders raw
// English in a Chinese UI. Same contract as the CommandCode case above.
describe("MiMo Desktop notice i18n", () => {
  const noticeKey = mimoDesktopRegistry.display?.notice?.text;

  it("the Desktop card has a notice that names the account-session requirement", () => {
    expect(noticeKey).toBeTruthy();
    expect(noticeKey).toContain("Account-session models.");
    expect(noticeKey).toContain("No API key is needed");
  });

  it("both Chinese dictionaries carry the MiMo Desktop notice", () => {
    for (const locale of ["zh-CN", "zh-TW"]) {
      const dict = JSON.parse(
        readFileSync(resolve(rootDir, `public/i18n/literals/${locale}.json`), "utf8"),
      );
      expect(dict[noticeKey], `${locale} notice entry`).toBeTruthy();
      // Guard against a copy-paste placeholder: the translation has to be Chinese.
      expect(dict[noticeKey], `${locale} notice is translated`).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});

// Same contract as MiMo Desktop above: the Nous Portal notice (#155) shipped
// with the English text only \u2014 translate() renders it raw in a Chinese UI.
describe("Nous Portal notice i18n", () => {
  const noticeKey = nousRegistry.display?.notice?.text;

  it("the Nous card has a notice naming the device-code flow and free models", () => {
    expect(noticeKey).toBeTruthy();
    expect(noticeKey).toContain("device code");
    expect(noticeKey).toContain("no credit card");
  });

  it("both Chinese dictionaries carry the Nous Portal notice", () => {
    for (const locale of ["zh-CN", "zh-TW"]) {
      const dict = JSON.parse(
        readFileSync(resolve(rootDir, `public/i18n/literals/${locale}.json`), "utf8"),
      );
      expect(dict[noticeKey], `${locale} notice entry`).toBeTruthy();
      expect(dict[noticeKey], `${locale} notice is translated`).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});

// Same contract as Nous Portal above: the CrowLLM notice
// shipped with the English text only \u2014 translate() renders it raw in a Chinese UI.
describe("CrowLLM notice i18n", () => {
  const noticeKey = crowllmRegistry.display?.notice?.text;

  it("the CrowLLM card has a notice naming the gateway family and free models", () => {
    expect(noticeKey).toBeTruthy();
    expect(noticeKey).toContain("one-hub family");
    expect(noticeKey).toContain(":free");
  });

  it("both Chinese dictionaries carry the CrowLLM notice", () => {
    for (const locale of ["zh-CN", "zh-TW"]) {
      const dict = JSON.parse(
        readFileSync(resolve(rootDir, `public/i18n/literals/${locale}.json`), "utf8"),
      );
      expect(dict[noticeKey], `${locale} notice entry`).toBeTruthy();
      expect(dict[noticeKey], `${locale} notice is translated`).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});

describe("Capy notice i18n", () => {
  const noticeKey = capyRegistry.display?.notice?.text;

  it("the Capy card has a notice naming the email-code login and free ad models", () => {
    expect(noticeKey).toBeTruthy();
    expect(noticeKey).toContain("email code");
    expect(noticeKey).toContain("ad-funded models");
  });

  it("both Chinese dictionaries carry the Capy notice", () => {
    for (const locale of ["zh-CN", "zh-TW"]) {
      const dict = JSON.parse(
        readFileSync(resolve(rootDir, `public/i18n/literals/${locale}.json`), "utf8"),
      );
      expect(dict[noticeKey], `${locale} notice entry`).toBeTruthy();
      expect(dict[noticeKey], `${locale} notice is translated`).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
