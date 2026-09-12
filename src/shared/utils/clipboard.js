"use client";

/**
 * Copy text to the clipboard with a fallback chain.
 *
 * navigator.clipboard only exists in secure contexts — viewing the dashboard
 * over a LAN IP (http://192.168.x.x) leaves it undefined, and even where it
 * exists writeText() can reject ("Document is not focused", permission
 * prompts). The textarea + execCommand path keeps working in all of those.
 * Returns true when a path actually succeeded.
 */
export async function copyTextToClipboard(text) {
  const value = String(text ?? "");
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
