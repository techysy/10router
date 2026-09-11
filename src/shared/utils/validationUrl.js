// Google VALIDATION_REQUIRED errors carry a one-click "Verify your account" URL
// (accounts.google.com/signin/continue?...). It reaches the dashboard embedded in
// error text from different surfaces — the chat error message and the connection
// test's lastError — so this extracts it from any string for jump-link rendering.
const VERIFICATION_URL_RE = /https:\/\/accounts\.google\.com\/signin\/continue[^\s"'<>)\]]+/;

export function extractAccountsVerificationUrl(text) {
  if (typeof text !== "string") return null;
  const match = VERIFICATION_URL_RE.exec(text);
  return match ? match[0] : null;
}
