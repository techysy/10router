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

// Real-name (实名) gates are a different vendor page but the same user need: the
// account stays blocked until a human opens the vendor's page. StepFun CN answers
// 403 with a face-verification URL
// (https://account.stepfun.com/security?action=realname).
//
// Deliberately its own function rather than a widening of the Google matcher
// above: that one is asserted to IGNORE non-signin Google URLs
// (myaccount.google.com/security), and broadening it to any `/security` path
// would both break that contract and let a StepFun link be handed back as a
// Google verification target. Callers pick the extractor that matches the gate
// they are rendering.
const REALNAME_VERIFICATION_URL_RE = /https:\/\/[^\s"'<>)\]]*account\.stepfun\.com\/security[^\s"'<>)\]]*/;

export function extractRealnameVerificationUrl(text) {
  if (typeof text !== "string") return null;
  const match = REALNAME_VERIFICATION_URL_RE.exec(text);
  return match ? match[0] : null;
}
