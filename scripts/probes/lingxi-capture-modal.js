/*
 * Probe: click Capture Session → modal opens with bookmarklet link (ot
 * minted) + paste textarea. Does NOT submit (that hits the live API).
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (location.pathname.startsWith("/login")) return { note: "not authed — run pass1 first" };
  await sleep(2000);
  // find the Capture Session button (grid + row variants share the label)
  const btns = [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.includes("Capture Session") || b.textContent?.includes("捕获会话"),
  );
  if (!btns.length) return { ok: false, note: "capture button not found" };
  btns[0].click();
  await sleep(2500);
  const text = document.body.innerText;
  const modalOpen = text.includes("捕获灵犀会话") || text.includes("书签捕获") || text.includes("手动方式");
  const hasBookmark = text.includes("捕获灵犀会话") && text.includes("拖到浏览器书签栏");
  const hasPaste = !!document.querySelector("textarea[placeholder*='wps_sid']");
  return { ok: modalOpen, modalOpen, hasBookmark, hasPaste, textSample: text.slice(0, 120).replace(/\n+/g, " | ") };
})();
