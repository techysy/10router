// The Codex CLI version shows up in several identity sites (registry transport headers, the
// image handler's user-agent + version headers, the connection-test probe). They must all
// derive from one place — registry codex.transport.cliVersion — or the values drift, which is
// exactly what the previous hardcoded 0.136.0 / 0.144.6 split looked like.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PROVIDERS } from "../../open-sse/config/providers.js";
import { CODEX_CLI_VERSION } from "../../open-sse/config/appConstants.js";
import codexImageProvider from "../../open-sse/handlers/imageProviders/codex.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

// A literal "codex_cli_rs/<semver>" anywhere means that site stopped deriving the version.
const HARDCODED = /codex_cli_rs\/\d+\.\d+\.\d+/;

const IDENTITY_FILES = [
  "open-sse/providers/registry/codex.js",
  "open-sse/handlers/imageProviders/codex.js",
  "src/app/api/providers/[id]/test/testUtils.js",
  "open-sse/config/appConstants.js",
];

describe("Codex CLI version is single-sourced", () => {
  it("derives CODEX_CLI_VERSION from the registry", () => {
    expect(PROVIDERS.codex.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CODEX_CLI_VERSION).toBe(PROVIDERS.codex.cliVersion);
  });

  it("uses it in the registry identity headers", () => {
    expect(PROVIDERS.codex.headers["User-Agent"]).toBe(`codex_cli_rs/${CODEX_CLI_VERSION}`);
    expect(PROVIDERS.codex.headers.originator).toBe("codex_cli_rs");
  });

  it("uses it in the image provider headers", () => {
    const headers = codexImageProvider.buildHeaders({
      accessToken: "codex-token",
      providerSpecificData: { chatgptAccountId: "account-123" },
    });

    expect(headers.version).toBe(CODEX_CLI_VERSION);
    expect(headers["user-agent"]).toBe(`codex_cli_rs/${CODEX_CLI_VERSION}`);
    expect(headers.originator).toBe("codex_cli_rs");
  });

  it("derives the connection-test probe headers", () => {
    expect(read("src/app/api/providers/[id]/test/testUtils.js")).toMatch(
      /"User-Agent": `codex_cli_rs\/\$\{CODEX_CLI_VERSION\}`/
    );
  });

  it("hardcodes the version in no identity site", () => {
    for (const file of IDENTITY_FILES) {
      expect(read(file), file).not.toMatch(HARDCODED);
    }
  });

  it("keeps the models-route client_version separate (query param, not identity)", () => {
    // /codex/models?client_version= gates the catalog by minimal_client_version — a different
    // notion from the identity version, deliberately not unified with it.
    expect(read("src/app/api/providers/[id]/models/route.js")).toMatch(/CODEX_CLIENT_VERSION = "\d+\.\d+\.\d+"/);
  });
});
