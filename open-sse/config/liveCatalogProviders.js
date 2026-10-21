// Providers whose registry `models[]` is only an offline floor and whose real
// catalogue needs the account credential (open-sse/services/liveCatalogs.js).
//
// Kept in a leaf module with no imports: callers that only need to decide
// "should I fetch a live list?" must not pull in liveCatalogs.js — that module
// imports proxyFetch, which patches globalThis.fetch at import time and would
// surprise route tests (and any caller that stubs fetch).
export const LIVE_CATALOG_PROVIDER_IDS = Object.freeze([
  "loomy",
  "lobsterai",
  "atomcode",
  "raccoon",
  "codearts",
  "officeace",
  "trae-solo",
]);

export const LIVE_CATALOG_PROVIDER_SET = new Set(LIVE_CATALOG_PROVIDER_IDS);
