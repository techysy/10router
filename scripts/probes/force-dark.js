// Force dark mode for visual audits: persist the zustand theme store value and
// pin the .dark class on <html> (themeStore may re-apply the light class during
// hydration, so a MutationObserver keeps it pinned for the screenshot window).
// Usage: node scripts/browser-probe.mjs <url> --script scripts/probes/force-dark.js --out dark.png
localStorage.setItem("theme", JSON.stringify({ state: { theme: "dark" }, version: 0 }));
const apply = () => document.documentElement.classList.add("dark");
apply();
new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
({ dark: document.documentElement.classList.contains("dark") });
