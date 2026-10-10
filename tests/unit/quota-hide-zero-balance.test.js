/**
 * "Hide zero-balance provider cards" — the depleted sibling of the
 * hide-no-quota view toggle.
 *
 * The behavior half runs for real (isConnectionDepleted moved out of the
 * component closure into utils.js exactly so it could be imported here — and
 * so the bulk disable/enable actions and the new view filter judge a card with
 * ONE predicate). The wiring half is source guards: the components cannot be
 * rendered under vitest (environment "node", no JSX transform), and the
 * failure modes are invisible in the browser anyway — the quota page reading a
 * key the Experimental page never writes, the toggle landing on the settings
 * PATCH path (it is a client view pref), or the two hide-toggles conflating
 * "no quota rows" with "every row at zero".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel) => readFileSync(abs(rel), "utf8");
const literal = (lang) => JSON.parse(read(`public/i18n/literals/${lang}.json`));

const EXPERIMENTAL = "src/app/(dashboard)/dashboard/experimental/ExperimentalClient.js";
const QUOTA_PAGE_LIMITS = "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js";
const UTILS = "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("isConnectionDepleted (shared depleted predicate)", () => {
  it("is importable from utils", async () => {
    const mod = await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js");
    expect(typeof mod.isConnectionDepleted).toBe("function");
  });

  it("depletes only when EVERY judged row is at absolute zero", async () => {
    const { isConnectionDepleted } = await import(
      "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );
    const data = (quotas) => ({ c1: { quotas } });
    const conn = { id: "c1" };

    // 0/0 with no allowance (Qoder free) and used>=total (spent pack) both zero.
    expect(isConnectionDepleted(conn, data([{ total: 0, used: 0 }]))).toBe(true);
    expect(isConnectionDepleted(conn, data([{ total: 100, used: 100 }]))).toBe(true);
    // One row with remaining credit keeps the whole card "available".
    expect(
      isConnectionDepleted(conn, data([
        { total: 100, used: 100 },
        { total: 50, used: 10 },
      ])),
    ).toBe(false);
  });

  it("unlimited rows opt out; a no-quota card is NOT depleted", async () => {
    const { isConnectionDepleted } = await import(
      "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );
    const data = (quotas) => ({ c1: { quotas } });
    const conn = { id: "c1" };

    // Only-unlimited stays available. An exhausted judged pack next to an
    // unlimited one IS depleted — "unlimited rows don't count either way" is
    // the established meaning here (the bulk disable action was judged on it
    // since its inception), and the view filter deliberately shares exactly
    // that one definition instead of minting a second, kinder one.
    expect(isConnectionDepleted(conn, data([{ unlimited: true, total: 0, used: 0 }]))).toBe(false);
    expect(
      isConnectionDepleted(conn, data([
        { total: 10, used: 10 },
        { unlimited: true },
      ])),
    ).toBe(true);
    // "No quota to show" is the OTHER toggle's job — never call that depleted.
    expect(isConnectionDepleted(conn, data([]))).toBe(false);
    expect(isConnectionDepleted(conn, data(undefined))).toBe(false);
    expect(isConnectionDepleted(conn, {})).toBe(false);
    expect(isConnectionDepleted(conn, undefined)).toBe(false);
  });
});

describe("zero-balance view filter (quota page)", () => {
  it("reads the localStorage pref the Experimental page owns", () => {
    const src = read(QUOTA_PAGE_LIMITS);
    expect(src).toContain('localStorage.getItem("quotaHideZeroBalance")');
    // The page only ever READS the pref — the Experimental page owns the write.
    expect(src).not.toContain("setHideZeroBalance");
    // Distinct name from the retired row-level "hideDepleted" filter — the
    // experimental-page guards forbid that older identity on this file.
    expect(src).not.toContain("quotaHideDepleted");
    expect(src).not.toMatch(/if \(hideDepleted\) \{/);
  });

  it("composes with hide-no-quota, judged by the shared predicate", () => {
    const src = read(QUOTA_PAGE_LIMITS);
    // One memo, two sequential filters — both opt-ins compose.
    expect(src).toMatch(/const renderConnections = useMemo\(\(\) => \{\s*let list = sortedConnections;/);
    expect(src).toContain("if (hideNoQuota) {");
    expect(src).toContain("if (hideZeroBalance) {");
    // Depletion judged by the SAME exported predicate the bulk actions use —
    // no second definition of "depleted" may reappear in the component.
    expect(src).toMatch(/return !isConnectionDepleted\(conn, quotaData\);/);
    expect(src).toMatch(/const handleDisableDepleted[\s\S]*isConnectionDepleted\(c, quotaData\)/);
    expect(src).not.toMatch(/const isConnectionDepleted = \(conn\) =>/);
    // Every keep-while-unknown guard survives in BOTH branches, so a real card
    // never blinks out mid-fetch or hides itself on an error.
    const filter = src.slice(
      src.indexOf("const renderConnections = useMemo"),
      src.indexOf("}, [sortedConnections, hideNoQuota, hideZeroBalance"),
    );
    expect((filter.match(/if \(loading\[conn\.id\]\) return true;/g) || []).length).toBe(2);
    expect((filter.match(/if \(errors\[conn\.id\]\) return true;/g) || []).length).toBe(2);
  });

  it("is imported from utils, not re-declared", () => {
    expect(read(QUOTA_PAGE_LIMITS)).toMatch(/isConnectionDepleted,/);
    expect(read(QUOTA_PAGE_LIMITS)).toContain('} from "./utils";');
  });
});

describe("hide-zero-balance toggle (Experimental page)", () => {
  it("renders the row and persists it as a client view pref", () => {
    const src = read(EXPERIMENTAL);
    expect(src).toContain('translate("Hide zero-balance provider cards")');
    expect(src).toContain('translate("Quota page view: hide cards whose quota is fully depleted (0 balance / 0 credits)")');
    expect(src).toContain('localStorage.getItem("quotaHideZeroBalance")');
    expect(src).toContain('localStorage.setItem("quotaHideZeroBalance"');
    // Client-side view pref — must NOT go through the settings PATCH path
    // (same trap the hide-no-quota guard pins).
    expect(src).not.toMatch(/\{\s*quotaHideZeroBalance:/);
  });

  it("sits directly below the hide-no-quota row it extends", () => {
    const src = read(EXPERIMENTAL);
    const noQuota = src.indexOf('translate("Hide no-quota provider cards")');
    const zeroBalance = src.indexOf('translate("Hide zero-balance provider cards")');
    const nested = src.indexOf('translate("Nested cycle quota bars")');
    expect(noQuota).toBeGreaterThan(-1);
    expect(zeroBalance).toBeGreaterThan(noQuota);
    expect(nested).toBeGreaterThan(zeroBalance);
  });
});

describe("i18n dictionaries", () => {
  it("has both Chinese dictionaries for the new strings", () => {
    for (const lang of ["zh-CN", "zh-TW"]) {
      const dict = literal(lang);
      expect(dict["Hide zero-balance provider cards"]).toBeTruthy();
      expect(dict["Quota page view: hide cards whose quota is fully depleted (0 balance / 0 credits)"]).toBeTruthy();
    }
  });
});
