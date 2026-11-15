/*
 * Probe: providers page renders WPS 灵犀 card? (single-pass, resilient)
 * The probe lands on /dashboard/providers; if bounced to /login, log in via
 * fetch (HttpOnly cookie sticks) and pushState into the SPA without reloading.
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function authed() {
    try {
      const st = await fetch("/api/auth/status").then((r) => r.json());
      return st.authMode === "password" ? !st.requireLogin : true;
    } catch { return false; }
  }

  if (!(await authed())) {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "lingxi-ui-1" }),
    });
    if (!res.ok) return { ok: false, note: "login failed " + res.status, path: location.pathname };
    // SPA is mounted (login page); use the router instead of a full reload.
    history.pushState({}, "", "/dashboard/providers");
    dispatchEvent(new PopStateEvent("popstate"));
    await sleep(4000);
  }

  // SPA may still be loading; poll for the grid
  for (let i = 0; i < 10; i++) {
    if (document.body.innerText.includes("Test All") || document.body.innerText.includes("测试全部")) break;
    await sleep(1000);
  }

  const text = document.body.innerText;
  const hasLingxi = text.includes("WPS 灵犀");
  let section = null;
  if (hasLingxi) {
    const all = [...document.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && el.textContent?.trim() === "WPS 灵犀",
    );
    let el = all[all.length - 1];
    while (el && el !== document.body) {
      const heads = [...(el.querySelectorAll?.("h1,h2") || [])];
      if (heads.length) { section = heads[heads.length - 1].textContent.trim(); break; }
      el = el.parentElement;
    }
  }
  return {
    path: location.pathname,
    hasLingxi,
    hasDumate: text.includes("DuMate"),
    section,
    textLen: text.length,
    sample: text.slice(0, 200).replace(/\n+/g, " | "),
  };
})();
