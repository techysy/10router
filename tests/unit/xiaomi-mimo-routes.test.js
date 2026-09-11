import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = (rel) => path.join(here, "..", "..", rel);
const read = (rel) => fs.readFileSync(srcPath(rel), "utf-8");

describe("xiaomi-mimo api-key route", () => {
  const src = () => read("src/app/api/oauth/xiaomi-mimo/api-key/route.js");

  it("rejects keys without the sk- prefix", () => {
    expect(src()).toContain('startsWith("sk-")');
  });

  it("validates against the models endpoint but soft-fails", () => {
    expect(src()).toContain("AbortSignal.timeout(10000)");
    // A blocked network must not block the import.
    expect(src()).toMatch(/Network error — still allow import/);
  });

  it("reads the Desktop session passToken server-side", () => {
    expect(src()).toContain("readDesktopPassToken");
    // …and does not require the client to send one.
    expect(src()).toMatch(/Prefer a\s+\/\/ server-side read/);
  });

  it("updates an existing connection instead of duplicating it", () => {
    expect(src()).toContain("updateProviderConnection");
    expect(src()).toContain("existing.id");
  });

  it("does not reflect upstream bodies on failure", () => {
    expect(src()).toContain("SSRF hardening");
  });

  it("reports a locked Desktop session without failing the import", () => {
    expect(src()).toContain('e?.code === "DESKTOP_LOCKED"');
    expect(src()).toContain("desktopLocked");
  });
});

describe("xiaomi-mimo auto-import route", () => {
  const src = () => read("src/app/api/oauth/xiaomi-mimo/auto-import/route.js");

  it("never returns the Desktop passToken to the client", () => {
    expect(src()).not.toMatch(/mimoPassToken:/);
    expect(src()).not.toMatch(/mimoUserId:/);
    expect(src()).not.toContain("providerSpecificData");
  });

  it("still reports whether a Desktop session was found", () => {
    expect(src()).toContain("hasDesktopSession");
    expect(src()).toContain("readDesktopPassToken");
  });

  it("checks the MiMoCode auth.json locations", () => {
    expect(src()).toContain("mimocode");
    expect(src()).toContain("auth.json");
  });

  it("tells the user to quit the Desktop app when its cookie store is locked", () => {
    expect(src()).toContain('e?.code === "DESKTOP_LOCKED"');
    expect(src()).toContain("desktopLocked");
    expect(src()).toMatch(/Quit the desktop app completely/);
    // A locked store must not fail the import — only the Preview session is missing.
    expect(src()).toContain("found: true");
  });
});

describe("xiaomi-mimo wiring in the generic oauth route", () => {
  const src = () => read("src/app/api/oauth/[provider]/[action]/route.js");

  it("starts the local proxy and registers a keypair on authorize", () => {
    expect(src()).toContain("startXiaomiMimoProxy");
    expect(src()).toContain("registerXiaomiMimoSession({ state, privateKeyDer })");
    expect(src()).toMatch(/return NextResponse\.json\(\{\s*authorizeUrl/);
  });

  it("redacts the API key from poll-status", () => {
    // The modal only needs truthiness; the key is applied server-side by /exchange.
    expect(src()).toContain("{ status: xm.status, result: { uid: xm.result.uid, baseUrl: xm.result.baseUrl } }");
    expect(src()).not.toMatch(/result: \{\s*\.\.\.xm\.result/);
  });

  it("keeps the session alive until exchange consumes it", () => {
    // Only the error branch may clear; the done branch must survive for /exchange.
    const src = read("src/app/api/oauth/[provider]/[action]/route.js");
    const done = src.slice(
      src.indexOf('if (xm.status === "done"'),
      src.indexOf('if (xm.status === "error"'),
    );
    expect(done).toContain("return NextResponse.json");
    expect(done).not.toContain("clearXiaomiMimoSession");
  });

  it("builds the connection from the decrypted session on exchange", () => {
    expect(src()).toContain('accessToken: session.result.accessToken');
    expect(src()).toContain("clearXiaomiMimoSession(state)");
    expect(src()).toContain("stopXiaomiMimoProxy()");
  });

  it("stops the proxy on stop-proxy", () => {
    expect(src()).toContain('else if (provider === "xiaomi-mimo") stopXiaomiMimoProxy();');
  });
});

describe("xiaomi-mimo dashboard wiring", () => {
  it("exports the modal", () => {
    expect(read("src/shared/components/index.js")).toContain("XiaomiMimoAuthModal");
  });

  it("routes the provider's OAuth button to the dedicated modal", () => {
    const page = read("src/app/(dashboard)/dashboard/providers/[id]/page.js");
    expect(page).toContain("XiaomiMimoAuthModal");
    expect(page).toContain('providerId === "xiaomi-mimo"');
    expect(page).toContain("setShowXiaomiMimoModal(true)");
  });

  it("has the modal read credentials locally and fall back to browser sign-in", () => {
    const modal = read("src/shared/components/XiaomiMimoAuthModal.js");
    expect(modal).toContain("/api/oauth/xiaomi-mimo/auto-import");
    expect(modal).toContain("/api/oauth/xiaomi-mimo/api-key");
    expect(modal).toContain("/authorize?state=");
    expect(modal).toContain("/poll-status?state=");
    expect(modal).toContain("/api/oauth/xiaomi-mimo/exchange");
  });

  it("tells the user the credentials come from the local Desktop profile", () => {
    const modal = read("src/shared/components/XiaomiMimoAuthModal.js");
    expect(modal).toMatch(/Desktop/);
    expect(modal).toContain("hasDesktopSession");
  });

  it("surfaces the locked cookie store as an actionable step", () => {
    const modal = read("src/shared/components/XiaomiMimoAuthModal.js");
    expect(modal).toContain("desktopLocked");
    expect(modal).toMatch(/Quit Xiaomi MiMo Desktop and retry/);
  });

  it("does not forward the passToken from the modal", () => {
    expect(read("src/shared/components/XiaomiMimoAuthModal.js")).not.toContain("mimoPassToken");
  });
});
