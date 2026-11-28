// search.js has no test file at all — handleSearch is not exercised anywhere in
// tests/ — so these are source-text guards, matching the repo convention for
// handler wiring that cannot be reached by importing (see
// tests/unit/disabled-models-ux.test.js:9).
//
// The invariant: a handler must use ONE lock key for all three touchpoints —
// credential resolution, the error lock, and the success clear. Mismatching them
// is silent and self-inflicted: markAccountUnavailable writes
// `modelLock_<model>`, and clearAccountError only nulls that same key, so a
// handler that locks with one key and clears with another leaves its own lock
// behind after a success. search.js already had the comment explaining why the
// key exists; it just wasn't passed to the clear.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(__dirname, "../..");
const read = (rel) => readFileSync(resolve(rootDir, rel), "utf8");

const HANDLERS = [
  { rel: "src/sse/handlers/search.js", key: "searchLockKey", label: "websearch" },
  { rel: "src/sse/handlers/fetch.js", key: "fetchLockKey", label: "webfetch" },
];

describe("web handlers clear the lock they wrote (#46 follow-up)", () => {
  for (const { rel, key } of HANDLERS) {
    it(`${rel} passes ${key} to clearAccountError`, () => {
      const src = read(rel);
      // The exact call shape, so a dropped argument is caught here rather than
      // by a user wondering why a recovered provider stays locked.
      expect(src).toMatch(new RegExp(`clearAccountError\\([^)]*,\\s*${key}\\s*\\)`));
    });

    it(`${rel} passes ${key} to markAccountUnavailable`, () => {
      const src = read(rel);
      expect(src).toMatch(new RegExp(`markAccountUnavailable\\([^)]*${key}\\s*\\)`));
    });

    it(`${rel} resolves credentials under ${key}`, () => {
      const src = read(rel);
      // Not anchored to the closing paren: this call carries options after the
      // lock key (the routing identity, so session stickiness can pick an
      // account), and those are none of this invariant's business.
      expect(src).toMatch(new RegExp(`getProviderCredentials\\([^)]*\\b${key}\\b`));
    });

    it(`${rel} scopes its lock key per provider, not account-wide`, () => {
      // A `__all` lock from one webFetch failure would take the whole account
      // offline — the exact conflation issue #46 is about.
      const src = read(rel);
      expect(src).toMatch(new RegExp(`const ${key} = \`web(fetch|search):\\$\\{providerId\}\`;`));
    });
  }
});
