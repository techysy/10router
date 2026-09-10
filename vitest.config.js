// The test suite lives in tests/ (own package.json + vitest.config.js with
// the "@/" and "open-sse" aliases). Running `npx vitest` from the repo root
// used to load no config at all, so those aliases failed to resolve. Delegate
// to the tests/ config so root-level invocations behave the same.
import base from "./tests/vitest.config.js";

export default {
  ...base,
  test: { ...base.test, root: "tests" },
};
