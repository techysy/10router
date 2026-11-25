/*
 * Probe: login page → fetch-login → assign location (full reload picks up the
 * HttpOnly cookie) → the NEXT probe run sees the authed providers page.
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (location.pathname.startsWith("/login")) {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "lx-cap-1" }),
    });
    if (!res.ok) return { pass: 1, ok: false, status: res.status };
    location.href = "/dashboard/providers/lingxi";
    return { pass: 1, ok: true, note: "navigating" };
  }
  await sleep(2500);
  const text = document.body.innerText;
  return {
    pass: 2,
    path: location.pathname,
    hasButton: text.includes("Capture Session") || text.includes("捕获会话"),
    connRows: (text.match(/192\*\*\*\*197/g) || []).length,
    textLen: text.length,
  };
})();
