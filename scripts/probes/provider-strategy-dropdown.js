/**
 * Provider detail page ("/dashboard/providers/[id]") 调度偏好 dropdown probe.
 *
 * Reads what the strategy controls ACTUALLY render — per quota category the
 * header area shows a different control (dropdown for pure-balance providers,
 * toggles for pack/rolling/generic), and #385384906-style regressions (an
 * option silently missing from the dropdown) are invisible to code reading:
 * the option list lives in the component, but whether THIS provider's category
 * reaches THAT branch is a runtime fact.
 *
 * Dumps every <select> on the page (label + options + selected value) so the
 * caller can diff the option list against what the registry category promises.
 *
 *   node scripts/browser-probe.mjs http://127.0.0.1:20127/dashboard/providers/minimax-code \
 *     --script scripts/probes/provider-strategy-dropdown.js --json result.json
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, r));
  const txt = (el) => (el ? el.textContent.trim().replace(/\s+/g, " ") : null);

  // Connections fetch async fills the table; the strategy controls render with
  // it. Poll for a select rather than trusting a fixed settle time.
  let selects = [];
  for (let i = 0; i < 40; i += 1) {
    selects = [...document.querySelectorAll("select")];
    const strategy = selects.find((s) =>
      [...s.options].some((o) => /Manual Priority|优先级顺序|Round Robin|负载均衡/.test(o.textContent || "")),
    );
    if (strategy) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const dump = selects.map((s) => {
    // The visible label sits next to the select in the same flex row.
    const row = s.closest("div");
    const label = row ? txt(row.querySelector("span")) : null;
    return {
      label,
      selected: s.value,
      selectedText: txt(s.selectedOptions[0]),
      options: [...s.options].map((o) => ({ value: o.value, text: txt(o) })),
    };
  });

  const strategy = dump.find((d) =>
    (d.options || []).some((o) => /priority|earliest|balance|round-robin/.test(o.value || "")),
  );
  const hasEarliest = Boolean(
    strategy && (strategy.options || []).some((o) => o.value === "earliest-expiry"),
  );

  const header = txt(document.querySelector("h1")) || txt(document.title);

  return JSON.stringify({
    page: header,
    url: location.pathname,
    strategyDropdownFound: Boolean(strategy),
    hasEarliestExpiryOption: hasEarliest,
    strategy,
    selectCount: selects.length,
    all: dump,
  });
})()
