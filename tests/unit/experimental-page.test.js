/**
 * Settings re-organisation: the auto-compact toggle moved to Token Saver, and the
 * provider-transfer + daily check-in toggles moved to a new /dashboard/experimental
 * page.
 *
 * These are source guards, because the failure mode they prevent is invisible in
 * a browser: a half-move. The component keeps rendering, the switch still flips,
 * and nothing tells you that the page no longer owns the key it PATCHes (so the
 * setting silently stops being saved), or that the same toggle is rendered in two
 * places and they disagree.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel) => readFileSync(abs(rel), "utf8");
const literal = (lang) => JSON.parse(read(`public/i18n/literals/${lang}.json`));

const PROFILE = "src/app/(dashboard)/dashboard/profile/page.js";
const TOKEN_SAVER = "src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js";
const EXPERIMENTAL = "src/app/(dashboard)/dashboard/experimental/ExperimentalClient.js";
const QUOTA_PAGE_LIMITS = "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js";
// The toolbar was extracted from index.js into its own component.
const QUOTA_TOOLBAR = "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaToolbar.js";
const SIDEBAR = "src/shared/components/Sidebar.js";
const HEADER = "src/shared/components/Header.js";
const NEW_DESCRIPTION = "Beta toggles for provider tools, daily check-ins, and dashboard security";

// The four beta toggles that left Settings, with the settings key each one writes.
const MOVED_TOGGLES = [
  ["OAuth import / export", "codeBuddyOAuthImport"],
  ["Qoder auto daily credit claim", "qoderCheckin"],
  ["CodeBuddy daily active session", "codeBuddyIntlSession"],
  ["CodeBuddy CN auto daily check-in", "codeBuddyCheckin"],
];

describe("settings reorganisation", () => {
  it("ships the experimental page", () => {
    expect(existsSync(abs("src/app/(dashboard)/dashboard/experimental/page.js"))).toBe(true);
    expect(existsSync(abs(EXPERIMENTAL))).toBe(true);
  });

  it("renders every beta toggle on the experimental page and PATCHes its own key", () => {
    const src = read(EXPERIMENTAL);
    for (const [label, key] of MOVED_TOGGLES) {
      expect(src).toContain(`translate("${label}")`);
      // The key has to appear inside a PATCH body, not just as a read.
      expect(src).toMatch(new RegExp(`\\{\\s*${key}:`));
    }
    expect(src).toMatch(/fetch\("\/api\/settings",\s*\{[\s\S]*method:\s*"PATCH"/);
  });

  it("leaves nothing behind in Settings", () => {
    const src = read(PROFILE);
    for (const [label, key] of MOVED_TOGGLES) {
      expect(src).not.toContain(`translate("${label}")`);
      expect(src).not.toContain(key);
    }
    expect(src).not.toContain("Auto-compact oversized context");
    expect(src).not.toContain("autoCompactEnabled");
    expect(src).not.toContain("autoCompactRatio");
  });

  it("keeps the trial-provider toggle in Settings", () => {
    const src = read(PROFILE);
    expect(src).toContain('translate("Show trial providers")');
    expect(src).toContain("showCommunityProviders");
  });

  it("re-homes auto-compact in Token Saver, still defaulting to ON", () => {
    const src = read(TOKEN_SAVER);
    expect(src).toContain('translate("Auto-compact oversized context")');
    expect(src).toContain('translate("Trigger threshold")');
    expect(src).toContain("autoCompactEnabled: value");
    expect(src).toContain("autoCompactRatio: ratio");
    // Default-on: the stored flag is an opt-out, so the read must be `!== false`.
    expect(src).toContain("setAutoCompactEnabled(data.autoCompactEnabled !== false)");
    expect(src).not.toContain("data.autoCompactEnabled === true");
  });

  it("places auto-compact below the Lazy senior dev (Ponytail) row", () => {
    // Requested layout: the bottom "be lazy about it" group — Ponytail, then
    // auto-compact, then the (currently hidden) PXPIPE row.
    const src = read(TOKEN_SAVER);
    const lazy = src.indexOf("Lazy senior dev");
    const autoCompact = src.indexOf('translate("Auto-compact oversized context")');
    const pxpipe = src.indexOf("Compress prompts as images");
    expect(lazy).toBeGreaterThan(-1);
    expect(autoCompact).toBeGreaterThan(lazy);
    expect(pxpipe).toBeGreaterThan(autoCompact);
  });

  it("puts the sidebar entry between Console Log and Settings", () => {
    const src = read(SIDEBAR);
    const consoleLog = src.indexOf("/dashboard/console-log");
    const experimental = src.indexOf("/dashboard/experimental");
    const settings = src.indexOf('href="/dashboard/profile"');
    expect(consoleLog).toBeGreaterThan(-1);
    expect(experimental).toBeGreaterThan(consoleLog);
    expect(settings).toBeGreaterThan(experimental);
  });

  it("gives the new route a header title and description", () => {
    const src = read(HEADER);
    const start = src.indexOf('pathname.includes("/experimental")');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('if (pathname === "/dashboard")'));
    expect(block).toContain('title: "Experimental"');
    expect(block).toContain(NEW_DESCRIPTION);
  });

  it("directs quota display preferences to the quota page toolbar", () => {
    const src = read(EXPERIMENTAL);
    expect(src).toContain('translate("Quota card display preferences have moved to the Quota Tracker toolbar.")');
  });

  it("quota page manages display preferences via the modal dialog", () => {
    const src = read(QUOTA_PAGE_LIMITS);
    expect(src).toContain('localStorage.getItem("quotaHideNoQuota")');
    expect(src).toContain('localStorage.getItem("quotaShowExternalCards")');
    expect(src).toContain("showPreferencesModal");
  });

  it("removes Only with balance bulk button and keeps per-row hide and Hidden chips", () => {
    const src = read(QUOTA_PAGE_LIMITS);
    // Commit 57711f3a removed "Only with balance" bulk button and handleHideDepletedQuotas
    // per user design decision (details collapsed, balance filter noise).
    // The per-row hide button and "Hidden:" chips remain for manual curation.
    expect(src).not.toContain("handleHideDepletedQuotas");
    expect(src).not.toContain('translate("Only with balance")');
    expect(src).toContain("const handleShowAllQuotas = useCallback(");
    expect(src).toContain("applyVisibilityToConnections");
    expect(src).toContain("setQuotaVisibility((current) => {");
    expect(src).not.toContain("setHideDepleted");
    expect(src).not.toContain("quotaHideDepleted");
    expect(src).not.toMatch(/if \(hideDepleted\) \{/);
  });

  it("explains an empty card body instead of collapsing to a bare chip row", () => {
    const src = read(QUOTA_PAGE_LIMITS);
    // QuotaTable returns null for an empty list, so a card whose rows are all
    // hidden (CodeBuddy Intl had all 5 of its rows hidden) rendered as a "Hidden:"
    // chip row with no body — it looked broken rather than filtered. It must
    // point at the chips, because every hidden row is reachable from them.
    expect(src).toMatch(/visibleQuotas\.length === 0 && rawQuotas\.length > 0/);
    expect(src).toContain("All quota rows are hidden — use the chips below to show them");
  });

  it("applies hide/show edits without dropping clicks made in the same tick", () => {
    const src = read(QUOTA_PAGE_LIMITS);
    // The "Hidden:" chips and the per-row hide buttons live in one card, so a
    // burst of clicks runs in a single tick. Reading `quotaVisibility` from the
    // render closure made every handler compute from the same pre-click
    // snapshot — the last PATCH won and the rest were silently dropped, so
    // clicking five chips restored only two rows. The edits must go through the
    // setState updater form so each one sees the previous.
    expect(src).toContain("setQuotaVisibility((current) => {");
    expect(src).toMatch(/const entryVisibility = current\[connectionId\] \|\| \{\}/);
    // The stale-closure form must not come back in either handler.
    const hide = src.slice(src.indexOf("const handleHideQuota"), src.indexOf("const handleShowQuota"));
    const show = src.slice(src.indexOf("const handleShowQuota"), src.indexOf("// Auto-refresh interval"));
    for (const [name, fn] of [["handleHideQuota", hide], ["handleShowQuota", show]]) {
      expect(fn, `${name} must not read the render-closure map`).not.toMatch(
        /const previous = quotaVisibility/,
      );
      expect(fn, `${name} should delegate to editQuotaVisibility`).toContain("editQuotaVisibility(");
    }
    // Antigravity group pruning must survive the refactor.
    expect(src).toContain("pruneAntigravityGroup");
  });

  it("reports the page count of what is actually rendered once a view filter drops cards", async () => {
    const { getVisiblePageSummary, getConnectionsPaginationSummary } = await import(
      "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );
    // Backend summary counts the server's page — it knows nothing about the
    // client-side view filters, which is how "Showing 1-10 of 46" ended up
    // sitting above a grid of 12 cards.
    expect(
      getConnectionsPaginationSummary({ page: 1, pageSize: 10, total: 46, totalPages: 5 }),
    ).toBe("Showing 1-10 of 46");
    // The filtered variant describes the cards on screen instead.
    expect(getVisiblePageSummary(12, 10)).toBe("Showing 1-10 of 12");
    expect(getVisiblePageSummary(7, 10)).toBe("Showing 1-7 of 7");
    expect(getVisiblePageSummary(0, 10)).toBe("Showing 0 of 0");
    // Degenerate inputs must not produce "Showing 1-NaN of undefined".
    expect(getVisiblePageSummary(undefined, 10)).toBe("Showing 0 of 0");
    expect(getVisiblePageSummary(4, undefined)).toBe("Showing 1-4 of 4");

    // The page must actually choose between them, not hardcode one.
    const src = read(QUOTA_PAGE_LIMITS);
    expect(src).toContain("getVisiblePageSummary");
    expect(src).toMatch(
      /\{viewFilterActive \? visiblePageSummary : connectionsPageSummary\}/,
    );
    // Only the card-level filter feeds this. "Only with balance" hides quota
    // ROWS, so it must NOT drag the summary onto a row-based number — that would
    // make the count mean something else for no reason.
    expect(src).toMatch(
      /const viewFilterActive = renderConnections\.length !== sortedConnections\.length;/,
    );
    expect(src).not.toMatch(/const viewFilterActive =[\s\S]{0,200}hideDepleted/);
    // The count alone carries the correction. A banner explaining "this number
    // counts the filtered cards" was tried and removed: it restated what the
    // number already says, and sat above the cards costing vertical space.
    expect(src).not.toMatch(/View filter is on/);
  });

  it("keeps the quota toolbar readable: translated tooltips + a visible refresh label", () => {
    const src = read(QUOTA_TOOLBAR);
    // The runtime i18n walker only translates text nodes, never `title`
    // attributes — so an icon-only toolbar button with a raw English `title`
    // shows English on hover for every non-English locale. Every toolbar
    // tooltip must go through translate().
    expect(src).toMatch(/title=\{translate\("Refresh all"\)\}/);
    expect(src).toMatch(/title=\{translate\("Filter quota providers"\)\}/);
    expect(src).toMatch(/title=\{translate\(autoRefresh \? "Disable auto-refresh" : "Enable auto-refresh"\)\}/);
    expect(src).not.toMatch(/title="Refresh all"/);
    expect(src).not.toMatch(/title="Disable auto-refresh"/);
    // The auto-refresh button keeps a visible label, not a bare icon.
    expect(src).toContain('{translate("Auto-refresh")}');
    // The reset-sort toggle is the exception: icon-only, because its label
    // wrapped the whole toolbar onto a second row. The tooltip names the sort
    // key (reset OR expiry — one-shot packs carry their expiry in resetAt) and
    // aria-label keeps an accessible name on the bare button.
    expect(src).toMatch(/title=\{translate\("Sort accounts by earliest reset or expiry time"\)\}/);
    expect(src).toMatch(/aria-label=\{translate\("Resets first"\)\}/);
    expect(src).not.toContain('hidden sm:inline">{translate("Resets first")}');
  });

  it("keeps the filter row on one line as the toolbar runs out of width", () => {
    const src = read(QUOTA_TOOLBAR);
    // The measured failure: the toolbar is 1046px wide in a 1400px window
    // (the sidebar eats ~300px and can also collapse), but one row with every
    // label needs 1108px — so the action group wrapped onto a second line.
    // The collapse ladder must measure the toolbar itself (`@container` +
    // `@min-[…]`), never the viewport: viewport breakpoints fire at the wrong
    // width whenever the sidebar state changes.
    expect(src).toMatch(/className="[^"]*@container/);
    // Width math (px, from the live DOM): filters 664 (tabs 224 + provider 153
    // + status radios 231 + sort 32 + gaps 24) + min gap 8 + actions 436
    // (count 71 + bulk 151 + auto-refresh 158 + refresh 32 + gaps 24) = 1108.
    // Each tier below drops one label and re-checks the sum, +20px of margin:
    //   −count (71)                  → 1037  ⇒ hide below 1130
    //   −bulk label (81)             →  956  ⇒ hide below 1060
    //   −auto-refresh label (80)     →  876  ⇒ hide below  980
    //   −tab labels (144)            →  732  ⇒ hide below  900
    expect(src).toContain("hidden text-xs tabular-nums text-text-muted @min-[1130px]:inline");
    expect(src).toContain('hidden @min-[1060px]:inline">{translate("Bulk actions")}');
    expect(src).toContain('hidden @min-[980px]:inline">{translate("Auto-refresh")}');
    expect(src).toContain('hidden @min-[900px]:inline">{tab.label}');
    // Viewport breakpoints would reintroduce the wrap at the wrong widths.
    expect(src).not.toContain('text-text-muted md:inline');
    expect(src).not.toContain('hidden sm:inline">{translate("Bulk actions")}');
    expect(src).not.toContain('hidden sm:inline">{translate("Auto-refresh")}');
    // A label hidden by `display:none` also leaves the accessibility tree, so
    // the tab and bulk buttons carry their names on the button itself.
    expect(src).toContain("aria-label={tab.label}");
    expect(src).toMatch(/aria-label=\{translate\("Bulk actions"\)\}/);
  });

  it("gives a phone exactly two tidy rows instead of three ragged ones", () => {
    const src = read(QUOTA_TOOLBAR);
    // DevTools iPhone emulation put every control on its own line: the
    // filters (provider 153 + status radios 231) can never share a ~358px
    // line with anything else. So below 640px of the bar the filter group
    // becomes a full-width SECOND row — ordered after the view tabs and the
    // actions, which share the first row. Two rows, deterministically.
    expect(src).toContain("@max-[640px]:order-last @max-[640px]:w-full");
    expect(src).toContain("@max-[640px]:order-2");
    // No overflow-x scrolling on the strip: the provider menu pops over the
    // cards below and would be clipped by a scroll container.
    expect(src).not.toMatch(/overflow-x-auto|overflow-x-scroll/);
    // The status radios go icon-only at phone width (same glyph language as
    // the bulk menu) — but `display:none` drops the label from the
    // accessibility tree, so the button carries the label as its name.
    expect(src).toContain("const ACCOUNT_FILTER_ICONS = { all: \"apps\", active: \"check_circle\", inactive: \"block\" };");
    expect(src).toContain("aria-label={translate(option.label)}");
    expect(src).toContain('hidden text-[14px] @max-[640px]:inline');
    expect(src).toContain('@max-[640px]:hidden">{translate(option.label)}');
    // The provider label truncates harder on a phone instead of wrapping.
    expect(src).toContain("@max-[640px]:max-w-[5rem]");
  });

  it("has both Chinese dictionaries for every string the move introduced", () => {
    for (const lang of ["zh-CN", "zh-TW"]) {
      const dict = literal(lang);
      expect(dict["Experimental"]).toBeTruthy();
      expect(dict[NEW_DESCRIPTION]).toBeTruthy();
      for (const [label] of MOVED_TOGGLES) expect(dict[label]).toBeTruthy();
      expect(dict["Auto-compact oversized context"]).toBeTruthy();
      expect(dict["Hide no-quota provider cards"]).toBeTruthy();
      expect(dict["Quota page view: hide cards that have no quota to display"]).toBeTruthy();
      expect(dict["Only with balance"]).toBeTruthy();
      expect(dict["Show all"]).toBeTruthy();
      // Toolbar tooltips wired through translate() (bug: raw `title` showed
      // English on hover for zh users after the buttons went icon-only).
      expect(dict["Refresh all"]).toBeTruthy();
      expect(dict["Disable auto-refresh"]).toBeTruthy();
      expect(dict["Enable auto-refresh"]).toBeTruthy();
      // Icon-only sort toggle: tooltip + accessible name.
      expect(dict["Sort accounts by earliest reset or expiry time"]).toBeTruthy();
      expect(dict["Resets first"]).toBeTruthy();
      expect(dict["Show all quota packs across current connections"]).toBeTruthy();
      expect(dict["Hide depleted (zero-balance) quota packs across current connections"]).toBeTruthy();
      // Empty-body explanation (a card whose rows are all hidden). The chips
      // below the card can restore any of them, so the message points at them.
      expect(dict["All quota rows are hidden — use the chips below to show them"]).toBeTruthy();
    }
    // Retired keys must be fully removed — a stale key would silently fall
    // back to English if code ever referenced it again.
    for (const lang of ["zh-CN", "zh-TW"]) {
      const dict = literal(lang);
      expect(dict["Beta toggles for provider transfer and daily credit check-ins"]).toBeUndefined();
      expect(dict["Hide no-quota"]).toBeUndefined();
      expect(dict["Hide cards with no quota to display"]).toBeUndefined();
      // The filter-explainer banner was removed as redundant.
      expect(
        dict["View filter is on: counts below cover the cards shown on this page. Paging still follows all connections."],
      ).toBeUndefined();
      expect(dict["No quota left to show — all rows are at zero balance"]).toBeUndefined();
    }
  });
});
